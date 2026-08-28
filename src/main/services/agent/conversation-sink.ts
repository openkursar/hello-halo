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

import type { Thought } from './types'
import type { StreamResult } from './stream-processor'
import type { TurnSink } from './turn-sink'
import {
  addMessage,
  updateLastMessage,
  saveSessionId,
  getConversation
} from '../conversation.service'
import { notifyTaskComplete } from '../notification.service'
import { type FileChangesSummary, extractFileChangesSummaryFromThoughts } from '../../../shared/file-changes'
import { resolveSourcesForReadPaths } from '../tlon'
import type { KBSource } from '../../../shared/types/tlon'

/**
 * Build the sink for a space conversation.
 *
 * Stateless across turns: every hook derives what it needs from the store, so
 * the same sink instance can serve a session that is rebuilt underneath it.
 */
export function createConversationSink(spaceId: string, conversationId: string): TurnSink {
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

    onTurnComplete(result: StreamResult) {
      persistTurnResult(spaceId, conversationId, result)

      const conversation = getConversation(spaceId, conversationId)
      notifyTaskComplete(conversation?.title || 'Conversation')
    },

    onTurnError(error: Error, turnStarted: boolean) {
      // With a placeholder in place we can update it. Without one, system:init
      // never arrived, so updateLastMessage would corrupt the *previous* turn's
      // assistant message instead.
      if (turnStarted) {
        updateLastMessage(spaceId, conversationId, {
          content: '',
          error: error.message,
        })
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
 * Persist a completed turn's result to the conversation.
 */
function persistTurnResult(
  spaceId: string,
  conversationId: string,
  result: StreamResult,
): void {
  const { finalContent, hasMeaningfulContent, thoughts, tokenUsage, capturedSessionId, hasErrorThought, errorThought } = result

  // Save session ID for future resumption
  if (capturedSessionId) {
    saveSessionId(spaceId, conversationId, capturedSessionId)
  }

  // Never persist the empty-response repair placeholder as message content —
  // it would render as a blank bubble and mask the empty-response error block.
  // Still persist when only thoughts exist (thinking-only turns) so the
  // reasoning survives a reload.
  const contentToStore = hasMeaningfulContent ? finalContent : ''

  if (contentToStore || hasErrorThought || thoughts.length > 0) {
    // Extract file changes summary
    let metadata: { fileChanges?: FileChangesSummary } | undefined
    let sources: KBSource[] | undefined
    if (thoughts.length > 0) {
      try {
        const fileChangesSummary = extractFileChangesSummaryFromThoughts(thoughts)
        if (fileChangesSummary) {
          metadata = { fileChanges: fileChangesSummary }
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
      error: errorThought?.content,
    })
  }
}
