/**
 * Cross-surface conversation navigation.
 *
 * Every surface that links into the main conversation board — the task panel,
 * cross-conversation provenance links, the space resource rail, a bot's session
 * browser — needs the same two moves: switch space first when the target lives
 * elsewhere, and always land on the space view, because a caller outside it
 * would otherwise select a conversation without showing it.
 *
 * Kept out of the PulseList component module so a non-component caller never
 * has to import a component to navigate.
 */

import { api } from '../api'
import { useAppStore } from '../stores/app.store'
import { useChatStore } from '../stores/chat.store'
import { useSpaceStore } from '../stores/space.store'
import { buildLocalSessionKey, getAppChatConversationId } from '../../shared/apps/im-keys'
import type { ImSessionRecord } from '../../shared/types/im-channel'

export function navigateToConversation(spaceId: string, conversationId: string) {
  const chatStore = useChatStore.getState()
  const currentSpaceId = chatStore.currentSpaceId

  useAppStore.getState().navigate('space')

  if (currentSpaceId === spaceId) {
    chatStore.selectConversation(conversationId)
    return
  }

  const spaceStore = useSpaceStore.getState()
  const targetSpace = spaceStore.haloSpace?.id === spaceId
    ? spaceStore.haloSpace
    : spaceStore.spaces.find(s => s.id === spaceId)

  if (!targetSpace) return

  // Set flag for SpacePage to consume after it finishes loading conversations
  useChatStore.setState({ pendingPulseNavigation: conversationId })

  // Switch space — SpacePage's initSpace will pick up the flag and call selectConversation
  spaceStore.setCurrentSpace(targetSpace)
}

/**
 * Navigate to a digital-human conversation, handling cross-space switching
 * exactly like navigateToConversation above, but landing on the app-chat
 * link (selectAppChatConversation) instead of a regular conversation.
 *
 * @param appSpaceId - The digital human's home space, or null for a global
 *   app — a global app has no space to switch to, so it opens in whichever
 *   space is currently active instead of forcing a jump.
 */
export function navigateToAppChat(appSpaceId: string | null, appId: string, conversationId: string) {
  const chatStore = useChatStore.getState()
  useAppStore.getState().navigate('space')

  const targetSpaceId = appSpaceId ?? chatStore.currentSpaceId
  if (!targetSpaceId) return

  if (chatStore.currentSpaceId === targetSpaceId) {
    chatStore.selectAppChatConversation(targetSpaceId, appId, conversationId)
    return
  }

  const spaceStore = useSpaceStore.getState()
  const targetSpace = spaceStore.haloSpace?.id === targetSpaceId
    ? spaceStore.haloSpace
    : spaceStore.spaces.find(s => s.id === targetSpaceId)
  if (!targetSpace) return

  useChatStore.setState({ pendingAppChatNavigation: { appId, conversationId } })
  spaceStore.setCurrentSpace(targetSpace)
}

/**
 * The desktop conversation to reopen for one digital human: the most recently
 * active of the sessions the main board's list shows for it. IM/HTTP sessions
 * are excluded — they are channel conversations read in the app's own session
 * browser, not places the main board can type into.
 */
async function latestDigitalHumanConversationId(appId: string): Promise<string | null> {
  try {
    const result = await api.imSessionsList(appId)
    if (!result.success || !Array.isArray(result.data)) return null
    const latest = (result.data as ImSessionRecord[])
      .filter(record => record.source === 'native' || record.source === 'local')
      .sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))[0]
    if (!latest) return null
    return latest.source === 'native'
      ? getAppChatConversationId(appId)
      : buildLocalSessionKey(appId, latest.chatId)
  } catch (error) {
    console.warn('[ConversationNavigation] Conversation lookup failed', { appId, error })
    return null
  }
}

/**
 * Start a conversation with one digital human and return its conversationId,
 * or null when the backend refused or the call failed (logged here, so every
 * caller reports a failure the same way).
 *
 * The single place the renderer creates a digital-human session: the input's
 * recipient picker, its "@" mention path, the resource rail's chat action and
 * the "open the last conversation" action above all mean "start talking now"
 * and must not each evolve their own request.
 */
export async function startDigitalHumanConversation(appId: string): Promise<string | null> {
  try {
    const result = await api.appSessionCreate(appId)
    if (result.success && result.data?.conversationId) return result.data.conversationId
    console.warn('[ConversationNavigation] Conversation creation refused', { appId, error: result.error })
  } catch (error) {
    console.warn('[ConversationNavigation] Conversation creation failed', { appId, error })
  }
  return null
}

/**
 * Talk to one digital human on the main conversation board: reopen their most
 * recent conversation, or start one when they have none — "talk to this person
 * now" has to land somewhere, and a person nobody has spoken to yet is the
 * normal case, not an error.
 *
 * Returns false when neither the lookup nor the creation produced a
 * conversation, so the caller can surface that nothing opened.
 */
export async function openDigitalHumanChat(appId: string, appSpaceId: string | null): Promise<boolean> {
  const conversationId = await latestDigitalHumanConversationId(appId)
    ?? await startDigitalHumanConversation(appId)
  if (!conversationId) return false
  navigateToAppChat(appSpaceId, appId, conversationId)
  return true
}
