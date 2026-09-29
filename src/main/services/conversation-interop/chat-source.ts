/**
 * Cross-Conversation Interop — the space's own conversations.
 *
 * Reads `{id}.json`'s `messages` only — never `{id}.thoughts.json`. That split
 * is the entire reason reading is affordable: a clean transcript costs nothing
 * extra to hand to another conversation, while the thinking/tool-call stream is
 * expensive and was never meant to leave its own turn.
 *
 * Delivery runs the normal `sendMessage` path — the model must receive the real
 * text — and then rewrites the message it just persisted into the delivered
 * shape. See DESIGN.md §2 for why that rewrite is id-keyed and never a
 * snapshot-and-replace.
 */

import { addMessage, getConversation, listConversations, updateMessageById } from '../conversation.service'
import { onAgentEvent, sendMessage } from '../agent'
import { isAppChatKey, parseRunSenderKey } from '../../../shared/apps/im-keys'
import { shortConversationId } from '../../../shared/conversation-reference'
import { isNativeConversationBusy, hasLiveNativeSession } from './busy'
import type { ConversationSource, DispatchedMessage, DispatchOutcome, SourceConversation } from './source'
import type { TranscriptLine } from './types'

const LOG_TAG = '[ConversationInterop]'

export const CHAT_SOURCE_KIND = 'chat'

/**
 * The persisted copy of a delivery: sendMessage writes the turn input as a
 * `role:'user'` message; find it and rewrite it. `beforeCount` is the message
 * count captured before sending — `addMessage` inside `sendMessage` runs
 * before its first `await`, so the delivered message lands exactly there
 * whatever the concurrently running turn appends after it. A scan by content
 * from that index covers a turn that appended something first.
 */
function locateDelivered(spaceId: string, conversationId: string, beforeCount: number, turnInput: string) {
  const messages = getConversation(spaceId, conversationId)?.messages
  if (!messages) return undefined
  const atIndex = messages[beforeCount]
  if (atIndex && atIndex.role === 'user' && atIndex.content === turnInput) return atIndex
  return messages.slice(beforeCount).find((m) => m.role === 'user' && m.content === turnInput)
}

export function createChatConversationSource(): ConversationSource {
  return {
    kind: CHAT_SOURCE_KIND,
    capabilities: { readable: true, writable: true },

    owns: (conversationId) => !isAppChatKey(conversationId) && !parseRunSenderKey(conversationId),

    list(spaceId): SourceConversation[] {
      return listConversations(spaceId).map((meta) => ({
        id: meta.id,
        title: meta.title,
        updatedAt: meta.updatedAt,
        messageCount: meta.messageCount,
      }))
    },

    getMeta(spaceId, conversationId): SourceConversation | null {
      const conversation = getConversation(spaceId, conversationId)
      if (!conversation) return null
      return {
        id: conversation.id,
        title: conversation.title,
        updatedAt: conversation.updatedAt,
        messageCount: conversation.messages.length,
      }
    },

    shortRef: shortConversationId,

    readTranscript(spaceId, conversationId): TranscriptLine[] | null {
      const conversation = getConversation(spaceId, conversationId)
      if (!conversation) return null
      return conversation.messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        source: m.source,
      }))
    },

    isBusy: isNativeConversationBusy,
    hasLiveSession: hasLiveNativeSession,

    async dispatch(spaceId, conversationId, message: DispatchedMessage): Promise<DispatchOutcome> {
      const beforeCount = getConversation(spaceId, conversationId)?.messages.length ?? 0

      await sendMessage({ spaceId, conversationId, message: message.turnInput })

      // Identified by id, then patched via `updateMessageById` (re-reads current
      // state itself before writing): the turn `sendMessage` started is running
      // concurrently and may append at any moment.
      const delivered = locateDelivered(spaceId, conversationId, beforeCount, message.turnInput)
      if (!delivered) {
        console.warn(
          `${LOG_TAG} delivery patch missed: conversation=${conversationId} expected index=${beforeCount} ` +
            '— the delivered turn stays persisted as a plain user message'
        )
        return {}
      }
      updateMessageById(spaceId, conversationId, delivered.id, {
        content: message.record.content,
        role: 'system',
        source: message.record.source,
        metadata: { ...delivered.metadata, ...message.record.metadata },
      })
      return { messageId: delivered.id }
    },

    onTurnEnd(listener) {
      // Both events reach here for every turn's end — success, error, and the
      // consumer's safety-net fallback. Digital-human keys are another source's.
      return onAgentEvent((event) => {
        if (event.channel !== 'agent:complete' && event.channel !== 'agent:error') return
        if (isAppChatKey(event.conversationId)) return
        listener(event.conversationId)
      })
    },

    writeNotice(spaceId, conversationId, content) {
      addMessage(spaceId, conversationId, { role: 'system', content, source: 'cross-conversation-notice' })
    },
  }
}
