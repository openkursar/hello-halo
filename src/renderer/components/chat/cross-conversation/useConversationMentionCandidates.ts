/**
 * Candidates for the composer's @ conversation picker.
 *
 * Derived entirely from state the renderer already holds: the current space's
 * conversation list and its digital-human chats (live titles, last-activity
 * preview), joined with the live per-conversation task status. No new transport.
 */

import { useMemo } from 'react'
import { useActiveConversationId, useChatStore, useAllConversationStatuses } from '../../../stores/chat.store'
import { useAppChatConversationRows } from '../../../hooks/useAppChatConversationRows'
import { useTranslation } from '../../../i18n'
import { buildConversationMentionCandidates } from './mention-candidates'
import { useAppsStore } from '../../../stores/apps.store'
import { isConversationCollabEnabled } from '../../../../shared/apps/app-types'

export type { ConversationMentionCandidate } from './mention-candidates'

export function useConversationMentionCandidates() {
  const { t } = useTranslation()
  const conversations = useChatStore(s => s.getCurrentSpaceState().conversations)
  const currentSpaceId = useChatStore(s => s.currentSpaceId)
  const activeConversationId = useActiveConversationId()
  const statuses = useAllConversationStatuses()
  const digitalHumanChats = useAppChatConversationRows(currentSpaceId)
  // Read from the live app list, so a switch flipped in settings shows at once.
  const apps = useAppsStore(s => s.apps)

  return useMemo(
    () => buildConversationMentionCandidates({
      conversations,
      digitalHumanChats,
      activeConversationId,
      statuses,
      isCollabEnabled: (appId) => {
        const app = apps.find(a => a.id === appId)
        return !!app && isConversationCollabEnabled(app)
      },
      t,
    }),
    [conversations, digitalHumanChats, activeConversationId, statuses, apps, t]
  )
}
