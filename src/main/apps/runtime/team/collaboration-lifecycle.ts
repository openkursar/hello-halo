import { onHumanRequest, onUserStop, requestSessionRebuild } from '../../../services/agent'
import type { ParticipantService } from '../../team'

/** The input/stop boundary is shared by space and digital-human conversations. */
export function registerCollaborationLifecycle(participants: ParticipantService): () => void {
  const input = onHumanRequest(event => participants.beginRequest(event.conversationId, event.requestId))
  const stop = onUserStop(conversationId => {
    if (participants.hasSource(conversationId)) requestSessionRebuild(conversationId)
    void participants.stopSource(conversationId).catch(error => {
      console.error(`[CollaborationLifecycle] Source stop failed: conversation=${conversationId}`, error)
    })
  })
  return () => { input.dispose(); stop.dispose() }
}
