/**
 * Conversation search result, as the main-process search service produces it
 * and the search UI consumes it.
 */

import type { TranscriptRole } from './transcript'

export interface SearchResult {
  /** A space conversation, or a digital human's session */
  kind: 'chat' | 'digital-human'
  /** The digital human a `digital-human` result belongs to */
  appId?: string
  /** Space conversation id, or the digital-human session key */
  conversationId: string
  conversationTitle: string
  /** Stable message id — what a result navigates to */
  messageId: string
  spaceId: string
  spaceName: string
  messageRole: TranscriptRole
  messageContent: string
  messageTimestamp: string
  matchCount: number
  contextBefore?: string
  contextAfter?: string
}
