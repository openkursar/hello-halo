import type { ConversationWorkHost } from '../../../services/agent'
import { getTeamService } from '../../team'

/**
 * The team runtime's answer for a conversation's collaborators. The agent service
 * owns when this runs (a user's stop, a request starting); this owns what it means.
 */
export function createConversationWorkHost(): ConversationWorkHost {
  const participants = () => getTeamService()?.participants
  return {
    beginRequest: (conversationId, requestId) => participants()?.beginRequest(conversationId, requestId),
    hasWork: conversationId => participants()?.hasSource(conversationId) === true,
    async stop(conversationId) { await participants()?.stopSource(conversationId) },
  }
}
