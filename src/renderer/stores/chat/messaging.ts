/**
 * createMessagingSlice — messaging slice of the chat store.
 */
import type { ChatSlice } from './internal'
import { api, canvasLifecycle, createEmptySessionState } from './internal'
import type { CanvasContext, Message } from './internal'

export const createMessagingSlice: ChatSlice<'sendMessage' | 'stopGeneration' | 'injectMessage' | 'approveTool' | 'rejectTool' | 'continueAfterInterrupt'> = (set, get) => ({
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
        const prevSession = newSessions.get(conversationId)
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
          pendingQuestion: null,
          queuedMessages: [],
          turnId: (prevSession?.turnId ?? 0) + 1,
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

  // Inject a mid-turn message into an active session (Agent Team mode).
  // The message is optimistically shown in the queued panel, then sent to the main process.
  injectMessage: async (conversationId: string, message: string) => {
    const trimmed = message.trim()
    if (!trimmed) return

    // Optimistic UI: add to queue for immediate feedback
    set((state) => {
      const newSessions = new Map(state.sessions)
      const session = newSessions.get(conversationId) || createEmptySessionState()
      newSessions.set(conversationId, {
        ...session,
        queuedMessages: [...session.queuedMessages, trimmed]
      })
      return { sessions: newSessions }
    })

    try {
      await api.injectMessage({ conversationId, message: trimmed })
    } catch (error) {
      console.error('[ChatStore] injectMessage failed:', error)
      // Roll back on failure
      set((state) => {
        const newSessions = new Map(state.sessions)
        const session = newSessions.get(conversationId)
        if (session) {
          newSessions.set(conversationId, {
            ...session,
            queuedMessages: session.queuedMessages.filter((m) => m !== trimmed)
          })
        }
        return { sessions: newSessions }
      })
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
})
