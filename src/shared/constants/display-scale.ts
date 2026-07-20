/**
 * Persistent display-scale (UI zoom) bounds, shared by the main process
 * (keyboard/menu zoom clamping) and the Settings slider so both surfaces
 * always cover the exact same range.
 */

export const DISPLAY_SCALE_MIN = 0.5
export const DISPLAY_SCALE_MAX = 1.5
export const DISPLAY_SCALE_STEP = 0.1
