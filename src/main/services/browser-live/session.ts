import { createHash } from 'crypto'
import type { NativeImage, WebContents } from 'electron'
import { capturePageFrame, withBrowserFrames } from '../browser-host'
import { BrowserLiveInputState, changesPage, type BrowserLiveViewport } from './input'
import { captureFullPage } from './full-page'
import { readPageMetrics } from './page-script'
import type { BrowserLiveDetailScope, BrowserLiveFrame, BrowserLiveInput, BrowserLiveScroll, BrowserLiveStopped } from '../../../shared/types/browser-live'

/** Wide enough to read a login form, narrow enough to stay cheap over a phone link. */
const STREAM_WIDTH = 1024
const STREAM_QUALITY = 40
/** Floor between captures: responsiveness matters more here than smoothness. */
const FRAME_INTERVAL_MS = 250
/** A page that has sat still this many captures is polled slowly until it moves again. */
const IDLE_AFTER_UNCHANGED = 8
const IDLE_INTERVAL_MS = 1000
/** Right after the viewer acts, the page's reaction is what they are waiting to see. */
const INPUT_INTERVAL_MS = 100
const INPUT_BURST_MS = 1500
/** Frames a viewer may owe before it stops being sent more. */
const MAX_OUTSTANDING_FRAMES = 2
/** A viewer owing frames this long is gone, whatever its socket still claims. */
const ACK_TIMEOUT_MS = 10_000
/** A page that yields nothing to capture for this long is reported instead of spinning forever. */
const BLANK_TIMEOUT_MS = 10_000
const CAPTURE_TIMEOUT_MS = 3000
const MAX_PENDING_INPUTS = 64
const MAX_STILL_BYTES = 2 * 1024 * 1024
const MAX_DETAIL_PIXELS = 3_000_000
const DETAIL_INTERVAL_MS = 1000

/** Delivers one frame; false means the viewer's link is gone. */
export type BrowserLiveFrameSink = (frame: BrowserLiveFrame) => boolean
/** Tells a viewer why it will receive no more frames. */
export type BrowserLiveStopSink = (stopped: BrowserLiveStopped) => void

export interface BrowserLiveViewerLink {
  viewerId: string
  frame: BrowserLiveFrameSink
  stopped: BrowserLiveStopSink
}

interface Viewer extends BrowserLiveViewerLink {
  outstanding: { seq: number; sentAt: number }[]
  lastDigest: string | null
  wantsDetail: Set<BrowserLiveDetailScope>
  input: BrowserLiveInputState
}

export interface BrowserLiveSessionStats {
  viewers: number
  frames: number
  bytes: number
  suppressed: number
}

/**
 * Streams one page to whoever asked to watch it. The frame lease is held for as
 * long as a viewer remains, so the page keeps producing frames while its host
 * window is hidden; the last viewer leaving releases it and restores the
 * page's original background policy.
 */
export class BrowserLiveSession {
  private readonly viewers = new Map<string, Viewer>()
  private seq = 0
  private lastDigest: string | null = null
  private running = false
  private stopping = false
  private wake: (() => void) | null = null
  private blankSince: number | null = null
  private frames = 0
  private bytes = 0
  private suppressed = 0
  private unchangedStreak = 0
  private burstUntil = 0
  /** The page's size in DIP as last measured, which input positions scale against. */
  private viewport: BrowserLiveViewport | null = null
  private inputChain: Promise<void> = Promise.resolve()
  private pendingInputs = 0
  private lastCaptureAt = -Infinity
  private lastDetailAt = -Infinity

  constructor(
    readonly viewId: string,
    private readonly contents: WebContents,
    private readonly onEmpty: (viewId: string) => void
  ) {}

  get viewerCount(): number {
    return this.viewers.size
  }

  stats(): BrowserLiveSessionStats {
    return { viewers: this.viewers.size, frames: this.frames, bytes: this.bytes, suppressed: this.suppressed }
  }

  addViewer(link: BrowserLiveViewerLink): void {
    if (this.viewers.has(link.viewerId)) return
    this.viewers.set(link.viewerId, {
      ...link, outstanding: [], lastDigest: null, wantsDetail: new Set(), input: new BrowserLiveInputState(this.contents),
    })
    this.unchangedStreak = 0
    this.start()
    this.wake?.()
  }

  removeViewer(viewerId: string, reason?: BrowserLiveStopped['reason']): void {
    const viewer = this.viewers.get(viewerId)
    if (!viewer) return
    this.viewers.delete(viewerId)
    this.enqueueInput(() => viewer.input.release())
    if (reason) {
      try {
        viewer.stopped({ viewId: this.viewId, reason })
      } catch { /* the link is already gone */ }
    }
    this.wake?.()
  }

  ack(viewerId: string, seq: number): void {
    const viewer = this.viewers.get(viewerId)
    if (!viewer) return
    const index = viewer.outstanding.findIndex(frame => frame.seq === seq)
    if (index >= 0) viewer.outstanding.splice(0, index + 1)
  }

  /** Queue one still for this viewer outside the stream, delivered before its next frame. */
  requestDetail(viewerId: string, scope: BrowserLiveDetailScope = 'screen'): void {
    const viewer = this.viewers.get(viewerId)
    if (!viewer) return
    viewer.wantsDetail.add(scope)
    this.wake?.()
  }

  /**
   * Operate the page on a viewer's behalf. Inputs run strictly in arrival order;
   * false means there is no such viewer or no frame yet to aim at.
   */
  input(viewerId: string, input: BrowserLiveInput, onDispatch?: () => void): boolean {
    const viewer = this.viewers.get(viewerId)
    const viewport = this.viewport
    if (!viewer || !viewport || viewer.lastDigest === null) return false
    if (this.pendingInputs >= MAX_PENDING_INPUTS) {
      if (input.kind !== 'mouse' || input.action !== 'move') {
        console.warn(`[BrowserLive] Input queue full for page ${this.viewId}; ending the viewer's input`)
        this.removeViewer(viewerId, 'stalled')
      }
      return false
    }
    this.pendingInputs++
    this.enqueueInput(async () => {
      try {
        if (this.viewers.get(viewerId) !== viewer || this.contents.isDestroyed()) return
        if (changesPage(input)) {
          onDispatch?.()
          this.burstUntil = Date.now() + INPUT_BURST_MS
          this.unchangedStreak = 0
          this.wake?.()
        }
        await viewer.input.dispatch(input, viewport)
      } finally {
        this.pendingInputs--
      }
    })
    return true
  }

  /** The page is gone or the service is shutting down: tell every viewer, then end the loop. */
  stop(reason: BrowserLiveStopped['reason']): void {
    this.stopping = true
    for (const viewerId of Array.from(this.viewers.keys())) this.removeViewer(viewerId, reason)
    this.wake?.()
  }

  private start(): void {
    if (this.running || this.stopping) return
    this.running = true
    void this.run()
  }

  private async run(): Promise<void> {
    this.blankSince = null
    try {
      await withBrowserFrames(this.contents, () => this.loop())
    } catch (error) {
      const reason = this.contents.isDestroyed() ? 'gone' : 'unavailable'
      if (!this.stopping) {
        console.warn(`[BrowserLive] Stream ended for ${this.viewId}: ${reason}`, error)
        this.stop(reason)
      }
    } finally {
      this.running = false
      // A viewer that arrived while the lease was being released must not be
      // left with a session nobody drives.
      if (!this.stopping && this.viewers.size > 0) this.start()
      else this.onEmpty(this.viewId)
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopping && this.viewers.size > 0 && !this.contents.isDestroyed()) {
      await this.serveDetail()
      if (this.stopping || this.viewers.size === 0) break
      await this.serveStream()
      const idle = this.lastCaptureAt + this.interval() - Date.now()
      await this.sleep(idle > 0 ? idle : INPUT_INTERVAL_MS)
    }
  }

  private async serveDetail(): Promise<void> {
    if (Date.now() - this.lastDetailAt < DETAIL_INTERVAL_MS) return
    const viewer = [...this.viewers.values()].find(candidate => candidate.wantsDetail.size > 0 &&
      candidate.outstanding.length < MAX_OUTSTANDING_FRAMES)
    if (!viewer) return
    const scope = viewer.wantsDetail.values().next().value
    viewer.wantsDetail.clear()
    this.lastDetailAt = Date.now()
    const frame = scope === 'page' ? await this.wholePage() : await this.screenStill()
    if (this.viewers.get(viewer.viewerId) !== viewer) return
    if (frame) this.send(viewer, frame, { counted: false })
    else this.removeViewer(viewer.viewerId, 'unavailable')
  }

  private async screenStill(): Promise<BrowserLiveFrame | null> {
    const captured = await this.capture()
    if (!captured) return null
    const { width, height } = captured.getSize()
    const scale = Math.min(1, Math.sqrt(MAX_DETAIL_PIXELS / (width * height)))
    const image = scale < 1 ? captured.resize({ width: Math.max(1, Math.floor(width * scale)) }) : captured
    const size = image.getSize()
    const png = image.toPNG()
    const encoded = png.length <= MAX_STILL_BYTES ? png : image.toJPEG(85)
    if (encoded.length > MAX_STILL_BYTES) return null
    return {
      viewId: this.viewId,
      seq: this.seq,
      image: `data:image/${encoded === png ? 'png' : 'jpeg'};base64,${encoded.toString('base64')}`,
      width: size.width,
      height: size.height,
      detail: true,
    }
  }

  /**
   * The document from its top. When that cannot be had, the screen alone, still
   * placed within the page, so the viewer is answered rather than left waiting.
   */
  private async wholePage(): Promise<BrowserLiveFrame | null> {
    try {
      const page = await captureFullPage(this.contents, () => this.capture())
      return {
        viewId: this.viewId, seq: this.seq, image: page.image, width: page.width, height: page.height,
        detail: true, page: { top: 0, height: page.covered, total: page.total },
      }
    } catch (error) {
      console.warn(`[BrowserLive] Whole-page capture of ${this.viewId} failed; sending the screen instead:`, error)
    }
    const image = await this.capture()
    if (!image) return null
    const scaled = this.scale(image)
    const scroll = await this.measure(image)
    const size = scaled.getSize()
    return {
      viewId: this.viewId,
      seq: this.seq,
      image: `data:image/jpeg;base64,${scaled.toJPEG(STREAM_QUALITY).toString('base64')}`,
      width: size.width,
      height: size.height,
      detail: true,
      page: scroll ? { top: scroll.top, height: scroll.viewport, total: scroll.total } : { top: 0, height: 0, total: 0 },
    }
  }

  private async serveStream(): Promise<void> {
    this.dropStalledViewers()
    if (Date.now() - this.lastCaptureAt < this.interval()) return
    this.lastCaptureAt = Date.now()
    if (![...this.viewers.values()].some(viewer => viewer.outstanding.length < MAX_OUTSTANDING_FRAMES)) return
    const image = await this.capture()
    if (!image || this.stopping || !this.viewers.size) return
    const scaled = this.scale(image)
    const jpeg = scaled.toJPEG(STREAM_QUALITY)
    const url = this.contents.getURL()
    const digest = createHash('sha1').update(jpeg).update(url).digest('base64')
    this.unchangedStreak = digest === this.lastDigest ? this.unchangedStreak + 1 : 0
    this.lastDigest = digest
    const waiting = [...this.viewers.values()].filter(viewer =>
      viewer.outstanding.length < MAX_OUTSTANDING_FRAMES && viewer.lastDigest !== digest)
    if (waiting.length === 0) {
      this.suppressed++
      return
    }
    const scroll = await this.measure(image)
    const size = scaled.getSize()
    const frame: BrowserLiveFrame = {
      viewId: this.viewId,
      seq: ++this.seq,
      image: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
      width: size.width,
      height: size.height,
      url,
      ...(scroll ? { scroll } : {}),
    }
    this.frames++
    this.bytes += jpeg.length
    for (const viewer of waiting) {
      if (this.viewers.get(viewer.viewerId) !== viewer) continue
      viewer.lastDigest = digest
      this.send(viewer, frame)
    }
  }

  private async capture(): Promise<NativeImage | null> {
    let timer: NodeJS.Timeout | undefined
    const image = await Promise.race([
      capturePageFrame(this.contents),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Browser frame capture timed out')), CAPTURE_TIMEOUT_MS)
      }),
    ]).finally(() => clearTimeout(timer))
    if (image) {
      this.blankSince = null
      return image
    }
    const now = Date.now()
    this.blankSince ??= now
    if (now - this.blankSince > BLANK_TIMEOUT_MS) {
      throw new Error(`Page produced no capturable frame for ${BLANK_TIMEOUT_MS} ms`)
    }
    return null
  }

  private send(viewer: Viewer, frame: BrowserLiveFrame, options: { counted?: boolean } = {}): void {
    if (options.counted !== false) viewer.outstanding.push({ seq: frame.seq, sentAt: Date.now() })
    let delivered = false
    try {
      delivered = viewer.frame(frame)
    } catch { /* treated as a dead link below */ }
    if (!delivered) this.removeViewer(viewer.viewerId)
  }

  private dropStalledViewers(): void {
    const now = Date.now()
    for (const viewer of Array.from(this.viewers.values())) {
      const oldest = viewer.outstanding[0]
      if (oldest && now - oldest.sentAt > ACK_TIMEOUT_MS) {
        console.warn(`[BrowserLive] Dropping stalled viewer ${viewer.viewerId} of ${this.viewId}: ${viewer.outstanding.length} unacknowledged frame(s)`)
        this.removeViewer(viewer.viewerId, 'stalled')
      }
    }
  }

  private interval(): number {
    if (Date.now() < this.burstUntil) return INPUT_INTERVAL_MS
    return this.unchangedStreak >= IDLE_AFTER_UNCHANGED ? IDLE_INTERVAL_MS : FRAME_INTERVAL_MS
  }

  /** Where the frame sits in its document, refreshing the size input is aimed against. */
  private async measure(image: NativeImage): Promise<BrowserLiveScroll | undefined> {
    // A page frozen by a modal dialog never answers; the frame goes out without a position.
    const metrics = await readPageMetrics(this.contents)
    if (metrics) {
      const zoom = this.contents.getZoomFactor()
      this.viewport = { width: metrics.width * zoom, height: metrics.height * zoom }
      return { top: Math.round(metrics.top), viewport: Math.round(metrics.height), total: Math.round(metrics.total) }
    }
    this.viewport ??= image.getSize()
    return undefined
  }

  private enqueueInput(task: () => Promise<void>): void {
    this.inputChain = this.inputChain.then(task).catch(error => {
      console.warn(`[BrowserLive] Input to ${this.viewId} failed:`, error)
    })
  }

  private scale(image: NativeImage): NativeImage {
    return image.getSize().width > STREAM_WIDTH ? image.resize({ width: STREAM_WIDTH }) : image
  }

  /** Waiting is interruptible so an ack, a new viewer or a stop is acted on at once. */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>(resolve => {
      let timer: NodeJS.Timeout | undefined
      const finish = (): void => {
        clearTimeout(timer)
        if (this.wake === finish) this.wake = null
        resolve()
      }
      timer = setTimeout(finish, ms)
      this.wake = finish
    })
  }
}
