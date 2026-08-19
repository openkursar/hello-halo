/**
 * Agent Module - Inject Message
 *
 * Sends a mid-turn user message into an active V2 session's input stream.
 * Persisted with source:'injection' (folded into the assistant bubble in the UI,
 * never rendered as its own user bubble). CC absorbs it into the current turn at
 * the next tool-round boundary and continues to a single result — no separate
 * turn. Backs the user's concurrent "type while generating".
 */

import { v2Sessions } from './session-manager'
import { addMessage } from '../conversation.service'

/**
 * Inject a plain-text message into an active V2 session mid-turn.
 *
 * 1. Persists the message (source: 'injection')
 * 2. Sends to CC subprocess via v2Session.send()
 *
 * CC absorbs this at the next tool boundary within the current turn; the turn
 * completes normally with a single result. Images are not supported here.
 *
 * @param conversationId - Target conversation
 * @param message - Plain text message to inject
 * @throws Error if no active V2 session exists for this conversation
 */
export function injectMessage(conversationId: string, message: string): void {
  const v2SessionInfo = v2Sessions.get(conversationId)
  if (!v2SessionInfo) {
    throw new Error(`No active V2 session for conversation: ${conversationId}`)
  }

  // Persist with source:'injection' so it appears in history and folds in the UI
  addMessage(v2SessionInfo.spaceId, conversationId, {
    role: 'user',
    content: message,
    source: 'injection',
  })

  v2SessionInfo.session.send(message)
  console.log(`[Agent][${conversationId}] Injection message sent and persisted (${message.length} chars)`)
}
