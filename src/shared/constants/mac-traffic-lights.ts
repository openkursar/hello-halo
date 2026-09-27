/**
 * macOS traffic-light geometry, shared by the main process (which places the
 * native buttons) and the renderer (which leaves room for them). Values are
 * real pixels: the buttons don't zoom, so renderer clearances divide by
 * --display-scale.
 */

/** Top-left of the button group (BrowserWindow `trafficLightPosition`). */
export const MAC_TRAFFIC_LIGHT_POSITION = { x: 5, y: 8 }

/** Height of the button group. Not queryable from Electron; measured. */
export const MAC_TRAFFIC_LIGHT_HEIGHT = 14

/** Where the button group ends, measured from the top of the window. */
export const MAC_TRAFFIC_LIGHT_BOTTOM = MAC_TRAFFIC_LIGHT_POSITION.y + MAC_TRAFFIC_LIGHT_HEIGHT
