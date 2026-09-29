/**
 * createMessagingSlice — messaging slice of the chat store.
 *
 * The verbs act on the conversation on screen (or the one named) and are
 * carried out by that conversation's backend; see ./backend.
 */
import type { ChatSlice } from './internal'
import { api, createEmptySessionState } from './internal'
import { selectActiveConversationId } from './active'
import { conversationKind, backendFor } from './backend'
import { noteTurnEnded, noteTurnSent, trackHome } from '../../services/home-telemetry'

export const createMessagingSlice: ChatSlice<'sendMessage' | 'stopGeneration' | 'injectMessage' | 'dequeueMessage' | 'approveTool' | 'rejectTool' | 'continueAfterInterrupt'> = (set, get) => ({
  sendMessage: async (content, images, thinkingEnabled, options) => {
    const conversationId = selectActiveConversationId(get())
    if (!conversationId) {
      console.error('[ChatStore] No conversation or space selected')
      return false
    }
    const sent = await backendFor(conversationId).send({ set, get }, conversationId, { content, images, thinkingEnabled, options })
    if (!sent) noteTurnEnded(conversationId, 'error')
    return sent
  },

  // Stop generation for a specific conversation (default: the one on screen)
  stopGeneration: async (conversationId?: string) => {
    const targetId = conversationId || selectActiveConversationId(get())
    if (!targetId) {
      try {
        await api.stopGeneration(undefined)
      } catch (error) {
        console.error('Failed to stop generation:', error)
      }
      return
    }
    noteTurnEnded(targetId, 'stopped')
    await backendFor(targetId).stop({ set, get }, targetId)
  },

  // Add a message to the turn that is running. It shows in the queued panel at
  // once and is taken back if the backend could not deliver it.
  injectMessage: async (conversationId: string, message: string) => {
    const trimmed = message.trim()
    if (!trimmed) return

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
      await backendFor(conversationId).inject({ set, get }, conversationId, trimmed)
    } catch (error) {
      console.error('[ChatStore] injectMessage failed:', error)
      get().dequeueMessage(conversationId, trimmed)
    }
  },

  dequeueMessage: (conversationId: string, message: string) => {
    set((state) => {
      const session = state.sessions.get(conversationId)
      const index = session?.queuedMessages.indexOf(message) ?? -1
      if (!session || index < 0) return state
      const newSessions = new Map(state.sessions)
      newSessions.set(conversationId, {
        ...session,
        queuedMessages: session.queuedMessages.filter((_, i) => i !== index)
      })
      return { sessions: newSessions }
    })
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

  // Continue after an interrupt (InterruptedBubble): clear the error and ask
  // the agent to resume the interrupted response.
  continueAfterInterrupt: (conversationId: string) => {
    set((state) => {
      const newSessions = new Map(state.sessions)
      const session = newSessions.get(conversationId)
      if (session) {
        newSessions.set(conversationId, { ...session, error: null, errorType: null })
      }
      return { sessions: newSessions }
    })

    const kind = conversationKind(conversationId)
    if (kind === 'virtual') return
    const recipient = kind === 'digital-human' ? 'digital_human' : 'halo'
    trackHome('home.composer.send', { source: 'continue', recipient, hasImages: false, imageCount: 0, isInject: false })
    noteTurnSent(conversationId, recipient)
    void backendFor(conversationId)
      .send({ set, get }, conversationId, { content: 'continue' })
      .catch((error) => console.error('[ChatStore] continueAfterInterrupt failed:', error))
  },
})
