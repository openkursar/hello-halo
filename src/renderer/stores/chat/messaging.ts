/**
 * createMessagingSlice — messaging slice of the chat store.
 */
import type { ChatSlice } from './internal'
import { api, canvasLifecycle, createEmptySessionState } from './internal'
import type { CanvasContext, Message } from './internal'
import { noteTurnEnded, noteTurnSent, trackHome } from '../../services/home-telemetry'
import i18n from '../../i18n'
import { titleFromFirstMessage } from '../../../shared/conversation-title'

export const createMessagingSlice: ChatSlice<'sendMessage' | 'stopGeneration' | 'injectMessage' | 'approveTool' | 'rejectTool' | 'continueAfterInterrupt'> = (set, get) => ({
  sendMessage: async (content, images, thinkingEnabled, options) => {
    const conversation = get().getCurrentConversation()
    const conversationMeta = get().getCurrentConversationMeta()
    const { currentSpaceId } = get()

    if ((!conversation && !conversationMeta) || !currentSpaceId) {
      console.error('[ChatStore] No conversation or space selected')
      return false
    }

    const conversationId = conversationMeta?.id || conversation?.id
    if (!conversationId) return false
    const goal = options?.goal
    let userMessage: Message | undefined

    // Main titles a conversation from its first message the moment it records
    // it; mirror that now instead of waiting for the turn-end reload.
    const titleSource = conversationMeta ?? conversation
    const previousTitle = titleSource?.title
    const autoTitle = titleSource && titleSource.messageCount === 0 && !titleSource.titleCustomized
      ? titleFromFirstMessage(content)
      : null
    const withTitle = <T extends { title: string }>(item: T, title: string | null | undefined): T =>
      title ? { ...item, title } : item
    const restoreOwnedTitle = <T extends { title: string; titleCustomized?: boolean }>(item: T): T =>
      autoTitle && item.title === autoTitle && !item.titleCustomized && previousTitle
        ? { ...item, title: previousTitle }
        : item

    // Take back the optimistic bubble and end "generating" for a message no
    // agent event will ever finish.
    const withdraw = (error: string | null) => set((state) => {
      const newSessions = new Map(state.sessions)
      const session = newSessions.get(conversationId) || createEmptySessionState()
      newSessions.set(conversationId, { ...session, error, isGenerating: false, isThinking: false })

      const newCache = new Map(state.conversationCache)
      const cached = newCache.get(conversationId)
      if (cached && userMessage) {
        newCache.set(conversationId, restoreOwnedTitle({ ...cached, messages: cached.messages.filter((m) => m !== userMessage) }))
      }

      const newSpaceStates = new Map(state.spaceStates)
      const spaceState = newSpaceStates.get(currentSpaceId)
      if (spaceState && userMessage) {
        newSpaceStates.set(currentSpaceId, {
          ...spaceState,
          conversations: spaceState.conversations.map((c) =>
            c.id === conversationId ? restoreOwnedTitle({ ...c, messageCount: Math.max(0, c.messageCount - 1) }) : c
          )
        })
      }
      return { sessions: newSessions, conversationCache: newCache, spaceStates: newSpaceStates }
    })

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
          apiRetry: null,
          textBlockVersion: 0,
          pendingQuestion: null,
          queuedMessages: [],
          turnId: (prevSession?.turnId ?? 0) + 1,
          turnStartedAt: Date.now(),
        })
        return { sessions: newSessions }
      })

      // Add user message to UI immediately (update cache if exists)
      userMessage = {
        id: `msg-${Date.now()}`,
        role: 'user',
        content,
        timestamp: new Date().toISOString(),
        images: images,  // Include images in message for display
        ...(goal ? { metadata: { goal } } : {})
      }

      set((state) => {
        // Update cache if conversation is loaded
        const newCache = new Map(state.conversationCache)
        const cached = newCache.get(conversationId)
        if (cached) {
          newCache.set(conversationId, withTitle({
            ...cached,
            messages: [...cached.messages, userMessage!],
            updatedAt: new Date().toISOString()
          }, autoTitle))
        }

        // Update metadata (messageCount, first-message title)
        const newSpaceStates = new Map(state.spaceStates)
        const spaceState = newSpaceStates.get(currentSpaceId)
        if (spaceState) {
          newSpaceStates.set(currentSpaceId, {
            ...spaceState,
            conversations: spaceState.conversations.map((c) =>
              c.id === conversationId
                ? withTitle({ ...c, messageCount: c.messageCount + 1, updatedAt: new Date().toISOString() }, autoTitle)
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
            path: activeTab.path,
            terminalSessionId: activeTab.terminalSessionId
          } : null,
          tabs: tabs.map(t => ({
            type: t.type,
            title: t.title,
            url: t.url,
            path: t.path,
            terminalSessionId: t.terminalSessionId,
            isActive: t.id === activeTabId
          }))
        }
      }

      // Send to agent (with images, thinking mode, and canvas context)
      const response = await api.sendMessage({
        spaceId: currentSpaceId,
        conversationId,
        message: content,
        images: images,  // Pass images to API
        thinkingEnabled,  // Pass thinking mode to API
        canvasContext: buildCanvasContext(),  // Pass canvas context for AI awareness
        ...(goal ? { goal } : {})
      })
      // A refusal comes back before main records the message or starts a turn,
      // so no agent event will ever end this one.
      if (response && response.success === false) {
        console.error(`[ChatStore] Message refused for ${conversationId}: ${response.error ?? 'unknown error'}`)
        noteTurnEnded(conversationId, 'error')
        // A goal send reports its own failure.
        withdraw(goal ? null : i18n.t('Failed to send message'))
        return false
      }
      return true
    } catch (error) {
      console.error('Failed to send message:', error)
      noteTurnEnded(conversationId, 'error')
      // A goal send reports its own failure and rolls back the goal shown for
      // it; its bubble goes too, since the composer hands the text back.
      if (goal) {
        withdraw(null)
        return false
      }
      // Update session error state
      set((state) => {
        const newSessions = new Map(state.sessions)
        const session = newSessions.get(conversationId) || createEmptySessionState()
        newSessions.set(conversationId, {
          ...session,
          error: i18n.t('Failed to send message'),
          isGenerating: false,
          isThinking: false
        })
        return { sessions: newSessions }
      })
      return true
    }
  },

  // Stop generation for a specific conversation
  stopGeneration: async (conversationId?: string) => {
    const targetId = conversationId || get().getCurrentSpaceState().currentConversationId
    if (targetId) noteTurnEnded(targetId, 'stopped')
    try {
      await api.stopGeneration(targetId ?? undefined)

      if (targetId) get().markSessionStopped(targetId)
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
      trackHome('home.composer.send', { source: 'continue', recipient: 'halo', hasImages: false, imageCount: 0, isInject: false })
      noteTurnSent(conversationId, 'halo')
      state.sendMessage('continue')
    }
  },
})
