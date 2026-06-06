/**
 * createSessionSlice — session slice of the chat store.
 */
import type { ChatSlice } from './internal'
import { PULSE_READ_GRACE_PERIOD_MS, api, createEmptySessionState } from './internal'
import type { Thought } from './internal'

// Store-level timer for pulseReadAt cleanup (independent of UI components)
let _pulseCleanupTimer: ReturnType<typeof setTimeout> | null = null

export const createSessionSlice: ChatSlice<'answerQuestion' | 'loadMessageThoughts' | 'cleanupPulseReadAt' | 'resetSession' | 'setSessionError' | 'reset' | 'resetSpace'> = (set, get) => ({
  answerQuestion: async (conversationId: string, answers: Record<string, string>) => {
    const session = get().sessions.get(conversationId)
    if (!session?.pendingQuestion) {
      console.warn(`[ChatStore] No pending question for conversation: ${conversationId}`)
      return
    }

    const { id } = session.pendingQuestion

    try {
      await api.answerQuestion({ conversationId, id, answers })

      // Mark as answered
      set((state) => {
        const newSessions = new Map(state.sessions)
        const currentSession = newSessions.get(conversationId)
        if (currentSession?.pendingQuestion) {
          newSessions.set(conversationId, {
            ...currentSession,
            pendingQuestion: {
              ...currentSession.pendingQuestion,
              status: 'answered',
              answers
            }
          })
        }
        return { sessions: newSessions }
      })
    } catch (error) {
      console.error('[ChatStore] Failed to answer question:', error)
    }
  },

  // Load thoughts for a specific message (lazy loading from separated storage)
  // Returns the thoughts array and updates the conversation cache so subsequent reads are instant
  loadMessageThoughts: async (spaceId: string, conversationId: string, messageId: string): Promise<Thought[]> => {
    // Check if already loaded in cache
    const cached = get().conversationCache.get(conversationId)
    if (cached) {
      const msg = cached.messages.find(m => m.id === messageId)
      if (msg && Array.isArray(msg.thoughts)) {
        console.log(`[ChatStore] Thoughts cache hit for ${conversationId}/${messageId}: ${msg.thoughts.length} thoughts`)
        return msg.thoughts  // Already loaded
      }
    }

    console.log(`[ChatStore] Loading thoughts for ${conversationId}/${messageId}...`)
    try {
      const response = await api.getMessageThoughts(spaceId, conversationId, messageId)
      if (response.success && response.data) {
        const thoughts = response.data as Thought[]
        console.log(`[ChatStore] Loaded ${thoughts.length} thoughts for ${conversationId}/${messageId}, updating cache`)

        // Update the conversation cache with loaded thoughts
        set((state) => {
          const newCache = new Map(state.conversationCache)
          const conversation = newCache.get(conversationId)
          if (conversation) {
            const updatedMessages = conversation.messages.map(m =>
              m.id === messageId ? { ...m, thoughts } : m
            )
            newCache.set(conversationId, { ...conversation, messages: updatedMessages })
          }
          return { conversationCache: newCache }
        })

        return thoughts
      }
    } catch (error) {
      console.error(`[ChatStore] Failed to load thoughts for ${conversationId}/${messageId}:`, error)
    }

    return []
  },

  // Remove expired pulse readAt entries and schedule next cleanup
  cleanupPulseReadAt: () => {
    if (_pulseCleanupTimer) { clearTimeout(_pulseCleanupTimer); _pulseCleanupTimer = null }
    const now = Date.now()
    const state = get()
    const newPulseReadAt = new Map(state.pulseReadAt)
    let changed = false
    for (const [id, info] of newPulseReadAt) {
      if (now - info.readAt >= PULSE_READ_GRACE_PERIOD_MS) {
        newPulseReadAt.delete(id)
        changed = true
      }
    }
    if (changed) {
      set({ pulseReadAt: newPulseReadAt })
    }
    // Schedule next cleanup if entries remain
    if (newPulseReadAt.size > 0) {
      let earliest = Infinity
      for (const [, info] of newPulseReadAt) {
        earliest = Math.min(earliest, info.readAt)
      }
      const delay = Math.max(0, earliest + PULSE_READ_GRACE_PERIOD_MS - now)
      _pulseCleanupTimer = setTimeout(() => get().cleanupPulseReadAt(), delay)
    }
  },

  // Reset a specific session to empty state (e.g., clear app chat, before new send)
  resetSession: (conversationId: string) => {
    set((state) => {
      const newSessions = new Map(state.sessions)
      newSessions.set(conversationId, createEmptySessionState())
      return { sessions: newSessions }
    })
  },

  // Set error state on a session (e.g., app chat send failure)
  setSessionError: (conversationId: string, error: string) => {
    set((state) => {
      const newSessions = new Map(state.sessions)
      const session = newSessions.get(conversationId) || createEmptySessionState()
      newSessions.set(conversationId, {
        ...session,
        error,
        isGenerating: false,
        isThinking: false,
      })
      return { sessions: newSessions }
    })
  },

  // Reset all state (use sparingly - e.g., logout)
  reset: () => {
    if (_pulseCleanupTimer) { clearTimeout(_pulseCleanupTimer); _pulseCleanupTimer = null }
    set({
      spaceStates: new Map(),
      conversationCache: new Map(),
      sessions: new Map(),
      sessionInitInfo: new Map(),
      unseenCompletions: new Map(),
      pulseReadAt: new Map(),
      currentSpaceId: null,
      pendingPulseNavigation: null,
      artifacts: [],
      isLoadingConversation: false,
      _pulseItems: [],
      _pulseCount: 0
    })
  },

  // Reset a specific space's state — cleans up all conversation-level data
  // associated with the space (cache, sessions, pulse entries).
  // Called when a space is deleted to prevent orphan data.
  resetSpace: (spaceId: string) => {
    set((state) => {
      // Collect conversationIds belonging to this space before removing the entry
      const spaceState = state.spaceStates.get(spaceId)
      const orphanIds = new Set(
        spaceState?.conversations.map(c => c.id) ?? []
      )

      const newSpaceStates = new Map(state.spaceStates)
      newSpaceStates.delete(spaceId)

      // Clean up conversation-level maps for orphan IDs
      const newCache = new Map(state.conversationCache)
      const newSessions = new Map(state.sessions)
      const newUnseen = new Map(state.unseenCompletions)
      const newPulseReadAt = new Map(state.pulseReadAt)

      for (const id of orphanIds) {
        newCache.delete(id)
        newSessions.delete(id)
        newUnseen.delete(id)
        newPulseReadAt.delete(id)
      }

      // Also clean unseenCompletions/pulseReadAt that reference this spaceId
      // but weren't in the conversations list (e.g. completed after last metadata load)
      for (const [id, info] of newUnseen) {
        if (info.spaceId === spaceId) newUnseen.delete(id)
      }
      for (const [id, info] of newPulseReadAt) {
        if (info.spaceId === spaceId) newPulseReadAt.delete(id)
      }

      return {
        spaceStates: newSpaceStates,
        conversationCache: newCache,
        sessions: newSessions,
        unseenCompletions: newUnseen,
        pulseReadAt: newPulseReadAt,
      }
    })
  }
})
