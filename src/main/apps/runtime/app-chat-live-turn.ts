/**
 * The turn an app chat is running right now: whether there is one, and how to
 * add to it.
 *
 * Both questions belong together and to a module of their own. Together,
 * because a caller that adds to a live turn must first know there is one, and
 * the two answers have to come from the same view of the session — two
 * independently-derived notions of "busy" is exactly how a session ends up
 * reading idle while it is not. Of their own, because the team runtime asks
 * both, synchronously, and cannot import `app-chat.ts` (that module imports the
 * team runtime accessor, so the edge back would close a cycle).
 *
 * The engine half of both answers comes from its own surface
 * (`services/agent/live-turn.ts`); this module adds only what is app-chat's to
 * add — the windows before the engine knows about a message (still starting,
 * then queued), and the transcript.
 */

import { hasLiveTurn, sendIntoLiveTurn } from '../../services/agent/live-turn'
import { createHash } from 'crypto'
import { formatReferencesBlock, type StopReason, type V2SessionLease } from '../../services/agent'
import type { TranscriptMessage, TranscriptProvenance } from '../../../shared/types/transcript'
import type { ContentReference } from '../../../shared/types/content-reference'
import type { ImageAttachment } from '../../../shared/types/image-attachment'
import type { ImPermissionContext } from './im-permission-registry'
import type { TeamRequestOrigin, TeamTriggerContext } from '../../../shared/apps/team-types'
import { createTurnGate } from '../../platform/turn-gate'
import { hasActiveAppChatRound, onAppChatRoundChange, peekAppChatSink, type PreparedAppChatInput } from './app-chat-sink'

const LOG_TAG = '[AppChatLiveTurn]'

/** A message on its way to the engine: accepted for a new turn, its round not queued yet. */
interface StartEntry {
  cancelled: boolean
  stoppedBy?: StopReason
  reset: boolean
  isUsable?: () => boolean
  retire?: () => void
}

const startingTurns = new Map<string, Set<StartEntry>>()
const boundSessions = new Map<string, Set<StartEntry>>()

/** A person's addition waiting for a turn to begin; see {@link injectIntoAppChatWhenLive}. */
interface LiveTurnWaiter {
  stopped: boolean
  /** Settles the wait once the turn began, the conversation went idle, or a stop was asked for. */
  check(): void
}

const liveTurnWaiters = new Map<string, Set<LiveTurnWaiter>>()

const changeListeners = new Set<(conversationId: string) => void>()

/**
 * Be told whenever a conversation may have moved between starting, queued,
 * running and idle: a start ended, a stop was asked for, a turn began, a round
 * settled or was dropped. Re-read the state on the call; the call itself says
 * only that it may have changed.
 *
 * @returns unsubscribe
 */
export function onAppChatConversationChange(listener: (conversationId: string) => void): () => void {
  followSinkRounds()
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}

function notifyConversationChange(conversationId: string): void {
  for (const waiter of Array.from(liveTurnWaiters.get(conversationId) ?? [])) waiter.check()
  for (const listener of Array.from(changeListeners)) {
    try {
      listener(conversationId)
    } catch (err) {
      console.error(`${LOG_TAG} Change listener failed for ${conversationId}:`, err)
    }
  }
}

let followingSinkRounds = false

/** Relay the sink's round changes from the first moment anyone waits on one. */
function followSinkRounds(): void {
  if (followingSinkRounds) return
  followingSinkRounds = true
  onAppChatRoundChange(notifyConversationChange)
}

/** A message accepted for a new turn; see {@link beginAppChatTurnStart}. */
export interface AppChatTurnStart {
  /** Stopped on the way: the turn must send nothing to the engine. */
  readonly cancelled: boolean
  /** Who stopped it on the way: a person's stop voids a person's message. */
  readonly stoppedBy: StopReason | undefined
  /**
   * The conversation was reset under the message (cleared, restarted, its team
   * session closed): whatever the turn built on its way rests on state the
   * reset replaced. Set by every system stop, whoever stopped it first.
   */
  readonly reset: boolean
  /** A failed acquired instance must not hold up its successor while preparation unwinds. */
  bindSession(lease: Pick<V2SessionLease, 'isUsable'>, retire: () => void): void
  /** Stops tracking the acquired instance when this caller finishes or retires. */
  releaseSession(): void
  /** The round is queued, or the turn gave up. Idempotent. */
  end(): void
}

/**
 * Hold `conversationId` for a message from the moment it is accepted for a new
 * turn until its round is queued with the engine. Getting there takes awaits —
 * credentials, tools, a session that may be cold — and in that window neither
 * the sink (no round yet) nor the engine (no turn yet) knows about the message.
 * Read as idle, the conversation let a second message start a turn of its own;
 * the engine folded both into one turn with one result, and the second round
 * waited for a turn that never came — failing much later with an error about a
 * message that had in fact been answered.
 *
 * Called synchronously where the turn is decided, before any await.
 */
export function beginAppChatTurnStart(conversationId: string): AppChatTurnStart {
  const entry: StartEntry = { cancelled: false, reset: false }
  const entries = startingTurns.get(conversationId) ?? new Set<StartEntry>()
  entries.add(entry)
  startingTurns.set(conversationId, entries)
  return {
    get cancelled() {
      return entry.cancelled
    },
    get stoppedBy() {
      return entry.stoppedBy
    },
    get reset() {
      return entry.reset
    },
    bindSession: (lease, retire) => {
      entry.isUsable = () => lease.isUsable
      entry.retire = retire
      const bound = boundSessions.get(conversationId) ?? new Set<StartEntry>()
      bound.add(entry)
      boundSessions.set(conversationId, bound)
      refreshAppChatTurnStarts(conversationId)
    },
    releaseSession: () => {
      const bound = boundSessions.get(conversationId)
      if (!bound?.delete(entry)) return
      if (bound.size === 0) boundSessions.delete(conversationId)
    },
    end: () => {
      const current = startingTurns.get(conversationId)
      if (!current?.delete(entry)) return
      if (current.size === 0) startingTurns.delete(conversationId)
      notifyConversationChange(conversationId)
    },
  }
}

/** Reconcile this conversation's acquired instances before admitting more work. */
export function refreshAppChatTurnStarts(conversationId: string): void {
  for (const entry of [...(boundSessions.get(conversationId) ?? [])]) {
    if (!entry.isUsable || entry.isUsable()) continue
    console.warn(`${LOG_TAG} Retiring turn whose acquired engine is unavailable: conversation=${conversationId}`)
    entry.retire?.()
  }
}

/**
 * A stop was asked for this conversation. Every message still on its way to the
 * engine sends nothing once it gets there — they keep holding the conversation
 * until they unwind, so whatever arrives meanwhile waits behind them instead of
 * starting a turn beside one that is still building its session — and a person's
 * addition waiting for the turn to begin learns that it will not.
 *
 * @returns whether any message was on its way
 */
export function cancelAppChatTurnStarts(conversationId: string, reason: StopReason): boolean {
  const entries = startingTurns.get(conversationId)
  if (entries) {
    for (const entry of entries) {
      entry.cancelled = true
      entry.stoppedBy ??= reason
      // The system stops a message on its way only to reset its conversation.
      if (reason === 'internal') entry.reset = true
    }
  }
  for (const waiter of liveTurnWaiters.get(conversationId) ?? []) waiter.stopped = true
  notifyConversationChange(conversationId)
  return !!entries
}

/** Conversations with a message still on its way to the engine. */
export function getStartingAppChatConversations(): string[] {
  return Array.from(startingTurns.keys())
}

/**
 * Whether the engine has this conversation's message: its round is queued, or a
 * turn is running — an autonomous one included. A message still starting does
 * not count; stopping one of those is {@link cancelAppChatTurnStarts}, not the
 * engine's business.
 */
export function isAppChatTurnDispatched(conversationId: string): boolean {
  return hasActiveAppChatRound(conversationId) || hasLiveTurn(conversationId)
}

/**
 * Whether a turn is in flight for this conversation.
 *
 * This is the only truthful source: app chat runs on the consumer model and
 * never registers in the engine's legacy `activeSessions` map, so anything that
 * asks that map about an app chat is told `false` forever — quietly, since a
 * session that reads idle looks exactly like a session that is idle.
 *
 * Three windows count, and every one matters: a message accepted for a turn and
 * still on its way to the engine ({@link beginAppChatTurnStart}), a message
 * dispatched but not yet acknowledged by the engine (round queued, no turn
 * running), and a turn the consumer is currently processing — including an
 * autonomous one, which occupies the session just as much as a solicited one.
 */
export function isAppChatConversationGenerating(conversationId: string): boolean {
  refreshAppChatTurnStarts(conversationId)
  return startingTurns.has(conversationId) || isAppChatTurnDispatched(conversationId)
}

/** Permission identity belongs to the assembled turn, never the chat's latest sender. */
export function getAppChatTurnIdentity(conversationId: string): string | undefined {
  return isAppChatConversationGenerating(conversationId)
    ? peekAppChatSink(conversationId)?.getTurnIdentity()
    : undefined
}

/**
 * Who a turn's input answers to. Inputs merge into one turn only when this
 * matches. The owner's own digital humans and the runtime are 'owner', so their
 * messages join the owner's running turn; a request from outside (`origin`, for
 * a team turn that serves one) never does, whatever it may use.
 */
export function appChatMessageIdentity(permission?: ImPermissionContext, origin?: TeamRequestOrigin): string {
  if (permission?.isOwner === false) {
    const canonical = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.every(item => typeof item === 'string') ? [...value].sort() : value.map(canonical)
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
      }
      return value
    }
    return `guest:${createHash('sha256').update(JSON.stringify(canonical(permission.guestPolicy ?? {}))).digest('hex')}`
  }
  return origin ?? 'owner'
}

export interface AppChatLiveMessage {
  text: string
  recorded?: { content: string; provenance?: TranscriptProvenance; teamOrigin?: Pick<TeamTriggerContext, 'kind' | 'correlationId'> }
  references?: ContentReference[]
  images?: ImageAttachment[]
  recordedMessages?: Array<{ content: string; images?: ImageAttachment[]; provenance?: TranscriptProvenance; references?: ContentReference[]; teamOrigin?: Pick<TeamTriggerContext, 'kind' | 'correlationId'> }>
  /** Taken back after a stop and handed over again: its record already stands where it first arrived. */
  inputRecorded?: boolean
  recordedInputIds?: readonly string[]
  /** The owner's own words: a stop before they are read voids them, marked where they stand. */
  personal?: boolean
}

/** Unread non-personal messages; both indexes and the optional ID arrays address the original full batch. */
export type AppChatBatchTakenBack = (indexes: readonly number[], recordedInputIds?: readonly (readonly string[])[]) => void

/** A person's own message a stop voided before anything was written for it. */
export interface UnwrittenStoppedInput {
  content: string
  images?: ImageAttachment[]
  provenance?: TranscriptProvenance
  references?: ContentReference[]
  teamOrigin?: Pick<TeamTriggerContext, 'kind' | 'correlationId'>
}

/**
 * A person's own words their stop voided before the engine read them stay in
 * the chat's record, marked as never handled: `records` already written are
 * marked, `unwritten` ones are written marked.
 */
export function keepStoppedInputs(
  conversationId: string,
  records: readonly TranscriptMessage[],
  unwritten: readonly UnwrittenStoppedInput[] = []
): void {
  if (!records.length && !unwritten.length) return
  const sink = peekAppChatSink(conversationId)
  if (!sink) {
    console.warn(`${LOG_TAG} Voided messages have no transcript to stay in: conversation=${conversationId} count=${records.length + unwritten.length}`)
    return
  }
  if (records.length) sink.markInputsStopped(records)
  for (const input of unwritten) sink.writeStoppedInput(input.content, input.images, input.provenance, input.references, input.teamOrigin)
}

function prepareLiveInput(conversationId: string, text: string, images?: ImageAttachment[]): PreparedAppChatInput | false {
  const sink = peekAppChatSink(conversationId)
  if (sink?.prepareLiveInput) return sink.prepareLiveInput(text, images)
  // A text-only engine turn predating this surface needs no image preparation.
  return images?.length ? false : { text }
}

/** A teammate's or another conversation's message read mid-turn is shown inside the reply it arrived in. */
function readMidTurn(provenance: TranscriptProvenance | undefined): TranscriptProvenance | undefined {
  return provenance?.source === 'team-message' || provenance?.source === 'cross-conversation'
    ? { ...provenance, metadata: { ...provenance.metadata, inputMode: 'live' } }
    : provenance
}

/** One engine handoff, with each original message retained in the transcript. */
export function injectIntoAppChatBatch(
  conversationId: string,
  messages: readonly AppChatLiveMessage[],
  onTakenBack: AppChatBatchTakenBack
): boolean {
  if (messages.length === 0) return false
  const text = messages.map(message => formatReferencesBlock(message.references, undefined) + message.text).join('\n\n')
  const images = messages.flatMap(message => message.images ?? [])
  const prepared = prepareLiveInput(conversationId, text, images.length > 0 ? images : undefined)
  const written: TranscriptMessage[][] = messages.map(() => [])
  const sink = peekAppChatSink(conversationId)
  const onWithdrawn = (): void => {
    const takenBack: number[] = []
    messages.forEach((message, index) => {
      if (message.personal) keepStoppedInputs(conversationId, written[index])
      else takenBack.push(index)
    })
    if (takenBack.length) onTakenBack(takenBack, messages.map((message, index) => [
      ...message.recordedInputIds ?? [],
      ...(sink?.getRecordedInputIds(written[index]) ?? []).filter((id): id is string => Boolean(id)),
    ]))
  }
  if (!prepared || !sendIntoLiveTurn(conversationId, prepared.text, prepared.images, { onWithdrawn })) return false
  try {
    messages.forEach((message, index) => {
      if (message.inputRecorded) return
      const originals = message.recordedMessages ?? [{
        content: message.recorded?.content ?? message.text, images: message.images, teamOrigin: message.recorded?.teamOrigin,
        provenance: message.recorded?.provenance, references: message.references,
      }]
      for (const original of originals) {
        const record = sink?.writeUserMessage(original.content, original.images, original.teamOrigin, readMidTurn(original.provenance), original.references)
        if (record) written[index].push(record)
      }
    })
    sink?.announceLiveInputs?.(written.flat())
  } catch (error) {
    console.error(`${LOG_TAG} Accepted live messages could not be recorded: conversation=${conversationId} count=${messages.length}`, error)
  }
  return true
}

/**
 * Deliver `text` into the turn `conversationId` is already running, and record
 * it in the app chat's transcript. The mid-turn mechanics — and the guarantee
 * that false means "nothing reached the engine" — are the engine's
 * (`sendIntoLiveTurn`); what is added here is the record, because an app chat's
 * history is its JSONL transcript, owned by the sink, not the conversation
 * store that space chat writes.
 *
 * Returns false — never throws — so a caller holding a slower fallback (the
 * team mailbox) can take the message back. A false answer must be cheap to be
 * wrong about, and it is: the cost is latency. A true answer must not be,
 * which is why nothing is written down until the engine has taken the message.
 *
 * `provenance` marks how the message entered the transcript. The user adding to
 * their own running turn passes `{ source: 'injection' }`, which the transcript
 * shows as an annotation on the reply instead of a bubble of its own.
 * `references` are the places that user pointed at: the engine reads them
 * expanded ahead of the text, the transcript keeps them as records.
 */
export function injectIntoAppChat(
  conversationId: string,
  text: string,
  provenance?: TranscriptProvenance,
  references?: ContentReference[]
): boolean {
  const engineText = references && references.length > 0 ? formatReferencesBlock(references, undefined) + text : text
  const prepared = prepareLiveInput(conversationId, engineText)
  let recorded: TranscriptMessage | undefined
  // The person's own words: a stop before they were read voids them, marked where they stand.
  const onWithdrawn = (): void => {
    if (recorded) keepStoppedInputs(conversationId, [recorded])
  }
  if (!prepared || !sendIntoLiveTurn(conversationId, prepared.text, prepared.images, { onWithdrawn })) return false

  // Written only once the engine has taken it, and deliberately after: the
  // transcript is a record of what happened, and until the send returns nothing
  // has. The turn reads the message from the engine's own input stream, not from
  // here, so this ordering costs the reader nothing.
  try {
    const sink = peekAppChatSink(conversationId)
    recorded = provenance || references
      ? sink?.writeUserMessage(text, undefined, undefined, provenance, references)
      : sink?.writeUserMessage(text)
    if (recorded) sink?.announceLiveInputs?.([recorded])
  } catch (err) {
    // The message DID arrive; only the record of it failed. Reporting failure
    // now would hand the caller's fallback a second copy of a message the member
    // is already reading.
    console.error(`${LOG_TAG} Delivered, but recording it in the transcript failed:`, err)
  }

  return true
}

/**
 * What became of a person's addition: added to the running turn, left for a
 * turn of its own because nothing is in flight, or held back because the turn
 * it was meant for was stopped — the person stopped it, so the text goes back
 * to them rather than starting work they just halted.
 */
export type AppChatAdditionOutcome = 'delivered' | 'no_turn' | 'stopped'

const ownerAdditions = createTurnGate<{ text: string; provenance?: TranscriptProvenance; references?: ContentReference[] }>({
  isBusy: isAppChatConversationGenerating,
  getJobIdentity: () => 'owner',
  getActiveIdentity: getAppChatTurnIdentity,
  deliverMidTurn: (key, message) => injectIntoAppChat(key, message.text, message.provenance, message.references),
  dispatch: async () => { throw new Error('An addition requires a live turn') },
})

/**
 * {@link injectIntoAppChat} for a person adding to their own turn, which may not
 * have begun yet: the composer treats a chat as working from the moment it sent
 * the first message, while the turn is still starting. Answering "nothing to add
 * to" then would have the text sent as a second turn, which the engine folds
 * into the first — so it waits until the turn begins, the conversation has
 * nothing in flight, or a stop is asked for. It sets no deadline of its own:
 * a start always ends (its sender's `finally`) and a queued round is given up
 * on by the sink's own deadline, so the wait is bounded by theirs.
 */
export async function injectIntoAppChatWhenLive(
  conversationId: string,
  text: string,
  provenance?: TranscriptProvenance,
  references?: ContentReference[]
): Promise<AppChatAdditionOutcome> {
  if (!hasLiveTurn(conversationId) && isAppChatConversationGenerating(conversationId)) {
    console.log(`${LOG_TAG} Waiting for the turn of ${conversationId} to begin before adding to it`)
    followSinkRounds()
    const stopped = await new Promise<boolean>((resolve) => {
      const waiters = liveTurnWaiters.get(conversationId) ?? new Set<LiveTurnWaiter>()
      const waiter: LiveTurnWaiter = {
        stopped: false,
        check: () => {
          if (!waiter.stopped && !hasLiveTurn(conversationId) && isAppChatConversationGenerating(conversationId)) return
          waiters.delete(waiter)
          if (waiters.size === 0 && liveTurnWaiters.get(conversationId) === waiters) liveTurnWaiters.delete(conversationId)
          resolve(waiter.stopped)
        },
      }
      waiters.add(waiter)
      liveTurnWaiters.set(conversationId, waiters)
    })
    if (stopped) {
      console.log(`${LOG_TAG} The turn of ${conversationId} was stopped; the addition goes back to its author`)
      return 'stopped'
    }
  }
  return ownerAdditions.tryDeliverLive(conversationId, { text, provenance, references })
    ? 'delivered'
    : 'no_turn'
}
