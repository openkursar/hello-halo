/**
 * apps/runtime/im-channels -- WeCom streaming reply session
 *
 * High-level "how to build a WeCom stream reply" logic, decoupled from the
 * WebSocket protocol layer (which now lives in @wecom/aibot-node-sdk).
 *
 * Responsibilities:
 *   - Progress-line accumulation (the `<think>` block content)
 *   - Final answer accumulation (text_delta events)
 *   - Long-task fallback: when the stream is about to hit the WeCom-imposed
 *     10-minute single-stream lifetime, proactively finish the stream and
 *     deliver subsequent updates as discrete proactive pushes.
 *   - Push-mode progress throttling
 *   - UTF-8 cleansing of every content payload (per WeCom protocol
 *     requirement that markdown content "必须是 utf8 编码")
 *   - The one-message byte limit (WECOM_MESSAGE_LIMIT): progress lines give
 *     way first; an answer that outgrows one message closes the stream on its
 *     beginning and goes out whole as `(i/n)` pushes
 *
 * What this module does NOT do (delegated to the SDK):
 *   - WebSocket connection management, heartbeat, reconnect
 *   - Ack waiting / serial reply queue / non-blocking back-pressure
 *   - Authentication and frame framing
 *
 * The session is constructed with a `StreamingTransport` interface that
 * the WecomBotInstance implements on top of the SDK's WSClient. This
 * keeps the session unit-testable without spinning up a real WebSocket.
 */

import type { WsFrameHeaders } from '@wecom/aibot-node-sdk'
import type {
  ProgressEvent,
  StreamingHandle,
} from '../../../../shared/types/inbound-message'
import { ensureUtf8WithReport } from './wecom-content-utf8'
import { messageHead, sendAsMessages, type MessageLimit } from './message-parts'

// ============================================
// Public constants (kept aligned with WeCom protocol limits)
// ============================================

/**
 * Bytes one WeCom message may carry, kept under the official 20480 (UTF-8)
 * that applies alike to a stream frame, a markdown reply and a markdown push.
 */
const WECOM_MESSAGE_MAX_BYTES = 20000

/** One WeCom message's capacity; longer content is sent in parts. */
export const WECOM_MESSAGE_LIMIT: MessageLimit = { maxBytes: WECOM_MESSAGE_MAX_BYTES }

/** 10-min stream lifetime per official docs (server auto-ends after). */
const STREAM_LIFETIME_MS = 10 * 60 * 1000
/** Safety margin before stream cutoff for proactive finish. */
const STREAM_SAFETY_MARGIN_MS = 30 * 1000
/** Throttle interval for progress pushes after stream→push transition. */
const STREAM_PROGRESS_PUSH_INTERVAL_MS = 2 * 60 * 1000
/** Chinese user-facing notice appended when we transition to push mode. */
const STREAM_TRANSITION_NOTICE =
  '\n\n---\n_任务仍在进行中，后续进度会以新消息推送（企微协议限制单条流式消息最长 10 分钟）_'
/**
 * Chinese user-facing notice closing a stream whose answer outgrew one
 * message: the stream shows its beginning, the whole answer follows in parts.
 */
const STREAM_LONG_ANSWER_NOTICE = '\n\n---\n_内容较长，完整回答将以新消息分条发送_'
/** Chinese user-facing marker replacing the truncated head of a push. */
const PUSH_TRUNCATION_HEAD =
  '_(回答过长已截断，仅保留末尾部分)_\n\n'
/** Pushed when the turn is still running but no answer text has streamed yet. */
const PUSH_STATUS_ONLY_TEXT = '_(任务进行中)_'

// ============================================
// Logger contract (mirrors WecomBotInstance's logEvent)
// ============================================

export type StreamLogLevel = 'info' | 'warn' | 'error'
export type StreamLogFields = Record<
  string,
  string | number | boolean | null | undefined
>
export type StreamLogger = (
  level: StreamLogLevel,
  event: string,
  fields: StreamLogFields,
) => void

// ============================================
// StreamingTransport (the only surface the session uses)
// ============================================

/**
 * Subset of the host instance that the session needs to deliver content.
 *
 * The instance wires these to the official SDK's WSClient methods.
 */
export interface StreamingTransport {
  /**
   * Non-blocking stream send. When the previous frame for the same req_id is
   * still pending its ack, the implementation must skip (return 'skipped')
   * instead of queueing — this prevents progress frames from piling up and
   * delaying the most recent state.
   *
   * Maps to `WSClient.replyStreamNonBlocking` for intermediate frames.
   */
  replyStreamNonBlocking(
    frame: WsFrameHeaders,
    streamId: string,
    content: string,
    finish: false,
  ): Promise<'sent' | 'skipped' | 'failed'>

  /**
   * Blocking stream send with ack-waiting and serial-queue semantics. Used
   * exclusively for `finish=true` frames so the final answer is guaranteed
   * to be enqueued and acked before the session is torn down.
   *
   * Maps to `WSClient.replyStream` with finish=true.
   */
  replyStreamFinish(
    frame: WsFrameHeaders,
    streamId: string,
    content: string,
  ): Promise<'sent' | 'failed'>

  /**
   * Queue a markdown push (aibot_send_msg) that survives a brief WS bounce
   * by being held until re-authentication. Returns true if the push was
   * eventually delivered, false otherwise.
   */
  queuePush(
    chatId: string,
    text: string,
    chatType: 'direct' | 'group',
    sourceTag: string,
    trace: string,
  ): Promise<boolean>

  /** Whether the WS link is currently authenticated and ready. */
  isAuthenticated(): boolean
}

// ============================================
// Progress line formatting
// ============================================

const BUILTIN_TOOL_ICONS: Record<string, string> = {
  Read: '📖',
  Edit: '✏️',
  Write: '📝',
  Bash: '⚙️',
  Glob: '🔍',
  Grep: '🔍',
  Agent: '🤖',
  Task: '🤖',
  WebFetch: '🌐',
  WebSearch: '🔎',
  TodoWrite: '📋',
  TodoRead: '📋',
  NotebookEdit: '📓',
  ExitPlanMode: '✅',
}

/** Resolve a display icon for a tool name. Mirrors the previous provider. */
function getToolIcon(toolName: string): string {
  if (BUILTIN_TOOL_ICONS[toolName]) return BUILTIN_TOOL_ICONS[toolName]
  if (toolName.startsWith('mcp__ai-browser__')) return '🌐'
  if (toolName.startsWith('mcp__web-search__')) return '🔎'
  if (toolName.startsWith('mcp__halo-')) return '🔧'
  if (toolName.startsWith('mcp__')) return '🔧'
  return '⚙️'
}

/** Single-line summary of a ProgressEvent for the WeCom `<think>` block. */
function formatProgressLine(event: ProgressEvent): string {
  switch (event.type) {
    case 'tool_call': {
      const icon = getToolIcon(event.tool)
      const label = event.summary || event.tool
      return `${icon} ${label}`
    }
    case 'tool_result': {
      const icon = event.success ? '✅' : '❌'
      return `${icon} ${event.summary || (event.success ? 'Done' : 'Error')}`
    }
    case 'thinking':
      return `💭 ${event.text}`
    case 'status':
      return `ℹ️ ${event.text}`
    default:
      return ''
  }
}

/** Truncate a string for log preview while preserving original length context. */
function previewText(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}...(+${s.length - max}chars)`
}

// ============================================
// WecomStreamSession
// ============================================

/**
 * Construction parameters for a stream session.
 *
 * @field frame    The original inbound WsFrame headers (carries the req_id
 *                 that SDK replyStream/replyStreamNonBlocking propagate).
 * @field streamId Stable ID for the stream message (the same ID is sent on
 *                 every update so WeCom replaces the previous content).
 * @field chatId   Conversation ID (used for push fallback).
 * @field chatType direct | group (used for push fallback).
 * @field trace    Per-conversation correlation ID for log grep'ability.
 * @field transport Wire abstraction (SDK in production, fake in tests).
 * @field logger   Structured log sink (matches WecomBotInstance's format).
 */
export interface WecomStreamSessionInit {
  frame: WsFrameHeaders
  streamId: string
  chatId: string
  chatType: 'direct' | 'group'
  trace: string
  transport: StreamingTransport
  logger: StreamLogger
  /** Called when the session ends so the host can untrack it. */
  onDispose?: () => void
}

/**
 * Manages a single streaming reply session.
 *
 * Starts in `stream` mode (SDK replyStream/replyStreamNonBlocking). Transitions
 * to `push` mode (SDK sendMessage queued through the host) when approaching the
 * server-side 10-minute cutoff or on WS failure. The accumulated content is
 * carried across the boundary so the user sees one continuous narrative.
 */
export class WecomStreamSession implements StreamingHandle {
  private readonly init: WecomStreamSessionInit
  private readonly startedAt: number

  private progressLines: string[] = []
  /**
   * Raw cumulative answer text from `text_delta` events. Sanitization is
   * deferred to output assembly so that surrogate pairs spanning chunk
   * boundaries (e.g. a 4-byte emoji split across two `text_delta` events)
   * are not corrupted by per-chunk encoding round-trips.
   *
   * Once `finish()` runs, this is overwritten with the SDK-authoritative
   * final text (already sanitized) and treated as canonical.
   */
  private answerText = ''
  /**
   * Cumulative count of U+FFFD replacements already reported via
   * `noteUtf8Replaced('answer_text', ...)`. Used to avoid double-counting
   * as `sanitizeAnswerForOutput()` runs on every frame build.
   */
  private answerUtf8ReplacedReported = 0
  private started = false
  private finished = false

  /** Once switched to push, never returns to stream. */
  private mode: 'stream' | 'push' = 'stream'
  /** True when the stream channel is no longer usable (broken / expired). */
  private streamChannelBroken = false

  // Push-mode progress throttle
  private lastProgressPushAt = 0
  /**
   * Character offset into the sanitized answer already covered by an
   * intermediate push. maybePushProgress sends only `answer.slice(offset)` so
   * consecutive pushes never overlap (each used to re-send the full
   * cumulative snapshot, duplicating content in the chat history).
   */
  private lastPushedAnswerLength = 0

  // Lifecycle counters — surfaced in the terminal summary log
  private streamPacketsSent = 0
  private streamPacketsSkipped = 0
  private streamPacketsRejected = 0
  private progressPushesSent = 0
  private finalPushSent = false
  private firstPacketAt = 0
  private brokenReason: string | null = null
  private terminalLogged = false

  /** Cumulative count of additional U+FFFD chars introduced by UTF-8 cleansing. */
  private utf8ReplacedTotal = 0

  constructor(init: WecomStreamSessionInit) {
    this.init = init
    this.startedAt = Date.now()
    this.logger('info', 'stream_open', {
      trace: this.init.trace,
      streamId: this.init.streamId,
      chatId: this.init.chatId,
      chatType: this.init.chatType,
    })
  }

  // ── Convenience accessors ────────────────────────────────────────

  /** Per-conversation correlation ID (used by host for log routing). */
  getTraceId(): string {
    return this.init.trace
  }

  /** Mark the stream as no longer deliverable via replyStream — go push-only. */
  markStreamBroken(reason: string): void {
    if (this.streamChannelBroken) return
    this.streamChannelBroken = true
    this.brokenReason = reason
    this.logger('warn', 'stream_broken', {
      trace: this.init.trace,
      streamId: this.init.streamId,
      reason,
      elapsedMs: Date.now() - this.startedAt,
      streamPacketsSent: this.streamPacketsSent,
    })
  }

  // ── StreamingHandle interface ────────────────────────────────────

  async update(event: ProgressEvent): Promise<void> {
    if (this.finished) return

    if (event.type === 'text_delta') {
      // Accumulate raw. Cross-chunk surrogate pairs (e.g. 4-byte emoji split
      // across two deltas) would be corrupted if sanitized per-chunk; we
      // sanitize once at output assembly time instead — see
      // sanitizeAnswerForOutput().
      this.answerText += event.text
    } else {
      // Progress lines are atomic (formatProgressLine produces a complete
      // single line), so per-line sanitization is safe and gives us
      // immediate diagnostics on the offending event.
      const line = formatProgressLine(event)
      if (line) {
        const { text, replaced } = ensureUtf8WithReport(line)
        this.progressLines.push(text)
        if (replaced > 0) this.noteUtf8Replaced(replaced, 'progress_line')
      }
    }

    if (this.mode === 'stream' && !this.streamChannelBroken) {
      if (this.isApproachingLifetimeCutoff()) {
        // Proactively transition to push mode just before the server-side cutoff.
        await this.transitionToPushMode('approaching 10-minute server cutoff', STREAM_TRANSITION_NOTICE)
      } else {
        const frame = this.buildContent()
        if (frame.complete) {
          await this.sendStreamFrame(false, frame.content)
          return
        }
        // A frame past one message is rejected and leaves the stream stuck
        // mid-answer; close it on what fits instead.
        await this.transitionToPushMode('answer longer than one message', STREAM_LONG_ANSWER_NOTICE)
      }
      // Fall through — push-mode progress logic below
    }

    // Push mode (or stream broken): throttled progress as discrete pushes
    await this.maybePushProgress()
  }

  async finish(finalText: string): Promise<void> {
    if (this.finished) return
    this.finished = true

    // UTF-8 cleanse the authoritative final text once (do not mix with deltas).
    const sanitized = ensureUtf8WithReport(finalText)
    if (sanitized.replaced > 0) this.noteUtf8Replaced(sanitized.replaced, 'final')

    // Detect drift between streamed accumulation and the SDK-authoritative
    // final. The accumulator is raw across chunks (deferred sanitize), so
    // compare against its sanitized form for a fair check.
    const accumulatedSanitized = this.sanitizeAnswerForOutput()
    if (accumulatedSanitized !== sanitized.text) {
      this.logger('warn', 'stream_content_mismatch', {
        trace: this.init.trace,
        streamId: this.init.streamId,
        streamedLen: accumulatedSanitized.length,
        finalLen: sanitized.text.length,
        streamedPreview: previewText(accumulatedSanitized, 200),
        finalPreview: previewText(sanitized.text, 200),
      })
    }
    // Overwrite with authoritative; further sanitize passes will be no-ops.
    this.answerText = sanitized.text

    let deliveredVia: 'stream' | 'push' | 'push_failed' = 'stream'
    if (
      this.mode === 'stream' &&
      !this.streamChannelBroken &&
      !this.isStreamExpired() &&
      this.init.transport.isAuthenticated()
    ) {
      const frame = this.buildContent()
      // An answer longer than one message closes the stream on its beginning.
      const closing = frame.complete ? frame : this.buildContent(STREAM_LONG_ANSWER_NOTICE)
      const result = await this.sendStreamFrame(true, closing.content)
      if (result === 'sent' && frame.complete) {
        deliveredVia = 'stream'
      } else {
        // Server-side rejected, transport-level failure, or more than one
        // message's worth — the whole answer goes out as pushes.
        if (result !== 'sent') this.markStreamBroken(`finish frame failed (result=${result})`)
        const ok = await this.pushFinalAnswer()
        this.finalPushSent = ok
        deliveredVia = ok ? 'push' : 'push_failed'
      }
    } else {
      // Stream channel already gone — push the final answer (survives WS bounce).
      const ok = await this.pushFinalAnswer()
      this.finalPushSent = ok
      deliveredVia = ok ? 'push' : 'push_failed'
    }

    this.init.onDispose?.()
    this.logTerminalSummary(deliveredVia)
  }

  /** Abort without delivering. For teardown only; prefer markStreamBroken() for WS bounces. */
  dispose(): void {
    if (this.finished) return
    this.finished = true
    this.init.onDispose?.()
    this.logTerminalSummary('disposed')
  }

  // ── Internal helpers ─────────────────────────────────────────────

  private logger(
    level: StreamLogLevel,
    event: string,
    fields: StreamLogFields,
  ): void {
    this.init.logger(level, event, fields)
  }

  private noteUtf8Replaced(count: number, source: string): void {
    this.utf8ReplacedTotal += count
    this.logger('warn', 'stream_content_utf8_sanitized', {
      trace: this.init.trace,
      streamId: this.init.streamId,
      replaced: count,
      source,
    })
  }

  private isApproachingLifetimeCutoff(): boolean {
    return (
      Date.now() - this.startedAt >=
      STREAM_LIFETIME_MS - STREAM_SAFETY_MARGIN_MS
    )
  }

  private isStreamExpired(): boolean {
    return Date.now() - this.startedAt >= STREAM_LIFETIME_MS
  }

  private async transitionToPushMode(reason: string, notice: string): Promise<void> {
    if (this.mode === 'push') return
    this.mode = 'push'
    this.logger('info', 'stream_transition_to_push', {
      trace: this.init.trace,
      streamId: this.init.streamId,
      reason,
      elapsedMs: Date.now() - this.startedAt,
      streamPacketsSent: this.streamPacketsSent,
    })
    if (!this.streamChannelBroken) {
      // Best-effort: finish the existing stream with the transition notice so
      // the WeCom UI doesn't dangle on an unfinished stream.
      const result = await this.callFinishFrame(this.buildContent(notice).content)
      if (result === 'sent') {
        // The closed stream carries the answer so far; progress pushes resume
        // a full interval later with what comes next, and finish() delivers
        // the whole answer either way.
        this.lastPushedAnswerLength = this.sanitizeAnswerForOutput().length
        this.lastProgressPushAt = Date.now()
      } else {
        this.markStreamBroken(`transition finish frame result=${result}`)
        // Stream UI dangled — push the transition notice as a discrete
        // message so the user knows updates will continue in push form
        // instead of seeing a stalled stream with no explanation.
        const ok = await this.init.transport.queuePush(
          this.init.chatId,
          notice.trim(),
          this.init.chatType,
          `stream-transition:${this.init.streamId}`,
          this.init.trace,
        )
        this.logger(ok ? 'info' : 'warn', 'stream_transition_notice_pushed', {
          trace: this.init.trace,
          streamId: this.init.streamId,
          ok,
        })
      }
    }
  }

  /**
   * Sanitize the cumulative raw answer text for the current frame. Reports
   * only newly introduced U+FFFD replacements (compared to the last call)
   * so a long stream doesn't spam identical sanitization logs.
   */
  private sanitizeAnswerForOutput(): string {
    if (this.answerText.length === 0) return ''
    const { text, replaced } = ensureUtf8WithReport(this.answerText)
    if (replaced > this.answerUtf8ReplacedReported) {
      const delta = replaced - this.answerUtf8ReplacedReported
      this.answerUtf8ReplacedReported = replaced
      this.noteUtf8Replaced(delta, 'answer_text')
    }
    return text
  }

  /**
   * Build the WeCom-formatted content — `<think>...</think>` + answer text +
   * an optional closing `notice` — within one message: the oldest progress
   * lines give way first, and only an answer too long on its own is cut to
   * its beginning. `complete` says whether the whole answer is in.
   */
  private buildContent(notice = ''): { content: string; complete: boolean } {
    const answer = this.sanitizeAnswerForOutput()
    let think = this.progressLines.length > 0
      ? `<think>\n${this.progressLines.join('\n')}\n</think>\n\n`
      : ''
    let content = think + answer + notice
    let evicted = 0

    while (
      this.progressLines.length > 1 &&
      Buffer.byteLength(content, 'utf8') > WECOM_MESSAGE_MAX_BYTES
    ) {
      this.progressLines.shift()
      evicted++
      think = `<think>\n...\n${this.progressLines.join('\n')}\n</think>\n\n`
      content = think + answer + notice
    }
    if (evicted > 0) {
      this.logger('warn', 'stream_content_truncated', {
        trace: this.init.trace,
        streamId: this.init.streamId,
        evictedLines: evicted,
        finalBytes: Buffer.byteLength(content, 'utf8'),
      })
    }
    if (Buffer.byteLength(content, 'utf8') <= WECOM_MESSAGE_MAX_BYTES) {
      return { content, complete: true }
    }

    if (Buffer.byteLength(think + notice, 'utf8') >= WECOM_MESSAGE_MAX_BYTES) think = ''
    const room = WECOM_MESSAGE_MAX_BYTES - Buffer.byteLength(think + notice, 'utf8')
    return { content: think + messageHead(answer, { maxBytes: room }) + notice, complete: false }
  }

  /** Send a stream frame: non-blocking for progress, blocking for the finish frame. */
  private async sendStreamFrame(
    finish: boolean,
    content: string,
  ): Promise<'sent' | 'skipped' | 'failed'> {
    const bytes = Buffer.byteLength(content, 'utf8')

    if (!this.started) {
      this.started = true
      this.firstPacketAt = Date.now()
      this.logger('info', 'stream_first_packet', {
        trace: this.init.trace,
        streamId: this.init.streamId,
        bytes,
        timeToFirstPacketMs: this.firstPacketAt - this.startedAt,
      })
    }

    let result: 'sent' | 'skipped' | 'failed'
    if (finish) {
      result = await this.callFinishFrame(content)
    } else {
      try {
        result = await this.init.transport.replyStreamNonBlocking(
          this.init.frame,
          this.init.streamId,
          content,
          false,
        )
      } catch (err) {
        result = 'failed'
        this.logger('error', 'stream_packet_send_error', {
          trace: this.init.trace,
          streamId: this.init.streamId,
          cat: 'network',
          err: err instanceof Error ? err.message : String(err),
        })
      }
    }

    if (result === 'sent') {
      this.streamPacketsSent++
      this.logger('info', 'stream_packet_sent', {
        trace: this.init.trace,
        streamId: this.init.streamId,
        seq: this.streamPacketsSent,
        finish,
        bytes,
        elapsedMs: Date.now() - this.startedAt,
        progressLines: this.progressLines.length,
      })
      if (finish) {
        this.logger('info', 'stream_finish_packet', {
          trace: this.init.trace,
          streamId: this.init.streamId,
          bytes,
          contentPreview: previewText(content, 500),
        })
      }
    } else if (result === 'skipped') {
      this.streamPacketsSkipped++
      // Skipped is the SDK back-pressure signal; not an error.
      this.logger('info', 'stream_packet_skipped', {
        trace: this.init.trace,
        streamId: this.init.streamId,
        bytes,
        reason: 'pending_ack',
      })
    } else {
      // 'failed' — either ack timeout or errcode!=0. Mark stream broken so
      // subsequent updates fall through to push mode.
      this.streamPacketsRejected++
      this.logger('warn', 'stream_packet_rejected', {
        trace: this.init.trace,
        streamId: this.init.streamId,
        finish,
        bytes,
      })
      if (!this.streamChannelBroken) {
        this.markStreamBroken(`packet result=failed finish=${finish}`)
      }
    }
    return result
  }

  private async callFinishFrame(
    content: string,
  ): Promise<'sent' | 'failed'> {
    try {
      return await this.init.transport.replyStreamFinish(
        this.init.frame,
        this.init.streamId,
        content,
      )
    } catch (err) {
      this.logger('error', 'stream_finish_send_error', {
        trace: this.init.trace,
        streamId: this.init.streamId,
        cat: 'network',
        err: err instanceof Error ? err.message : String(err),
      })
      return 'failed'
    }
  }

  /**
   * Push throttled increment while in push mode. Only the answer text past
   * `lastPushedAnswerLength` goes out, so each push is pure new content — a
   * lost mid push never affects final completeness (finish() re-delivers the
   * authoritative full text). While no answer text has streamed yet, only the
   * bare in-progress status goes out.
   */
  private async maybePushProgress(): Promise<void> {
    const now = Date.now()
    if (now - this.lastProgressPushAt < STREAM_PROGRESS_PUSH_INTERVAL_MS) return

    const answer = this.sanitizeAnswerForOutput()
    const delta = answer.slice(this.lastPushedAnswerLength)
    if (delta.trim().length === 0 && this.progressLines.length === 0) return

    this.lastProgressPushAt = now
    this.lastPushedAnswerLength = answer.length
    const pushText = delta.trim().length > 0
      ? this.truncatePushText(delta)
      : PUSH_STATUS_ONLY_TEXT
    this.progressPushesSent++

    this.logger('info', 'stream_progress_push', {
      trace: this.init.trace,
      streamId: this.init.streamId,
      seq: this.progressPushesSent,
      bytes: Buffer.byteLength(pushText, 'utf8'),
      elapsedMs: now - this.startedAt,
    })

    await this.init.transport.queuePush(
      this.init.chatId,
      pushText,
      this.init.chatType,
      `stream:${this.init.streamId}`,
      this.init.trace,
    )
  }

  /**
   * Cap a push at the byte budget, keeping the TAIL — in push mode the user
   * has already seen the head in earlier pushes, and the tail is where new
   * content lands. UTF-8 never splits a surrogate pair across byte
   * boundaries, so walking to a char boundary keeps the slice valid.
   */
  private truncatePushText(text: string): string {
    if (Buffer.byteLength(text, 'utf8') <= WECOM_MESSAGE_MAX_BYTES) return text
    const headBudget = WECOM_MESSAGE_MAX_BYTES - Buffer.byteLength(PUSH_TRUNCATION_HEAD, 'utf8')
    const bytes = Buffer.from(text, 'utf8')
    let start = bytes.length - headBudget
    while (start > 0 && (bytes[start] & 0xc0) === 0x80) {
      start++
    }
    return PUSH_TRUNCATION_HEAD + bytes.subarray(start).toString('utf8')
  }

  /**
   * Push the whole final answer: one message when it fits, otherwise ordered
   * `(1/n) … (n/n)` parts within the per-message cap, so the complete answer
   * is delivered instead of being rejected as oversized (#225).
   */
  private async pushFinalAnswer(): Promise<boolean> {
    return sendAsMessages(this.sanitizeAnswerForOutput(), WECOM_MESSAGE_LIMIT, (part) =>
      this.init.transport.queuePush(
        this.init.chatId,
        part,
        this.init.chatType,
        `stream:${this.init.streamId}`,
        this.init.trace,
      ),
    )
  }

  private logTerminalSummary(
    deliveredVia: 'stream' | 'push' | 'push_failed' | 'disposed',
  ): void {
    if (this.terminalLogged) return
    this.terminalLogged = true
    this.logger(
      deliveredVia === 'push_failed' ? 'error' : 'info',
      'stream_close',
      {
        trace: this.init.trace,
        streamId: this.init.streamId,
        mode: this.mode,
        delivered: deliveredVia,
        broken: this.streamChannelBroken,
        brokenReason: this.brokenReason ?? undefined,
        lifetimeMs: Date.now() - this.startedAt,
        timeToFirstPacketMs:
          this.firstPacketAt > 0 ? this.firstPacketAt - this.startedAt : -1,
        streamPacketsSent: this.streamPacketsSent,
        streamPacketsSkipped: this.streamPacketsSkipped,
        streamPacketsRejected: this.streamPacketsRejected,
        progressPushesSent: this.progressPushesSent,
        finalPushSent: this.finalPushSent,
        finalBytes: Buffer.byteLength(this.answerText, 'utf8'),
        progressLineCount: this.progressLines.length,
        utf8Replaced: this.utf8ReplacedTotal,
      },
    )
  }
}

// ============================================
// Exports for tests + host integration
// ============================================

export const STREAM_TIMING_CONSTANTS = {
  STREAM_LIFETIME_MS,
  STREAM_SAFETY_MARGIN_MS,
  STREAM_PROGRESS_PUSH_INTERVAL_MS,
} as const
