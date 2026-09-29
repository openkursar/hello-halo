/**
 * Conversation cache policy.
 *
 * Bounded, least-recently-cached-first — but never at the expense of anything
 * the user is looking at or a turn that is still running: evicting those would
 * blank the page, or drop the place a finishing turn writes into.
 */
import { CONVERSATION_CACHE_SIZE } from '../internal'
import type { ChatState, Conversation } from '../internal'
import { selectActiveConversationId } from '../active'

type CacheInput = Pick<ChatState, 'conversationCache' | 'spaceStates' | 'sessions' | 'currentSpaceId'>

function pinnedIds(state: CacheInput, incomingId: string): Set<string> {
  const pinned = new Set<string>([incomingId])
  const active = selectActiveConversationId(state)
  if (active) pinned.add(active)
  const spaceState = state.currentSpaceId ? state.spaceStates.get(state.currentSpaceId) : undefined
  if (spaceState?.currentConversationId) pinned.add(spaceState.currentConversationId)
  // A space's selected digital human is what it shows on return, and unlike a
  // regular conversation nothing re-reads it when the space is entered again.
  for (const [, other] of state.spaceStates) {
    if (other.selectedAppChat) pinned.add(other.selectedAppChat.conversationId)
  }
  for (const [id, session] of state.sessions) if (session.isGenerating) pinned.add(id)
  return pinned
}

/** The cache with `conversation` inserted as the most recent entry. */
export function cacheConversation(state: CacheInput, conversation: Conversation): Map<string, Conversation> {
  const next = new Map(state.conversationCache)
  next.delete(conversation.id)
  next.set(conversation.id, conversation)
  if (next.size <= CONVERSATION_CACHE_SIZE) return next

  const pinned = pinnedIds(state, conversation.id)
  for (const id of next.keys()) {
    if (next.size <= CONVERSATION_CACHE_SIZE) break
    if (!pinned.has(id)) next.delete(id)
  }
  return next
}
