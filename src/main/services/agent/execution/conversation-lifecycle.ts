/**
 * Who stops a chat's collaborators.
 *
 * A conversation's work outlives its turns: a member may still be working when no
 * turn is running, and a turn's execution is only the tools that turn mounted. So
 * the stop and admission boundary is the conversation's, owned here — where the
 * agent service already decides what a user's stop means — and the application
 * layer answers what stopping that conversation's work is.
 *
 * Nothing here waits or polls: the two agent events are the whole trigger.
 */

import { onHumanRequest } from '../events'
import { onUserStop } from '../control'
import { requestSessionRebuild } from '../session-manager'
import type { ConversationWorkHost } from './types'

/**
 * Bind the agent service's stop and admission events to the application layer's
 * conversation work. A user's stop cancels that conversation's request, its queued
 * deliveries and its collaborators; a reused engine session is rebuilt at its next
 * turn, because the tool endpoint it holds was retired with the request.
 */
export function bindConversationLifecycle(host: ConversationWorkHost): () => void {
  const input = onHumanRequest(event => host.beginRequest(event.conversationId, event.requestId))
  const stop = onUserStop(conversationId => {
    if (host.hasWork(conversationId)) requestSessionRebuild(conversationId)
    void host.stop(conversationId).catch(error => {
      console.error(`[AgentExecution] Conversation stop failed: conversation=${conversationId}`, error)
    })
  })
  return () => { input.dispose(); stop.dispose() }
}
