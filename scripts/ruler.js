import { log } from "./module.js";


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
 
// wrapping the constructor appears not to work.


// will need to update measuring to account for elevation
export function elevationRulerMeasure(wrapped, ...args) {
  log("we are measuring!", this);
  return wrapped(...args);
}

// moveToken should modify token elevation 
export function elevationRulerMoveToken(wrapped, ...args) {
  log("we are moving!", this);
  return wrapped(...args);
}

// clear should reset elevation info
export function elevationRulerClear(wrapped, ...args) {
  log("we are clearing!", this);
  
  /**
     * The current destination point at the end of the measurement
     * @type {PIXI.Point}
     */
  this.elevation_increments = [];
  
  /**
   * The current destination point elevation increment relative to origin.
   * @type {integer}
   */
  this.destination_elevation_increment = 0; 
  
  return wrapped(...args);
}

// update will need to transfer relevant elevation data (probably?)
export function elevationRulerUpdate(wrapped, ...args) {
  log("we are updating!", this);
  return wrapped(...args);
}

// adding waypoint should also add elevation info
export function elevationRulerAddWaypoint(wrapped, ...args) {
  log("adding waypoint!", this);
  return wrapped(...args);
}





