/**
 * Space conversations: stored by the space (`conversation.service`), addressed
 * by the space's own conversation ids. Everything here is the behavior the chat
 * store always had for them, gathered behind the backend interface.
 */
import { api } from '../internal'
import type { Conversation, ConversationMeta, Message, Thought } from '../internal'
import i18n from '../../../i18n'
import { titleFromFirstMessage } from '../../../../shared/conversation-title'
import { buildCanvasContext } from './canvas-context'
import { cacheConversation } from './cache'
import { recoverSessionState } from './recover'
import { beginTurn, endTurnWithError, finishedTurnState } from './turn'
import type { ChatBackend, SendRequest, BackendContext } from './types'
import { noteTurnEnded } from '../../../services/home-telemetry'

function metaFromConversation(conversation: Conversation): ConversationMeta {
  return {
    id: conversation.id,
    spaceId: conversation.spaceId,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messageCount: conversation.messages?.length || 0,
    preview: conversation.messages?.length
      ? conversation.messages[conversation.messages.length - 1].content.slice(0, 50)
      : undefined,
    starred: conversation.starred,
    // Carried through reloads so the engine badge does not blink off between turns.
    engineId: conversation.engineId,
    titleCustomized: conversation.titleCustomized
  }
}

let loadsInFlight = 0

function withLoadError(state: { conversationLoadErrors: Map<string, string> }, conversationId: string, error: string | null) {
  const errors = new Map(state.conversationLoadErrors)
  if (error === null) errors.delete(conversationId)
  else errors.set(conversationId, error)
  return errors
}

async function load(ctx: BackendContext, spaceId: string, conversationId: string): Promise<void> {
  const { set } = ctx
  loadsInFlight++
  set({ isLoadingConversation: true })
  console.log(`[ChatStore] Loading full conversation: ${conversationId}`)
  try {
    const response = await api.getConversation(spaceId, conversationId)
    if (!response.success || !response.data) throw new Error(response.error || i18n.t('Failed to load chat'))
    const fullConversation = response.data as Conversation
    set((state) => ({
      conversationCache: cacheConversation(state, fullConversation),
      conversationLoadErrors: withLoadError(state, conversationId, null),
    }))
    console.log(`[ChatStore] Loaded conversation with ${fullConversation.messages?.length || 0} messages`)
  } catch (error) {
    // Recorded so the page shows the failure with a retry, instead of an
    // empty conversation that looks like it has no messages.
    console.error(`[ChatStore] Failed to load conversation ${conversationId}:`, error)
    set((state) => ({ conversationLoadErrors: withLoadError(state, conversationId, String((error as Error)?.message ?? error)) }))
  } finally {
    loadsInFlight--
    if (loadsInFlight === 0) set({ isLoadingConversation: false })
  }
}

async function open(ctx: BackendContext, { spaceId, conversationId }: { spaceId: string; conversationId: string }): Promise<void> {
  if (!ctx.get().conversationCache.has(conversationId)) await load(ctx, spaceId, conversationId)

  await recoverSessionState(ctx, conversationId)

  // A ready V2 session means the first message does not pay the cold start.
  try {
    api.ensureSessionWarm(spaceId, conversationId)
      .catch((error) => console.error('[ChatStore] Session warm up failed:', error))
  } catch (error) {
    console.error('[ChatStore] Failed to trigger session warm up:', error)
  }
}

async function refresh(ctx: BackendContext, { spaceId, conversationId }: { spaceId: string; conversationId: string }): Promise<void> {
  try {
    const response = await api.getConversation(spaceId, conversationId)
    if (!response.success || !response.data) return
    const updated = response.data as Conversation
    ctx.set((state) => ({
      conversationCache: cacheConversation(state, updated),
      conversationLoadErrors: withLoadError(state, conversationId, null),
    }))
  } catch (error) {
    console.error('[ChatStore] Failed to refresh conversation:', error)
  }
}

async function send(ctx: BackendContext, conversationId: string, request: SendRequest): Promise<boolean> {
  const { set, get } = ctx
  const conversation = get().conversationCache.get(conversationId) ?? null
  const currentSpaceId = get().currentSpaceId
  const conversationMeta = currentSpaceId
    ? get().spaceStates.get(currentSpaceId)?.conversations.find((c) => c.id === conversationId) ?? null
    : null

  if ((!conversation && !conversationMeta) || !currentSpaceId) {
    console.error('[ChatStore] No conversation or space selected')
    return false
  }

  const { content, images, thinkingEnabled, options } = request
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
    const sessions = new Map(state.sessions)
    sessions.set(conversationId, endTurnWithError(sessions.get(conversationId), error))

    const conversationCache = new Map(state.conversationCache)
    const cached = conversationCache.get(conversationId)
    if (cached && userMessage) {
      conversationCache.set(conversationId, restoreOwnedTitle({ ...cached, messages: cached.messages.filter((m) => m !== userMessage) }))
    }

    const spaceStates = new Map(state.spaceStates)
    const spaceState = spaceStates.get(currentSpaceId)
    if (spaceState && userMessage) {
      spaceStates.set(currentSpaceId, {
        ...spaceState,
        conversations: spaceState.conversations.map((c) =>
          c.id === conversationId ? restoreOwnedTitle({ ...c, messageCount: Math.max(0, c.messageCount - 1) }) : c
        )
      })
    }
    return { sessions, conversationCache, spaceStates }
  })

  try {
    beginTurn(set, conversationId)

    userMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
      images,
      ...(goal ? { metadata: { goal } } : {})
    }

    set((state) => {
      const conversationCache = new Map(state.conversationCache)
      const cached = conversationCache.get(conversationId)
      if (cached) {
        conversationCache.set(conversationId, withTitle({
          ...cached,
          messages: [...cached.messages, userMessage!],
          updatedAt: new Date().toISOString()
        }, autoTitle))
      }

      const spaceStates = new Map(state.spaceStates)
      const spaceState = spaceStates.get(currentSpaceId)
      if (spaceState) {
        spaceStates.set(currentSpaceId, {
          ...spaceState,
          conversations: spaceState.conversations.map((c) =>
            c.id === conversationId
              ? withTitle({ ...c, messageCount: c.messageCount + 1, updatedAt: new Date().toISOString() }, autoTitle)
              : c
          )
        })
      }
      return { spaceStates, conversationCache }
    })

    const response = await api.sendMessage({
      spaceId: currentSpaceId,
      conversationId,
      message: content,
      images,
      thinkingEnabled,
      canvasContext: buildCanvasContext(),
      ...(goal ? { goal } : {})
    })
    // A refusal comes back before main records the message or starts a turn,
    // so no agent event will ever end this one.
    if (response && response.success === false) {
      console.error(`[ChatStore] Message refused for ${conversationId}: ${response.error ?? 'unknown error'}`)
      // A goal send reports its own failure.
      withdraw(goal ? null : i18n.t('Failed to send message'))
      return false
    }
    return true
  } catch (error) {
    console.error('Failed to send message:', error)
    // A goal send reports its own failure and rolls back the goal shown for
    // it; its bubble goes too, since the composer hands the text back.
    if (goal) {
      withdraw(null)
      return false
    }
    noteTurnEnded(conversationId, 'error')
    set((state) => {
      const sessions = new Map(state.sessions)
      sessions.set(conversationId, endTurnWithError(sessions.get(conversationId), i18n.t('Failed to send message')))
      return { sessions }
    })
    return true
  }
}

async function stop(ctx: BackendContext, conversationId: string): Promise<void> {
  try {
    await api.stopGeneration(conversationId)
    ctx.get().markSessionStopped(conversationId)
  } catch (error) {
    console.error('Failed to stop generation:', error)
  }
}

async function inject(_ctx: BackendContext, conversationId: string, message: string): Promise<void> {
  await api.injectMessage({ conversationId, message })
}

async function settleTurn(ctx: BackendContext, { spaceId, conversationId }: { spaceId: string; conversationId: string }, turnId: number): Promise<void> {
  const { set } = ctx
  try {
    const response = await api.getConversation(spaceId, conversationId)
    if (response.success && response.data) {
      const updatedConversation = response.data as Conversation
      const updatedMeta = metaFromConversation(updatedConversation)

      // One commit for cache, metadata and session, so the streamed turn is
      // replaced by its persisted form without a frame in between.
      set((state) => {
        const conversationCache = cacheConversation(state, updatedConversation)

        const spaceStates = new Map(state.spaceStates)
        const spaceState = spaceStates.get(spaceId)
        if (spaceState) {
          spaceStates.set(spaceId, {
            ...spaceState,
            conversations: spaceState.conversations.map((c) => c.id === conversationId ? updatedMeta : c)
          })
        }

        // A new turn may have started while the read was in flight; its state
        // must not be overwritten.
        const sessions = new Map(state.sessions)
        const current = sessions.get(conversationId)
        if (current && current.turnId === turnId) {
          sessions.set(conversationId, finishedTurnState(current))
        } else if (current) {
          console.log(`[ChatStore] Skipping session clear for [${conversationId}]: new turn started (completeTurnId=${turnId}, currentTurnId=${current.turnId})`)
        }

        return { spaceStates, sessions, conversationCache }
      })
      console.log(`[ChatStore] Conversation reloaded from backend [${conversationId}]`)
      return
    }
  } catch (error) {
    console.error('[ChatStore] Failed to reload conversation:', error)
  }

  // The reload failed (or the conversation is gone): the turn is over either
  // way, so unblock the page instead of leaving it generating.
  set((state) => {
    const sessions = new Map(state.sessions)
    const current = sessions.get(conversationId)
    if (current && current.turnId === turnId) {
      sessions.set(conversationId, { ...finishedTurnState(current), isThinking: false, thoughts: [] })
    }
    return { sessions }
  })
}

async function loadThoughts(ctx: BackendContext, { spaceId, conversationId }: { spaceId: string; conversationId: string }, messageId: string): Promise<Thought[]> {
  const cached = ctx.get().conversationCache.get(conversationId)
  const message = cached?.messages.find(m => m.id === messageId)
  if (message && Array.isArray(message.thoughts)) return message.thoughts

  try {
    const response = await api.getMessageThoughts(spaceId, conversationId, messageId)
    if (response.success && response.data) {
      const thoughts = response.data as Thought[]
      ctx.set((state) => {
        const conversationCache = new Map(state.conversationCache)
        const conversation = conversationCache.get(conversationId)
        if (conversation) {
          conversationCache.set(conversationId, {
            ...conversation,
            messages: conversation.messages.map(m => m.id === messageId ? { ...m, thoughts } : m)
          })
        }
        return { conversationCache }
      })
      return thoughts
    }
  } catch (error) {
    console.error(`[ChatStore] Failed to load thoughts for ${conversationId}/${messageId}:`, error)
  }
  return []
}

// A space conversation is read whole: nothing is ever older than what is loaded.
async function loadEarlier(): Promise<void> {}
async function loadThrough(): Promise<void> {}

export const spaceBackend: ChatBackend = {
  open,
  refresh,
  send,
  stop,
  inject,
  settleTurn,
  loadThoughts,
  loadEarlier,
  loadThrough,
}
