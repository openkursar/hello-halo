/**
 * Opening the conversation a `[#Title](conv:<id>)` reference points at.
 *
 * Resolved on click against what the renderer already holds — the space
 * conversations loaded so far and the digital-human chat records — so showing a
 * reference costs nothing. Both are fetched again before giving up: the
 * conversation may be newer than the lists.
 */

import i18n from '../../../i18n'
import type { ImSessionRecord } from '../../../../shared/types/im-channel'
import { buildLocalSessionKey, getAppChatConversationId } from '../../../../shared/apps/im-keys'
import { shortConversationId } from '../../../../shared/conversation-reference'
import { useChatStore } from '../../../stores/chat.store'
import { useAppsStore } from '../../../stores/apps.store'
import { getAppChatSessions, loadAppChatSessions } from '../../../stores/app-chat-sessions'
import { useNotificationStore } from '../../../stores/notification.store'
import { navigateToAppChat, navigateToConversation } from '../../../utils/conversation-navigation'

const NOTICE_ID = 'conversation-reference'

/** Space conversations, the current space first. */
function openSpaceConversation(shortId: string): boolean {
  const { currentSpaceId, spaceStates } = useChatStore.getState()
  const spaceIds = [...spaceStates.keys()].sort((a, b) => Number(b === currentSpaceId) - Number(a === currentSpaceId))
  for (const spaceId of spaceIds) {
    const match = spaceStates.get(spaceId)?.conversations.find(c => shortConversationId(c.id) === shortId)
    if (match) {
      navigateToConversation(match.spaceId || spaceId, match.id)
      return true
    }
  }
  return false
}

/** The chats the composer offers: a digital human's default chat and its local ones. */
function chatIdOf(record: ImSessionRecord): string | null {
  if (record.source === 'native') return getAppChatConversationId(record.appId)
  if (record.source === 'local') return buildLocalSessionKey(record.appId, record.chatId)
  return null
}

function openDigitalHumanChat(shortId: string, records: readonly ImSessionRecord[]): boolean {
  const { apps } = useAppsStore.getState()
  const currentSpaceId = useChatStore.getState().currentSpaceId
  for (const record of records) {
    const conversationId = chatIdOf(record)
    if (!conversationId || shortConversationId(conversationId) !== shortId) continue
    const app = apps.find(a => a.id === record.appId)
    const spaceId = app?.spaceId ?? currentSpaceId
    if (!app || app.status === 'uninstalled' || !spaceId) continue
    navigateToAppChat(spaceId, app.id, conversationId)
    return true
  }
  return false
}

export async function openConversationReference(shortId: string): Promise<void> {
  if (openSpaceConversation(shortId) || openDigitalHumanChat(shortId, getAppChatSessions())) return

  const { currentSpaceId, loadConversations } = useChatStore.getState()
  const [records] = await Promise.all([
    loadAppChatSessions(),
    currentSpaceId ? loadConversations(currentSpaceId) : undefined,
    useAppsStore.getState().loadApps(),
  ])
  if (openSpaceConversation(shortId) || openDigitalHumanChat(shortId, records)) return

  useNotificationStore.getState().show({
    id: NOTICE_ID,
    title: i18n.t('This conversation is no longer available'),
    variant: 'warning',
    duration: 4000,
  })
}
