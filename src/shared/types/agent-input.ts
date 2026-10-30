import type { TranscriptMessage } from './transcript'
import { parseReferences } from '../content-reference'

/** Original input records accepted by a conversation, delivered only to detail subscribers. */
export interface AgentInputArrivedEvent {
  spaceId: string
  conversationId: string
  messages: TranscriptMessage[]
  /** False for the input opening a new turn; true for additions to existing work. */
  live: boolean
}

/**
 * What became of a person's live addition, stored as `metadata.inputOutcome`.
 * Absent: the engine read it, or the record predates outcomes.
 * `stopped`: the person stopped the turn before the engine read it; it was never handled.
 */
export type LiveInputOutcome = 'stopped'

/** A person's live additions a stop voided, as stored records now carrying their outcome. */
export interface AgentInputStoppedEvent {
  spaceId: string
  conversationId: string
  messages: TranscriptMessage[]
}

/** Keep malformed relayed events from entering transcript state. */
export function isAgentInputArrivedEvent(value: unknown): value is AgentInputArrivedEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as Partial<AgentInputArrivedEvent>
  if (typeof event.spaceId !== 'string' || typeof event.conversationId !== 'string' || typeof event.live !== 'boolean') return false
  return isInputRecordBatch(event.messages)
}

/** Keep malformed relayed events from entering transcript state. */
export function isAgentInputStoppedEvent(value: unknown): value is AgentInputStoppedEvent {
  if (!value || typeof value !== 'object') return false
  const event = value as Partial<AgentInputStoppedEvent>
  if (typeof event.spaceId !== 'string' || typeof event.conversationId !== 'string') return false
  return isInputRecordBatch(event.messages)
}

function isInputRecordBatch(messages: TranscriptMessage[] | undefined): messages is TranscriptMessage[] {
  if (!Array.isArray(messages) || messages.length > 512) return false
  return messages.every(message => {
    if (!message || typeof message !== 'object' || typeof message.id !== 'string' || typeof message.content !== 'string' || typeof message.timestamp !== 'string') return false
    if (!['user', 'assistant', 'system'].includes(message.role)) return false
    if (message.source !== undefined && !['injection', 'cross-conversation', 'cross-conversation-notice', 'team-message', 'push', 'continuity-notice'].includes(message.source)) return false
    if (message.metadata !== undefined && (!message.metadata || typeof message.metadata !== 'object' || Array.isArray(message.metadata))) return false
    if (message.metadata) {
      const metadata = message.metadata as Record<string, unknown>
      for (const key of ['fromConversationId', 'fromConversationTitle', 'summary', 'correlationId', 'teamId', 'epochId', 'teamName', 'teamTriggerKind', 'inputReplyId', 'pushedByAppId', 'pushedByName']) {
        if (metadata[key] !== undefined && typeof metadata[key] !== 'string') return false
      }
      if (metadata.inputMode !== undefined && metadata.inputMode !== 'live' && metadata.inputMode !== 'turn') return false
      if (metadata.inputOutcome !== undefined && metadata.inputOutcome !== 'stopped') return false
      if (metadata.fromMemberName !== undefined && metadata.fromMemberName !== null && typeof metadata.fromMemberName !== 'string') return false
      if (metadata.references !== undefined && !parseReferences(metadata.references).ok) return false
    }
    if (message.images !== undefined && (!Array.isArray(message.images) || !message.images.every(image => image && typeof image.id === 'string' && typeof image.data === 'string' && typeof image.mediaType === 'string' && (image.url === undefined || typeof image.url === 'string')))) return false
    return true
  })
}
