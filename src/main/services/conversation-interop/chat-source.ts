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
import { formatMessageAttachmentsBrief, getWorkingDir, onAgentEvent, sendMessage, sendIntoLiveTurn, hasPendingSessionInput, emitAgentEvent } from '../agent'
import { isSpaceConversationId } from '../../../shared/apps/im-keys'
import { shortConversationId } from '../../../shared/conversation-reference'
import { isNativeConversationBusy, hasLiveNativeSession } from './busy'
import type { ConversationSource, DispatchedMessage, DispatchOutcome, SourceConversation } from './source'
import type { TranscriptLine } from './types'
import type { TranscriptMessage } from '../../../shared/types/transcript'

const LOG_TAG = '[ConversationInterop]'

export const CHAT_SOURCE_KIND = 'chat'

async function dispatchBatch(
  spaceId: string,
  conversationId: string,
  messages: readonly DispatchedMessage[]
): Promise<DispatchOutcome[]> {
  const opener = messages.findIndex(message => !message.inputRecorded)
  if (opener < 0) throw new Error('Recorded deliveries must join an existing turn')
  const outcomes: DispatchOutcome[] = messages.map(() => ({}))
  const excludedHistoryMessageIds = messages.flatMap(message => message.recordedInputIds ?? [])
  let recorded = false
  await sendMessage({ spaceId, conversationId, message: messages.map(message => message.turnInput).join('\n\n') }, {
    excludedHistoryMessageIds,
    onUserMessageRecorded: (messageId) => {
      recorded = true
      try {
        const delivered = getConversation(spaceId, conversationId)?.messages.find(message => message.id === messageId)
        if (!delivered) {
          console.warn(`${LOG_TAG} delivery patch missed: conversation=${conversationId} message=${messageId}`)
          return
        }
        const message = messages[opener]
        updateMessageById(spaceId, conversationId, messageId, {
          content: message.record.content, role: 'system', source: message.record.source,
          metadata: { ...delivered.metadata, ...message.record.metadata, ...(message.record.source === 'team-message' ? { inputMode: 'turn' as const } : {}) },
        })
        outcomes[opener] = { messageId }
        excludedHistoryMessageIds.push(messageId)
        messages.forEach((item, index) => {
          if (index === opener || item.inputRecorded) return
          const additional = addMessage(spaceId, conversationId, {
            role: 'system', content: item.record.content, source: item.record.source,
            metadata: item.record.source === 'team-message' ? { ...item.record.metadata, inputMode: 'turn' } : item.record.metadata,
          })
          outcomes[index] = { messageId: additional.id }
          excludedHistoryMessageIds.push(additional.id)
        })
      } catch (error) {
        // Recording failures must not make the mailbox dispatch the accepted model input twice.
        console.error(`${LOG_TAG} Started input could not be recorded: conversation=${conversationId}`, error)
      }
    },
  })
  if (!recorded) console.warn(`${LOG_TAG} delivery patch missed: conversation=${conversationId} reason=no-record-callback`)
  return outcomes
}

export function createChatConversationSource(): ConversationSource {
  return {
    kind: CHAT_SOURCE_KIND,
    capabilities: { readable: true, writable: true },

    owns: isSpaceConversationId,

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
      let workDir: string | undefined
      return conversation.messages.map((m) => {
        const { references, task } = m.metadata ?? {}
        let content = m.content
        if (references?.length || task) {
          workDir ??= getWorkingDir(spaceId)
          content = [formatMessageAttachmentsBrief(references, task, workDir), m.content].filter(Boolean).join('\n')
        }
        return { id: m.id, role: m.role, content, timestamp: m.timestamp, source: m.source }
      })
    },

    isBusy: isNativeConversationBusy,
    hasLiveSession: hasLiveNativeSession,

    getActiveIdentity: () => 'owner',

    dispatch: async (spaceId, conversationId, message) => (await dispatchBatch(spaceId, conversationId, [message]))[0],
    dispatchBatch,

    deliverMidTurn(spaceId, conversationId, messages, onWithdrawn) {
      const recordedInputIds = messages.map(message => [...message.recordedInputIds ?? []])
      if (!sendIntoLiveTurn(conversationId, messages.map((message) => message.turnInput).join('\n\n'), undefined, { onWithdrawn: () => onWithdrawn(recordedInputIds) })) return false
      const transcript = getConversation(spaceId, conversationId)?.messages ?? []
      let at = transcript.length - 1
      while (at >= 0 && (transcript[at].role === 'system' || transcript[at].source === 'injection')) at--
      const reply = transcript[at]
      const inputReplyId = reply?.role === 'assistant' && !reply.content && !reply.error && !reply.tokenUsage && !reply.thoughtsSummary && !reply.thoughts?.length
        ? reply.id : undefined
      const records: TranscriptMessage[] = []
      const outcomes = messages.map((message, index) => {
        if (message.inputRecorded) return {}
        try {
          const recorded = addMessage(spaceId, conversationId, {
            role: 'system', content: message.record.content, source: message.record.source,
            metadata: { ...message.record.metadata, inputMode: 'live', ...(inputReplyId ? { inputReplyId } : {}) },
          })
          records.push(recorded)
          recordedInputIds[index].push(recorded.id)
          return { messageId: recorded.id }
        } catch (error) {
          console.error(`${LOG_TAG} Accepted live input could not be recorded: conversation=${conversationId}`, error)
          return {}
        }
      })
      if (records.length) emitAgentEvent('agent:input-arrived', spaceId, conversationId, { messages: records, live: true })
      return outcomes
    },

    onTurnReady(listener) {
      return onAgentEvent((event) => {
        if (event.channel === 'agent:turn-start' && isSpaceConversationId(event.conversationId)) listener(event.conversationId)
      })
    },

    onTurnEnd(listener) {
      // Both events reach here for every turn's end — success, error, and the
      // consumer's safety-net fallback. Other sources report their own.
      return onAgentEvent((event) => {
        if (event.channel !== 'agent:complete' && event.channel !== 'agent:error') return
        if (!isSpaceConversationId(event.conversationId)) return
        if (hasPendingSessionInput(event.conversationId)) return
        listener(event.conversationId)
      })
    },

    writeNotice(spaceId, conversationId, content) {
      addMessage(spaceId, conversationId, { role: 'system', content, source: 'cross-conversation-notice' })
    },
  }
}
