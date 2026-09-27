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
 * Start a conversation with one digital human and return its conversationId,
 * or null when the backend refused or the call failed (logged here, so every
 * caller reports a failure the same way).
 *
 * The single place the renderer creates a digital-human session: the input's
 * recipient picker, its "@" mention path, the resource rail's chat action, and
 * every "Chat"/"talk to it now" button all mean the same thing and must not
 * each evolve their own request — including not silently reopening whatever
 * conversation happened to be most recent, which reads as "nothing happened"
 * when the user expected a new one.
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

const openingChats = new Map<string, Promise<boolean>>()

/**
 * "Talk to this digital human now": start a fresh conversation and open it on
 * the main board. Repeat calls for the same digital human while one is still
 * being created share it, so a double-click doesn't leave an extra empty
 * session behind.
 *
 * Returns false when no conversation could be created.
 */
export function openDigitalHumanChat(appId: string, appSpaceId: string | null): Promise<boolean> {
  const pending = openingChats.get(appId)
  if (pending) return pending
  const opening = (async () => {
    const conversationId = await startDigitalHumanConversation(appId)
    if (!conversationId) return false
    navigateToAppChat(appSpaceId, appId, conversationId)
    return true
  })().finally(() => openingChats.delete(appId))
  openingChats.set(appId, opening)
  return opening
}
