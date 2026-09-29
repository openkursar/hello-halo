/**
 * Which conversations the composer's @ menu offers, and how each reads.
 *
 * A space's own conversations and the digital-human chats listed beside them
 * are one pool: the model reaches both through the same `halo-conversations`
 * tools, so a person should be able to point at either. Pure — the hook feeds it
 * the live state.
 */

import type { ConversationMeta, TaskStatus } from '../../../types'
import { digitalHumanChatTitle } from '../../../../shared/conversation-reference'
import type { AppChatConversationRow } from '../../../hooks/useAppChatConversationRows'

export interface ConversationMentionCandidate {
  id: string
  title: string
  /** Last-activity preview; empty when the conversation has no messages yet. */
  summary: string
  updatedAt: string
  status: TaskStatus
  /** The digital human this chat belongs to; absent for a space conversation. */
  digitalHuman?: string
  /**
   * Its digital human has conversation collaboration off, so a reference to it
   * would reach nothing: listed for awareness, not selectable.
   */
  unavailable?: boolean
}

interface Translate {
  (text: string): string
}

/** Running conversations first, then the most recently active. */
function activityRank(status: TaskStatus): number {
  if (status === 'generating') return 0
  if (status === 'waiting') return 1
  return 2
}

export function buildConversationMentionCandidates(input: {
  conversations: readonly ConversationMeta[]
  digitalHumanChats: readonly AppChatConversationRow[]
  /** The conversation the composer belongs to, whichever kind — self-delivery is a pure loop source. */
  activeConversationId: string | null | undefined
  statuses: ReadonlyMap<string, TaskStatus>
  /** Whether a digital human currently has conversation collaboration on. */
  isCollabEnabled: (appId: string) => boolean
  t: Translate
}): ConversationMentionCandidate[] {
  const { conversations, digitalHumanChats, activeConversationId, statuses, isCollabEnabled, t } = input

  const own: ConversationMentionCandidate[] = conversations
    .filter(c => c.id !== activeConversationId)
    .map(c => ({
      id: c.id,
      title: c.title,
      summary: c.preview || '',
      updatedAt: c.updatedAt,
      status: statuses.get(c.id) ?? 'idle',
    }))

  // A removed digital human can no longer be messaged, and the backend does not
  // resolve its chats either.
  const digitalHuman: ConversationMentionCandidate[] = digitalHumanChats
    .filter(row => !row.uninstalled && row.id !== activeConversationId)
    .map(row => ({
      id: row.id,
      title: digitalHumanChatTitle({ ...row, name: row.digitalHumanName }, t('New chat')),
      summary: row.lastMessage ?? '',
      updatedAt: new Date(row.updatedAt).toISOString(),
      status: statuses.get(row.id) ?? 'idle',
      digitalHuman: row.digitalHumanName,
      ...(isCollabEnabled(row.appId) ? {} : { unavailable: true }),
    }))

  return [...own, ...digitalHuman].sort((a, b) => {
    if (!!a.unavailable !== !!b.unavailable) return a.unavailable ? 1 : -1
    const rank = activityRank(a.status) - activityRank(b.status)
    if (rank !== 0) return rank
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  })
}
