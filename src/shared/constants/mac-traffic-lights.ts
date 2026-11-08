/**
 * macOS traffic-light geometry, shared by the main process (which places the
 * native buttons) and the renderer (which leaves room for them). Values are
 * real pixels: the buttons don't zoom, so renderer clearances divide by
 * --display-scale.
 */

export interface MacTrafficLightGeometry {
  /** Top-left of the button group (BrowserWindow `trafficLightPosition`). */
  position: { x: number; y: number }
  /** Where the button group ends, measured from the top of the window. */
  bottom: number
}

// Height of the button group. Not queryable from Electron; measured.
const BEFORE_TAHOE: MacTrafficLightGeometry = { position: { x: 5, y: 8 }, bottom: 8 + 14 }

// macOS 26 drops the buttons' invisible top margin and rounds window corners
// far more, so the old position sits high and against the corner curve.
const TAHOE: MacTrafficLightGeometry = { position: { x: 8, y: 10 }, bottom: 10 + 14 }

/** Geometry for a macOS version string such as `process.getSystemVersion()` ("26.1.0"). */
export function macTrafficLightGeometry(systemVersion: string | undefined): MacTrafficLightGeometry {
  const major = Number.parseInt(systemVersion ?? '', 10)
  return major >= 26 ? TAHOE : BEFORE_TAHOE
}
