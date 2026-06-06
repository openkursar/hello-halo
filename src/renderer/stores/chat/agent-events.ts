/**
 * createAgentEventsSlice — agent-events slice of the chat store.
 */
import type { ChatSlice } from './internal'
import { api, createEmptySessionState } from './internal'
import type { AgentEventBase, Conversation, ConversationMeta, Thought, ToolCall } from './internal'

export const createAgentEventsSlice: ChatSlice<'handleAgentMessage' | 'handleAgentToolCall' | 'handleAgentToolResult' | 'handleAgentError' | 'handleAgentComplete' | 'handleAgentThought' | 'handleAgentThoughtDelta' | 'handleAgentCompact' | 'handleAgentSessionInfo' | 'handleAgentTurnStart' | 'handleAskQuestion'> = (set, get) => ({
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
      let metaFound = false
      for (const [, ss] of state.spaceStates) {
        const meta = ss.conversations.find(c => c.id === conversationId)
        if (meta) { title = meta.title; metaFound = true; break }
      }

      // Conversation may have been created remotely (web/mobile) — sync local state
      if (!metaFound) {
        console.log(`[ChatStore] handleAgentComplete: conversation ${conversationId} not in local state, reloading space ${spaceId}`)
        await get().loadConversations(spaceId)
        // Re-read title from freshly loaded data
        for (const [, ss] of get().spaceStates) {
          const meta = ss.conversations.find(c => c.id === conversationId)
          if (meta) { title = meta.title; break }
        }
      }

      set((s) => {
        const newUnseenCompletions = new Map(s.unseenCompletions)
        newUnseenCompletions.set(conversationId, { spaceId, title })
        return { unseenCompletions: newUnseenCompletions }
      })
    }

    // Capture turnId BEFORE any async work. If a new turn starts (sendMessage or
    // handleAgentTurnStart) while we're awaiting getConversation, turnId will have
    // incremented. We use this to avoid overwriting the new turn's session state.
    const completeTurnId = get().sessions.get(conversationId)?.turnId ?? 0

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
          starred: updatedConversation.starred,
          // Carry the engine stamp through reload so EngineBadge stays
          // visible across send-message cycles (otherwise the badge would
          // flicker off until the user navigates away and back).
          engineId: updatedConversation.engineId
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

          // Check if a new turn has started while we were awaiting getConversation.
          // If so, skip session state clearing to avoid overwriting the new turn's state
          // (isGenerating, streamingContent, thoughts, etc.).
          const newSessions = new Map(state.sessions)
          const currentSession = newSessions.get(conversationId)
          if (currentSession && currentSession.turnId === completeTurnId) {
            // Same turn — safe to clear session state
            // Error is now persisted in message.error, so clear session-level error.
            // IMPORTANT: interrupted errors arrive AFTER agent:complete via a separate IPC event.
            // Because this reload is async, handleAgentError may have already written the
            // interrupted error into the session by the time we get here. We must NOT clear it.
            newSessions.set(conversationId, {
              ...currentSession,
              isGenerating: false,
              streamingContent: '',
              compactInfo: null,  // Clear temporary compact notification
              pendingQuestion: null,  // Clear pending question
              queuedMessages: [],  // Clear mid-turn queued messages
              // Preserve interrupted errors — they may have arrived during the async reload
              error: currentSession.errorType === 'interrupted' ? currentSession.error : null,
              errorType: currentSession.errorType === 'interrupted' ? currentSession.errorType : null
            })
          } else if (currentSession) {
            console.log(`[ChatStore] Skipping session clear for [${conversationId}]: new turn started (completeTurnId=${completeTurnId}, currentTurnId=${currentSession.turnId})`)
          }

          return {
            spaceStates: newSpaceStates,
            sessions: newSessions,
            conversationCache: newCache
          }
        })
        console.log(`[ChatStore] Conversation reloaded from backend [${conversationId}]`)
      } else {
        // Conversation not found in backend (e.g. virtual conversationIds like "app-chat:*")
        // Still must clear generating state to unblock UI.
        // IMPORTANT: also clear thoughts and isThinking here — for IM sessions there is no
        // sendMessage call to reset these between turns, so stale thoughts from a previous
        // turn would otherwise accumulate and show up in the next turn's ThoughtProcess.
        set((state) => {
          const newSessions = new Map(state.sessions)
          const currentSession = newSessions.get(conversationId)
          if (currentSession && currentSession.turnId === completeTurnId) {
            newSessions.set(conversationId, {
              ...currentSession,
              isGenerating: false,
              isThinking: false,
              streamingContent: '',
              thoughts: [],
              compactInfo: null,
              pendingQuestion: null,
              queuedMessages: [],  // Clear mid-turn queued messages
              error: currentSession.errorType === 'interrupted' ? currentSession.error : null,
              errorType: currentSession.errorType === 'interrupted' ? currentSession.errorType : null,
            })
          } else if (currentSession) {
            console.log(`[ChatStore] Skipping session clear for [${conversationId}]: new turn started`)
          }
          return { sessions: newSessions }
        })
        console.log(`[ChatStore] No backend conversation for [${conversationId}], session state cleared`)
      }
    } catch (error) {
      console.error('[ChatStore] Failed to reload conversation:', error)
      // Even on error, must clear state to avoid stale content — but only if turn hasn't changed
      set((state) => {
        const newSessions = new Map(state.sessions)
        const currentSession = newSessions.get(conversationId)
        if (currentSession && currentSession.turnId === completeTurnId) {
          newSessions.set(conversationId, {
            ...currentSession,
            isGenerating: false,
            isThinking: false,
            streamingContent: '',
            thoughts: [],
            compactInfo: null,  // Clear temporary compact notification
            pendingQuestion: null,  // Clear pending question
            queuedMessages: [],  // Clear mid-turn queued messages
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
    const { conversationId, thoughtId, delta, content, toolInput, isComplete, isReady, isToolInput, toolResult, isToolResult, taskProgress } = data
    // Don't log every delta to reduce console noise (only log on complete, toolResult, or taskProgress)
    if (isComplete || isToolResult || taskProgress) {
      console.log(`[ChatStore] handleAgentThoughtDelta [${conversationId}]: thought ${thoughtId} ${isToolResult ? 'toolResult merged' : taskProgress ? 'taskProgress' : 'complete'}`)
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
      if (taskProgress) {
        // Task/Agent lifecycle update — update progress on the parent Task thought
        thought.taskProgress = taskProgress
      } else if (isToolResult && toolResult) {
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

  // Handle session-info from SDK system:init — store slash_commands / skills / agents
  handleAgentSessionInfo: (data) => {
    const { conversationId, slashCommands, skills, agents } = data
    set((state) => {
      const newSessionInitInfo = new Map(state.sessionInitInfo)
      newSessionInitInfo.set(conversationId, { slashCommands, skills, agents })
      return { sessionInitInfo: newSessionInitInfo }
    })
  },

  // Handle autonomous turn start — CC produced output without user send
  // (e.g., Agent Team sub-agent message triggered a new turn)
  handleAgentTurnStart: (data) => {
    const { conversationId } = data as AgentEventBase & { autonomous?: boolean }
    console.log(`[ChatStore] handleAgentTurnStart [${conversationId}]: autonomous turn detected`)

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
})
