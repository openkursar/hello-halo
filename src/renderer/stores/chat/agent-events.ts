/**
 * createAgentEventsSlice — agent-events slice of the chat store.
 */
import type { ChatSlice } from './internal'
import { api, createEmptySessionState } from './internal'
import type { AgentEventBase, Thought, ToolCall } from './internal'
import { nextTextBlockVersion } from './text-block-version'
import { selectViewedConversationId } from './active'
import { conversationKind, backendFor } from './backend'
import { startedTurnState } from './backend/turn'
import { noteTurnEnded } from '../../services/home-telemetry'
import { acceptsDetailEvent, releaseTurnDetail } from './detail-retention'

export const createAgentEventsSlice: ChatSlice<'handleAgentMessage' | 'handleAgentToolCall' | 'handleAgentToolResult' | 'handleAgentError' | 'handleAgentComplete' | 'handleAgentThought' | 'handleAgentThoughtDelta' | 'handleAgentCompact' | 'handleAgentApiRetry' | 'handleAgentSessionInfo' | 'handleAgentTurnStart' | 'handleAskQuestion'> = (set, get) => ({
  handleAgentMessage: (data) => {
    const { conversationId, content, delta, isStreaming, isNewTextBlock } = data as AgentEventBase & {
      content?: string
      delta?: string
      isComplete: boolean
      isStreaming?: boolean
      isNewTextBlock?: boolean  // Signal from content_block_start (type='text')
    }

    set((state) => {
      if (!acceptsDetailEvent(state, conversationId)) return state
      const newSessions = new Map(state.sessions)
      const session = newSessions.get(conversationId) || createEmptySessionState()

      const prevContent = session.streamingContent || ''

      // Incremental mode: append delta to existing content
      // Full mode: replace directly (backward compatible)
      const newContent = delta
        ? prevContent + delta
        : (content ?? prevContent)

      const newTextBlockVersion = nextTextBlockVersion(
        session.textBlockVersion || 0,
        isNewTextBlock,
        prevContent.length
      )

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

    // An approval request is a status event: it reaches this store for every
    // conversation, since the turn stays blocked until someone answers.
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
  handleAgentToolResult: () => {
    // Tool results are tracked in thoughts, no additional state needed
  },

  // Handle error for a specific conversation
  handleAgentError: (data) => {
    const { conversationId, error, errorType } = data
    console.log(`[ChatStore] handleAgentError [${conversationId}]:`, error, errorType ? `(type: ${errorType})` : '')
    // A user stop is recorded when requested, so any interruption reaching here is a failure.
    noteTurnEnded(conversationId, 'error')

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
        errorSeen: false,
        isGenerating: false,
        isThinking: false,
        apiRetry: null,
        // Only add error thought for non-interrupted errors
        thoughts: errorType === 'interrupted' ? session.thoughts : [...session.thoughts, errorThought],
        // Mark pending question as cancelled on error
        pendingQuestion: session.pendingQuestion?.status === 'active'
          ? { ...session.pendingQuestion, status: 'cancelled' as const }
          : session.pendingQuestion
      })
      return { sessions: newSessions }
    })
    releaseTurnDetail(conversationId)
  },

  // A turn ended. The conversation is re-read from its store (the single source
  // of truth) and the streamed turn is replaced by it in one commit, so the
  // reply never disappears and reappears. `isGenerating` stays up until then.
  handleAgentComplete: async (data) => {
    const { spaceId, conversationId } = data
    console.log(`[ChatStore] handleAgentComplete [${conversationId}]`)
    const endedSession = get().sessions.get(conversationId)
    noteTurnEnded(conversationId, endedSession?.error ? 'error' : 'ok')

    // A remembered selection can be hidden behind settings or a full-screen canvas.
    const state = get()
    const kind = conversationKind(conversationId)
    const isUserViewingThisConversation =
      state.currentSpaceId === spaceId &&
      selectViewedConversationId(state) === conversationId

    // Track unseen completion if user is not viewing this conversation. Space
    // and digital-human conversations are followed; IM sessions and team
    // members are not.
    if (!isUserViewingThisConversation && kind !== 'virtual') {
      // Digital-human items are named by the task panel, not from the index.
      let title = kind === 'digital-human' ? '' : 'Conversation'
      let metaFound = kind === 'digital-human'
      for (const [, ss] of state.spaceStates) {
        const meta = ss.conversations.find(c => c.id === conversationId)
        if (meta) { title = meta.title; metaFound = true; break }
      }

      // Conversation may have been created remotely (web/mobile) — sync local state
      let unlisted = false
      if (!metaFound) {
        console.log(`[ChatStore] handleAgentComplete: conversation ${conversationId} not in local state, reloading space ${spaceId}`)
        const loaded = await get().loadConversations(spaceId)
        // Re-read title from freshly loaded data
        for (const [, ss] of get().spaceStates) {
          const meta = ss.conversations.find(c => c.id === conversationId)
          if (meta) { title = meta.title; metaFound = true; break }
        }
        // Not in the list just read: an ephemeral conversation backing another
        // view (the knowledge base chat), or one deleted meanwhile — nothing to
        // come back to. A list that did not load proves nothing.
        unlisted = loaded && !metaFound
      }

      if (!unlisted) {
        set((s) => {
          const newUnseenCompletions = new Map(s.unseenCompletions)
          newUnseenCompletions.set(conversationId, { spaceId, title })
          return { unseenCompletions: newUnseenCompletions }
        })
        api.taskMarkUnseen(conversationId, spaceId, title).catch(err =>
          console.error('[ChatStore] taskMarkUnseen error:', err))
        // Loading missing metadata may have yielded while the user returned to the chat.
        get().readActiveCompletion()
      }
    }

    // Captured BEFORE any async work: if a new turn starts while the backend
    // re-reads, turnId has moved on and its state must not be overwritten.
    const completeTurnId = get().sessions.get(conversationId)?.turnId ?? 0

    // Stop the streaming indicators but keep the streaming bubble visible
    // (isGenerating and streamingContent stay) until the persisted turn loads.
    set((state) => {
      const newSessions = new Map(state.sessions)
      const session = newSessions.get(conversationId)
      if (session) {
        newSessions.set(conversationId, {
          ...session,
          isStreaming: false,
          isThinking: false,
          apiRetry: null
        })
      }
      return { sessions: newSessions }
    })

    await backendFor(conversationId).settleTurn({ set, get }, { spaceId, conversationId }, completeTurnId)
    // A turn sent after this one ended keeps the hold.
    if ((get().sessions.get(conversationId)?.turnId ?? 0) === completeTurnId) releaseTurnDetail(conversationId)
  },

  // Handle thought for a specific conversation.
  // Highest-frequency write in this store — every reasoning step of every
  // running agent, including background digital humans and team members. Keep
  // it allocation-free and unlogged.
  handleAgentThought: (data) => {
    const { conversationId, thought } = data

    set((state) => {
      if (!acceptsDetailEvent(state, conversationId)) return state
      const newSessions = new Map(state.sessions)
      const session = newSessions.get(conversationId) || createEmptySessionState()

      // Skip a thought already recorded (can re-arrive after stream recovery)
      if (session.thoughts.some(t => t.id === thought.id)) {
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
    // Partial tool input only signals progress the step already shows as streaming.
    // Halo no longer publishes it, but an older one still may: a team peer, or
    // the computer a phone app connects to.
    if (isToolInput && !(isComplete && toolInput) && !taskProgress && !(isToolResult && toolResult)) return

    set((state) => {
      const session = state.sessions.get(conversationId)
      if (!session) return state

      // The step a delta updates is almost always the newest one.
      let thoughtIndex = session.thoughts.length - 1
      while (thoughtIndex >= 0 && session.thoughts[thoughtIndex].id !== thoughtId) thoughtIndex--
      if (thoughtIndex === -1) {
        console.warn(`[ChatStore] Thought not found for delta: ${thoughtId}`)
        return state
      }

      // Only the updated step gets a new object; every other step keeps its identity.
      const newSessions = new Map(state.sessions)
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
      if (!acceptsDetailEvent(state, conversationId)) return state
      const newSessions = new Map(state.sessions)
      const session = newSessions.get(conversationId) || createEmptySessionState()

      newSessions.set(conversationId, {
        ...session,
        compactInfo: { trigger, preTokens }
      })
      return { sessions: newSessions }
    })
  },

  // A failed model request is waiting to be resent (retry), or requests go
  // through again (null). The deadline is fixed on this client's clock.
  handleAgentApiRetry: (data) => {
    const { conversationId, retry } = data
    if (retry) {
      console.log(`[ChatStore] handleAgentApiRetry [${conversationId}]: attempt ${retry.attempt}/${retry.maxRetries} in ${retry.delayMs}ms (status ${retry.errorStatus ?? 'none'})`)
    }

    set((state) => {
      const session = state.sessions.get(conversationId)
      if (!retry && !session?.apiRetry) return state
      if (!acceptsDetailEvent(state, conversationId)) return state

      const newSessions = new Map(state.sessions)
      newSessions.set(conversationId, {
        ...(session || createEmptySessionState()),
        apiRetry: retry ? { ...retry, retryAt: Date.now() + retry.delayMs } : null
      })
      return { sessions: newSessions }
    })
  },

  // Handle session-info from SDK system:init — store slash_commands / skills / agents
  handleAgentSessionInfo: (data) => {
    const { conversationId, slashCommands, skills, agents } = data
    set((state) => {
      if (!acceptsDetailEvent(state, conversationId)) return state
      const newSessionInitInfo = new Map(state.sessionInitInfo)
      newSessionInitInfo.set(conversationId, { slashCommands, skills, agents })
      return { sessionInitInfo: newSessionInitInfo }
    })
  },

  // Handle autonomous turn start — CC produced output without user send
  // (e.g., Agent Team sub-agent message triggered a new turn)
  handleAgentTurnStart: (data) => {
    const { spaceId, conversationId } = data as AgentEventBase & { autonomous?: boolean }
    const startedHere = get().sessions.get(conversationId)?.isGenerating === true
    console.log(`[ChatStore] handleAgentTurnStart [${conversationId}]: autonomous turn detected`)

    set((state) => {
      const newSessions = new Map(state.sessions)
      newSessions.set(conversationId, startedTurnState(newSessions.get(conversationId)))
      return { sessions: newSessions }
    })

    // A turn this page did not send (another client, another conversation
    // delivering into this one) has its input written to the transcript only:
    // read it in so the message it answers is on screen while it streams.
    if (!startedHere && conversationKind(conversationId) === 'digital-human' && get().conversationCache.has(conversationId)) {
      void backendFor(conversationId).refresh({ set, get }, { spaceId, conversationId })
    }
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
