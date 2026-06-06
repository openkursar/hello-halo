/**
 * createGettersSlice — getters slice of the chat store.
 */
import type { ChatSlice } from './internal'
import { EMPTY_SESSION, EMPTY_SPACE_STATE } from './internal'

export const createGettersSlice: ChatSlice<'getCurrentSpaceState' | 'getSpaceState' | 'getCurrentConversation' | 'getCurrentConversationMeta' | 'getConversations' | 'getCurrentConversationId' | 'getCachedConversation' | 'getCurrentSession' | 'getSession'> = (set, get) => ({
  getCurrentSpaceState: () => {
    const { spaceStates, currentSpaceId } = get()
    if (!currentSpaceId) return EMPTY_SPACE_STATE
    return spaceStates.get(currentSpaceId) || EMPTY_SPACE_STATE
  },

  // Get space state by ID
  getSpaceState: (spaceId: string) => {
    const { spaceStates } = get()
    return spaceStates.get(spaceId) || EMPTY_SPACE_STATE
  },

  // Get current conversation (full, from cache)
  getCurrentConversation: () => {
    const spaceState = get().getCurrentSpaceState()
    if (!spaceState.currentConversationId) return null
    return get().conversationCache.get(spaceState.currentConversationId) || null
  },

  // Get current conversation metadata (lightweight)
  getCurrentConversationMeta: () => {
    const spaceState = get().getCurrentSpaceState()
    if (!spaceState.currentConversationId) return null
    return spaceState.conversations.find((c) => c.id === spaceState.currentConversationId) || null
  },

  // Get conversations metadata for current space
  getConversations: () => {
    return get().getCurrentSpaceState().conversations
  },

  // Get current conversation ID
  getCurrentConversationId: () => {
    return get().getCurrentSpaceState().currentConversationId
  },

  // Get cached conversation by ID
  getCachedConversation: (conversationId: string) => {
    return get().conversationCache.get(conversationId) || null
  },

  // Get current session state (for the currently viewed conversation)
  getCurrentSession: () => {
    const spaceState = get().getCurrentSpaceState()
    if (!spaceState.currentConversationId) return EMPTY_SESSION
    return get().sessions.get(spaceState.currentConversationId) || EMPTY_SESSION
  },

  // Get session state for any conversation
  getSession: (conversationId: string) => {
    return get().sessions.get(conversationId) || EMPTY_SESSION
  },
})
