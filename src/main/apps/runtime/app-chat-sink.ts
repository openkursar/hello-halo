/**
 * apps/runtime -- App Chat Turn Sink
 *
 * The {@link TurnSink} for digital-human chat: turns are persisted to the
 * session JSONL and, when the turn answers a user message, handed back to the
 * caller that sent it (native UI, IM channel, HTTP API).
 *
 * ## Why a round queue
 *
 * The session consumer reads the CC REPL continuously, so a session produces
 * two kinds of turn:
 *
 *   - **solicited** — the answer to a message somebody sent and is awaiting;
 *   - **autonomous** — output CC produces on its own (a background task
 *     finishing, a team agent reporting), with nobody waiting.
 *
 * The SDK stream carries no correlation between a `send()` and the turn it
 * causes, so ownership is decided by order: a round enqueued before a turn
 * starts is claimed by that turn; a turn that starts with an empty queue is
 * autonomous. Enqueueing happens immediately before `send()`, and a round
 * enqueued while a turn is already running cannot be claimed by it (the claim
 * happens once, at turn start), so the queue mirrors CC's own FIFO processing.
 *
 * Autonomous turns are not dropped: they are persisted like any other turn and,
 * for IM sessions, pushed to the originating chat — the user asked for the work,
 * so its completion belongs in the conversation.
 */

import type { StreamResult } from '../../services/agent/stream-processor'
import type { TurnSink } from '../../services/agent/turn-sink'
import type { ImageAttachment } from '../../services/agent/types'
import type { ProgressEvent } from '../../../shared/types/inbound-message'
import { parseAppChatKey } from '../../../shared/apps/im-keys'
import { classifySessionSource, LOCAL_SESSION_CHANNEL } from '../../../shared/types/im-channel'
import { getImSessionRegistry } from './im-session-registry'
import { getActiveImChannelManager } from './im-channels'
import { ReplyTextAccumulator } from './reply-accumulator'
import { ProgressEventParser } from './progress-formatter'
import { openSessionWriter, saveChatSessionId, type SessionWriter } from './session-store'

// ============================================
// Types
// ============================================

/** Per-round callbacks supplied by whoever sent the message. */
export interface AppChatRoundHooks {
  onProgress?(event: ProgressEvent): void
  onReply?(finalContent: string): void
  onMessageAccepted?(): void
}

/** Handle for one awaited round, returned by {@link AppChatSink.beginRound}. */
export interface AppChatRoundHandle {
  /** Settles when the claimed turn finishes; rejects when it fails. */
  readonly done: Promise<void>
  /**
   * Drop the round without waiting — used when the send itself fails, so the
   * next turn is not mis-attributed to a message CC never received.
   */
  cancel(): void
}

interface Round {
  hooks: AppChatRoundHooks
  resolve: () => void
  reject: (err: Error) => void
  settled: boolean
}

/** State rebuilt for every turn, solicited or not. */
interface TurnState {
  accumulator: ReplyTextAccumulator
  progressParser: ProgressEventParser
  accepted: boolean
}

function newTurnState(): TurnState {
  return {
    accumulator: new ReplyTextAccumulator(),
    progressParser: new ProgressEventParser(),
    accepted: false,
  }
}

// ============================================
// Sink
// ============================================

class AppChatSink implements TurnSink {
  private readonly queue: Round[] = []
  private current: Round | null = null
  private turn: TurnState = newTurnState()
  private writer: SessionWriter | undefined
  private writerOpened = false

  constructor(
    private readonly appId: string,
    private readonly conversationId: string,
    private readonly runId: string,
    private readonly spacePath: string
  ) {}

  // ── Round lifecycle (caller side) ──────────────────────

  beginRound(hooks: AppChatRoundHooks): AppChatRoundHandle {
    let resolve!: () => void
    let reject!: (err: Error) => void
    const done = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })

    const round: Round = { hooks, resolve, reject, settled: false }
    this.queue.push(round)

    return {
      done,
      cancel: () => {
        if (round.settled) return
        round.settled = true
        const queued = this.queue.indexOf(round)
        if (queued !== -1) this.queue.splice(queued, 1)
        if (this.current === round) this.current = null
        resolve()
      },
    }
  }

  /** Whether a message is awaiting its answer, or its turn is running. */
  hasActiveRound(): boolean {
    return this.current !== null || this.queue.length > 0
  }

  /** Persist a user message to the transcript ahead of the turn it triggers. */
  writeUserMessage(text: string, images?: ImageAttachment[]): void {
    this.getWriter()?.writeTrigger(text, images)
  }

  // ── TurnSink ───────────────────────────────────────────

  onTurnStart(): void {
    this.turn = newTurnState()
    this.current = this.queue.shift() ?? null
  }

  onRawMessage(sdkMessage: unknown): void {
    const message = sdkMessage as { type?: string }

    // The first message of the turn is the earliest proof the engine took our
    // input: before it, nothing entered the engine's history.
    if (this.current && !this.turn.accepted) {
      this.turn.accepted = true
      try {
        this.current.hooks.onMessageAccepted?.()
      } catch (err) {
        console.error(`[AppChat][${this.appId}] onMessageAccepted callback error:`, err)
      }
    }

    // Persist SDK messages to JSONL for "View process" / reload recovery.
    //
    // We skip `stream_event` for both engines: token-level deltas are too
    // granular for JSONL (hundreds per response) and the engine adapters are
    // required to ALSO emit aggregate top-level `assistant`/`user` envelopes
    // (see services/agent/codex/event-normalizer.ts → aggregateBlock). The
    // aggregates are what session-store.convertEventsToMessages reconstructs
    // the chat history from. Engine-specific persistence gates here are a
    // protocol-conformance smell; if a future engine needs them, fix the engine
    // adapter, not this consumer.
    if (message?.type !== 'stream_event') {
      this.getWriter()?.writeEvent(message as Record<string, unknown>)
    }

    // Accumulate assistant text for the reply. SDK assistant messages carry
    // complete text blocks in order, so the accumulator can track the last
    // contiguous run across a multi-step (text/tool_use) flow.
    this.turn.accumulator.feed(sdkMessage)

    const onProgress = this.current?.hooks.onProgress
    if (onProgress) {
      const progressEvent = this.turn.progressParser.feed(sdkMessage)
      if (progressEvent) {
        try {
          onProgress(progressEvent)
        } catch (err) {
          console.error(`[AppChat][${this.appId}] onProgress callback error:`, err)
        }
      }
    }
  }

  onTurnComplete(result: StreamResult): void {
    this.persistSessionId(result)

    // Read the reply from the raw SDK messages rather than processStream's
    // lastTextContent, which is subject to the dual-path pollution documented
    // in stream-processor.ts.
    const accumulated = this.turn.accumulator.getReply()
    const replyContent = accumulated || result.finalContent

    const round = this.takeCurrentRound()
    console.log(
      `[AppChat][${this.appId}] Turn complete (${round ? 'solicited' : 'autonomous'}): ` +
      `content=${replyContent.length} chars` +
      `${accumulated ? ' (from SDK message)' : ' (from streamResult)'}, ` +
      `thoughts=${result.thoughts.length}, tokens=${result.tokenUsage ? 'yes' : 'no'}`
    )

    if (!round) {
      this.deliverAutonomous(replyContent)
      return
    }

    // Fire onReply whenever content exists — including the whitespace-only
    // empty-response placeholder — because the bridge's onReply is what
    // terminates a streaming IM session. Whether the placeholder is shown or
    // replaced with a notice is the bridge's decision, not ours.
    if (replyContent) {
      try {
        round.hooks.onReply?.(replyContent)
      } catch (err) {
        console.error(`[AppChat][${this.appId}] onReply callback error:`, err)
      }
      round.resolve()
      return
    }

    // No content and the turn did not end cleanly: surface it as a failed round
    // so the caller can close out its transport. A user-initiated stop is not a
    // failure — the caller already tore its transport down.
    if (!result.wasAborted && (result.hasErrorThought || result.isInterrupted)) {
      round.reject(new Error(result.errorThought?.content || 'The model response was interrupted.'))
      return
    }

    round.resolve()
  }

  onTurnError(error: Error): void {
    const round = this.takeCurrentRound()
    round?.reject(error)
  }

  onConsumerStopped(): void {
    const pending = this.takeCurrentRound()
    pending?.reject(new Error('Chat session ended before the reply completed.'))
    while (this.queue.length > 0) {
      const round = this.queue.shift()!
      if (round.settled) continue
      round.settled = true
      round.reject(new Error('Chat session ended before the message was processed.'))
    }
  }

  // ── Internals ──────────────────────────────────────────

  private takeCurrentRound(): Round | null {
    const round = this.current
    this.current = null
    if (!round || round.settled) return null
    round.settled = true
    return round
  }

  private getWriter(): SessionWriter | undefined {
    if (!this.writerOpened) {
      this.writerOpened = true
      this.writer = this.spacePath
        ? openSessionWriter(this.spacePath, this.appId, this.runId)
        : undefined
    }
    return this.writer
  }

  private persistSessionId(result: StreamResult): void {
    if (!result.capturedSessionId || !this.spacePath) return
    saveChatSessionId(this.spacePath, this.appId, this.runId, result.capturedSessionId)

    // A local session created via "continue in client" carries a pending
    // resume-and-fork marker. The captured id is the NEW forked session, so the
    // marker has done its job; later messages resume normally. No-op elsewhere.
    const parsed = parseAppChatKey(this.conversationId)
    if (parsed?.channel === LOCAL_SESSION_CHANNEL) {
      getImSessionRegistry()?.clearPendingResume(this.appId, parsed.channel, parsed.chatId)
    }
  }

  /**
   * Deliver a turn nobody is waiting for. Native and HTTP sessions need nothing:
   * the transcript plus the agent:* events already reached the client. An IM
   * chat has no live listener, so the text is pushed to it.
   */
  private deliverAutonomous(replyContent: string): void {
    const text = replyContent.trim()
    if (!text) return

    const parsed = parseAppChatKey(this.conversationId)
    if (!parsed || classifySessionSource(parsed.channel) !== 'im') return

    const session = getImSessionRegistry()?.findSession(this.appId, parsed.channel, parsed.chatId)
    const instance = session?.instanceId
      ? getActiveImChannelManager()?.getInstance(session.instanceId)
      : undefined
    if (!instance) {
      console.warn(
        `[AppChat][${this.appId}] Autonomous turn not delivered — no live channel ` +
        `instance for ${this.conversationId}`
      )
      return
    }

    try {
      instance.pushToChat(parsed.chatId, text, parsed.chatType)
      console.log(`[AppChat][${this.appId}] Autonomous turn pushed to ${this.conversationId}`)
    } catch (err) {
      console.error(`[AppChat][${this.appId}] Autonomous turn push failed:`, err)
    }
  }
}

// ============================================
// Registry
// ============================================

/**
 * One sink per conversation, outliving the V2 sessions beneath it: a session
 * rebuild (credential change, idle timeout, crash) must not orphan the rounds
 * queued against that conversation.
 */
const sinks = new Map<string, AppChatSink>()

export function getAppChatSink(params: {
  appId: string
  conversationId: string
  runId: string
  spacePath: string
}): AppChatSink {
  const existing = sinks.get(params.conversationId)
  if (existing) return existing

  const sink = new AppChatSink(params.appId, params.conversationId, params.runId, params.spacePath)
  sinks.set(params.conversationId, sink)
  return sink
}

/** Whether a conversation has a message awaiting its answer. */
export function hasActiveAppChatRound(conversationId: string): boolean {
  return sinks.get(conversationId)?.hasActiveRound() ?? false
}

/** Conversations that currently have a round in flight. */
export function getConversationsWithActiveRound(): string[] {
  const ids: string[] = []
  for (const [conversationId, sink] of sinks) {
    if (sink.hasActiveRound()) ids.push(conversationId)
  }
  return ids
}

/**
 * Drop a conversation's sink. Called when its history is wiped or the session
 * is deleted — the next message builds a fresh one.
 */
export function disposeAppChatSink(conversationId: string): void {
  sinks.delete(conversationId)
}

export type { AppChatSink }
