/**
 * Agent Module - Conversation Turn Sink
 *
 * The TurnSink for space conversations: turns are persisted through
 * conversation.service and surfaced in the chat UI.
 *
 * Extracted verbatim from the session consumer when app chat joined the same
 * consumption loop — this file is the "space chat" half that the consumer used
 * to hold inline.
 */

import type { EngineId } from '../../../shared/types/engine'
import type { EngineSessionState } from '../../../shared/types/engine-session'
import type { Thought } from './types'
import type { StreamResult } from './stream-processor'
import type { TurnSink } from './turn-sink'
import { replyEndingOf } from './reply-ending'
import type { ReplyEnding } from '../../../shared/types/transcript'
import {
  addMessage,
  updateLastMessage,
  removeEmptyReplyPlaceholder,
  saveSessionId,
  getConversationEngineState,
  saveConversationEngineBinding,
  getConversation,
  type Message
} from '../conversation.service'
import { notifyTaskComplete } from '../notification.service'
import { emitAgentEvent } from './events'
import { CONTINUITY_NOTICE_TEXT } from '../../../shared/transcript'
import { type FileChangesSummary, extractFileChangesSummaryFromThoughts } from '../../../shared/file-changes'
import { resolveSourcesForReadPaths } from '../tlon'
import type { KBSource } from '../../../shared/types/tlon'

/**
 * Build the sink for a space conversation.
 *
 * Stateless across turns: every hook derives what it needs from the store, so
 * the same sink instance can serve a session that is rebuilt underneath it.
 */
export function createConversationSink(spaceId: string, conversationId: string, preparedState?: EngineSessionState): TurnSink {
  let expected = preparedState ?? getConversationEngineState(spaceId, conversationId) ?? {}
  const commit = (sessionId: string, engineId?: EngineId): boolean => {
    if (!engineId) { saveSessionId(spaceId, conversationId, sessionId); return true }
    const binding = { version: 1 as const, engineId, sessionId }
    if (!saveConversationEngineBinding(spaceId, conversationId, binding, expected)) return false
    expected = { sessionId, binding }
    return true
  }
  return {
    onTurnStart() {
      // Placeholder for the assistant reply, created uniformly for user-initiated
      // and autonomous turns — the turn is only ever known to have started here.
      addMessage(spaceId, conversationId, {
        role: 'assistant',
        content: '',
        toolCalls: [],
      })
    },

    onContinuedFromRecord() {
      const notice = addMessage(spaceId, conversationId, { role: 'system', content: CONTINUITY_NOTICE_TEXT, source: 'continuity-notice' })
      emitAgentEvent('agent:input-arrived', spaceId, conversationId, { messages: [notice], live: false })
    },

    onTurnComplete(result: StreamResult) {
      persistTurnResult(spaceId, conversationId, result, commit)

      const conversation = getConversation(spaceId, conversationId)
      notifyTaskComplete(conversation?.title || 'Conversation')
    },

    acceptsQuietEnd() {
      const messages = getConversation(spaceId, conversationId)?.messages
      return !!messages && !hasPersonInput(messages)
    },

    onConsumerStopped(partial) {
      if (partial) {
        persistTurnResult(spaceId, conversationId, partial, commit, 'Chat session ended before the reply completed.')
      }
    },

    onTurnError(error: Error, turnStarted: boolean, partial?: StreamResult) {
      // A failure before init has no placeholder and must not overwrite the previous reply.
      if (turnStarted && partial) {
        persistTurnResult(spaceId, conversationId, partial, commit, error.message)
      } else if (turnStarted) {
        updateLastMessage(spaceId, conversationId, { error: error.message })
      } else {
        addMessage(spaceId, conversationId, {
          role: 'assistant',
          content: '',
          error: error.message,
          toolCalls: [],
        })
      }
    },
  }
}

/**
 * Whether a person's message belongs to the turn whose reply is the last
 * assistant message: sent since the previous reply, or added while this turn
 * ran. Messages from other conversations and teammates, and Halo's notices,
 * are system records.
 */
function hasPersonInput(messages: readonly Message[]): boolean {
  let reply = messages.length - 1
  while (reply >= 0 && messages[reply].role !== 'assistant') reply--
  if (reply < 0) return true
  for (let index = messages.length - 1; index >= 0; index--) {
    if (index < reply && messages[index].role === 'assistant') return false
    if (messages[index].role === 'user') return true
  }
  return false
}

/**
 * Persist a completed turn's result to the conversation.
 */
function persistTurnResult(
  spaceId: string,
  conversationId: string,
  result: StreamResult,
  commit: (sessionId: string, engineId?: EngineId) => boolean,
  error?: string,
): void {
  const { finalContent, hasMeaningfulContent, thoughts, tokenUsage, capturedSessionId, hasErrorThought, errorThought } = result

  // Save session ID for future resumption
  if (capturedSessionId) {
    if (!commit(capturedSessionId, result.engineId)) return
  }

  // Never persist the empty-response repair placeholder as message content —
  // it would render as a blank bubble and mask the empty-response error block.
  // Still persist when only thoughts exist (thinking-only turns) so the
  // reasoning survives a reload.
  const contentToStore = hasMeaningfulContent ? finalContent : ''
  // The connection and end-of-turn markers are not something the turn produced,
  // nor is the blank text a quiet end carries.
  const producedThoughts = thoughts.some((t: Thought) => t.type !== 'system' && t.type !== 'result'
    && !(result.endedQuietly && t.type === 'text' && !t.content.trim()))

  if (contentToStore || hasErrorThought || producedThoughts || error) {
    // A partial kept because of a failure shows that failure instead.
    const ending = error ? undefined : replyEndingOf(result)
    let metadata: { fileChanges?: FileChangesSummary; ending?: ReplyEnding } | undefined = ending ? { ending } : undefined
    let sources: KBSource[] | undefined
    if (thoughts.length > 0) {
      try {
        const fileChangesSummary = extractFileChangesSummaryFromThoughts(thoughts)
        if (fileChangesSummary) {
          metadata = { ...metadata, fileChanges: fileChangesSummary }
        }
      } catch (error) {
        console.error(`[Consumer][${conversationId}] Failed to extract file changes:`, error)
      }
      // Knowledge-base documents the agent Read this turn → clickable citations.
      try {
        const readPaths = thoughts
          .filter((t: Thought) => t.type === 'tool_use' && t.toolName === 'Read' && typeof t.toolInput?.file_path === 'string')
          .map((t: Thought) => t.toolInput!.file_path as string)
        const resolved = readPaths.length > 0 ? resolveSourcesForReadPaths(readPaths) : []
        if (resolved.length > 0) sources = resolved
      } catch (error) {
        console.error(`[Consumer][${conversationId}] Failed to resolve KB sources:`, error)
      }
    }

    updateLastMessage(spaceId, conversationId, {
      content: contentToStore,
      thoughts: thoughts.length > 0 ? [...thoughts] : undefined,
      tokenUsage: tokenUsage || undefined,
      metadata,
      sources,
      error: error || errorThought?.content,
    })
  } else {
    // Typically stopped before the model said anything: no blank reply is left behind.
    const outcome = removeEmptyReplyPlaceholder(spaceId, conversationId)
    console.log(`[Consumer][${conversationId}] Turn produced nothing; reply placeholder ${outcome === 'removed' ? 'removed' : `kept (${outcome})`}`)
  }
}
