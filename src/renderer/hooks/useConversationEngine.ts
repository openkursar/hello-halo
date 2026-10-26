import { useChatStore } from '../stores/chat.store'
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
