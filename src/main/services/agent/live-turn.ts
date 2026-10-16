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

import { v2Sessions, getConsumerHandle, activeSessions, hasPendingSessionInput } from './session-manager'
import { buildMessageContent } from './message-utils'
import type { ImageAttachment } from './types'

const LOG_TAG = '[Agent][LiveTurn]'

/** Whether `conversationId` has a turn the consumer is actively processing. */
export function hasLiveTurn(conversationId: string): boolean {
  const consumer = getConsumerHandle(conversationId)
  return activeSessions.has(conversationId) || hasPendingSessionInput(conversationId) || !!(consumer?.isRunning && consumer.getActiveSessionState())
}

export interface LiveInputOptions {
  /**
   * The person stopped the turn before the engine read this input, so it will
   * never run. Called at most once, inside that stop; never for input the
   * engine read, and never on internal stops, rebuilds or crashes.
   */
  onWithdrawn: () => void
}

/**
 * Synchronously transfers ownership to the engine. Accepted input reaches its
 * next tool boundary or an immediate continuation if the turn is already ending.
 * False leaves ownership with the caller; no input was enqueued.
 */
export function sendIntoLiveTurn(conversationId: string, text: string, images: ImageAttachment[] | undefined, options: LiveInputOptions): boolean {
  const info = v2Sessions.get(conversationId)
  if (!info) {
    console.warn(`${LOG_TAG} No live session for ${conversationId}; not delivered`)
    return false
  }
  if (!hasLiveTurn(conversationId)) {
    console.warn(`${LOG_TAG} No turn in flight for ${conversationId}; not delivered`)
    return false
  }
  if (!info.session.sendIntoLiveTurn) {
    console.warn(`${LOG_TAG} Engine has no synchronous live-input acceptance for ${conversationId}; not delivered`)
    return false
  }
  const onWithdrawn = () => {
    try {
      options.onWithdrawn()
    } catch (err) {
      console.error(`${LOG_TAG} Withdrawn-input handler failed for ${conversationId}:`, err)
    }
  }
  try {
    const content = buildMessageContent(text, images)
    return info.session.sendIntoLiveTurn(typeof content === 'string' ? content : {
      type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content },
    }, { onWithdrawn })
  } catch (err) {
    console.error(`${LOG_TAG} Delivery into the running turn of ${conversationId} failed:`, err)
    return false
  }
}

/**
 * A person's stop: takes back what the engine accepted for `conversationId`
 * but has not read, calling each input's `onWithdrawn`, before the turn is
 * interrupted. Input accepted after this call is not touched.
 */
export async function withdrawUnreadLiveInput(conversationId: string): Promise<void> {
  const session = v2Sessions.get(conversationId)?.session
  if (!session?.withdrawUnreadInput) return
  try {
    const withdrawn = await session.withdrawUnreadInput()
    if (withdrawn > 0) console.log(`${LOG_TAG} Stop withdrew ${withdrawn} unread input(s) of ${conversationId}; they will not run`)
  } catch (err) {
    console.error(`${LOG_TAG} Withdrawing unread input of ${conversationId} failed; it may still run after the stop:`, err)
  }
}
