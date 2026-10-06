export interface BrowserHostBounds {
  x: number
  y: number
  width: number
  height: number
}

/** A guest's creation URL is immutable; only main may navigate its WebContents. */
export interface BrowserHostPage {
  id: string
  token: string
  src: string
  bounds: BrowserHostBounds
  visible: boolean
  viewportWidth?: number
  frameLeaseId?: string
}

export type BrowserHostCommand =
  | { type: 'upsert'; page: BrowserHostPage }
  | { type: 'remove'; id: string; token: string }

export interface BrowserHostFailure {
  id: string
  token: string
  error: string
}

export interface BrowserPageGone {
  viewId: string
  reason: 'closed' | 'lost'
}

export interface BrowserHostFrameReady {
  id: string
  token: string
  frameLeaseId: string
}

export interface BrowserHostBridge {
  browserHostReady: () => Promise<BrowserHostPage[]>
  browserHostFailed: (failure: BrowserHostFailure) => void
  browserHostFrameReady: (ready: BrowserHostFrameReady) => void
  onBrowserHostCommand: (callback: (command: BrowserHostCommand) => void) => () => void
}
