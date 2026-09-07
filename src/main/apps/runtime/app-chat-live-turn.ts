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
 */

import { getConsumerHandle, v2Sessions } from '../../services/agent/session-manager'
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
  if (hasActiveAppChatRound(conversationId)) return true
  const consumer = getConsumerHandle(conversationId)
  return !!(consumer?.isRunning && consumer.getActiveSessionState())
}

/**
 * Deliver `text` into the turn `conversationId` is already running.
 *
 * The engine absorbs it at that turn's next tool-round boundary, which still
 * ends with a single result — no second turn is started and nothing is
 * interrupted. Same primitive that backs a person typing while their agent is
 * generating (`services/agent/inject-message.ts`), rebuilt here because the two
 * differ in exactly one thing: where the message is persisted. Space chat writes
 * to the conversation store; an app chat's record is its JSONL transcript, owned
 * by the sink.
 *
 * Returns false — never throws — whenever the message did NOT reach the engine,
 * so a caller holding a slower fallback (the team mailbox) can take it back. A
 * false answer must therefore be cheap to be wrong about, and it is: the cost is
 * latency. A true answer must not be, which is why nothing is written down until
 * the engine has taken the message.
 */
export function injectIntoAppChat(conversationId: string, text: string): boolean {
  const info = v2Sessions.get(conversationId)
  if (!info) {
    console.warn(`${LOG_TAG} No live session for ${conversationId}; not delivered`)
    return false
  }

  // A live session is not a live TURN. Between the engine emitting a turn's
  // result and the consumer tearing the subprocess down there is a window where
  // the session object is still here and nothing is listening: text sent into it
  // goes nowhere, and the caller would have been told it was delivered. Of the
  // two ways to be wrong, "queued a little late" is recoverable and "reported as
  // delivered but never arrived" is not, so this checks the narrowest signal
  // available — a turn the consumer is actively processing — and declines
  // otherwise.
  //
  // It narrows the window rather than closing it: the turn can still end in the
  // microseconds after this reads true. That residue is why the caller must
  // treat false as "use your slower path" and never as "lost".
  const consumer = getConsumerHandle(conversationId)
  if (!consumer?.isRunning || !consumer.getActiveSessionState()) {
    console.warn(`${LOG_TAG} No turn in flight for ${conversationId}; not delivered`)
    return false
  }

  try {
    info.session.send(text)
  } catch (err) {
    // Nothing reached the engine, and nothing was written down: the caller takes
    // it back. Recording it here would leave the member reading the same message
    // twice — once from a transcript line for a delivery that failed, once from
    // the mailbox that legitimately re-delivers it.
    console.error(`${LOG_TAG} Delivery into the running turn of ${conversationId} failed:`, err)
    return false
  }

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
