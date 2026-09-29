/**
 * The conversation on screen.
 *
 * A space has two pointers: the regular conversation last opened
 * (`currentConversationId`, kept while a digital human is selected so switching
 * back lands there) and the digital-human conversation selected in the input
 * (`selectedAppChat`). What the page shows is the digital human's when one is
 * selected, otherwise the regular one — reading `currentConversationId` alone
 * answers for the hidden conversation, which is how the header model picker
 * once rewrote a conversation nobody was looking at.
 *
 * Pure selectors over the state slice they need, so components and tests can
 * use them without the store.
 */
import type { ChatState, Conversation, SessionState } from './internal'
import { EMPTY_SESSION } from './internal'

type ActiveInput = Pick<ChatState, 'currentSpaceId' | 'spaceStates'>

export function selectActiveConversationId(state: ActiveInput): string | null {
  if (!state.currentSpaceId) return null
  const spaceState = state.spaceStates.get(state.currentSpaceId)
  return spaceState?.selectedAppChat?.conversationId ?? spaceState?.currentConversationId ?? null
}

export function selectActiveConversation(
  state: ActiveInput & Pick<ChatState, 'conversationCache'>
): Conversation | null {
  const id = selectActiveConversationId(state)
  return id ? state.conversationCache.get(id) ?? null : null
}

export function selectActiveSession(
  state: ActiveInput & Pick<ChatState, 'sessions'>
): SessionState {
  const id = selectActiveConversationId(state)
  return (id && state.sessions.get(id)) || EMPTY_SESSION
}
