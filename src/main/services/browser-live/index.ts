/**
 * Browser Live View — public API
 *
 * Lets a client that cannot host a browser page watch one anyway: a remote
 * browser, a phone, or a server install with no desktop window at all. Pixels
 * come from the same hidden-window capture path the AI's own screenshots use,
 * paced by the viewer's acknowledgements.
 *
 * Watching is always an explicit act. Nothing streams until a viewer attaches,
 * and the last one leaving releases the page's frame lease — a page nobody is
 * looking at costs nothing.
 *
 * A viewer may also operate the page (click, scroll, type) so a person can take
 * over steps only they can do, such as logging in. Whatever it changes is
 * announced to the AI working the same page.
 */

import { browserViewManager } from '../browser-view.service'
import { BrowserLiveSession, type BrowserLiveViewerLink } from './session'
import { changesPage, parseBrowserLiveInput } from './input'
import type { BrowserLiveDetailScope, BrowserLiveStopped } from '../../../shared/types/browser-live'

export type { BrowserLiveFrameSink, BrowserLiveStopSink, BrowserLiveViewerLink } from './session'

const sessions = new Map<string, BrowserLiveSession>()

/** Minutes-scale, so a stream left running overnight is visible in the log. */
const HEARTBEAT_MS = 60_000
let heartbeat: NodeJS.Timeout | null = null
let viewDestroyed: (() => void) | null = null

function dropSession(viewId: string): void {
  sessions.delete(viewId)
  if (sessions.size === 0) stopWatching()
}

function startWatching(): void {
  if (!viewDestroyed) {
    viewDestroyed = browserViewManager.onViewDestroyed(viewId => {
      sessions.get(viewId)?.stop('gone')
    })
  }
  if (!heartbeat) {
    heartbeat = setInterval(reportState, HEARTBEAT_MS)
    heartbeat.unref?.()
  }
}

function stopWatching(): void {
  viewDestroyed?.()
  viewDestroyed = null
  if (heartbeat) clearInterval(heartbeat)
  heartbeat = null
}

function reportState(): void {
  let viewers = 0
  let frames = 0
  let bytes = 0
  let suppressed = 0
  for (const session of sessions.values()) {
    const stats = session.stats()
    viewers += stats.viewers
    frames += stats.frames
    bytes += stats.bytes
    suppressed += stats.suppressed
  }
  console.log(`[BrowserLive] pages=${sessions.size} viewers=${viewers} frames=${frames} kb=${Math.round(bytes / 1024)} unchanged=${suppressed}`)
}

/**
 * Start streaming a page to one viewer. Returns false when the page does not
 * exist (closed between the click and this call), which the caller must report
 * instead of leaving the viewer waiting for frames that will never come.
 */
export function browserLiveAttach(viewId: string, link: BrowserLiveViewerLink): boolean {
  const contents = browserViewManager.getWebContents(viewId)
  if (!contents || contents.isDestroyed()) return false

  let session = sessions.get(viewId)
  if (!session) {
    session = new BrowserLiveSession(viewId, contents, dropSession)
    sessions.set(viewId, session)
    startWatching()
  }
  session.addViewer(link)
  return true
}

export function browserLiveDetach(viewId: string, viewerId: string): void {
  sessions.get(viewId)?.removeViewer(viewerId)
}

/** The viewer rendered up to `seq` and is ready for the next frame. */
export function browserLiveAck(viewId: string, viewerId: string, seq: number): void {
  sessions.get(viewId)?.ack(viewerId, seq)
}

/**
 * One still outside the stream: the screen at full resolution, for content the
 * stream's bitrate destroys, or the whole page, to find a spot to jump to.
 */
export function browserLiveRequestDetail(viewId: string, viewerId: string, scope: BrowserLiveDetailScope = 'screen'): void {
  sessions.get(viewId)?.requestDetail(viewerId, scope)
}

/**
 * Operate a watched page as its viewer. The payload is untrusted; false means
 * it was malformed or the viewer is not watching that page.
 */
export function browserLiveInput(viewId: string, viewerId: string, raw: unknown): boolean {
  const input = parseBrowserLiveInput(raw)
  const session = sessions.get(viewId)
  if (!input || !session?.input(viewerId, input)) return false
  if (changesPage(input)) browserViewManager.noteUserInput(viewId)
  return true
}

/** A vanished client stops gating every page it was watching. */
export function browserLiveViewerDisconnected(viewerId: string): void {
  for (const session of Array.from(sessions.values())) session.removeViewer(viewerId)
}

/** Shutdown: end every stream so no page keeps its frame lease. */
export function stopAllBrowserLiveSessions(reason: BrowserLiveStopped['reason'] = 'unavailable'): void {
  for (const session of Array.from(sessions.values())) session.stop(reason)
}
