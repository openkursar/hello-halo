/**
 * Agent Module - Live Turn
 *
 * The engine's own answers to two questions outside callers keep asking about
 * a conversation: is a turn actively being processed right now, and can text
 * be handed into that turn. Exported here so no caller reads the session
 * tables directly — the session model can change shape without silently
 * breaking probes built outside the engine.
 *
 * Deliberately narrower than the cleanup-facing notion of busy inside
 * `session-manager.ts` (`isSessionBusy`): a consumer idle between turns, even
 * one with team agents still running, has no turn to hand text to.
 *
 * Persistence is the caller's. Each chat surface owns its own record — space
 * chat writes the conversation store (`inject-message.ts` wraps this concern
 * for it), an app chat writes its transcript — which is why neither the send
 * nor the probe writes anything down here.
 */

import { v2Sessions, getConsumerHandle } from './session-manager'

const LOG_TAG = '[Agent][LiveTurn]'

/** Whether `conversationId` has a turn the consumer is actively processing. */
export function hasLiveTurn(conversationId: string): boolean {
  const consumer = getConsumerHandle(conversationId)
  return !!(consumer?.isRunning && consumer.getActiveSessionState())
}

/**
 * Hand `text` into the turn `conversationId` is already running. The engine
 * absorbs it at that turn's next tool-round boundary, which still ends with a
 * single result — no second turn is started and nothing is interrupted; the
 * same primitive backs a person typing while their agent is generating.
 *
 * Returns false — never throws — whenever the text did NOT reach the engine:
 * no live session, no turn in flight, or the send itself failed. A live
 * session is not a live TURN: between the engine emitting a turn's result and
 * the consumer tearing the subprocess down, the session object is still here
 * and nothing is listening — text sent into it goes nowhere. So this checks
 * the narrowest signal available (`hasLiveTurn`) and declines otherwise. The
 * check narrows that window rather than closing it — the turn can still end
 * in the microseconds after it reads true — which is why a caller must treat
 * false as "use your slower path" and never as "lost", and treat true as "the
 * engine has it".
 */
export function sendIntoLiveTurn(conversationId: string, text: string): boolean {
  const info = v2Sessions.get(conversationId)
  if (!info) {
    console.warn(`${LOG_TAG} No live session for ${conversationId}; not delivered`)
    return false
  }
  if (!hasLiveTurn(conversationId)) {
    console.warn(`${LOG_TAG} No turn in flight for ${conversationId}; not delivered`)
    return false
  }
  try {
    info.session.send(text)
  } catch (err) {
    console.error(`${LOG_TAG} Delivery into the running turn of ${conversationId} failed:`, err)
    return false
  }
  return true
}
