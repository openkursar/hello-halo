/**
 * Chat Store - Conversation and messaging state
 *
 * Architecture:
 * - spaceStates: Map<spaceId, SpaceState> - conversation metadata organized by space
 * - conversationCache: Map<conversationId, Conversation> - full conversations loaded on-demand
 * - sessions: Map<conversationId, SessionState> - runtime state per conversation (cross-space)
 * - currentSpaceId: pointer to active space
 *
 * Performance optimization:
 * - listConversations returns lightweight ConversationMeta (no messages)
 * - Full conversation loaded on-demand when selecting
 * - LRU cache for recently accessed conversations
 *
 * This allows:
 * - Fast space switching (only metadata loaded)
 * - Space switching without losing session states
 * - Multiple conversations running in parallel across spaces
 * - Clean separation of concerns
 */

import { create } from 'zustand'
import { api } from '../api'
import type { Conversation, ConversationMeta, Message, ToolCall, Artifact, Thought, AgentEventBase, ImageAttachment, CompactInfo, CanvasContext, AgentErrorType, PendingQuestion, Question, TaskStatus, PulseItem } from '../types'
import { PULSE_READ_GRACE_PERIOD_MS } from '../types'
import { canvasLifecycle } from '../services/canvas-lifecycle'

// LRU cache size limit
const CONVERSATION_CACHE_SIZE = 10

// Store-level timer for pulseReadAt cleanup (independent of UI components)
let _pulseCleanupTimer: ReturnType<typeof setTimeout> | null = null

// Per-space state (conversations metadata belong to a space)
interface SpaceState {
  conversations: ConversationMeta[]  // Lightweight metadata, no messages
  currentConversationId: string | null
}

// Per-session runtime state (isolated per conversation, persists across space switches)
interface SessionState {
  isGenerating: boolean
  streamingContent: string
  isStreaming: boolean  // True during token-level text streaming
  thoughts: Thought[]
  isThinking: boolean
  pendingToolApproval: ToolCall | null
  error: string | null
  errorType: AgentErrorType | null  // Special error type for custom UI handling
  // Compact notification
  compactInfo: CompactInfo | null
  // Text block version - increments on each new text block (for StreamingBubble reset)
  textBlockVersion: number
  // Pending question from AskUserQuestion tool
  pendingQuestion: PendingQuestion | null
}

// Create empty session state
function createEmptySessionState(): SessionState {
  return {
    isGenerating: false,
    streamingContent: '',
    isStreaming: false,
    thoughts: [],
    isThinking: false,
    pendingToolApproval: null,
    error: null,
    errorType: null,
    compactInfo: null,
    textBlockVersion: 0,
    pendingQuestion: null
  }
}

// Create empty space state
function createEmptySpaceState(): SpaceState {
  return {
    conversations: [],
    currentConversationId: null
  }
}

interface ChatState {
  // Per-space state: Map<spaceId, SpaceState>
  spaceStates: Map<string, SpaceState>

  // Conversation cache: Map<conversationId, Conversation>
  // Full conversations loaded on-demand, with LRU eviction
  conversationCache: Map<string, Conversation>

  // Per-session runtime state: Map<conversationId, SessionState>
  // This persists across space switches - background tasks keep running
  sessions: Map<string, SessionState>

  // Pulse: tracks conversations that completed while user was not viewing them
  // Map<conversationId, { spaceId: string; title: string }>
  unseenCompletions: Map<string, { spaceId: string; title: string }>

  // Pulse: tracks read timestamps for grace period display (60s before removal)
  // Map<conversationId, { readAt: number; originalStatus: 'completed-unseen' | 'error'; spaceId: string; title: string }>
  pulseReadAt: Map<string, { readAt: number; originalStatus: 'completed-unseen' | 'error'; spaceId: string; title: string }>

  // Current space pointer
  currentSpaceId: string | null

  // Pulse: pending cross-space navigation target (set by navigateToConversation, consumed by SpacePage init)
  pendingPulseNavigation: string | null

  // Artifacts (per space)
  artifacts: Artifact[]

  // Loading
  isLoading: boolean
  isLoadingConversation: boolean  // Loading full conversation

  // Computed getters
  getCurrentSpaceState: () => SpaceState
  getSpaceState: (spaceId: string) => SpaceState
  getCurrentConversation: () => Conversation | null
  getCurrentConversationMeta: () => ConversationMeta | null
  getCurrentSession: () => SessionState
  getSession: (conversationId: string) => SessionState
  getConversations: () => ConversationMeta[]
  getCurrentConversationId: () => string | null
  getCachedConversation: (conversationId: string) => Conversation | null

  // Space actions
  setCurrentSpace: (spaceId: string) => void

  // Conversation actions
  loadConversations: (spaceId: string) => Promise<void>
  preloadAllSpaceConversations: (spaceIds: string[]) => void
  createConversation: (spaceId: string) => Promise<Conversation | null>
  selectConversation: (conversationId: string) => void
  deleteConversation: (spaceId: string, conversationId: string) => Promise<boolean>
  renameConversation: (spaceId: string, conversationId: string, newTitle: string) => Promise<boolean>
  toggleStarConversation: (spaceId: string, conversationId: string, starred: boolean) => Promise<boolean>

  // Messaging
  sendMessage: (content: string, images?: ImageAttachment[], aiBrowserEnabled?: boolean, thinkingEnabled?: boolean) => Promise<void>
  stopGeneration: (conversationId?: string) => Promise<void>

  // Tool approval
  approveTool: (conversationId: string) => Promise<void>
  rejectTool: (conversationId: string) => Promise<void>

  // Error handling
  continueAfterInterrupt: (conversationId: string) => void

  // Event handlers (called from App component) - with session IDs
  handleAgentMessage: (data: AgentEventBase & { content: string; isComplete: boolean }) => void
  handleAgentToolCall: (data: AgentEventBase & ToolCall) => void
  handleAgentToolResult: (data: AgentEventBase & { toolId: string; result: string; isError: boolean }) => void
  handleAgentError: (data: AgentEventBase & { error: string; errorType?: AgentErrorType }) => void
  handleAgentComplete: (data: AgentEventBase) => void
  handleAgentThought: (data: AgentEventBase & { thought: Thought }) => void
  handleAgentThoughtDelta: (data: AgentEventBase & {
    thoughtId: string
    delta?: string
    content?: string
    toolInput?: Record<string, unknown>
    isComplete?: boolean
    isReady?: boolean
    isToolInput?: boolean
    toolResult?: { output: string; isError: boolean; timestamp: string }
    isToolResult?: boolean
  }) => void
  handleAgentCompact: (data: AgentEventBase & { trigger: 'manual' | 'auto'; preTokens: number }) => void

  // AskUserQuestion handlers
  handleAskQuestion: (data: AgentEventBase & { id: string; questions: Question[] }) => void
  answerQuestion: (conversationId: string, answers: Record<string, string>) => Promise<void>

  // Thoughts lazy loading
  loadMessageThoughts: (spaceId: string, conversationId: string, messageId: string) => Promise<Thought[]>

  // Pulse cleanup
  cleanupPulseReadAt: () => void

  // Derived pulse state (cached, recalculated only when pulse-relevant fields change)
  _pulseItems: PulseItem[]
  _pulseCount: number

  // Cleanup
  reset: () => void
  resetSpace: (spaceId: string) => void
}

// Default empty states
const EMPTY_SESSION: SessionState = createEmptySessionState()
const EMPTY_SPACE_STATE: SpaceState = createEmptySpaceState()

export const useChatStore = create<ChatState>((set, get) => ({
  // Initial state
  spaceStates: new Map<string, SpaceState>(),
  conversationCache: new Map<string, Conversation>(),
  sessions: new Map<string, SessionState>(),
  unseenCompletions: new Map<string, { spaceId: string; title: string }>(),
  pulseReadAt: new Map<string, { readAt: number; originalStatus: 'completed-unseen' | 'error'; spaceId: string; title: string }>(),
  currentSpaceId: null,
  pendingPulseNavigation: null,
  artifacts: [],
  isLoading: false,
  isLoadingConversation: false,
  _pulseItems: [],
  _pulseCount: 0,

  // Get current space state
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

  // Set current space (called when entering a space)
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
          preview: undefined
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
    const { currentSpaceId, spaceStates, conversationCache } = get()
    if (!currentSpaceId) return

    const spaceState = spaceStates.get(currentSpaceId)
    if (!spaceState) return

    const conversationMeta = spaceState.conversations.find((c) => c.id === conversationId)
    if (!conversationMeta) return

    // Subscribe to conversation events (for remote mode)
    api.subscribeToConversation(conversationId)

    // Update the pointer + move unseen/error items to readAt grace period
    set((state) => {
      const newSpaceStates = new Map(state.spaceStates)
      newSpaceStates.set(currentSpaceId, {
        ...spaceState,
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
    if (!conversationCache.has(conversationId)) {
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

  // Send message (with optional images for multi-modal, optional AI Browser and thinking mode)
  sendMessage: async (content, images, aiBrowserEnabled, thinkingEnabled) => {
    const conversation = get().getCurrentConversation()
    const conversationMeta = get().getCurrentConversationMeta()
    const { currentSpaceId } = get()

    if ((!conversation && !conversationMeta) || !currentSpaceId) {
      console.error('[ChatStore] No conversation or space selected')
      return
    }

    const conversationId = conversationMeta?.id || conversation?.id
    if (!conversationId) return

    try {
      // Initialize/reset session state for this conversation
      set((state) => {
        const newSessions = new Map(state.sessions)
        newSessions.set(conversationId, {
          isGenerating: true,
          streamingContent: '',
          isStreaming: false,
          thoughts: [],
          isThinking: true,
          pendingToolApproval: null,
          error: null,
          errorType: null,
          compactInfo: null,
          textBlockVersion: 0,
          pendingQuestion: null
        })
        return { sessions: newSessions }
      })

      // Add user message to UI immediately (update cache if exists)
      const userMessage: Message = {
        id: `msg-${Date.now()}`,
        role: 'user',
        content,
        timestamp: new Date().toISOString(),
        images: images  // Include images in message for display
      }

      set((state) => {
        // Update cache if conversation is loaded
        const newCache = new Map(state.conversationCache)
        const cached = newCache.get(conversationId)
        if (cached) {
          newCache.set(conversationId, {
            ...cached,
            messages: [...cached.messages, userMessage],
            updatedAt: new Date().toISOString()
          })
        }

        // Update metadata (messageCount)
        const newSpaceStates = new Map(state.spaceStates)
        const spaceState = newSpaceStates.get(currentSpaceId)
        if (spaceState) {
          newSpaceStates.set(currentSpaceId, {
            ...spaceState,
            conversations: spaceState.conversations.map((c) =>
              c.id === conversationId
                ? { ...c, messageCount: c.messageCount + 1, updatedAt: new Date().toISOString() }
                : c
            )
          })
        }
        return { spaceStates: newSpaceStates, conversationCache: newCache }
      })

      // Build Canvas Context for AI awareness
      // This allows AI to naturally understand what the user is currently viewing
      const buildCanvasContext = (): CanvasContext | undefined => {
        if (!canvasLifecycle.getIsOpen() || canvasLifecycle.getTabCount() === 0) {
          return undefined
        }

        const tabs = canvasLifecycle.getTabs()
        const activeTabId = canvasLifecycle.getActiveTabId()
        const activeTab = canvasLifecycle.getActiveTab()

        return {
          isOpen: true,
          tabCount: tabs.length,
          activeTab: activeTab ? {
            type: activeTab.type,
            title: activeTab.title,
            url: activeTab.url,
            path: activeTab.path
          } : null,
          tabs: tabs.map(t => ({
            type: t.type,
            title: t.title,
            url: t.url,
            path: t.path,
            isActive: t.id === activeTabId
          }))
        }
      }

      // Send to agent (with images, AI Browser state, thinking mode, and canvas context)
      await api.sendMessage({
        spaceId: currentSpaceId,
        conversationId,
        message: content,
        images: images,  // Pass images to API
        aiBrowserEnabled,  // Pass AI Browser state to API
        thinkingEnabled,  // Pass thinking mode to API
        canvasContext: buildCanvasContext()  // Pass canvas context for AI awareness
      })
    } catch (error) {
      console.error('Failed to send message:', error)
      // Update session error state
      set((state) => {
        const newSessions = new Map(state.sessions)
        const session = newSessions.get(conversationId) || createEmptySessionState()
        newSessions.set(conversationId, {
          ...session,
          error: 'Failed to send message',
          isGenerating: false,
          isThinking: false
        })
        return { sessions: newSessions }
      })
    }
  },

  // Stop generation for a specific conversation
  stopGeneration: async (conversationId?: string) => {
    const targetId = conversationId || get().getCurrentSpaceState().currentConversationId
    try {
      await api.stopGeneration(targetId)

      if (targetId) {
        set((state) => {
          const newSessions = new Map(state.sessions)
          const session = newSessions.get(targetId)
          if (session) {
            newSessions.set(targetId, {
              ...session,
              isGenerating: false,
              isThinking: false,
              // Mark pending question as cancelled on stop
              pendingQuestion: session.pendingQuestion?.status === 'active'
                ? { ...session.pendingQuestion, status: 'cancelled' as const }
                : session.pendingQuestion
            })
          }
          return { sessions: newSessions }
        })
      }
    } catch (error) {
      console.error('Failed to stop generation:', error)
    }
  },

  // Approve tool for a specific conversation
  approveTool: async (conversationId: string) => {
    try {
      await api.approveTool(conversationId)
      set((state) => {
        const newSessions = new Map(state.sessions)
        const session = newSessions.get(conversationId)
        if (session) {
          newSessions.set(conversationId, { ...session, pendingToolApproval: null })
        }
        return { sessions: newSessions }
      })
    } catch (error) {
      console.error('Failed to approve tool:', error)
    }
  },

  // Reject tool for a specific conversation
  rejectTool: async (conversationId: string) => {
    try {
      await api.rejectTool(conversationId)
      set((state) => {
        const newSessions = new Map(state.sessions)
        const session = newSessions.get(conversationId)
        if (session) {
          newSessions.set(conversationId, { ...session, pendingToolApproval: null })
        }
        return { sessions: newSessions }
      })
    } catch (error) {
      console.error('Failed to reject tool:', error)
    }
  },

  // Continue conversation after interrupt (used by InterruptedBubble)
  // Clears error state and sends a "continue" message to AI to resume the interrupted response
  continueAfterInterrupt: (conversationId: string) => {
    // First clear the error state
    set((state) => {
      const newSessions = new Map(state.sessions)
      const session = newSessions.get(conversationId)
      if (session) {
        newSessions.set(conversationId, {
          ...session,
          error: null,
          errorType: null
        })
      }
      return { sessions: newSessions }
    })

    // Then send a "continue" message to AI
    const state = get()
    const spaceState = state.spaceStates.get(state.currentSpaceId || '')
    if (spaceState?.currentConversationId === conversationId) {
      state.sendMessage('continue')
    }
  },

  // Handle agent message - update session-specific streaming content
  // Supports both incremental (delta) and full (content) modes for backward compatibility
  handleAgentMessage: (data) => {
    const { conversationId, content, delta, isStreaming, isNewTextBlock } = data as AgentEventBase & {
      content?: string
      delta?: string
      isComplete: boolean
      isStreaming?: boolean
      isNewTextBlock?: boolean  // Signal from content_block_start (type='text')
    }

    set((state) => {
      const newSessions = new Map(state.sessions)
      const session = newSessions.get(conversationId) || createEmptySessionState()

      // New text block signal: increment version number
      // StreamingBubble detects version change to reset activeSnapshotLen
      const newTextBlockVersion = isNewTextBlock
        ? (session.textBlockVersion || 0) + 1
        : (session.textBlockVersion || 0)

      // Incremental mode: append delta to existing content
      // Full mode: replace directly (backward compatible)
      const newContent = delta
        ? (session.streamingContent || '') + delta
        : (content ?? session.streamingContent)

      newSessions.set(conversationId, {
        ...session,
        streamingContent: newContent,
        isStreaming: isStreaming ?? false,
        textBlockVersion: newTextBlockVersion
      })
      return { sessions: newSessions }
    })
  },

  // Handle tool call for a specific conversation
  handleAgentToolCall: (data) => {
    const { conversationId, ...toolCall } = data
    console.log(`[ChatStore] handleAgentToolCall [${conversationId}]:`, toolCall.name)

    if (toolCall.requiresApproval) {
      set((state) => {
        const newSessions = new Map(state.sessions)
        const session = newSessions.get(conversationId) || createEmptySessionState()
        newSessions.set(conversationId, {
          ...session,
          pendingToolApproval: toolCall as ToolCall
        })
        return { sessions: newSessions }
      })
    }
  },

  // Handle tool result for a specific conversation
  handleAgentToolResult: (data) => {
    const { conversationId, toolId } = data
    // console.log(`[ChatStore] handleAgentToolResult [${conversationId}]:`, toolId)
    // Tool results are tracked in thoughts, no additional state needed
  },

  // Handle error for a specific conversation
  handleAgentError: (data) => {
    const { conversationId, error, errorType } = data
    console.log(`[ChatStore] handleAgentError [${conversationId}]:`, error, errorType ? `(type: ${errorType})` : '')

    // Add error thought to session (only for non-interrupted errors)
    // Interrupted errors get special UI treatment, not shown as error thought
    const errorThought: Thought = {
      id: `thought-error-${Date.now()}`,
      type: 'error',
      content: error,
      timestamp: new Date().toISOString(),
      isError: true
    }

    set((state) => {
      const newSessions = new Map(state.sessions)
      const session = newSessions.get(conversationId) || createEmptySessionState()
      newSessions.set(conversationId, {
        ...session,
        error,
        errorType: errorType || null,
        isGenerating: false,
        isThinking: false,
        // Only add error thought for non-interrupted errors
        thoughts: errorType === 'interrupted' ? session.thoughts : [...session.thoughts, errorThought],
        // Mark pending question as cancelled on error
        pendingQuestion: session.pendingQuestion?.status === 'active'
          ? { ...session.pendingQuestion, status: 'cancelled' as const }
          : session.pendingQuestion
      })
      return { sessions: newSessions }
    })
  },

  // Handle complete - reload conversation from backend (Single Source of Truth)
  // Key: Only set isGenerating=false AFTER backend data is loaded to prevent flash
  handleAgentComplete: async (data) => {
    const { spaceId, conversationId } = data
    console.log(`[ChatStore] handleAgentComplete [${conversationId}]`)

    // Check if user is currently viewing this conversation
    const state = get()
    const currentSpaceState = state.currentSpaceId ? state.spaceStates.get(state.currentSpaceId) : null
    const isUserViewingThisConversation =
      state.currentSpaceId === spaceId &&
      currentSpaceState?.currentConversationId === conversationId

    // Track unseen completion if user is not viewing this conversation
    if (!isUserViewingThisConversation) {
      // Find the conversation title from any space state
      let title = 'Conversation'
      for (const [, ss] of state.spaceStates) {
        const meta = ss.conversations.find(c => c.id === conversationId)
        if (meta) { title = meta.title; break }
      }
      set((s) => {
        const newUnseenCompletions = new Map(s.unseenCompletions)
        newUnseenCompletions.set(conversationId, { spaceId, title })
        return { unseenCompletions: newUnseenCompletions }
      })
    }

    // First, just stop streaming indicator but keep isGenerating=true
    // This keeps the streaming bubble visible during backend load
    set((state) => {
      const newSessions = new Map(state.sessions)
      const session = newSessions.get(conversationId)
      if (session) {
        newSessions.set(conversationId, {
          ...session,
          isStreaming: false,
          isThinking: false
          // Keep isGenerating=true and streamingContent until backend loads
        })
      }
      return { sessions: newSessions }
    })

    // Reload conversation from backend (Single Source of Truth)
    // Backend has already saved the complete message with thoughts
    try {
      const response = await api.getConversation(spaceId, conversationId)
      if (response.success && response.data) {
        const updatedConversation = response.data as Conversation

        // Extract updated metadata
        const updatedMeta: ConversationMeta = {
          id: updatedConversation.id,
          spaceId: updatedConversation.spaceId,
          title: updatedConversation.title,
          createdAt: updatedConversation.createdAt,
          updatedAt: updatedConversation.updatedAt,
          messageCount: updatedConversation.messages?.length || 0,
          preview: updatedConversation.messages?.length
            ? updatedConversation.messages[updatedConversation.messages.length - 1].content.slice(0, 50)
            : undefined,
          starred: updatedConversation.starred
        }

        // Now atomically: update cache, metadata, AND clear session state
        // This prevents flash by doing all in one render
        set((state) => {
          // Update cache with fresh data
          const newCache = new Map(state.conversationCache)
          newCache.set(conversationId, updatedConversation)

          // Update metadata in space state
          const newSpaceStates = new Map(state.spaceStates)
          const currentSpaceState = newSpaceStates.get(spaceId)
          if (currentSpaceState) {
            newSpaceStates.set(spaceId, {
              ...currentSpaceState,
              conversations: currentSpaceState.conversations.map((c) =>
                c.id === conversationId ? updatedMeta : c
              )
            })
          }

          // Clear session state atomically with conversation update
          // Error is now persisted in message.error, so clear session-level error
          // Note: interrupted errors are sent AFTER agent:complete, so they won't be affected
          const newSessions = new Map(state.sessions)
          const currentSession = newSessions.get(conversationId)
          if (currentSession) {
            newSessions.set(conversationId, {
              ...currentSession,
              isGenerating: false,
              streamingContent: '',
              compactInfo: null,  // Clear temporary compact notification
              pendingQuestion: null,  // Clear pending question
              error: null,  // Clear session error — now persisted in message.error
              errorType: null
            })
          }

          return {
            spaceStates: newSpaceStates,
            sessions: newSessions,
            conversationCache: newCache
          }
        })
        console.log(`[ChatStore] Conversation reloaded from backend [${conversationId}]`)
      }
    } catch (error) {
      console.error('[ChatStore] Failed to reload conversation:', error)
      // Even on error, must clear state to avoid stale content
      set((state) => {
        const newSessions = new Map(state.sessions)
        const currentSession = newSessions.get(conversationId)
        if (currentSession) {
          newSessions.set(conversationId, {
            ...currentSession,
            isGenerating: false,
            streamingContent: '',
            compactInfo: null,  // Clear temporary compact notification
            pendingQuestion: null  // Clear pending question
          })
        }
        return { sessions: newSessions }
      })
    }
  },

  // Handle thought for a specific conversation
  handleAgentThought: (data) => {
    const { conversationId, thought } = data
    console.log(`[ChatStore] handleAgentThought [${conversationId}]:`, thought.type, thought.id)

    set((state) => {
      const newSessions = new Map(state.sessions)
      const session = newSessions.get(conversationId) || createEmptySessionState()

      // Check if thought with same id already exists (avoid duplicates after recovery)
      const existingIds = new Set(session.thoughts.map(t => t.id))
      if (existingIds.has(thought.id)) {
        console.log(`[ChatStore] Skipping duplicate thought: ${thought.id}`)
        return state // No change
      }

      newSessions.set(conversationId, {
        ...session,
        thoughts: [...session.thoughts, thought],
        isThinking: true,
        isGenerating: true // Ensure generating state is set
      })
      return { sessions: newSessions }
    })
  },

  // Handle thought delta - incremental update to a streaming thought
  handleAgentThoughtDelta: (data) => {
    const { conversationId, thoughtId, delta, content, toolInput, isComplete, isReady, isToolInput, toolResult, isToolResult } = data
    // Don't log every delta to reduce console noise (only log on complete or toolResult)
    if (isComplete || isToolResult) {
      console.log(`[ChatStore] handleAgentThoughtDelta [${conversationId}]: thought ${thoughtId} ${isToolResult ? 'toolResult merged' : 'complete'}`)
    }

    set((state) => {
      const newSessions = new Map(state.sessions)
      const session = newSessions.get(conversationId)
      if (!session) return state

      // Find the thought to update
      const thoughtIndex = session.thoughts.findIndex(t => t.id === thoughtId)
      if (thoughtIndex === -1) {
        console.warn(`[ChatStore] Thought not found for delta: ${thoughtId}`)
        return state
      }

      // Create updated thoughts array
      const newThoughts = [...session.thoughts]
      const thought = { ...newThoughts[thoughtIndex] }

      // Apply delta or content update
      if (isToolResult && toolResult) {
        // Tool result merge - add result to tool_use thought
        thought.toolResult = toolResult
      } else if (isToolInput) {
        // For tool input, we just track streaming state, don't update content
        // Content will be set on completion with toolInput
        if (isComplete && toolInput) {
          thought.toolInput = toolInput
          thought.isStreaming = false
          thought.isReady = isReady ?? true
        }
      } else {
        // For thinking/text content
        if (delta) {
          thought.content = (thought.content || '') + delta
        } else if (content !== undefined) {
          thought.content = content
        }

        if (isComplete) {
          thought.isStreaming = false
        }
      }

      newThoughts[thoughtIndex] = thought

      newSessions.set(conversationId, {
        ...session,
        thoughts: newThoughts
      })
      return { sessions: newSessions }
    })
  },

  // Handle compact notification - context was compressed
  handleAgentCompact: (data) => {
    const { conversationId, trigger, preTokens } = data
    console.log(`[ChatStore] handleAgentCompact [${conversationId}]: trigger=${trigger}, preTokens=${preTokens}`)

    set((state) => {
      const newSessions = new Map(state.sessions)
      const session = newSessions.get(conversationId) || createEmptySessionState()

      newSessions.set(conversationId, {
        ...session,
        compactInfo: { trigger, preTokens }
      })
      return { sessions: newSessions }
    })
  },

  // Handle AskUserQuestion - set pending question on session
  handleAskQuestion: (data) => {
    const { conversationId, id, questions } = data
    console.log(`[ChatStore] handleAskQuestion [${conversationId}]: id=${id}, questions=${questions?.length || 0}`)

    set((state) => {
      const newSessions = new Map(state.sessions)
      const session = newSessions.get(conversationId) || createEmptySessionState()

      newSessions.set(conversationId, {
        ...session,
        pendingQuestion: {
          id,
          questions: questions || [],
          status: 'active'
        }
      })
      return { sessions: newSessions }
    })
  },

  // Answer a pending AskUserQuestion
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

  // Reset all state (use sparingly - e.g., logout)
  reset: () => {
    if (_pulseCleanupTimer) { clearTimeout(_pulseCleanupTimer); _pulseCleanupTimer = null }
    set({
      spaceStates: new Map(),
      conversationCache: new Map(),
      sessions: new Map(),
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

  // Reset a specific space's state (use when needed)
  resetSpace: (spaceId: string) => {
    set((state) => {
      const newSpaceStates = new Map(state.spaceStates)
      newSpaceStates.delete(spaceId)
      return { spaceStates: newSpaceStates }
    })
  }
}))

// ==========================================
// Derived Pulse State — recalculates only when pulse-relevant fields change.
// During streaming, sessions change every token (streamingContent, thoughts, etc.)
// but pulse-relevant fields (isGenerating, pendingToolApproval, error, pendingQuestion)
// stay the same. We extract a fingerprint of only these fields and skip recalculation
// when the fingerprint is unchanged.
// ==========================================

/**
 * Extract a pulse-relevant fingerprint from sessions.
 * Only includes fields that affect deriveTaskStatus().
 */
function _extractPulseFingerprint(sessions: Map<string, SessionState>): string {
  const parts: string[] = []
  for (const [id, s] of sessions) {
    // Only include sessions that could produce non-idle status
    if (s.isGenerating || s.pendingToolApproval || s.error || s.pendingQuestion?.status === 'active') {
      parts.push(`${id}:${s.isGenerating ? 1 : 0}${s.pendingToolApproval ? 1 : 0}${s.error && s.errorType !== 'interrupted' ? 1 : 0}${s.pendingQuestion?.status === 'active' ? 1 : 0}`)
    }
  }
  return parts.join('|')
}

/**
 * Compute pulse items from state (same logic as the original usePulseItems selector).
 */
function _computePulseItems(state: ChatState): PulseItem[] {
  const items: PulseItem[] = []
  const addedIds = new Set<string>()

  const getSpaceName = (spaceId: string): string => {
    return spaceId === 'halo-temp' ? 'Halo' : spaceId
  }

  // 1. Active sessions
  for (const [conversationId, session] of state.sessions) {
    const hasUnseen = state.unseenCompletions.has(conversationId)
    const status = deriveTaskStatus(session, hasUnseen)
    if (status === 'idle') continue

    let meta: ConversationMeta | undefined
    for (const [, ss] of state.spaceStates) {
      meta = ss.conversations.find(c => c.id === conversationId)
      if (meta) break
    }
    if (!meta) continue

    items.push({
      conversationId,
      spaceId: meta.spaceId,
      spaceName: getSpaceName(meta.spaceId),
      title: meta.title,
      status,
      starred: !!meta.starred,
      updatedAt: meta.updatedAt
    })
    addedIds.add(conversationId)
  }

  // 2. Unseen completions
  for (const [conversationId, info] of state.unseenCompletions) {
    if (addedIds.has(conversationId)) continue
    let meta: ConversationMeta | undefined
    for (const [, ss] of state.spaceStates) {
      meta = ss.conversations.find(c => c.id === conversationId)
      if (meta) break
    }
    items.push({
      conversationId,
      spaceId: info.spaceId,
      spaceName: getSpaceName(info.spaceId),
      title: meta?.title || info.title,
      status: 'completed-unseen',
      starred: !!meta?.starred,
      updatedAt: meta?.updatedAt || new Date().toISOString()
    })
    addedIds.add(conversationId)
  }

  // 3. Starred conversations
  for (const [, ss] of state.spaceStates) {
    for (const conv of ss.conversations) {
      if (!conv.starred || addedIds.has(conv.id)) continue
      items.push({
        conversationId: conv.id,
        spaceId: conv.spaceId,
        spaceName: getSpaceName(conv.spaceId),
        title: conv.title,
        status: 'idle',
        starred: true,
        updatedAt: conv.updatedAt
      })
      addedIds.add(conv.id)
    }
  }

  // 4. Read items in grace period
  const now = Date.now()
  for (const [conversationId, info] of state.pulseReadAt) {
    if (addedIds.has(conversationId)) continue
    if (now - info.readAt >= PULSE_READ_GRACE_PERIOD_MS) continue
    items.push({
      conversationId,
      spaceId: info.spaceId,
      spaceName: getSpaceName(info.spaceId),
      title: info.title,
      status: info.originalStatus,
      starred: false,
      updatedAt: new Date(info.readAt).toISOString(),
      readAt: info.readAt
    })
    addedIds.add(conversationId)
  }

  // Sort by priority
  const priorityOrder: Record<TaskStatus, number> = {
    'waiting': 0,
    'generating': 1,
    'completed-unseen': 2,
    'error': 3,
    'idle': 4
  }
  items.sort((a, b) => {
    const pa = priorityOrder[a.status]
    const pb = priorityOrder[b.status]
    if (pa !== pb) return pa - pb
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  })

  return items
}

/**
 * Count pulse items (same logic as the original usePulseCount selector).
 */
function _computePulseCount(state: ChatState): number {
  let count = 0
  const countedIds = new Set<string>()

  for (const [conversationId, session] of state.sessions) {
    const hasUnseen = state.unseenCompletions.has(conversationId)
    const status = deriveTaskStatus(session, hasUnseen)
    if (status !== 'idle') {
      count++
      countedIds.add(conversationId)
    }
  }

  for (const [conversationId] of state.unseenCompletions) {
    if (!countedIds.has(conversationId)) {
      count++
      countedIds.add(conversationId)
    }
  }

  for (const [, ss] of state.spaceStates) {
    for (const conv of ss.conversations) {
      if (conv.starred && !countedIds.has(conv.id)) {
        count++
        countedIds.add(conv.id)
      }
    }
  }

  const now = Date.now()
  for (const [conversationId, info] of state.pulseReadAt) {
    if (!countedIds.has(conversationId) && now - info.readAt < PULSE_READ_GRACE_PERIOD_MS) {
      count++
      countedIds.add(conversationId)
    }
  }

  return count
}

// Track previous pulse-relevant state to avoid unnecessary recalculations
let _prevPulseFingerprint = ''
let _prevUnseenSize = 0
let _prevPulseReadAtSize = 0
let _prevStarredFingerprint = ''

/**
 * Extract a fingerprint of starred conversations across all spaces.
 */
function _extractStarredFingerprint(spaceStates: Map<string, SpaceState>): string {
  const parts: string[] = []
  for (const [, ss] of spaceStates) {
    for (const conv of ss.conversations) {
      if (conv.starred) {
        parts.push(`${conv.id}:${conv.title}:${conv.updatedAt}`)
      }
    }
  }
  return parts.join('|')
}

// Subscribe to store changes and recalculate pulse only when relevant fields change
useChatStore.subscribe((state) => {
  const sessionFingerprint = _extractPulseFingerprint(state.sessions)
  const unseenSize = state.unseenCompletions.size
  const pulseReadAtSize = state.pulseReadAt.size
  const starredFingerprint = _extractStarredFingerprint(state.spaceStates)

  if (
    sessionFingerprint === _prevPulseFingerprint &&
    unseenSize === _prevUnseenSize &&
    pulseReadAtSize === _prevPulseReadAtSize &&
    starredFingerprint === _prevStarredFingerprint
  ) {
    return // No pulse-relevant changes
  }

  _prevPulseFingerprint = sessionFingerprint
  _prevUnseenSize = unseenSize
  _prevPulseReadAtSize = pulseReadAtSize
  _prevStarredFingerprint = starredFingerprint

  const newItems = _computePulseItems(state)
  const newCount = _computePulseCount(state)

  // Only update if values actually changed (avoid infinite loop)
  const currentItems = state._pulseItems
  const itemsChanged = newItems.length !== currentItems.length ||
    newItems.some((item, i) =>
      item.conversationId !== currentItems[i]?.conversationId ||
      item.status !== currentItems[i]?.status ||
      item.starred !== currentItems[i]?.starred ||
      item.title !== currentItems[i]?.title ||
      item.updatedAt !== currentItems[i]?.updatedAt ||
      item.readAt !== currentItems[i]?.readAt
    )

  if (itemsChanged || newCount !== state._pulseCount) {
    useChatStore.setState({ _pulseItems: newItems, _pulseCount: newCount })
  }
})

/**
 * Selector: Get current session's isGenerating state
 * Use this in components that need to react to generation state changes
 */
export function useIsGenerating(): boolean {
  return useChatStore((state) => {
    const spaceState = state.currentSpaceId
      ? state.spaceStates.get(state.currentSpaceId)
      : null
    if (!spaceState?.currentConversationId) return false
    const session = state.sessions.get(spaceState.currentConversationId)
    return session?.isGenerating ?? false
  })
}

/**
 * Derive task status for a conversation from session state and unseen completions
 */
export function deriveTaskStatus(
  session: SessionState | undefined,
  hasUnseenCompletion: boolean
): TaskStatus {
  if (session) {
    if (session.pendingToolApproval || session.pendingQuestion?.status === 'active') return 'waiting'
    if (session.error && session.errorType !== 'interrupted') return 'error'
    if (session.isGenerating) return 'generating'
  }
  if (hasUnseenCompletion) return 'completed-unseen'
  return 'idle'
}

/**
 * Selector: Get task status for a specific conversation
 */
export function useConversationTaskStatus(conversationId: string | undefined): TaskStatus {
  return useChatStore((state) => {
    if (!conversationId) return 'idle'
    const session = state.sessions.get(conversationId)
    const hasUnseen = state.unseenCompletions.has(conversationId)
    return deriveTaskStatus(session, hasUnseen)
  })
}

/**
 * Selector: Get task statuses for all conversations in the current space.
 * Returns a Map of conversationId -> TaskStatus, only including non-idle entries.
 * This replaces N individual useConversationTaskStatus subscriptions with a single one.
 */
export function useAllConversationStatuses(): Map<string, TaskStatus> {
  return useChatStore(
    (state) => {
      const result = new Map<string, TaskStatus>()
      const spaceState = state.currentSpaceId
        ? state.spaceStates.get(state.currentSpaceId)
        : null
      if (!spaceState) return result

      for (const conv of spaceState.conversations) {
        const session = state.sessions.get(conv.id)
        const hasUnseen = state.unseenCompletions.has(conv.id)
        const status = deriveTaskStatus(session, hasUnseen)
        if (status !== 'idle') {
          result.set(conv.id, status)
        }
      }
      return result
    },
    // Shallow equality: only re-render if the map content actually changed
    (a, b) => {
      if (a.size !== b.size) return false
      for (const [id, status] of a) {
        if (b.get(id) !== status) return false
      }
      return true
    }
  )
}

/**
 * Selector: Get all Pulse items from derived state (pre-computed, not recalculated on every store update).
 * Recalculation is driven by the subscribe-based fingerprint watcher above.
 */
export function usePulseItems(): PulseItem[] {
  return useChatStore(state => state._pulseItems)
}

/**
 * Selector: Get the count of pulse items from derived state (pre-computed).
 */
export function usePulseCount(): number {
  return useChatStore(state => state._pulseCount)
}

/**
 * Selector: Get the dominant beacon color based on most urgent status
 * Returns: 'waiting' | 'completed' | 'generating' | 'error' | null
 */
export function usePulseBeaconStatus(): 'waiting' | 'completed' | 'generating' | 'error' | null {
  return useChatStore((state) => {
    let hasWaiting = false
    let hasCompleted = false
    let hasGenerating = false
    let hasError = false

    // Check all sessions
    for (const [conversationId, session] of state.sessions) {
      const hasUnseen = state.unseenCompletions.has(conversationId)
      const status = deriveTaskStatus(session, hasUnseen)
      if (status === 'waiting') hasWaiting = true
      if (status === 'completed-unseen') hasCompleted = true
      if (status === 'generating') hasGenerating = true
      if (status === 'error') hasError = true
    }

    // Check unseen completions
    if (state.unseenCompletions.size > 0) hasCompleted = true

    // Priority: waiting > completed > generating > error
    if (hasWaiting) return 'waiting'
    if (hasCompleted) return 'completed'
    if (hasGenerating) return 'generating'
    if (hasError) return 'error'

    // Check if there are starred items (no beacon color for idle starred)
    for (const [, ss] of state.spaceStates) {
      if (ss.conversations.some(c => c.starred)) return null
    }

    return null
  })
}
