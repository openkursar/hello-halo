/**
 * apps/runtime/im-channels -- Feishu Stream Session
 *
 * Bridges Halo's push-style `StreamingHandle` (update / finish / dispose, fed
 * by the agent's ProgressEvent flow) onto Feishu's pull-style streaming card
 * API, where the SDK drives a producer callback until it resolves.
 *
 * Shape of the impedance mismatch:
 *   - Halo calls us whenever something happened.
 *   - The Feishu SDK wants `stream(chatId, { markdown: producer })`, holds the
 *     card open for as long as `producer` has not resolved, and hands the
 *     producer a controller to write the current full content.
 *
 * So the session opens the stream lazily on the first update, parks the
 * producer on a deferred, writes the rendered content on every change, and
 * resolves the deferred from finish()/dispose(). Nothing else in the provider
 * needs to know the SDK's control flow.
 *
 * This file owns:
 *   - progress-line accumulation (bounded) and final-answer accumulation
 *   - coalescing writes so a fast token stream cannot queue unbounded patches
 *   - the guarantee that a final answer is delivered even when the card breaks
 *     (card size limits, revoked permission, dropped connection)
 *
 * It does NOT own connection state, credentials, or the Feishu API surface —
 * those reach it only through the injected FeishuStreamTransport.
 *
 * Unlike WeCom there is no single-stream lifetime cutoff to design around: a
 * Feishu card stays editable, and the SDK splits content across follow-up cards
 * when an element approaches Feishu's per-element size limit. The session
 * therefore has no timed "switch to discrete pushes" mode.
 */

import type { ProgressEvent, StreamingHandle } from '../../../../shared/types/inbound-message'

// ============================================
// Logging contract (provider supplies the sink)
// ============================================

export type StreamLogLevel = 'info' | 'warn' | 'error'
export type StreamLogFields = Record<string, string | number | boolean | null | undefined>
export type StreamLogger = (
  level: StreamLogLevel,
  event: string,
  fields?: StreamLogFields,
) => void

// ============================================
// Transport contract
// ============================================

/** Write surface handed to us by the SDK for the duration of one card. */
export interface FeishuStreamController {
  /** Replace the card's markdown content with `full`. */
  setContent(full: string): Promise<void>
}

/**
 * The only outbound surface this session touches.
 *
 * `openStream` must resolve when the streaming card is finalized — i.e. after
 * the producer it is given has resolved — and reject if the card could not be
 * created or updated. `sendPlain` is the non-streaming fallback and must report
 * honest delivery.
 */
export interface FeishuStreamTransport {
  openStream(
    producer: (controller: FeishuStreamController) => Promise<void>,
  ): Promise<void>
  sendPlain(text: string): Promise<boolean>
}

export interface FeishuStreamSessionInit {
  chatId: string
  /** Correlation id shared with the inbound message's log lines. */
  trace: string
  transport: FeishuStreamTransport
  logger: StreamLogger
  /** Called once when the session releases its resources. */
  onDispose?: () => void
}

// ============================================
// Rendering constants
// ============================================

/**
 * How many progress lines stay visible. The card is a live status surface, not
 * a log: older steps scroll out so the newest state is always at a predictable
 * place, and the rendered payload stays small enough that every patch is cheap.
 */
const MAX_PROGRESS_LINES = 6
/** Per-line cap so a pathological tool summary cannot dominate the card. */
const MAX_PROGRESS_LINE_CHARS = 180

// ============================================
// Session
// ============================================

export class FeishuStreamSession implements StreamingHandle {
  private readonly chatId: string
  private readonly trace: string
  private readonly transport: FeishuStreamTransport
  private readonly log: StreamLogger
  /** Cleared once invoked: teardown can be reached more than once. */
  private disposeCallback: (() => void) | undefined

  /** Visible progress lines, newest last. */
  private progress: string[] = []
  /** Accumulated answer text from text_delta events (raw, joined on render). */
  private answer = ''
  /** Controller handed over by the SDK once the card exists. */
  private controller: FeishuStreamController | null = null
  /** Resolver that lets the SDK's producer return, closing the card. */
  private releaseProducer: (() => void) | null = null
  /** The in-flight openStream() promise, awaited by finish(). */
  private streamPromise: Promise<void> | null = null
  /** True once the card is unusable; every later delivery goes via sendPlain. */
  private broken = false
  /** True after finish()/dispose(); guards against late updates. */
  private closed = false
  /** Latch so a post-close progress tail is reported once, not per event. */
  private lateUpdateLogged = false

  /** Write coalescing: at most one in-flight write plus one pending render. */
  private writing: Promise<void> = Promise.resolve()
  private dirty = false

  constructor(init: FeishuStreamSessionInit) {
    this.chatId = init.chatId
    this.trace = init.trace
    this.transport = init.transport
    this.log = init.logger
    this.disposeCallback = init.onDispose
  }

  // ── StreamingHandle ──────────────────────────────────────────────

  /**
   * Record one progress event and refresh the card.
   *
   * Progress is best-effort by contract: a failure here degrades the live view
   * but must never fail the turn, so the card is marked broken and finish()
   * takes over delivery.
   */
  async update(event: ProgressEvent): Promise<void> {
    if (this.closed) {
      // Progress arriving after the answer was delivered means a turn kept
      // working past its own reply — worth knowing once, but only once: the
      // tail of a token stream would otherwise fill the log with copies.
      if (!this.lateUpdateLogged) {
        this.lateUpdateLogged = true
        this.log('warn', 'stream_update_after_close', {
          trace: this.trace,
          chatId: this.chatId,
          eventType: event.type,
          cat: 'internal',
        })
      }
      return
    }

    if (event.type === 'text_delta') {
      // Accumulate raw: a multi-byte character split across two deltas would be
      // corrupted by per-chunk normalization, so shaping happens at render time.
      this.answer += event.text
    } else {
      const line = formatProgressLine(event)
      if (line) this.pushProgress(line)
    }

    if (this.broken) return
    await this.ensureStream()
    if (this.broken) return
    this.scheduleWrite()
  }

  /**
   * Deliver the final answer and close the card.
   *
   * Delivery is mandatory: if the card cannot carry the text (never opened,
   * broken mid-flight, or the closing write fails) the session falls back to a
   * plain message, and throws only when that fallback also fails.
   */
  async finish(finalText: string): Promise<void> {
    if (this.closed) {
      this.log('warn', 'stream_finish_after_close', { trace: this.trace, chatId: this.chatId })
      return
    }
    this.closed = true
    this.answer = finalText
    this.progress = []

    if (this.controller && !this.broken) {
      try {
        await this.writeNow(this.renderFinal())
        this.release()
        await this.streamPromise
        this.log('info', 'stream_finish_sent', {
          trace: this.trace,
          chatId: this.chatId,
          bytes: Buffer.byteLength(finalText, 'utf8'),
        })
        this.settle()
        return
      } catch (err) {
        this.broken = true
        this.log('warn', 'stream_finish_failed', {
          trace: this.trace,
          chatId: this.chatId,
          cat: 'protocol',
          err: describeError(err),
        })
      }
    }

    // No usable card: release whatever the SDK still holds, then fall back.
    this.release()
    if (this.streamPromise) {
      // Swallow: the card already failed, and its rejection is reported above.
      await this.streamPromise.catch(() => undefined)
    }

    this.log('info', 'stream_finish_fallback_begin', {
      trace: this.trace,
      chatId: this.chatId,
      bytes: Buffer.byteLength(finalText, 'utf8'),
    })
    const sent = await this.transport.sendPlain(finalText)
    this.settle()
    if (!sent) {
      throw new Error(
        `Feishu stream finish fallback failed for chat ${this.chatId} (trace=${this.trace})`,
      )
    }
    this.log('info', 'stream_finish_fallback_sent', { trace: this.trace, chatId: this.chatId })
  }

  /** Abandon the card without sending. Safe to call multiple times. */
  dispose(): void {
    if (this.closed && !this.controller) {
      this.settle()
      return
    }
    this.closed = true
    this.release()
    this.settle()
  }

  // ── Provider-facing controls ─────────────────────────────────────

  /**
   * Mark the card unusable (e.g. the long connection dropped). finish() will
   * then deliver through the plain-message fallback instead of patching a card
   * the platform may no longer accept writes for.
   */
  markStreamBroken(reason: string): void {
    if (this.broken) return
    this.broken = true
    this.log('warn', 'stream_broken', { trace: this.trace, chatId: this.chatId, reason })
    // Let the SDK's producer return so its card is finalized rather than left
    // hanging on a deferred nobody will resolve.
    this.release()
  }

  // ── Internals ────────────────────────────────────────────────────

  /**
   * Open the streaming card on first use.
   *
   * The producer parks on a deferred that finish()/dispose()/markStreamBroken()
   * resolve; until then the SDK keeps the card open and lets us patch it.
   */
  private async ensureStream(): Promise<void> {
    if (this.controller || this.streamPromise) return

    const ready = deferred<void>()
    const parked = deferred<void>()
    this.releaseProducer = parked.resolve

    this.streamPromise = this.transport
      .openStream(async (controller) => {
        this.controller = controller
        ready.resolve()
        await parked.promise
      })
      .catch((err) => {
        // Either the card never opened or a later patch failed fatally. Both
        // mean the same thing to us: stop patching, keep the answer deliverable.
        this.broken = true
        this.controller = null
        this.log('warn', 'stream_open_failed', {
          trace: this.trace,
          chatId: this.chatId,
          cat: 'protocol',
          err: describeError(err),
        })
        ready.resolve()
      })

    await ready.promise
    if (this.controller) {
      this.log('info', 'stream_open', { trace: this.trace, chatId: this.chatId })
    }
  }

  /**
   * Queue a write of the current content.
   *
   * Writes are coalesced: while one patch is in flight, further updates only
   * set `dirty`, so a fast token stream produces one follow-up patch carrying
   * the newest state rather than a backlog of stale ones.
   */
  private scheduleWrite(): void {
    this.dirty = true
    this.writing = this.writing.then(async () => {
      if (!this.dirty || this.broken || !this.controller) return
      this.dirty = false
      try {
        await this.controller.setContent(this.renderLive())
      } catch (err) {
        this.broken = true
        this.log('warn', 'stream_write_failed', {
          trace: this.trace,
          chatId: this.chatId,
          cat: 'protocol',
          err: describeError(err),
        })
      }
    })
  }

  /** Write immediately, awaiting any in-flight patch first. */
  private async writeNow(content: string): Promise<void> {
    this.dirty = false
    const pending = this.writing
    this.writing = pending.then(async () => {
      if (!this.controller) return
      await this.controller.setContent(content)
    })
    await this.writing
  }

  private pushProgress(line: string): void {
    const trimmed = line.length > MAX_PROGRESS_LINE_CHARS
      ? line.slice(0, MAX_PROGRESS_LINE_CHARS) + '…'
      : line
    // Consecutive duplicates are noise: repeated identical tool summaries are
    // common and would push useful context out of the visible window.
    if (this.progress[this.progress.length - 1] === trimmed) return
    this.progress.push(trimmed)
    if (this.progress.length > MAX_PROGRESS_LINES) {
      this.progress.splice(0, this.progress.length - MAX_PROGRESS_LINES)
    }
  }

  /** Content while the turn is running: progress above, partial answer below. */
  private renderLive(): string {
    const parts: string[] = []
    if (this.progress.length > 0) {
      parts.push(this.progress.map((l) => `*${escapeMarkdownInline(l)}*`).join('\n'))
    }
    const answer = this.answer.trim()
    if (answer) parts.push(answer)
    return parts.join('\n\n') || '…'
  }

  /** Content once the answer is final: no progress, just the reply. */
  private renderFinal(): string {
    const answer = this.answer.trim()
    return answer || '…'
  }

  private release(): void {
    if (this.releaseProducer) {
      this.releaseProducer()
      this.releaseProducer = null
    }
  }

  private settle(): void {
    this.controller = null
    const cb = this.disposeCallback
    if (!cb) return
    // Cleared first: the callback removes us from the provider's active set, and
    // a second settle() must not call it again.
    this.disposeCallback = undefined
    try {
      cb()
    } catch (err) {
      // Teardown continues regardless, but a failure here means the provider
      // still holds this session in its active set — a slow leak that is
      // invisible except through this line and the activeStreams count in the
      // provider's health snapshot.
      this.log('warn', 'stream_dispose_callback_failed', {
        trace: this.trace,
        chatId: this.chatId,
        cat: 'internal',
        err: describeError(err),
      })
    }
  }
}

// ============================================
// Helpers
// ============================================

/** Render one non-text progress event as a single status line. */
function formatProgressLine(event: ProgressEvent): string | null {
  switch (event.type) {
    case 'thinking':
      return event.text.trim() ? `🤔 ${collapseWhitespace(event.text)}` : null
    case 'tool_call':
      return `🔧 ${event.tool}${event.summary ? `: ${collapseWhitespace(event.summary)}` : ''}`
    case 'tool_result':
      return `${event.success ? '✅' : '⚠️'} ${event.tool}${event.summary ? `: ${collapseWhitespace(event.summary)}` : ''}`
    case 'status':
      return event.text.trim() ? collapseWhitespace(event.text) : null
    default:
      return null
  }
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Neutralize the inline markers that would otherwise break out of the italic
 * wrapper used for progress lines. Only `*` and `_` can do that; everything
 * else renders harmlessly.
 */
function escapeMarkdownInline(text: string): string {
  return text.replace(/([*_])/g, '\\$1')
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

/** Exported for tests and for the provider's log-field documentation. */
export const FEISHU_STREAM_CONSTANTS = {
  MAX_PROGRESS_LINES,
  MAX_PROGRESS_LINE_CHARS,
}
