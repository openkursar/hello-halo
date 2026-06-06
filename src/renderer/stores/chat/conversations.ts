/**
 * createConversationsSlice — conversations slice of the chat store.
 */
import type { ChatSlice } from './internal'
import { CONVERSATION_CACHE_SIZE, api, createEmptySessionState, createEmptySpaceState } from './internal'
import type { Conversation, ConversationMeta, Thought } from './internal'

export const createConversationsSlice: ChatSlice<'setCurrentSpace' | 'loadConversations' | 'preloadAllSpaceConversations' | 'createConversation' | 'selectConversation' | 'deleteConversation' | 'renameConversation' | 'toggleStarConversation'> = (set, get) => ({
  setCurrentSpace: (spaceId: string) => {
    set({ currentSpaceId: spaceId })
  },

  // Load conversations for a space (returns lightweight metadata)
  loadConversations: async (spaceId) => {
    try {
      set({ isLoading: true })

      const response = await api.listConversations(spaceId)

      if (response.success && response.data) {
        // Now receives ConversationMeta[] (lightweight, no messages)
        const conversations = response.data as ConversationMeta[]

        set((state) => {
          const newSpaceStates = new Map(state.spaceStates)
          const existingState = newSpaceStates.get(spaceId) || createEmptySpaceState()

          newSpaceStates.set(spaceId, {
            ...existingState,
            conversations
          })

          return { spaceStates: newSpaceStates }
        })
      }
    } catch (error) {
      console.error('Failed to load conversations:', error)
    } finally {
      set({ isLoading: false })
    }
  },

  // Preload conversation metadata for all spaces (background, non-blocking).
  // Ensures PULSE can see starred conversations from spaces the user hasn't visited yet.
  preloadAllSpaceConversations: (spaceIds: string[]) => {
    const { spaceStates } = get()
    const unloaded = spaceIds.filter(id => !spaceStates.has(id))
    if (unloaded.length === 0) return

    // Fire-and-forget: load each unloaded space in parallel
    for (const spaceId of unloaded) {
      api.listConversations(spaceId)
        .then((response) => {
          if (response.success && response.data) {
            const conversations = response.data as ConversationMeta[]
            set((state) => {
              // Don't overwrite if another load already populated this space
              if (state.spaceStates.has(spaceId)) return state
              const newSpaceStates = new Map(state.spaceStates)
              newSpaceStates.set(spaceId, {
                conversations,
                currentConversationId: null
              })
              return { spaceStates: newSpaceStates }
            })
          }
        })
        .catch((err) => console.error(`[ChatStore] Preload failed for space ${spaceId}:`, err))
    }
  },

  // Create new conversation
  createConversation: async (spaceId) => {
    try {
      const response = await api.createConversation(spaceId)

      if (response.success && response.data) {
        const newConversation = response.data as Conversation

        // Extract metadata for the list
        const meta: ConversationMeta = {
          id: newConversation.id,
          spaceId: newConversation.spaceId,
          title: newConversation.title,
          createdAt: newConversation.createdAt,
          updatedAt: newConversation.updatedAt,
          messageCount: newConversation.messages?.length || 0,
          preview: undefined,
          // Carry the engine stamp so EngineBadge renders immediately on the
          // newly created item — without this the badge only appears after
          // a meta reload (e.g. switching away and back).
          engineId: newConversation.engineId
        }

        set((state) => {
          const newSpaceStates = new Map(state.spaceStates)
          const existingState = newSpaceStates.get(spaceId) || createEmptySpaceState()

          // Add to conversation cache (new conversation is full)
          const newCache = new Map(state.conversationCache)
          newCache.set(newConversation.id, newConversation)

          // LRU eviction
          if (newCache.size > CONVERSATION_CACHE_SIZE) {
            const firstKey = newCache.keys().next().value
            if (firstKey) newCache.delete(firstKey)
          }

          newSpaceStates.set(spaceId, {
            conversations: [meta, ...existingState.conversations],
            currentConversationId: newConversation.id
          })

          return { spaceStates: newSpaceStates, conversationCache: newCache }
        })

        // Warm up V2 Session for new conversation - non-blocking
        // This ensures first message doesn't have cold start delay
        try {
          api.ensureSessionWarm(spaceId, newConversation.id)
            .catch((error) => console.error('[ChatStore] Session warm up failed:', error))
        } catch (error) {
          console.error('[ChatStore] Failed to trigger session warm up:', error)
        }

        return newConversation
      }

      return null
    } catch (error) {
      console.error('Failed to create conversation:', error)
      return null
    }
  },

  // Select conversation (changes pointer, loads full conversation on-demand)
  selectConversation: async (conversationId) => {
    let { currentSpaceId } = get()
    if (!currentSpaceId) return

    let spaceState = get().spaceStates.get(currentSpaceId)
    if (!spaceState) return

    let conversationMeta = spaceState.conversations.find((c) => c.id === conversationId)

    // Conversation may have been created remotely — reload and retry
    if (!conversationMeta) {
      console.log(`[ChatStore] selectConversation: meta not found for ${conversationId}, reloading space ${currentSpaceId}`)
      await get().loadConversations(currentSpaceId)
      spaceState = get().spaceStates.get(currentSpaceId)
      if (!spaceState) return
      conversationMeta = spaceState.conversations.find((c) => c.id === conversationId)

      if (!conversationMeta) {
        // Still not found after reload — clean up stale pulse state to prevent stuck entries
        console.log(`[ChatStore] selectConversation: ${conversationId} not found after reload, cleaning up stale state`)
        set((s) => {
          const newUnseenCompletions = new Map(s.unseenCompletions)
          newUnseenCompletions.delete(conversationId)
          const newPulseReadAt = new Map(s.pulseReadAt)
          newPulseReadAt.delete(conversationId)
          return { unseenCompletions: newUnseenCompletions, pulseReadAt: newPulseReadAt }
        })
        return
      }
    }

    // Subscribe to conversation events (for remote mode)
    api.subscribeToConversation(conversationId)

    // Update the pointer + move unseen/error items to readAt grace period
    set((state) => {
      const newSpaceStates = new Map(state.spaceStates)
      const latestSpaceState = newSpaceStates.get(currentSpaceId!)
      if (!latestSpaceState) return state
      newSpaceStates.set(currentSpaceId!, {
        ...latestSpaceState,
        currentConversationId: conversationId
      })

      const newUnseenCompletions = new Map(state.unseenCompletions)
      const newPulseReadAt = new Map(state.pulseReadAt)
      const newSessions = new Map(state.sessions)
      const now = Date.now()

      // If this conversation had an unseen completion, move to readAt grace period
      const unseenInfo = newUnseenCompletions.get(conversationId)
      if (unseenInfo) {
        newPulseReadAt.set(conversationId, {
          readAt: now,
          originalStatus: 'completed-unseen',
          spaceId: unseenInfo.spaceId,
          title: unseenInfo.title
        })
        newUnseenCompletions.delete(conversationId)
      }

      // If this conversation had an error session, move to readAt grace period and clear session error
      // The error is now persisted in message.error and will render from MessageItem on reload
      const session = newSessions.get(conversationId)
      if (session?.error && session.errorType !== 'interrupted') {
        // Find conversation meta for title/spaceId
        let meta: ConversationMeta | undefined
        for (const [, ss] of state.spaceStates) {
          meta = ss.conversations.find(c => c.id === conversationId)
          if (meta) break
        }
        newPulseReadAt.set(conversationId, {
          readAt: now,
          originalStatus: 'error',
          spaceId: meta?.spaceId || currentSpaceId,
          title: meta?.title || 'Conversation'
        })
        // Clear session error — persisted error in message.error handles display after reload
        newSessions.set(conversationId, {
          ...session,
          error: null,
          errorType: null
        })
      }

      return {
        spaceStates: newSpaceStates,
        unseenCompletions: newUnseenCompletions,
        pulseReadAt: newPulseReadAt,
        sessions: newSessions
      }
    })

    // Ensure store-level cleanup is scheduled (independent of sidebar mount state)
    get().cleanupPulseReadAt()

    // Load full conversation if not in cache
    if (!get().conversationCache.has(conversationId)) {
      set({ isLoadingConversation: true })
      console.log(`[ChatStore] Loading full conversation: ${conversationId}`)

      try {
        const response = await api.getConversation(currentSpaceId, conversationId)
        if (response.success && response.data) {
          const fullConversation = response.data as Conversation

          set((state) => {
            const newCache = new Map(state.conversationCache)
            newCache.set(conversationId, fullConversation)

            // LRU eviction
            if (newCache.size > CONVERSATION_CACHE_SIZE) {
              const firstKey = newCache.keys().next().value
              if (firstKey) newCache.delete(firstKey)
            }

            return { conversationCache: newCache, isLoadingConversation: false }
          })
          console.log(`[ChatStore] Loaded conversation with ${fullConversation.messages?.length || 0} messages`)
        } else {
          set({ isLoadingConversation: false })
        }
      } catch (error) {
        console.error('[ChatStore] Failed to load conversation:', error)
        set({ isLoadingConversation: false })
      }
    }

    // Check if this conversation has an active session and recover thoughts
    try {
      const response = await api.getSessionState(conversationId)
      if (response.success && response.data) {
        const sessionState = response.data as { isActive: boolean; thoughts: Thought[]; spaceId?: string }

        if (sessionState.isActive && sessionState.thoughts.length > 0) {
          console.log(`[ChatStore] Recovering ${sessionState.thoughts.length} thoughts for conversation ${conversationId}`)

          set((state) => {
            const newSessions = new Map(state.sessions)
            const existingSession = newSessions.get(conversationId) || createEmptySessionState()

            newSessions.set(conversationId, {
              ...existingSession,
              isGenerating: true,
              isThinking: true,
              thoughts: sessionState.thoughts
            })

            return { sessions: newSessions }
          })
        }
      }
    } catch (error) {
      console.error('[ChatStore] Failed to recover session state:', error)
    }

    // Warm up V2 Session in background - non-blocking
    // When user sends a message, V2 Session is ready to avoid delay
    try {
      api.ensureSessionWarm(currentSpaceId, conversationId)
        .catch((error) => console.error('[ChatStore] Session warm up failed:', error))
    } catch (error) {
      console.error('[ChatStore] Failed to trigger session warm up:', error)
    }
  },

  // Delete conversation
  deleteConversation: async (spaceId, conversationId) => {
    try {
      const response = await api.deleteConversation(spaceId, conversationId)

      if (response.success) {
        set((state) => {
          // Clean up session state
          const newSessions = new Map(state.sessions)
          newSessions.delete(conversationId)

          // Clean up cache
          const newCache = new Map(state.conversationCache)
          newCache.delete(conversationId)

          // Clean up unseen completions
          const newUnseenCompletions = new Map(state.unseenCompletions)
          newUnseenCompletions.delete(conversationId)

          // Clean up pulse read-at grace period
          const newPulseReadAt = new Map(state.pulseReadAt)
          newPulseReadAt.delete(conversationId)

          // Update space state
          const newSpaceStates = new Map(state.spaceStates)
          const existingState = newSpaceStates.get(spaceId) || createEmptySpaceState()
          const newConversations = existingState.conversations.filter((c) => c.id !== conversationId)

          newSpaceStates.set(spaceId, {
            conversations: newConversations,
            currentConversationId:
              existingState.currentConversationId === conversationId
                ? (newConversations[0]?.id || null)
                : existingState.currentConversationId
          })

          return {
            spaceStates: newSpaceStates,
            sessions: newSessions,
            conversationCache: newCache,
            unseenCompletions: newUnseenCompletions,
            pulseReadAt: newPulseReadAt
          }
        })

        return true
      }

      return false
    } catch (error) {
      console.error('Failed to delete conversation:', error)
      return false
    }
  },

  // Rename conversation
  renameConversation: async (spaceId, conversationId, newTitle) => {
    try {
      const response = await api.updateConversation(spaceId, conversationId, { title: newTitle })

      if (response.success) {
        set((state) => {
          // Update cache if exists
          const newCache = new Map(state.conversationCache)
          const cached = newCache.get(conversationId)
          if (cached) {
            newCache.set(conversationId, {
              ...cached,
              title: newTitle,
              updatedAt: new Date().toISOString()
            })
          }

          // Update space state metadata
          const newSpaceStates = new Map(state.spaceStates)
          const existingState = newSpaceStates.get(spaceId)
          if (existingState) {
            newSpaceStates.set(spaceId, {
              ...existingState,
              conversations: existingState.conversations.map((c) =>
                c.id === conversationId
                  ? { ...c, title: newTitle, updatedAt: new Date().toISOString() }
                  : c
              )
            })
          }

          return {
            spaceStates: newSpaceStates,
            conversationCache: newCache
          }
        })

        return true
      }

      return false
    } catch (error) {
      console.error('Failed to rename conversation:', error)
      return false
    }
  },

  // Toggle star on a conversation
  toggleStarConversation: async (spaceId, conversationId, starred) => {
    try {
      const response = await api.toggleStarConversation(spaceId, conversationId, starred)
      if (response.success) {
        set((state) => {
          // Update cache if exists
          const newCache = new Map(state.conversationCache)
          const cached = newCache.get(conversationId)
          if (cached) {
            newCache.set(conversationId, { ...cached, starred: starred || undefined })
          }

          // Update space state metadata
          const newSpaceStates = new Map(state.spaceStates)
          const existingState = newSpaceStates.get(spaceId)
          if (existingState) {
            newSpaceStates.set(spaceId, {
              ...existingState,
              conversations: existingState.conversations.map((c) =>
                c.id === conversationId ? { ...c, starred: starred || undefined } : c
              )
            })
          }

          return { spaceStates: newSpaceStates, conversationCache: newCache }
        })
        return true
      }
      return false
    } catch (error) {
      console.error('Failed to toggle star:', error)
      return false
    }
  },
})
