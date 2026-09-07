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
 * add — the pre-engine round window, and the transcript.
 */

import { hasLiveTurn, sendIntoLiveTurn } from '../../services/agent/live-turn'
import { hasActiveAppChatRound, peekAppChatSink } from './app-chat-sink'

const LOG_TAG = '[AppChatLiveTurn]'

/**
 * Whether a turn is in flight for this conversation.
 *
 * This is the only truthful source: app chat runs on the consumer model and
 * never registers in the engine's legacy `activeSessions` map, so anything that
 * asks that map about an app chat is told `false` forever — quietly, since a
 * session that reads idle looks exactly like a session that is idle.
 *
 * Two windows count, and both matter: a message dispatched but not yet
 * acknowledged by the engine (round queued, no turn running), and a turn the
 * consumer is currently processing — including an autonomous one, which occupies
 * the session just as much as a solicited one.
 */
export function isAppChatConversationGenerating(conversationId: string): boolean {
  return hasActiveAppChatRound(conversationId) || hasLiveTurn(conversationId)
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
 */
export function injectIntoAppChat(conversationId: string, text: string): boolean {
  if (!sendIntoLiveTurn(conversationId, text)) return false

  // Written only once the engine has taken it, and deliberately after: the
  // transcript is a record of what happened, and until the send returns nothing
  // has. The turn reads the message from the engine's own input stream, not from
  // here, so this ordering costs the reader nothing.
  try {
    peekAppChatSink(conversationId)?.writeUserMessage(text)
  } catch (err) {
    // The message DID arrive; only the record of it failed. Reporting failure
    // now would hand the caller's fallback a second copy of a message the member
    // is already reading.
    console.error(`${LOG_TAG} Delivered, but recording it in the transcript failed:`, err)
  }

  console.log(`${LOG_TAG} Delivered into the running turn of ${conversationId} (${text.length} chars)`)
  return true
}
