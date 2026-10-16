/**
 * Agent Module - Inject Message
 *
 * Sends a mid-turn user message into an active V2 session's input stream.
 * Persisted with source:'injection' (folded into the assistant bubble in the UI,
 * never rendered as its own user bubble). The engine absorbs it at the next tool boundary, or runs
 * an immediate continuation when the current turn is already ending. Backs the user's concurrent "type while generating".
 */

import { v2Sessions } from './session-manager'
import { sendIntoLiveTurn } from './live-turn'
import { emitAgentEvent } from './events'
import { addMessage, updateMessageById, type Message } from '../conversation.service'
import { getWorkingDir } from './helpers'
import { formatReferencesBlock } from './references'
import type { ContentReference } from '../../../shared/types/content-reference'

/**
 * Inject a message into an active V2 session mid-turn.
 *
 * Accepts through the engine's synchronous live-input primitive, then persists
 * the original text and references before the engine's next asynchronous step.
 *
 * Accepted text is consumed at the next model step or an immediate continuation.
 * If the user stops the turn before that, it never runs and its record is marked
 * stopped. Images are not supported by this legacy UI entry.
 *
 * @param conversationId - Target conversation
 * @param message - Message text; may be empty when references carry it
 * @param references - Places the user pointed at, already checked
 * @throws Error if no active V2 session exists for this conversation
 */
export function injectMessage(conversationId: string, message: string, references?: ContentReference[]): void {
  const v2SessionInfo = v2Sessions.get(conversationId)
  if (!v2SessionInfo) {
    throw new Error(`No active V2 session for conversation: ${conversationId}`)
  }
  const { spaceId } = v2SessionInfo

  const text = formatReferencesBlock(references, getWorkingDir(spaceId)) + message
  let recorded: Message | undefined
  const onWithdrawn = () => {
    if (!recorded) {
      console.warn(`[Agent][${conversationId}] Stopped live input has no record to mark`)
      return
    }
    const stopped = updateMessageById(spaceId, conversationId, recorded.id, {
      metadata: { ...recorded.metadata, inputOutcome: 'stopped' },
    })
    if (!stopped) {
      console.warn(`[Agent][${conversationId}] Stopped live input ${recorded.id} is no longer stored; mark skipped`)
      return
    }
    emitAgentEvent('agent:input-stopped', spaceId, conversationId, { messages: [stopped] })
  }
  if (!sendIntoLiveTurn(conversationId, text, undefined, { onWithdrawn })) {
    throw new Error('The live turn cannot accept input; send this message through the normal send entry')
  }
  try {
    // Acceptance is synchronous; persistence precedes the engine's next async step.
    recorded = addMessage(spaceId, conversationId, {
      role: 'user',
      content: message,
      source: 'injection',
      ...(references && references.length > 0 ? { metadata: { references } } : {}),
    })
    emitAgentEvent('agent:input-arrived', spaceId, conversationId, { messages: [recorded], live: true })
    console.log(`[Agent][${conversationId}] Live input accepted and recorded: chars=${text.length}`)
  } catch (error) {
    console.error(`[Agent][${conversationId}] Accepted live input could not be recorded or announced:`, error)
  }
}
