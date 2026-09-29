/**
 * Opening a conversation that finished or failed while the user was away
 * moves it from "needs you" into the task panel's read grace period. Shared
 * by regular conversations and digital-human sessions so both follow one
 * lifecycle.
 *
 * A regular conversation's live error is cleared, since the error is also
 * persisted on its message. A digital-human session keeps its error on screen
 * (its transcript has no error record) and is only marked as seen.
 */
import type { ChatState } from './internal'
import { api } from './internal'
import { conversationKind } from './backend'

type ReadTransition = Pick<ChatState, 'unseenCompletions' | 'pulseReadAt' | 'sessions'>

/**
 * The state change for opening `conversationId`, or null when it has nothing
 * pending. `fallback` names the item when the store has no record of it.
 */
export function readTransition(
  state: ChatState,
  conversationId: string,
  fallback: { spaceId: string; title: string }
): { patch: ReadTransition; persist: () => void } | null {
  const unseenInfo = state.unseenCompletions.get(conversationId)
  const session = state.sessions.get(conversationId)
  const hasError = !!session?.error && session.errorType !== 'interrupted' && !session.errorSeen
  if (!unseenInfo && !hasError) return null

  const unseenCompletions = new Map(state.unseenCompletions)
  const pulseReadAt = new Map(state.pulseReadAt)
  const sessions = new Map(state.sessions)
  const readAt = Date.now()
  const { spaceId, title } = unseenInfo ?? fallback
  const originalStatus = hasError ? 'error' : 'completed-unseen'

  pulseReadAt.set(conversationId, { readAt, originalStatus, spaceId, title })
  unseenCompletions.delete(conversationId)
  if (hasError) {
    sessions.set(conversationId, conversationKind(conversationId) !== 'space'
      ? { ...session!, errorSeen: true }
      : { ...session!, error: null, errorType: null })
  }

  return {
    patch: { unseenCompletions, pulseReadAt, sessions },
    persist: () => {
      api.taskMarkRead(conversationId, spaceId, title, originalStatus).catch(err =>
        console.error('[ChatStore] taskMarkRead error:', err))
    },
  }
}
