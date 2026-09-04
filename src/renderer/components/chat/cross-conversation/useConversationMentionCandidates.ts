/**
 * Candidates for the composer's @ conversation picker.
 *
 * Derived entirely from state the renderer already holds: the current space's
 * conversation list (live titles, last-activity preview) joined with the live
 * per-conversation task status. No new transport.
 */

import { useMemo } from 'react'
import { useChatStore, useAllConversationStatuses } from '../../../stores/chat.store'
import type { TaskStatus } from '../../../types'

export interface ConversationMentionCandidate {
  id: string
  title: string
  /** Last-activity preview; empty when the conversation has no messages yet. */
  summary: string
  updatedAt: string
  status: TaskStatus
}

/** Running conversations first, then the most recently active. */
function activityRank(status: TaskStatus): number {
  if (status === 'generating') return 0
  if (status === 'waiting') return 1
  return 2
}

export function useConversationMentionCandidates(): ConversationMentionCandidate[] {
  const spaceState = useChatStore(s => s.getCurrentSpaceState())
  const statuses = useAllConversationStatuses()

  const { conversations, currentConversationId } = spaceState

  return useMemo(() => {
    // Self-delivery is a pure loop source and is rejected by the delivery path;
    // it must not be offerable here either.
    return conversations
      .filter(c => c.id !== currentConversationId)
      .map(c => ({
        id: c.id,
        title: c.title,
        summary: c.preview || '',
        updatedAt: c.updatedAt,
        status: statuses.get(c.id) ?? ('idle' as TaskStatus),
      }))
      .sort((a, b) => {
        const rank = activityRank(a.status) - activityRank(b.status)
        if (rank !== 0) return rank
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      })
  }, [conversations, currentConversationId, statuses])
}
