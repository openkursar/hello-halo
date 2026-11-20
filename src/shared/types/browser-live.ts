/**
 * Live-view payloads for watching a browser page from a client that cannot host
 * the page itself (remote browser, mobile, a server install with no desktop
 * window). Pixels travel as data URLs because the WebSocket transport is
 * JSON-only.
 */

/** One frame of a page a viewer asked to watch. */
export interface BrowserLiveFrame {
  viewId: string
  /** Monotonic within a session; the viewer echoes it back to ask for more. */
  seq: number
  image: string
  width: number
  height: number
  /** Where the page is now; it navigates on its own while the viewer watches. */
  url?: string
  /** Which slice of a taller page the frame shows; absent when unknown. */
  scroll?: BrowserLiveScroll
  /**
   * A full-resolution still requested outside the paced stream, for content the
   * stream's bitrate destroys — a QR code a phone camera has to read.
   */
  detail?: true
  /** Present when the still was asked for as the whole page: which part of it the image covers. */
  page?: BrowserLivePageSpan
}

/** A still covers the screen, or as much of the whole page as could be captured. */
export type BrowserLiveDetailScope = 'screen' | 'page'

/** The document range an image covers, in CSS pixels. */
export interface BrowserLivePageSpan {
  top: number
  height: number
  total: number
}

/** Vertical position of the frame within its document, in CSS pixels. */
export interface BrowserLiveScroll {
  top: number
  viewport: number
  total: number
}

export type BrowserLiveModifier = 'shift' | 'control' | 'alt' | 'meta'

/**
 * One input from a viewer operating the page. Positions and wheel deltas are
 * fractions of the frame as displayed, so the viewer never needs the page's
 * real size.
 */
export type BrowserLiveInput =
  | {
    kind: 'mouse'
    action: 'down' | 'up' | 'move'
    x: number
    y: number
    button?: 'left' | 'middle' | 'right'
    clickCount?: number
    modifiers?: BrowserLiveModifier[]
  }
  | { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: 'key'; action: 'down' | 'up'; key: string; modifiers?: BrowserLiveModifier[] }
  /** Typed or pasted text, already composed by the viewer's own input method. */
  | { kind: 'text'; text: string }
  /** Puts the page's first visible line at `top`, in the CSS pixels `scroll` reports. */
  | { kind: 'scroll-to'; top: number }

/** The stream ended for a reason the viewer cannot infer from frames stopping. */
export interface BrowserLiveStopped {
  viewId: string
  /** `unsupported`: this install is not a server, so pages are not streamed at all. */
  reason: 'gone' | 'unavailable' | 'stalled' | 'unsupported'
}
