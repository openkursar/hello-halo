/**
 * Which conversations this store asks main to stream in full
 * (`api.retainConversationDetail`). Everything else arrives as status only.
 *
 * - The conversation a chat page shows is retained by the page while mounted
 *   (`ChatView`).
 * - A turn sent from this window is held until it ends, so its reply keeps
 *   streaming when the user looks elsewhere and is whole when they come back.
 *
 * Detail events for a conversation that is neither retained nor already
 * tracked do not create session state.
 */

import { api } from '../../api'
import type { ChatState } from './internal'

const turnHolds = new Map<string, () => void>()

export function holdTurnDetail(conversationId: string): void {
  if (!turnHolds.has(conversationId)) turnHolds.set(conversationId, api.retainConversationDetail(conversationId))
}

export function releaseTurnDetail(conversationId: string): void {
  turnHolds.get(conversationId)?.()
  turnHolds.delete(conversationId)
}

export function acceptsDetailEvent(state: Pick<ChatState, 'sessions'>, conversationId: string): boolean {
  return state.sessions.has(conversationId) || api.isConversationDetailRetained(conversationId)
}
