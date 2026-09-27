/**
 * createSessionSlice — session slice of the chat store.
 */
import type { ChatSlice } from './internal'
import { PULSE_READ_GRACE_PERIOD_MS, api, createEmptySessionState } from './internal'
import type { Thought, PulseReadInfo } from './internal'

// Store-level timer for pulseReadAt cleanup (independent of UI components)
let _pulseCleanupTimer: ReturnType<typeof setTimeout> | null = null

type TaskStateRow = {
  conversationId: string
  spaceId: string
  title: string
  state: 'unseen' | 'read'
  originalStatus: 'completed-unseen' | 'error' | null
  readAt: number | null
  kept: boolean
}

/** Splits persisted rows into the two Maps chat.store tracks locally. */
function splitTaskStateRows(rows: TaskStateRow[]): {
  unseenCompletions: Map<string, { spaceId: string; title: string }>
  pulseReadAt: Map<string, PulseReadInfo>
} {
  const unseenCompletions = new Map<string, { spaceId: string; title: string }>()
  const pulseReadAt = new Map<string, PulseReadInfo>()
  for (const row of rows) {
    if (row.state === 'unseen') {
      unseenCompletions.set(row.conversationId, { spaceId: row.spaceId, title: row.title })
    } else if (row.readAt !== null && row.originalStatus !== null) {
      pulseReadAt.set(row.conversationId, {
        readAt: row.readAt,
        originalStatus: row.originalStatus,
        spaceId: row.spaceId,
        title: row.title,
        kept: row.kept,
      })
    }
  }
  return { unseenCompletions, pulseReadAt }
}

export const createSessionSlice: ChatSlice<'answerQuestion' | 'loadMessageThoughts' | 'cleanupPulseReadAt' | 'keepPulseItem' | 'removePulseItem' | 'loadPersistedTaskState' | 'syncPersistedTaskState' | 'resetSession' | 'setSessionError' | 'markSessionStopped' | 'reset' | 'resetSpace'> = (set, get) => ({
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

  // Remove expired pulse readAt entries and schedule next cleanup. `kept`
  // entries (user clicked "Keep") never expire, so they're excluded from
  // both deletion and the "when's the next check due" calculation.
  cleanupPulseReadAt: () => {
    if (_pulseCleanupTimer) { clearTimeout(_pulseCleanupTimer); _pulseCleanupTimer = null }
    const now = Date.now()
    const state = get()
    const newPulseReadAt = new Map(state.pulseReadAt)
    let changed = false
    let earliest = Infinity
    for (const [id, info] of newPulseReadAt) {
      if (info.kept) continue
      if (now - info.readAt >= PULSE_READ_GRACE_PERIOD_MS) {
        newPulseReadAt.delete(id)
        changed = true
      } else {
        earliest = Math.min(earliest, info.readAt)
      }
    }
    if (changed) {
      set({ pulseReadAt: newPulseReadAt })
    }
    // Schedule next cleanup if any non-kept entries remain
    if (earliest !== Infinity) {
      const delay = Math.max(0, earliest + PULSE_READ_GRACE_PERIOD_MS - now)
      _pulseCleanupTimer = setTimeout(() => get().cleanupPulseReadAt(), delay)
    }
  },

  // "Keep" — cancel the auto-removal timer, the item stays in the pulse
  // list until explicitly removed or re-opened. Does not touch the
  // underlying conversation/task, only this UI-side bookkeeping entry.
  keepPulseItem: (conversationId: string) => {
    set((state) => {
      const info = state.pulseReadAt.get(conversationId)
      if (!info || info.kept) return state
      const newPulseReadAt = new Map(state.pulseReadAt)
      newPulseReadAt.set(conversationId, { ...info, kept: true })
      return { pulseReadAt: newPulseReadAt }
    })
    api.taskSetKept(conversationId, true).catch(err =>
      console.error('[ChatStore] taskSetKept error:', err))
  },

  // "Remove" — hide immediately. Only clears this UI-side grace-period
  // entry; the conversation and its history are untouched.
  removePulseItem: (conversationId: string) => {
    set((state) => {
      if (!state.pulseReadAt.has(conversationId)) return state
      const newPulseReadAt = new Map(state.pulseReadAt)
      newPulseReadAt.delete(conversationId)
      return { pulseReadAt: newPulseReadAt }
    })
    api.taskRemoveState(conversationId).catch(err =>
      console.error('[ChatStore] taskRemoveState error:', err))
  },

  // Cold-start hydration from the persisted task-state table (platform/task-state),
  // so completed-but-unseen conversations and in-progress grace periods survive
  // an app restart instead of only living in this renderer-memory Map.
  //
  // Merge-only: never overwrites an entry already present locally, since by
  // the time this resolves the user may already have generated fresher local
  // state (e.g. selected a conversation) that must not be clobbered.
  loadPersistedTaskState: async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await api.taskListState()
      if (res.success) {
        const { unseenCompletions: fetched, pulseReadAt: fetchedRead } = splitTaskStateRows((res.data ?? []) as TaskStateRow[])

        set((state) => {
          const unseenCompletions = new Map(state.unseenCompletions)
          const pulseReadAt = new Map(state.pulseReadAt)
          for (const [id, info] of fetched) {
            if (!unseenCompletions.has(id) && !pulseReadAt.has(id)) unseenCompletions.set(id, info)
          }
          for (const [id, info] of fetchedRead) {
            if (!unseenCompletions.has(id) && !pulseReadAt.has(id)) pulseReadAt.set(id, info)
          }
          return { unseenCompletions, pulseReadAt }
        })
        // Purges any rows that already expired while the app was closed, and
        // (re)schedules the timer for the rest — same self-healing pass the
        // 60s in-session timer already runs on every tick.
        get().cleanupPulseReadAt()
        return
      }
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)))
    }
    console.error('[ChatStore] loadPersistedTaskState: giving up after 5 attempts')
  },

  // Full resync triggered by a `task:state_changed` push — see internal.ts
  // for why this replaces rather than merges.
  syncPersistedTaskState: async () => {
    const res = await api.taskListState()
    if (!res.success) return
    const { unseenCompletions, pulseReadAt } = splitTaskStateRows((res.data ?? []) as TaskStateRow[])
    set({ unseenCompletions, pulseReadAt })
    get().cleanupPulseReadAt()
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

  // Settle a session's generating state after a stop was requested, keeping
  // messages and thoughts intact. Callers must not wait for agent:complete to
  // do this: the backend swallows the abort on several paths (team mode kills
  // the subprocess, so the stream rejects and no event is emitted at all), and
  // even on the normal path the event may only arrive after the drain timeout.
  markSessionStopped: (conversationId: string) => {
    set((state) => {
      const session = state.sessions.get(conversationId)
      if (!session) return state
      const newSessions = new Map(state.sessions)
      newSessions.set(conversationId, {
        ...session,
        isGenerating: false,
        isThinking: false,
        pendingQuestion: session.pendingQuestion?.status === 'active'
          ? { ...session.pendingQuestion, status: 'cancelled' as const }
          : session.pendingQuestion,
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
      pendingComposerInput: null,
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
