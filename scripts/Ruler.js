/* globals
canvas,
CONFIG,
CONST,
game,
PIXI,
Ruler,
ui
*/
/* eslint no-unused-vars: ["error", { "argsIgnorePattern": "^_" }] */

// Patches for the Ruler class
export const PATCHES = {};
PATCHES.BASIC = {};
PATCHES.SPEED_HIGHLIGHTING = {};

import { SPEED, MODULE_ID } from "./const.js";
import { Settings } from "./settings.js";
import { Ray3d } from "./geometry/3d/Ray3d.js";
import { Point3d } from "./geometry/3d/Point3d.js";
import {
  elevationAtWaypoint,
  originElevation,
  destinationElevation,
  terrainElevationAtLocation,
  elevationAtLocation
} from "./terrain_elevation.js";

import {
  _getMeasurementSegments,
  _getSegmentLabel,
  _animateSegment,
  _highlightMeasurementSegment
} from "./segments.js";

import { log, unsnappedTokenPositionAt } from "./util.js";

import { PhysicalDistance } from "./PhysicalDistance.js";

import { MoveDistance } from "./MoveDistance.js";

import { gridShape, pointFromGridCoordinates, canvasElevationFromCoordinates } from "./grid_coordinates.js";

/**
 * Modified Ruler
 * Measure elevation change at each waypoint and destination.
 * Modify distance calculation accordingly.
 * Display current elevation change and change at each waypoint.
 */

/**
 * Typical Ruler workflow:
 * - clear when drag starts
 * - create initial waypoint
 * - measure (likely multiple)
 * - add'l waypoints (optional)
 * - possible token movement
 * - clear when drag abandoned
 */

/*
UX goals:
1. Ruler origin elevation is the starting token elevation, if any, or the terrain elevation.
2. Dragging the ruler to the next space may cause it to drop if the token is elevated.
- This is probably fine? If flying while everyone else is on the ground, the default should
    account for that.
- A bit cumbersome if measuring straight across elevated terrain, but (a) use terrain layer and
    (b) other elevated tokens should change the destination elevation automatically. (see 3 below)
3. If the destination space is an elevated token or terrain, use that elevation for destination.
- So measuring that space will change the ruler elevation indicator accordingly.
- This will cause the elevation indicator to change without other user input. This is probably fine?
    User will be dragging the ruler, so that is appropriate feedback.
4. User can at any time increment or decrement. This is absolute, in that it is added on top of any
    default elevations from originating/destination tokens or terrain.
- Meaning, origination could be 0, user increments 5 and then drags to a terrain space of 50; ruler
    would go from 5 to 55.
*/

// ----- NOTE: Wrappers ----- //

/**
 * Wrap Ruler.prototype._getMeasurementData
 * Store the current userElevationIncrements for the destination.
 * Store segment information, possibly including pathfinding.
 */
function _getMeasurementData(wrapper) {
  const obj = wrapper();
  const myObj = obj[MODULE_ID] = {};

  // Segment information
  // Simplify the ray.
  if ( this.segments ) myObj._segments = this.segments.map(segment => {
    const newObj = { ...segment };
    newObj.ray = {
      A: segment.ray.A,
      B: segment.ray.B
    };
    newObj.label = Boolean(segment.label);
    if ( segment.speed ) newObj.speed = segment.speed.name;
    return newObj;
  });

  myObj._userElevationIncrements = this._userElevationIncrements;
  myObj.totalDistance = this.totalDistance;
  myObj.totalMoveDistance = this.totalMoveDistance;
  myObj._isTokenRuler = this._isTokenRuler;
  myObj._originAdjX = this._originAdjX;
  myObj._originAdjY = this._originAdjY;
  return obj;
}

/**
 * Wrap Ruler.prototype.update
 * Retrieve the current _userElevationIncrements.
 * Retrieve the current snap status.
 */
function update(wrapper, data) {
  if ( !data || (data.state === Ruler.STATES.INACTIVE) ) return wrapper(data);
  const myData = data[MODULE_ID];
  if ( !myData ) return wrapper(data); // Just in case.

  // Fix for displaying user elevation increments as they happen.
  const triggerMeasure = this._userElevationIncrements !== myData._userElevationIncrements;
  this._userElevationIncrements = myData._userElevationIncrements;
  this._isTokenRuler = myData._isTokenRuler;
  this._originAdjX = myData._originAdjX;
  this.__originAdjY = myData._originAdjY;

  // Reconstruct segments.
  if ( myData._segments ) this.segments = myData._segments.map(segment => {
    segment.ray = new Ray3d(segment.ray.A, segment.ray.B);
    if ( segment.speed ) segment.speed = SPEED.CATEGORIES.find(category => category.name === segment.speed);
    return segment;
  });

  // Add the calculated distance totals.
  this.totalDistance = myData.totalDistance;
  this.totalMoveDistance = myData.totalMoveDistance;

  wrapper(data);

  if ( triggerMeasure ) {
    const ruler = canvas.controls.ruler;
    this.destination.x -= 1;
    ruler.measure(this.destination);
  }
}

/**
 * Wrap Ruler.prototype._addWaypoint
 * Add elevation increments
 */
function _addWaypoint(wrapper, point) {
  wrapper(point);

  // In case the waypoint was never added.
  if ( (this.state !== Ruler.STATES.STARTING) && (this.state !== Ruler.STATES.MEASURING ) ) return;
  if ( !this.waypoints.length ) return;

  // Elevate the waypoint.
  addWaypointElevationIncrements(this, point);
}

/**
 * Wrap Ruler.prototype._removeWaypoint
 * Remove elevation increments.
 * Remove calculated path.
 */
function _removeWaypoint(wrapper, point, { snap = true } = {}) {
  if ( this._pathfindingSegmentMap ) this._pathfindingSegmentMap.delete(this.waypoints.at(-1));
  this._userElevationIncrements = 0;
  wrapper(point, { snap });
}

/**
 * Wrap Ruler.prototype._getMeasurementOrigin
 * Get the measurement origin.
 * If Token Ruler, shift the measurement origin to the token center, adjusted for non-symmetrical tokens.
 * @param {Point} point                    The waypoint
 * @param {object} [options]               Additional options
 * @param {boolean} [options.snap=true]    Snap the waypoint?
 * @protected
 */
function _getMeasurementOrigin(wrapped, point, {snap=true}={}) {
  point = wrapped(point, { snap });
  const token = this.token;
  if ( !this._isTokenRuler || !token ) return point;

  // Shift to token center or snapped center.
  // Adjust for non-symmetrical token sizes.
  // Non-symmetrical move from the innermost right/left or top/bottom from center.
  // log(`_getMeasurementOrigin|Shifting ruler origin to ${token.center.x},${token.center.y}`);
  const dSize = canvas.dimensions.size;
  const tCenter = token.center;
  const { width, height } = token.getSize();
  const adjX = (((width / dSize) + 1) % 2) / 2;
  const adjY = (((height / dSize) + 1) % 2) / 2;
  const signX = Math.sign(point.x - tCenter.x);
  const signY = Math.sign(point.y - tCenter.y);

  this._originAdjX = (adjX * signX * dSize);
  this._originAdjY = (adjY * signY * dSize);
  return {
    x: tCenter.x + this._originAdjX,
    y: tCenter.y + this._originAdjY
  }

  // return token.center;
  // return point;
}

/**
 * Wrap Ruler.prototype._getMeasurementDestination
 * Get the destination point. By default the point is snapped to grid space centers.
 * Adjust the destination point match where the preview token is placed.
 * @param {Point} point                    The point coordinates
 * @param {object} [options]               Additional options
 * @param {boolean} [options.snap=true]    Snap the point?
 * @returns {Point}                        The snapped destination point
 * @protected
 */
function _getMeasurementDestination(wrapped, point, {snap=true}={}) {
  point = wrapped(point, { snap });
  const token = this.token;
  if ( !this._isTokenRuler || !token ) return point;
  if ( !(this._originAdjX || this._originAdjY) ) return point;
  if ( !token._preview ) return point;

  const tCenter = token._preview.center;
  return {
    x: tCenter.x + this._originAdjX,
    y: tCenter.y + this._originAdjY
  };
}

/**
 * Mixed wrap Ruler.prototype._animateMovement
 * Add additional controlled tokens to the move, if permitted.
 */
async function _animateMovement(wrapped, token) {
  if ( !this.segments || !this.segments.length ) return; // Ruler._animateMovement expects at least one segment.

  log(`Moving ${token.name} ${this.segments.length} segments.`, [...this.segments]);

  this.segments.forEach((s, idx) => s.idx = idx);

  //_recalculateOffset.call(this, token);
  const promises = [wrapped(token)];
  for ( const controlledToken of canvas.tokens.controlled ) {
    if ( controlledToken === token ) continue;
    if ( !(this.user.isGM || this._canMove(controlledToken)) ) {
      ui.notifications.error(`${game.i18n.localize("RULER.MovementNotAllowed")} for ${controlledToken.name}`);
      continue;
    }
    promises.push(wrapped(controlledToken));
  }
  return Promise.allSettled(promises);
}

/**
 * Wrap Ruler.prototype._canMove
 * Allow GM full reign to move tokens.
 */
function _canMove(wrapper, token) {
  if ( this.user.isGM ) return true;
  return wrapper(token);
}

/**
 * Override Ruler.prototype._computeDistance
 * Use measurement that counts segments within a grid square properly.
 * Add moveDistance property to each segment; track the total.
 * If token not present or Terrain Mapper not active, this will be the same as segment distance.
 */
function _computeDistance() {
  // If not this ruler's user, use the segments already calculated and passed via socket.
  if ( this.user !== game.user ) return;

  // Debugging
  const debug = CONFIG[MODULE_ID].debug;
  if ( debug && this.segments.some(s => !s) ) console.error("Segment is undefined.");

  // Determine the distance of each segment.
  _computeSegmentDistances.call(this);
  _computeTokenSpeed.call(this); // Always compute speed if there is a token b/c other users may get to see the speed.

  if ( debug ) {
    switch ( this.segments.length ) {
      case 1: break;
      case 2: break;
      case 3: break;
      case 4: break;
      case 5: break;
      case 6: break;
      case 7: break;
      case 8: break;
      case 9: break;
    }
  }

  // Debugging
  if ( debug && this.segments.some(s => !s) ) console.error("Segment is undefined.");

  // Compute the waypoint distances for labeling. (Distance to immediately previous waypoint.)
  const waypointKeys = new Set(this.waypoints.map(w => w.key));
  let waypointDistance = 0;
  let waypointMoveDistance = 0;
  let waypointStartingElevation = 0;
  for ( const segment of this.segments ) {
    const A = Point3d.fromObject(segment.ray.A);
    const B = Point3d.fromObject(segment.ray.B);
    if ( waypointKeys.has(A.to2d().key) ) {
      waypointDistance = 0;
      waypointMoveDistance = 0;
      waypointStartingElevation = A.z;
    }
    waypointDistance += segment.distance;
    waypointMoveDistance += segment.moveDistance;
    segment.waypointDistance = waypointDistance;
    segment.waypointMoveDistance = waypointMoveDistance;
    segment.waypointElevationIncrement = B.z - waypointStartingElevation;
  }
}

/**
 * Calculate the distance of each segment.
 * Segments are considered a group, so that alternating diagonals gives the same result
 * with or without the segment breaks.
 */
function _computeSegmentDistances() {
  const token = this.token;

  // Loop over each segment in turn, adding the physical distance and the move distance.
  let totalDistance = 0;
  let totalMoveDistance = 0;
  let numPrevDiagonal = 0;

  if ( this.segments.length ) {
    this.segments[0].first = true;
    this.segments.at(-1).last = true;
  }
  for ( const segment of this.segments ) {
    numPrevDiagonal = _measureSegment(segment, token, numPrevDiagonal);
    totalDistance += segment.distance;
    totalMoveDistance += segment.moveDistance;
  }

  this.totalDistance = totalDistance;
  this.totalMoveDistance = totalMoveDistance;
}

/**
 * Measure a given segment, updating its distance labels accordingly.
 * Segment modified in place.
 * @param {RulerSegment} segment          Segment to measure
 * @param {Token} [token]                 Token to use for the measurement
 * @param {number} [numPrevDiagonal=0]    Number of previous diagonals for the segment
 * @returns {number} numPrevDiagonal
 */
function _measureSegment(segment, token, numPrevDiagonal = 0) {
  segment.numPrevDiagonal = numPrevDiagonal;
  const res = MoveDistance.measure(
    segment.ray.A,
    segment.ray.B,
    { token, useAllElevation: segment.last, numPrevDiagonal });
  segment.distance = res.distance;
  segment.moveDistance = res.moveDistance;
  segment.numDiagonal = res.numDiagonal;
  return res.numPrevDiagonal;
}

// TODO:
// Need to recalculate segment distances and segment numPrevDiagonal, because
// each split will potentially screw up numPrevDiagonal.
// May not even need to store numPrevDiagonal in segments.
// Also need to handle array of speed points.
//   Need CONFIG function that takes a token and gives array of speeds with colors.

/**
 * Incrementally add together all segments. Split segment(s) at SpeedCategory maximum distances.
 * Mark each segment with the distance, move distance, and SpeedCategory name.
 * Does not assume segments have measurements, and modifies existing measurements.
 * Segments modified in place.
 */
function _computeTokenSpeed() {
  // Requires a movement token and a defined token speed.
  const token = this.token;
  if ( !token ) return;

  // Precalculate the token speed.
  const tokenSpeed = SPEED.tokenSpeed(token);
  if ( !tokenSpeed ) return;

  // Other constants
  const gridless = canvas.grid.type === CONST.GRID_TYPES.GRIDLESS;

  // Variables changed in the loop
  let totalDistance = 0;
  let totalMoveDistance = 0;
  let totalCombatMoveDistance = 0;
  let minDistance = 0;
  let numPrevDiagonal = 0;
  let s = 0;
  let segment;

  // Debugging
  if ( CONFIG[MODULE_ID].debug ) {
    if ( this.segments[0].moveDistance > 25 ) log(`${this.segments[0].moveDistance}`);
    if ( this.segments[0].moveDistance > 30 ) log(`${this.segments[0].moveDistance}`);
    if ( this.segments[0].moveDistance > 50 ) log(`${this.segments[0].moveDistance}`);
    if ( this.segments[0].moveDistance > 60 ) log(`${this.segments[0].moveDistance}`);
  }

  // Progress through each speed attribute in turn.
  const categoryIter = [...SPEED.CATEGORIES].values();
  let speedCategory = categoryIter.next().value;
  let maxDistance = SPEED.maximumCategoryDistance(token, speedCategory, tokenSpeed);

  // Determine which speed category we are starting with
  // Add in already moved combat distance and determine the starting category
  if ( game.combat?.started
    && Settings.get(Settings.KEYS.SPEED_HIGHLIGHTING.COMBAT_HISTORY) ) {

    totalCombatMoveDistance = token.lastMoveDistance;
    minDistance = totalCombatMoveDistance;
  }

  while ( (segment = this.segments[s]) ) {
    // Skip speed categories that do not provide a distance larger than the last.
    while ( speedCategory && maxDistance <= minDistance ) {
      speedCategory = categoryIter.next().value;
      maxDistance = SPEED.maximumCategoryDistance(token, speedCategory, tokenSpeed);
    }
    if ( !speedCategory ) speedCategory = SPEED.CATEGORIES.at(-1);

    segment.speed = speedCategory;
    let newPrevDiagonal = _measureSegment(segment, token, numPrevDiagonal);

    // If we have exceeded maxDistance, determine if a split is required.
    const newDistance = totalCombatMoveDistance + segment.moveDistance;

    if ( newDistance > maxDistance || newDistance.almostEqual(maxDistance ) ) {
      if ( newDistance > maxDistance ) {
        // Split the segment, inserting the latter portion in the queue for future iteration.
        const splitDistance = maxDistance - totalCombatMoveDistance;
        const breakpoint = locateSegmentBreakpoint(segment, splitDistance, token, gridless);
        if ( breakpoint ) {
          const segments = _splitSegmentAt(segment, breakpoint);
          this.segments.splice(s, 1, segments[0]); // Delete the old segment, replace.
          this.segments.splice(s + 1, 0, segments[1]); // Add the split.
          segment = segments[0];
          newPrevDiagonal = _measureSegment(segment, token, numPrevDiagonal);
        }
      }

      // Increment to the next speed category.
      // Next category will be selected in the while loop above: first category to exceed minDistance.
      minDistance = maxDistance;
    }

    // Increment totals.
    s += 1;
    totalDistance += segment.distance;
    totalMoveDistance += segment.moveDistance;
    totalCombatMoveDistance += segment.moveDistance;
    numPrevDiagonal = newPrevDiagonal;
  }

  this.totalDistance = totalDistance;
  this.totalMoveDistance = totalMoveDistance;
}

/**
 * Determine the specific point at which to cut a ruler segment such that the first subsegment
 * measures a specific incremental move distance.
 * @param {RulerMeasurementSegment} segment       Segment, with ray property, to split
 * @param {number} incrementalMoveDistance        Distance, in grid units, of the desired first subsegment move distance
 * @param {Token} token                           Token to use when measuring move distance
 * @returns {Point3d|null}
 *   If the incrementalMoveDistance is less than 0, returns null.
 *   If the incrementalMoveDistance is greater than segment move distance, returns null
 *   Otherwise returns the point at which to break the segment.
 */
function locateSegmentBreakpoint(segment, splitMoveDistance, token, gridless) {
  if ( splitMoveDistance <= 0 ) return null;
  if ( !segment.moveDistance || splitMoveDistance > segment.moveDistance ) return null;

  // Attempt to move the split distance and determine the split location.
  const { A, B } = segment.ray;
  const res = Ruler.measureMoveDistance(A, B,
    { token, gridless, useAllElevation: false, stopTarget: splitMoveDistance });

  let breakpoint = pointFromGridCoordinates(res.endGridCoords); // We can get the exact split point.
  if ( !gridless ) {
    // We can get the end grid.
    // Use halfway between the intersection points for this grid shape.
    breakpoint = Point3d.fromObject(segmentGridHalfIntersection(breakpoint, A, B) ?? A);
    if ( breakpoint === A ) breakpoint.z = A.z;
    else breakpoint.z = canvasElevationFromCoordinates(res.endGridCoords);
  }

  if ( breakpoint.almostEqual(B) || breakpoint.almostEqual(A) ) return null;
  return breakpoint;
}

/**
 * Cut a ruler segment at a specified point. Does not remeasure the resulting segments.
 * Assumes without testing that the breakpoint lies on the segment between A and B.
 * @param {RulerMeasurementSegment} segment       Segment, with ray property, to split
 * @param {Point3d} breakpoint                    Point to use when splitting the segments
 * @returns [RulerMeasurementSegment, RulerMeasurementSegment]
 */
function _splitSegmentAt(segment, breakpoint) {
  const { A, B } = segment.ray;

  // Split the segment into two at the break point.
  const s0 = {...segment};
  s0.ray = new Ray3d(A, breakpoint);
  s0.distance = null;
  s0.moveDistance = null;
  s0.numDiagonal = null;

  const s1 = {...segment};
  s1.ray = new Ray3d(breakpoint, B);
  s1.distance = null;
  s1.moveDistance = null;
  s1.numPrevDiagonal = null;
  s1.numDiagonal = null;
  s1.speed = null;

  if ( segment.first ) { s1.first = false; }
  if ( segment.last ) { s0.last = false; }
  return [s0, s1];
}

/**
 * For a given segment, locate its intersection at a grid shape.
 * The intersection point is on the segment, halfway between the two intersections for the shape.
 * @param {number[]} gridCoords
 * @param {PIXI.Point} a
 * @param {PIXI.Point} b
 * @returns {PIXI.Point|undefined} Undefined if no intersection. If only one intersection, the
 *   endpoint contained within the shape.
 */
function segmentGridHalfIntersection(gridCoords, a, b) {
  const shape = gridShape(gridCoords);
  const ixs = shape.segmentIntersections(a, b);
  if ( !ixs || ixs.length === 0 ) return null;
  if ( ixs.length === 1 ) return shape.contains(a.x, a.y) ? a : b;
  return PIXI.Point.midPoint(ixs[0], ixs[1]);
}


// ----- NOTE: Event handling ----- //

/**
 * Wrap Ruler.prototype._onDragStart
 * Record whether shift is held.
 * Reset FORCE_TO_GROUND
 * @param {PIXI.FederatedEvent} event   The drag start event
 * @see {Canvas._onDragLeftStart}
 */
function _onDragStart(wrapped, event, { isTokenDrag = false } = {}) {
  Settings.FORCE_TO_GROUND = false;
  this._userElevationIncrements = 0;
  this._isTokenRuler = isTokenDrag;
  return wrapped(event);
}

/**
 * Wrap Ruler.prototype._onMoveKeyDown
 * If the teleport key is held, teleport the token.
 * @param {KeyboardEventContext} context
 */
function _onMoveKeyDown(wrapped, context) {
  const teleportKeys = new Set(game.keybindings.get(MODULE_ID, Settings.KEYBINDINGS.TELEPORT).map(binding => binding.key));
  if ( teleportKeys.intersects(game.keyboard.downKeys) ) this.segments.forEach(s => s.teleport = true);
  wrapped(context);
}

PATCHES.BASIC.WRAPS = {
  _getMeasurementData,
  update,
  _addWaypoint,
  _removeWaypoint,
  _getMeasurementOrigin,
  _getMeasurementDestination,

  // Wraps related to segments
  _getSegmentLabel,

  // Events
  _onDragStart,
  _canMove,
  _onMoveKeyDown
};

PATCHES.BASIC.MIXES = { _animateMovement, _getMeasurementSegments };

PATCHES.BASIC.OVERRIDES = { _computeDistance, _animateSegment };

PATCHES.SPEED_HIGHLIGHTING.WRAPS = { _highlightMeasurementSegment };

// ----- NOTE: Methods ----- //

/**
 * Add Ruler.prototype.incrementElevation
 * Increase the elevation at the current ruler destination by one grid unit.
 */
function incrementElevation() {
  const ruler = canvas.controls.ruler;
  if ( !ruler || !ruler.active ) return;
  ruler._userElevationIncrements ??= 0;
  ruler._userElevationIncrements += 1;

  // Weird, but slightly change the destination to trigger a measure
  const destination = { x: this.destination.x, y: this.destination.y };
  this.destination.x -= 1;
  ruler.measure(destination);

  // Broadcast the activity (see ControlsLayer.prototype._onMouseMove)
  this._broadcastMeasurement();
  // game.user.broadcastActivity({ ruler: ruler.toJSON() });
}

/**
 * Add Ruler.prototype.decrementElevation
 * Decrease the elevation at the current ruler destination by one grid unit.
 */
function decrementElevation() {
  const ruler = canvas.controls.ruler;
  if ( !ruler || !ruler.active ) return;
  ruler._userElevationIncrements ??= 0;
  ruler._userElevationIncrements -= 1;

  // Weird, but slightly change the destination to trigger a measure
  const destination = { x: this.destination.x, y: this.destination.y };
  this.destination.x -= 1;
  ruler.measure(destination);

  // Broadcast the activity (see ControlsLayer.prototype._onMouseMove)
  this._broadcastMeasurement();
  // game.user.broadcastActivity({ ruler: ruler.toJSON() });
}

/**
 * Add Ruler.prototype.moveWithoutAnimation
 * Move the token and stop the ruler measurement
 * @returns {boolean} False if the movement did not occur
 */
async function teleport(_context) {
  if ( this._state !== this.constructor.STATES.MEASURING ) return false;
  if ( !this._canMove(this.token) ) return false;

  // Change all segments to teleport.
  this.segments.forEach(s => s.teleport = true);
  return this.moveToken();
}


PATCHES.BASIC.METHODS = {
  incrementElevation,
  decrementElevation,
  elevationAtLocation,
  _computeTokenSpeed,
  teleport
};

PATCHES.BASIC.GETTERS = {
  originElevation,
  destinationElevation
};

PATCHES.BASIC.STATIC_METHODS = {
  elevationAtWaypoint,
  terrainElevationAtLocation,
  measureDistance: PhysicalDistance.measure.bind(PhysicalDistance),
  measureMoveDistance: MoveDistance.measure.bind(MoveDistance)
};


// ----- Helper functions ----- //

/**
 * Helper to add elevation increments to waypoint
 */
function addWaypointElevationIncrements(ruler, _point) {
  const ln = ruler.waypoints.length;
  const newWaypoint = ruler.waypoints[ln - 1];

  // Set defaults.
  newWaypoint._terrainElevation = 0;
  newWaypoint._userElevationIncrements = 0;

  if ( ln === 1 ) {
    const moveToken = ruler.token;
    newWaypoint._terrainElevation = moveToken ? moveToken.elevationE : Ruler.terrainElevationAtLocation(newWaypoint);

  } else {
    newWaypoint._userElevationIncrements = ruler._userElevationIncrements ?? 0;
    newWaypoint._terrainElevation = ruler.elevationAtLocation(newWaypoint);
  }
}
