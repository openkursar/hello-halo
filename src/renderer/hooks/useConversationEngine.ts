import { api } from '../api'
import { useChatStore } from '../stores/chat.store'
import { useEngineStore } from '../stores/engine.store'
import type { Conversation } from '../types'
import type { EngineId } from '../../shared/types/engine'

/** A pending preference does not change the engine of the session still on screen. */
export function useConversationEngineId(
  conversationId: string | null | undefined,
  spaceId?: string | null,
  preferredEngine?: EngineId,
): EngineId | undefined {
  const liveEngine = useChatStore(state => conversationId ? state.sessionInitInfo.get(conversationId)?.engineId : undefined)
  const cached = useChatStore(state => conversationId ? state.conversationCache.get(conversationId) : undefined)
  const summaries = useChatStore(state => spaceId ? state.spaceStates.get(spaceId)?.conversations : undefined)
  const conversation = cached ?? summaries?.find(item => item.id === conversationId)
  return liveEngine ?? conversation?.resolvedEngineId ?? conversation?.engineBinding?.engineId ?? conversation?.engineOverride ?? preferredEngine
}

/**
 * Save a conversation's engine preference and reflect it in the chat store.
 * Resolves the reason when the change was not saved, or null.
 */
export async function saveConversationEngineOverride(spaceId: string, conversationId: string, engine: EngineId | null): Promise<string | null> {
  const response = await api.updateConversation(spaceId, conversationId, { engineOverride: engine })
  if (!response.success) {
    console.warn('[ConversationEngine] Engine preference rejected', { conversationId, reason: response.error?.slice(0, 300) })
    return response.error || 'The engine selection could not be saved. Please try again.'
  }
  const saved = response.data as Conversation | undefined
  if (!saved || (saved.engineOverride ?? null) !== engine) {
    console.warn('[ConversationEngine] Engine preference was not persisted', { conversationId })
    return 'The engine selection could not be saved. Please try again.'
  }
  useChatStore.setState(state => {
    const cache = new Map(state.conversationCache)
    const cached = cache.get(conversationId)
    if (cached) cache.set(conversationId, { ...cached, engineOverride: engine ?? undefined })
    const spaces = new Map(state.spaceStates)
    const space = spaces.get(spaceId)
    if (space) spaces.set(spaceId, { ...space, conversations: space.conversations.map(item => item.id === conversationId ? { ...item, engineOverride: engine ?? undefined } : item) })
    return { conversationCache: cache, spaceStates: spaces }
  })
  if (engine) void useEngineStore.getState().load(engine)
  return null
}
