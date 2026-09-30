/**
 * Height of the app header, shared by the renderer (Header) and the main
 * process (the Windows/Linux titleBarOverlay that holds the native caption
 * buttons in the same strip).
 */
export const APP_HEADER_HEIGHT = 40

/**
 * The caption-button overlay stops one pixel short of the header: tall enough
 * to center the buttons in it, while its opaque fill leaves the header's 1px
 * bottom border visible.
 */
export const TITLE_BAR_OVERLAY_HEIGHT = APP_HEADER_HEIGHT - 1
