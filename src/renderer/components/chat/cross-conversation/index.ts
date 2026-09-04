/**
 * Cross-conversation delivery — renderer surface.
 *
 * Everything the chat UI needs to render messages that arrived from another
 * conversation in the same space, and to address one from the composer.
 * Consumers import from here, never from the files inside.
 */

export { isCrossConversationMessage, isCrossConversationNotice } from './message-source'
export { CrossConversationMessage } from './CrossConversationMessage'
export { CrossConversationNotice } from './CrossConversationNotice'
export { ConversationMentionRow } from './ConversationMentionRow'
export { useConversationMentionCandidates } from './useConversationMentionCandidates'
export type { ConversationMentionCandidate } from './useConversationMentionCandidates'
