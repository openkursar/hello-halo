/**
 * Mouse-as-touch for H5 (mobile) browser pages, scoped to the cursor.
 *
 * Chromium keeps one "emit touch events for mouse" switch per window: set on an
 * embedded page, it turns the whole Halo window into a touch surface and is not
 * undone by closing the page. So it is set on the main window, and only while
 * the cursor is over a displayed H5 page.
 */

export interface TouchPointerRect {
  x: number
  y: number
  width: number
  height: number
}

export interface TouchPointerDeps {
  /** Displayed H5 page bounds in host CSS px, or null when none is displayed. */
  getPageBounds(): TouchPointerRect | null
  /** Main window content origin in screen DIP and its zoom factor, or null when unusable. */
  getHost(): { x: number; y: number; zoom: number; focused: boolean } | null
  /** Cursor position in screen DIP. */
  getCursor(): { x: number; y: number }
  /** Flip the window-wide switch. */
  setEmit(enabled: boolean): Promise<void>
}

const POLL_MS = 100
/** After a failed switch, wait this long before sending again. */
const RETRY_MS = 1000

export function containsPoint(rect: TouchPointerRect, point: { x: number; y: number }): boolean {
  return point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height
}

export class TouchPointerController {
  private timer: NodeJS.Timeout | null = null
  /** Last value sent (a fresh window starts off); null = unknown, so the next decision is always sent. */
  private emitting: boolean | null = false
  /** Set while the switch keeps failing: no resend before this time, and one warning per failure streak. */
  private retryAt: number | null = null
  /** Resends a failed "off" once nothing is tracking any more. */
  private retryTimer: NodeJS.Timeout | null = null

  constructor(private readonly deps: TouchPointerDeps) {}

  /** Re-evaluate after anything that changes which page is displayed, its mode, bounds or window focus. */
  sync(): void {
    const active = this.deps.getPageBounds() !== null && this.deps.getHost()?.focused === true
    if (active) {
      if (!this.timer) {
        console.log('[Browser] H5 touch pointer: tracking cursor over the displayed page')
        this.timer = setInterval(() => this.tick(), POLL_MS)
        this.timer.unref?.()
      }
      this.tick()
      return
    }
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
      console.log('[Browser] H5 touch pointer: stopped tracking')
    }
    this.apply(false, true)
  }

  /** Force the switch off, e.g. on shutdown or when the window goes away. */
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.apply(false, true)
  }

  private tick(): void {
    const page = this.deps.getPageBounds()
    const host = this.deps.getHost()
    if (!page || !host?.focused) {
      this.sync()
      return
    }
    const onScreen = {
      x: host.x + page.x * host.zoom,
      y: host.y + page.y * host.zoom,
      width: page.width * host.zoom,
      height: page.height * host.zoom,
    }
    this.apply(containsPoint(onScreen, this.deps.getCursor()))
  }

  /** `force` skips the backoff: turning off when tracking stops must not wait for a tick that no longer comes. */
  private apply(enabled: boolean, force = false): void {
    if (this.emitting === enabled) return
    if (!force && this.retryAt !== null && Date.now() < this.retryAt) return
    this.emitting = enabled
    this.deps.setEmit(enabled).then(() => {
      if (this.retryAt === null) return
      this.retryAt = null
      console.log('[Browser] H5 touch pointer: switch works again')
    }, error => {
      // Unknown state: let the next decision resend.
      this.emitting = null
      if (this.retryAt === null) console.warn(`[Browser] H5 touch pointer: failed to turn ${enabled ? 'on' : 'off'}, retrying every ${RETRY_MS}ms`, error)
      this.retryAt = Date.now() + RETRY_MS
      if (!this.timer && !this.retryTimer) {
        this.retryTimer = setTimeout(() => { this.retryTimer = null; this.sync() }, RETRY_MS)
        this.retryTimer.unref?.()
      }
    })
  }
}
