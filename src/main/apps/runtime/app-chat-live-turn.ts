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
import { formatReferencesBlock } from '../../services/agent'
import type { TranscriptProvenance } from '../../../shared/types/transcript'
import type { ContentReference } from '../../../shared/types/content-reference'
import { hasActiveAppChatRound, onAppChatRoundChange, peekAppChatSink } from './app-chat-sink'

const LOG_TAG = '[AppChatLiveTurn]'

/** A message on its way to the engine: accepted for a new turn, its round not queued yet. */
interface StartEntry {
  cancelled: boolean
}

const startingTurns = new Map<string, Set<StartEntry>>()

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
  const entry: StartEntry = { cancelled: false }
  const entries = startingTurns.get(conversationId) ?? new Set<StartEntry>()
  entries.add(entry)
  startingTurns.set(conversationId, entries)
  return {
    get cancelled() {
      return entry.cancelled
    },
    end: () => {
      const current = startingTurns.get(conversationId)
      if (!current?.delete(entry)) return
      if (current.size === 0) startingTurns.delete(conversationId)
      notifyConversationChange(conversationId)
    },
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
export function cancelAppChatTurnStarts(conversationId: string): boolean {
  const entries = startingTurns.get(conversationId)
  if (entries) {
    for (const entry of entries) entry.cancelled = true
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
  return startingTurns.has(conversationId) || isAppChatTurnDispatched(conversationId)
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
  if (!sendIntoLiveTurn(conversationId, engineText)) return false

  // Written only once the engine has taken it, and deliberately after: the
  // transcript is a record of what happened, and until the send returns nothing
  // has. The turn reads the message from the engine's own input stream, not from
  // here, so this ordering costs the reader nothing.
  try {
    const sink = peekAppChatSink(conversationId)
    if (provenance || references) sink?.writeUserMessage(text, undefined, undefined, provenance, references)
    else sink?.writeUserMessage(text)
  } catch (err) {
    // The message DID arrive; only the record of it failed. Reporting failure
    // now would hand the caller's fallback a second copy of a message the member
    // is already reading.
    console.error(`${LOG_TAG} Delivered, but recording it in the transcript failed:`, err)
  }

  console.log(`${LOG_TAG} Delivered into the running turn of ${conversationId} (${text.length} chars)`)
  return true
}

/**
 * What became of a person's addition: added to the running turn, left for a
 * turn of its own because nothing is in flight, or held back because the turn
 * it was meant for was stopped — the person stopped it, so the text goes back
 * to them rather than starting work they just halted.
 */
export type AppChatAdditionOutcome = 'delivered' | 'no_turn' | 'stopped'

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
  return hasLiveTurn(conversationId) && injectIntoAppChat(conversationId, text, provenance, references)
    ? 'delivered'
    : 'no_turn'
}
