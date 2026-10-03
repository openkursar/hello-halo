/**
 * Digital-human conversations: a chat with a digital human on the main board.
 *
 * The transcript is the digital human's JSONL run log, read through the shared
 * transcript reader a page at a time; live turns arrive as the same `agent:*`
 * events as a space conversation. Reads and turn completion are merged into the
 * cached conversation instead of replacing it, so opening a seen conversation
 * is instant and a finished turn settles where it streamed.
 */
import { api, createEmptySessionState } from '../internal'
import type { Conversation, Thought } from '../internal'
import type { TranscriptPage } from '../../../../shared/types/transcript'
import i18n from '../../../i18n'
import { cacheConversation, cacheLoadedThoughts } from './cache'
import { digitalHumanAppId } from './kind'
import { createPendingUserMessage, prependOlder, reconcileTranscript } from './reconcile'
import { recoverSessionState } from './recover'
import { buildCanvasContext } from './canvas-context'
import { endTurnWithError, finishedTurnState, startedTurnState } from './turn'
import type { ConversationRef, ChatBackend, SendRequest, BackendContext } from './types'
import { noteTurnEnded } from '../../../services/home-telemetry'

const LOG_TAG = '[ChatStore/DigitalHuman]'

/** Rows read when a conversation is opened or a turn settles. */
const PAGE_SIZE = 50

/** The space a digital-human conversation belongs to, from the state that knows it. */
export function digitalHumanSpaceId(state: ReturnType<BackendContext['get']>, conversationId: string): string | null {
  const cached = state.conversationCache.get(conversationId)
  if (cached?.spaceId) return cached.spaceId
  for (const [spaceId, spaceState] of state.spaceStates) {
    if (spaceState.selectedAppChat?.conversationId === conversationId) return spaceId
  }
  return state.currentSpaceId
}

function resolve(ctx: BackendContext, conversationId: string): { appId: string; spaceId: string } | null {
  const appId = digitalHumanAppId(conversationId)
  const spaceId = digitalHumanSpaceId(ctx.get(), conversationId)
  return appId && spaceId ? { appId, spaceId } : null
}

async function readPage(appId: string, ref: ConversationRef, request: { before?: string; limit?: number; through?: string } = {}): Promise<TranscriptPage> {
  const response = await api.appChatTranscript({ appId, spaceId: ref.spaceId, conversationId: ref.conversationId, ...request })
  if (!response.success || !response.data) throw new Error(response.error || i18n.t('Failed to load chat'))
  return response.data as TranscriptPage
}

function emptyConversation(appId: string, ref: ConversationRef): Conversation {
  const now = new Date().toISOString()
  return {
    id: ref.conversationId,
    spaceId: ref.spaceId,
    appId,
    title: '',
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    messages: [],
    earlier: { hasMore: false, before: null },
  }
}

/**
 * The conversation after `page` (the newest window) has been folded into
 * `existing`.
 *
 * While a turn is in flight the reader already lists its partial reply, which
 * the live streaming section is drawing: replies not shown yet are held back
 * until the turn settles, or the same text would appear twice.
 */
function withPage(
  existing: Conversation | undefined,
  appId: string,
  ref: ConversationRef,
  page: TranscriptPage,
  inFlight: boolean
): Conversation {
  const base = existing ?? emptyConversation(appId, ref)
  let incoming = page.messages
  if (inFlight) {
    const shown = new Set(base.messages.map(m => m.id))
    let end = incoming.length
    while (end > 0 && incoming[end - 1].role === 'assistant' && !shown.has(incoming[end - 1].id)) end--
    incoming = incoming.slice(0, end)
  }
  const { messages, keptOlder } = reconcileTranscript(base.messages, incoming, { dropUnconfirmed: !inFlight })
  const last = messages[messages.length - 1]
  return {
    ...base,
    messages,
    messageCount: page.total,
    updatedAt: last?.timestamp ?? base.updatedAt,
    earlier: keptOlder && base.earlier ? base.earlier : { hasMore: page.hasMoreBefore, before: page.cursor },
  }
}

const loads = new Map<string, Promise<void>>()

/**
 * `settled` holds the commit until a running turn has been recovered: a read
 * that lands first would list the running turn's partial reply beside the live
 * stream that is drawing it.
 */
function load(ctx: BackendContext, appId: string, ref: ConversationRef, settled?: Promise<unknown>): Promise<void> {
  const existing = loads.get(ref.conversationId)
  if (existing) return existing

  const run = (async () => {
    // `isLoadingConversation` is the space backend's: a digital-human conversation
    // reads as loading while it is neither cached nor failed (ChatView).
    try {
      const page = await readPage(appId, ref, { limit: PAGE_SIZE })
      await settled?.catch(() => undefined)
      ctx.set((state) => {
        // A message sent while the read was in flight is already in the cache.
        const inFlight = state.sessions.get(ref.conversationId)?.isGenerating ?? false
        const conversationCache = cacheConversation(state, withPage(state.conversationCache.get(ref.conversationId), appId, ref, page, inFlight))
        const errors = new Map(state.conversationLoadErrors)
        errors.delete(ref.conversationId)
        return { conversationCache, conversationLoadErrors: errors }
      })
    } catch (error) {
      console.error(`${LOG_TAG} Failed to load ${ref.conversationId}:`, error)
      ctx.set((state) => {
        const errors = new Map(state.conversationLoadErrors)
        errors.set(ref.conversationId, String((error as Error)?.message ?? error))
        return { conversationLoadErrors: errors }
      })
    } finally {
      loads.delete(ref.conversationId)
    }
  })()
  loads.set(ref.conversationId, run)
  return run
}

async function refresh(ctx: BackendContext, ref: ConversationRef, settled?: Promise<unknown>): Promise<void> {
  const appId = digitalHumanAppId(ref.conversationId)
  if (!appId) return
  try {
    const page = await readPage(appId, ref, { limit: PAGE_SIZE })
    await settled?.catch(() => undefined)
    ctx.set((state) => {
      const inFlight = state.sessions.get(ref.conversationId)?.isGenerating ?? false
      const errors = new Map(state.conversationLoadErrors)
      errors.delete(ref.conversationId)
      return {
        conversationCache: cacheConversation(state, withPage(state.conversationCache.get(ref.conversationId), appId, ref, page, inFlight)),
        conversationLoadErrors: errors,
      }
    })
  } catch (error) {
    console.error(`${LOG_TAG} Failed to refresh ${ref.conversationId}:`, error)
  }
}

async function open(ctx: BackendContext, ref: ConversationRef): Promise<void> {
  const appId = digitalHumanAppId(ref.conversationId)
  if (!appId) return

  // Started first so the read below commits knowing whether a turn is running.
  const recovered = recoverSessionState(ctx, ref.conversationId)
  if (ctx.get().conversationCache.has(ref.conversationId)) {
    // Shown as it is; anything written elsewhere since merges in place.
    void refresh(ctx, ref, recovered)
  } else {
    await load(ctx, appId, ref, recovered)
  }
  await recovered
}

async function send(ctx: BackendContext, conversationId: string, request: SendRequest): Promise<boolean> {
  const target = resolve(ctx, conversationId)
  if (!target) {
    console.error(`${LOG_TAG} Cannot send: no digital human or space for ${conversationId}`)
    return false
  }
  const { appId, spaceId } = target
  const { content, images, thinkingEnabled } = request
  const pending = createPendingUserMessage(content, images)

  // Turn state and the optimistic bubble land in one commit.
  ctx.set((state) => {
    const sessions = new Map(state.sessions)
    sessions.set(conversationId, startedTurnState(sessions.get(conversationId)))
    const base = state.conversationCache.get(conversationId) ?? emptyConversation(appId, { spaceId, conversationId })
    const conversation: Conversation = { ...base, messages: [...base.messages, pending], updatedAt: pending.timestamp }
    return { sessions, conversationCache: cacheConversation(state, conversation) }
  })

  const withdraw = (error: string) => ctx.set((state) => {
    const sessions = new Map(state.sessions)
    sessions.set(conversationId, endTurnWithError(sessions.get(conversationId), error))
    const conversationCache = new Map(state.conversationCache)
    const cached = conversationCache.get(conversationId)
    if (cached) conversationCache.set(conversationId, { ...cached, messages: cached.messages.filter(m => m.id !== pending.id) })
    return { sessions, conversationCache }
  })

  try {
    const response = await api.appChatSend({
      appId,
      spaceId,
      message: content,
      images,
      thinkingEnabled,
      conversationId,
      canvasContext: buildCanvasContext(),
    })
    if (!response.success) {
      console.error(`${LOG_TAG} Message refused for ${conversationId}: ${response.error ?? 'unknown error'}`)
      withdraw(String(response.error || i18n.t('Failed to send message')))
      return false
    }
    return true
  } catch (error) {
    console.error(`${LOG_TAG} Failed to send message:`, error)
    // The request may have reached main: keep the bubble and report the failure.
    noteTurnEnded(conversationId, 'error')
    ctx.set((state) => {
      const sessions = new Map(state.sessions)
      sessions.set(conversationId, endTurnWithError(sessions.get(conversationId), String((error as Error)?.message || i18n.t('Failed to send message'))))
      return { sessions }
    })
    return true
  }
}

async function stop(ctx: BackendContext, conversationId: string): Promise<void> {
  const appId = digitalHumanAppId(conversationId)
  if (!appId) return
  try {
    await api.appChatStop(appId, conversationId)
    ctx.get().markSessionStopped(conversationId)
  } catch (error) {
    console.error(`${LOG_TAG} Failed to stop ${conversationId}:`, error)
  }
}

async function inject(ctx: BackendContext, conversationId: string, message: string): Promise<void> {
  const target = resolve(ctx, conversationId)
  if (!target) throw new Error(`No digital human for ${conversationId}`)
  const response = await api.appChatInject({ appId: target.appId, conversationId, message })
  if (!response.success) throw new Error(response.error || i18n.t('Failed to add message'))
  // The turn ended between the click and delivery: the text still has to go
  // somewhere, and a fresh turn is where it belongs.
  if (response.data?.delivered === false) {
    ctx.get().dequeueMessage(conversationId, message)
    await send(ctx, conversationId, { content: message })
  }
}

async function settleTurn(ctx: BackendContext, ref: ConversationRef, turnId: number): Promise<void> {
  const appId = digitalHumanAppId(ref.conversationId)
  // Not open anywhere: nothing to settle into, and reading it would only push
  // conversations the user has open out of the cache. `open` reads it later.
  const cached = ctx.get().conversationCache.has(ref.conversationId)
  let page: TranscriptPage | null = null
  if (appId && cached) {
    try {
      page = await readPage(appId, ref, { limit: PAGE_SIZE })
    } catch (error) {
      console.error(`${LOG_TAG} Failed to read the finished turn of ${ref.conversationId}:`, error)
    }
  }

  // One commit: the persisted turn and the end of the streamed one.
  ctx.set((state) => {
    const sessions = new Map(state.sessions)
    const session = sessions.get(ref.conversationId)
    const sameTurn = !!session && session.turnId === turnId
    if (sameTurn) {
      // Without the persisted turn the streamed one has nothing left to belong to.
      const finished = finishedTurnState(session)
      sessions.set(ref.conversationId, page ? finished : { ...finished, isThinking: false, thoughts: [] })
    } else if (session) console.log(`${LOG_TAG} Skipping session clear for [${ref.conversationId}]: new turn started`)

    // A turn that has started since owns the pending bubbles of its message and
    // still needs this turn's reply on screen. A turnId that moved without a turn
    // running means the history was cleared (or the conversation forgotten)
    // after the read: merging it would bring the cleared messages back.
    const newTurnRunning = !!session && !sameTurn && session.isGenerating
    const stale = !!session && !sameTurn && !session.isGenerating
    const conversationCache = page && appId && !stale && state.conversationCache.has(ref.conversationId)
      ? cacheConversation(state, withPage(state.conversationCache.get(ref.conversationId), appId, ref, page, newTurnRunning))
      : state.conversationCache
    return { sessions, conversationCache }
  })
}

async function loadThoughts(ctx: BackendContext, ref: ConversationRef, messageId: string): Promise<Thought[]> {
  const cached = ctx.get().conversationCache.get(ref.conversationId)?.messages.find(m => m.id === messageId)
  if (cached && Array.isArray(cached.thoughts)) return cached.thoughts

  const appId = digitalHumanAppId(ref.conversationId)
  if (!appId) return []
  try {
    const response = await api.appChatMessageThoughts({ appId, spaceId: ref.spaceId, conversationId: ref.conversationId, messageId })
    if (!response.success || !response.data) return []
    const thoughts = response.data as Thought[]
    ctx.set((state) => ({ conversationCache: cacheLoadedThoughts(state, ref.conversationId, messageId, thoughts) }))
    return thoughts
  } catch (error) {
    console.error(`${LOG_TAG} Failed to load thoughts for ${ref.conversationId}/${messageId}:`, error)
    return []
  }
}

const earlierLoads = new Set<string>()

async function loadEarlier(ctx: BackendContext, ref: ConversationRef): Promise<void> {
  const appId = digitalHumanAppId(ref.conversationId)
  const earlier = ctx.get().conversationCache.get(ref.conversationId)?.earlier
  if (!appId || !earlier?.hasMore || !earlier.before || earlierLoads.has(ref.conversationId)) return

  earlierLoads.add(ref.conversationId)
  try {
    const page = await readPage(appId, ref, { before: earlier.before, limit: PAGE_SIZE })
    ctx.set((state) => {
      const conversation = state.conversationCache.get(ref.conversationId)
      // History cleared or re-anchored while the page was in flight.
      if (!conversation || conversation.earlier?.before !== earlier.before) return state
      const conversationCache = new Map(state.conversationCache)
      conversationCache.set(ref.conversationId, {
        ...conversation,
        messages: prependOlder(conversation.messages, page.messages),
        earlier: { hasMore: page.hasMoreBefore, before: page.cursor ?? earlier.before },
      })
      return { conversationCache }
    })
  } catch (error) {
    console.error(`${LOG_TAG} Failed to load earlier messages of ${ref.conversationId}:`, error)
  } finally {
    earlierLoads.delete(ref.conversationId)
  }
}

async function loadThrough(ctx: BackendContext, ref: ConversationRef, messageId: string): Promise<void> {
  const appId = digitalHumanAppId(ref.conversationId)
  if (!appId) return
  // The read that opened the conversation may still be in flight.
  await loads.get(ref.conversationId)
  if (ctx.get().conversationCache.get(ref.conversationId)?.messages.some(m => m.id === messageId)) return

  try {
    const page = await readPage(appId, ref, { limit: PAGE_SIZE, through: messageId })
    ctx.set((state) => {
      const inFlight = state.sessions.get(ref.conversationId)?.isGenerating ?? false
      return { conversationCache: cacheConversation(state, withPage(state.conversationCache.get(ref.conversationId), appId, ref, page, inFlight)) }
    })
  } catch (error) {
    console.error(`${LOG_TAG} Failed to load ${ref.conversationId} through ${messageId}:`, error)
  }
}

async function clear(ctx: BackendContext, ref: ConversationRef): Promise<boolean> {
  const appId = digitalHumanAppId(ref.conversationId)
  if (!appId) return false
  try {
    const response = await api.appChatClear(appId, ref.spaceId, ref.conversationId)
    if (!response.success) return false
  } catch (error) {
    console.error(`${LOG_TAG} Failed to clear ${ref.conversationId}:`, error)
    return false
  }

  ctx.set((state) => {
    const sessions = new Map(state.sessions)
    sessions.set(ref.conversationId, { ...createEmptySessionState(), turnId: (sessions.get(ref.conversationId)?.turnId ?? 0) + 1 })
    const conversationCache = new Map(state.conversationCache)
    const cached = conversationCache.get(ref.conversationId)
    if (cached) {
      conversationCache.set(ref.conversationId, {
        ...cached,
        messages: [],
        messageCount: 0,
        earlier: { hasMore: false, before: null },
      })
    }
    return { sessions, conversationCache }
  })
  return true
}

/**
 * Delete a local digital-human session and everything the store holds for it.
 * The default session cannot be deleted — clearing it is the equivalent.
 */
export async function deleteAppChatSession(ctx: BackendContext, ref: ConversationRef & { appId: string }): Promise<boolean> {
  try {
    const response = await api.appSessionDelete(ref.appId, ref.spaceId, ref.conversationId)
    if (!response.success) return false
  } catch (error) {
    console.error(`${LOG_TAG} Failed to delete ${ref.conversationId}:`, error)
    return false
  }
  ctx.get().forgetConversation(ref.conversationId)
  return true
}

export const digitalHumanBackend: ChatBackend = {
  open,
  refresh: (ctx, ref) => refresh(ctx, ref),
  send,
  stop,
  inject,
  settleTurn,
  loadThoughts,
  loadEarlier,
  loadThrough,
  clear,
}
