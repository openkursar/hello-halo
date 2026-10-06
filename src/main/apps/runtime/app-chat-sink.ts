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

import type { TeamTriggerContext } from '../../../shared/apps/team-types'
import type { StreamResult } from '../../services/agent/stream-processor'
import type { TurnSink } from '../../services/agent/turn-sink'
import type { ImageAttachment } from '../../services/agent/types'
import type { ProgressEvent } from '../../../shared/types/inbound-message'
import type { TranscriptProvenance } from '../../../shared/types/transcript'
import type { ContentReference } from '../../../shared/types/content-reference'
import { parseAppChatKey } from '../../../shared/apps/im-keys'
import { classifySessionSource, LOCAL_SESSION_CHANNEL } from '../../../shared/types/im-channel'
import { getImSessionRegistry } from './im-session-registry'
import { getActiveImChannelManager } from './im-channels'
import { ReplyTextAccumulator } from './reply-accumulator'
import { ProgressEventParser } from './progress-formatter'
import { TurnCutPoint } from './escalation-cut'
import { openSessionWriter, saveChatSessionId, type SessionWriter } from './session-store'
import { AppChatTurnInterrupted, turnEndingOf, withTurnEndingNote, type AppChatTurnEnding } from './turn-ending'
import { stopGeneration } from '../../services/agent/control'
import { listResidentSessions } from '../../services/agent'

// ============================================
// Types
// ============================================

/** Per-round callbacks supplied by whoever sent the message. */
export interface AppChatRoundHooks {
  onProgress?(event: ProgressEvent): void
  /**
   * The turn's answer. `ending` says it stopped short (the step limit, or cut
   * off) — then `finalContent` is what was written, possibly nothing.
   */
  onReply?(finalContent: string, ending?: AppChatTurnEnding): void
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

/**
 * How long the engine may leave a dispatched message unclaimed while nothing
 * else is running.
 *
 * Only idle time counts, and idle means the engine is producing nothing at all
 * — not merely that it is producing something nobody claimed. A message queued
 * behind a turn working for minutes is not late, whether that turn answers an
 * earlier message or the digital human started it on its own.
 *
 * What this catches is a session that will never produce a turn at all — a
 * resume against a transcript a crashed process left broken, an engine that
 * failed to launch — which reports nothing, so the caller would otherwise wait
 * forever on a reply that can no longer arrive. Silence is the one outcome a
 * user cannot act on.
 */
const TURN_START_TIMEOUT_MS = 90_000

/**
 * Says only what the sink can actually establish: nothing came back and it
 * stopped waiting. Whether the engine took the message in is not observable
 * from here, so the wording claims neither delivery nor failure — and it does
 * not invite a resend, which would risk the work being done twice. A turn
 * arriving late is still persisted and delivered as an unsolicited one, so the
 * answer does reach the user if it ever comes.
 */
const NO_RESPONSE_MESSAGE =
  'No response to this message yet, so Halo stopped waiting on it. If it is picked up later, the reply still appears in this conversation.'

/** State rebuilt for every turn, solicited or not. */
interface TurnState {
  accumulator: ReplyTextAccumulator
  progressParser: ProgressEventParser
  accepted: boolean
  cutPoint: TurnCutPoint
  /** Set when this turn asked the user a question (see escalation-cut.ts). */
  askedUser: boolean
  cutIssued: boolean
}

function newTurnState(): TurnState {
  return {
    accumulator: new ReplyTextAccumulator(),
    progressParser: new ProgressEventParser(),
    accepted: false,
    cutPoint: new TurnCutPoint(),
    askedUser: false,
    cutIssued: false,
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
  private turnStartTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Whether the engine is mid-turn — including a turn it started on its own,
   * which claims no round. Liveness is the question the deadline below asks,
   * and an unclaimed turn is proof of liveness just the same.
   */
  private turnRunning = false

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

    // Unlike every other settlement, the deadline below fires on its own clock
    // rather than in response to something the caller did, so it can reject
    // before a handler is attached. Claim the rejection here so that never
    // surfaces as an unhandled one; the caller's own await still sees it.
    void done.catch(() => {})

    const round: Round = { hooks, resolve, reject, settled: false }
    this.queue.push(round)
    this.armTurnStartDeadline()

    return {
      done,
      cancel: () => {
        if (round.settled) return
        round.settled = true
        const queued = this.queue.indexOf(round)
        if (queued !== -1) this.queue.splice(queued, 1)
        if (this.current === round) this.current = null
        resolve()
        this.armTurnStartDeadline()
        emitRoundChange(this.conversationId)
      },
    }
  }

  /**
   * Whether a message is awaiting its answer, or its turn is running.
   *
   * Abandoned slots do not count: nobody is waiting on them, and treating one
   * as live would leave the conversation looking permanently busy — which would
   * buffer every later message as a supplement instead of answering it.
   */
  hasActiveRound(): boolean {
    return this.current !== null || this.queue.some(round => !round.settled)
  }

  /** Persist a user message to the transcript ahead of the turn it triggers. */
  writeUserMessage(
    text: string,
    images?: ImageAttachment[],
    teamOrigin?: Pick<TeamTriggerContext, 'kind' | 'correlationId'>,
    provenance?: TranscriptProvenance,
    references?: ContentReference[]
  ): void {
    this.getWriter()?.writeTrigger(text, images, teamOrigin, provenance, references)
  }

  /** A message failed before the engine created a turn to checkpoint. */
  writePreInitFailure(error: Error): void {
    this.getWriter()?.writeEvent({ type: 'turn_snapshot', content: '', thoughts: [], error: error.message })
  }

  /**
   * This turn asked the user a decision, so it ends as soon as the transcript
   * allows it. Called from the report tool while the turn is still running; the
   * cut itself happens in {@link onRawMessage}, which is the only place that can
   * see when the question's tool call is complete.
   */
  noteAskedUser(): void {
    this.turn.askedUser = true
  }

  // ── TurnSink ───────────────────────────────────────────

  onTurnStart(): void {
    this.turn = newTurnState()
    this.current = this.queue.shift() ?? null
    this.turnRunning = true
    // The engine is producing again; whatever is still queued is waiting on
    // this turn rather than on a session that will never answer.
    this.clearTurnStartDeadline()
    emitRoundChange(this.conversationId)
  }

  onRawMessage(sdkMessage: unknown): void {
    const message = sdkMessage as { type?: string }

    // The first message of the turn is the earliest proof the engine took our
    // input: before it, nothing entered the engine's history. An abandoned slot
    // has no caller left to tell.
    if (this.current && !this.current.settled && !this.turn.accepted) {
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
    // aggregates are what session-transcript.convertEventsToMessages reconstructs
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

    this.cutTurnIfItAskedUser(sdkMessage)
  }

  onTurnComplete(result: StreamResult): void {
    try {
      this.completeTurn(result)
    } finally {
      this.turnRunning = false
      // Anything still queued is owed a turn of its own from here.
      this.armTurnStartDeadline()
      emitRoundChange(this.conversationId)
    }
  }

  onTurnError(error: Error, _turnStarted?: boolean, partial?: StreamResult): void {
    try {
      if (partial) this.persistPartial(partial, error.message)
    } finally {
      const round = this.takeCurrentRound()
      round?.reject(error)
      this.turnRunning = false
      this.armTurnStartDeadline()
      emitRoundChange(this.conversationId)
    }
  }

  private completeTurn(result: StreamResult): void {
    this.persistSessionId(result)

    // Raw aggregates define delivery independently of the live UI's streaming state.
    const accumulated = this.turn.accumulator.getReply()
    const replyContent = accumulated || result.finalContent
    const ending = turnEndingOf(result)

    const round = this.takeCurrentRound()
    console.log(
      `[AppChat][${this.appId}] Turn complete (${round ? 'solicited' : 'autonomous'}): ` +
      `content=${replyContent.length} chars` +
      `${accumulated ? ' (from SDK message)' : ' (from streamResult)'}, ` +
      `thoughts=${result.thoughts.length}, tokens=${result.tokenUsage ? 'yes' : 'no'}` +
      `${ending ? `, ended=${ending.kind}` : ''}`
    )

    if (!round) {
      this.deliverAutonomous(replyContent, ending)
      return
    }

    // Fire onReply whenever content exists — including the whitespace-only
    // empty-response placeholder — because the bridge's onReply is what
    // terminates a streaming IM session. Whether the placeholder is shown or
    // replaced with a notice is the bridge's decision, not ours.
    if (replyContent) {
      this.reply(round, replyContent, ending)
      return
    }

    // No content and the turn did not end cleanly: surface it as a failed round
    // so the caller can close out its transport. A user-initiated stop is not a
    // failure — the caller already tore its transport down. A cut-off turn says
    // so in a way its caller can tell from a model error.
    if (!result.wasAborted && (result.hasErrorThought || result.isInterrupted)) {
      round.reject(result.hasErrorThought
        ? new Error(result.errorThought?.content || 'The model response was interrupted.')
        : new AppChatTurnInterrupted())
      return
    }

    // The step limit came before any text: the reply is that it stopped.
    if (ending) {
      this.reply(round, '', ending)
      return
    }
    round.resolve()
  }

  private reply(round: Round, content: string, ending: AppChatTurnEnding | undefined): void {
    try {
      if (ending) round.hooks.onReply?.(content, ending)
      else round.hooks.onReply?.(content)
    } catch (err) {
      console.error(`[AppChat][${this.appId}] onReply callback error:`, err)
    }
    round.resolve()
  }

  onConsumerStopped(partial?: StreamResult): void {
    try {
      if (partial) this.persistPartial(partial, 'Chat session ended before the reply completed.')
    } finally {
      this.turnRunning = false
      this.clearTurnStartDeadline()
      const pending = this.takeCurrentRound()
      pending?.reject(new Error('Chat session ended before the reply completed.'))
      while (this.queue.length > 0) {
        const round = this.queue.shift()!
        if (round.settled) continue
        round.settled = true
        round.reject(new Error('Chat session ended before the message was processed.'))
      }
      emitRoundChange(this.conversationId)
    }
  }

  /** Drop the sink's timer so a discarded sink cannot outlive its conversation. */
  dispose(): void {
    this.clearTurnStartDeadline()
  }

  // ── Internals ──────────────────────────────────────────

  /**
   * Start the clock on a message the engine has not claimed, if one is waiting
   * and nothing is running. Idempotent — safe to call on every state change.
   */
  private armTurnStartDeadline(): void {
    this.clearTurnStartDeadline()
    if (this.turnRunning || this.queue.length === 0) return

    this.turnStartTimer = setTimeout(() => {
      this.turnStartTimer = null
      const round = this.queue.find(r => !r.settled)
      if (!round) return
      // Settled but deliberately LEFT IN THE QUEUE. Ownership here is decided by
      // order, and the turn this message was dispatched for may still arrive —
      // removing its place would hand its answer to whatever was sent next.
      // The slot stays as a marker nobody is waiting on; when the turn lands it
      // claims this slot and is delivered as an unsolicited reply.
      round.settled = true
      console.error(
        `[AppChat][${this.appId}] No turn started within ${TURN_START_TIMEOUT_MS / 1000}s ` +
        `of dispatch and no turn is running (conversation=${this.conversationId}) — ` +
        `giving up the wait; acceptance by the engine is unknown`
      )
      round.reject(new Error(NO_RESPONSE_MESSAGE))
      // Whatever is behind it is owed a turn on the same terms.
      this.armTurnStartDeadline()
      emitRoundChange(this.conversationId)
    }, TURN_START_TIMEOUT_MS)

    // Never a reason to hold the process open.
    this.turnStartTimer.unref?.()
  }

  private clearTurnStartDeadline(): void {
    if (!this.turnStartTimer) return
    clearTimeout(this.turnStartTimer)
    this.turnStartTimer = null
  }

  /**
   * End a turn that raised an escalation, once its tool call is complete.
   *
   * Interrupting is what actually stops the engine; the round below settles on
   * its own when the stream ends, and the escalation has already been recorded
   * out of band, so no result is lost by cutting the turn short here.
   */
  private cutTurnIfItAskedUser(sdkMessage: unknown): void {
    const settled = this.turn.cutPoint.observe(sdkMessage)
    if (!settled || !this.turn.askedUser || this.turn.cutIssued) return

    this.turn.cutIssued = true
    console.log(
      `[AppChat][${this.appId}] Escalation raised — ending this turn ` +
      `(conversation=${this.conversationId}); the answer arrives as its own wake`
    )
    void stopGeneration(this.conversationId).catch((err) => {
      console.error(`[AppChat][${this.appId}] Could not end the turn after an escalation:`, err)
    })
  }

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

  private persistPartial(partial: StreamResult, error: string): void {
    this.persistSessionId(partial)
    this.getWriter()?.writeEvent({
      type: 'turn_snapshot',
      content: partial.hasMeaningfulContent ? partial.finalContent : '',
      thoughts: partial.thoughts,
      tokenUsage: partial.tokenUsage,
      error,
    })
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
   * chat has no live listener, so the text is pushed to it — noting a stop
   * short, since nobody asked and nothing else would tell.
   */
  private deliverAutonomous(replyContent: string, ending: AppChatTurnEnding | undefined): void {
    const written = replyContent.trim()
    if (!written) return
    const text = ending ? withTurnEndingNote(written, ending) : written

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
const lastUsedAt = new Map<string, number>()

/** A sink idle this long, with no round and no resident session, is released. */
export const SINK_IDLE_RELEASE_MS = 60 * 60 * 1000
const SINK_SWEEP_INTERVAL_MS = 10 * 60 * 1000
let lastSweepAt = 0

/**
 * Release sinks of conversations nobody has touched for an hour. A sink is only
 * released when it has no round in flight and its conversation holds no
 * resident session (whose consumer writes into it); the next message builds a
 * fresh one, as after a history wipe.
 */
export function sweepIdleAppChatSinks(
  hasResidentSession: (conversationId: string) => boolean,
  now = Date.now(),
): number {
  let released = 0
  for (const [conversationId, sink] of sinks) {
    if (now - (lastUsedAt.get(conversationId) ?? 0) < SINK_IDLE_RELEASE_MS) continue
    if (sink.hasActiveRound() || hasResidentSession(conversationId)) continue
    disposeAppChatSink(conversationId)
    released += 1
  }
  return released
}

function maybeSweep(now: number): void {
  if (now - lastSweepAt < SINK_SWEEP_INTERVAL_MS) return
  lastSweepAt = now
  const resident = new Set(listResidentSessions().map(s => s.conversationId))
  const released = sweepIdleAppChatSinks(id => resident.has(id), now)
  if (released > 0) console.log(`[AppChat] Released ${released} idle chat sink(s); ${sinks.size} remain`)
}

export function getAppChatSink(params: {
  appId: string
  conversationId: string
  runId: string
  spacePath: string
}): AppChatSink {
  const now = Date.now()
  maybeSweep(now)
  lastUsedAt.set(params.conversationId, now)
  const existing = sinks.get(params.conversationId)
  if (existing) return existing

  const sink = new AppChatSink(params.appId, params.conversationId, params.runId, params.spacePath)
  sinks.set(params.conversationId, sink)
  return sink
}

/**
 * The sink of a conversation that already has one, without creating it. For a
 * caller that is adding to a turn in flight rather than starting one, and so
 * has none of the identity a new sink would need.
 */
export function peekAppChatSink(conversationId: string): AppChatSink | undefined {
  return sinks.get(conversationId)
}

/** Whether a conversation has a message awaiting its answer. */
export function hasActiveAppChatRound(conversationId: string): boolean {
  return sinks.get(conversationId)?.hasActiveRound() ?? false
}

const roundChangeListeners = new Set<(conversationId: string) => void>()

/**
 * Be told whenever a conversation's turn starts, or one of its rounds settles or
 * is dropped — the moments its "awaiting an answer" state can change.
 *
 * @returns unsubscribe
 */
export function onAppChatRoundChange(listener: (conversationId: string) => void): () => void {
  roundChangeListeners.add(listener)
  return () => {
    roundChangeListeners.delete(listener)
  }
}

function emitRoundChange(conversationId: string): void {
  for (const listener of Array.from(roundChangeListeners)) {
    try {
      listener(conversationId)
    } catch (err) {
      console.error(`[AppChat] Round change listener failed for ${conversationId}:`, err)
    }
  }
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
  sinks.get(conversationId)?.dispose()
  sinks.delete(conversationId)
  lastUsedAt.delete(conversationId)
}

export type { AppChatSink }
