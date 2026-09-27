/**
 * task-state -- Type Definitions
 *
 * Persists the two pieces of task-panel bookkeeping that previously lived
 * only in renderer memory (chat.store's `unseenCompletions`/`pulseReadAt`
 * Maps), so a completed-but-unseen conversation survives an app restart
 * instead of silently disappearing from the task panel.
 */

/**
 * A conversation's task-panel bookkeeping row.
 *
 * - 'unseen': the conversation finished while the user wasn't looking at it.
 *   `originalStatus` is always 'completed-unseen' in this state; `readAt`/
 *   `kept` are not yet meaningful.
 * - 'read': the user has since opened the conversation. It is now in the
 *   post-view grace period (or exempted via `kept`) before it disappears
 *   from the task panel. `originalStatus` records why it was shown
 *   ('completed-unseen' or 'error') so the panel can render the right label.
 */
export interface ConversationTaskState {
  conversationId: string
  spaceId: string
  title: string
  state: 'unseen' | 'read'
  originalStatus: 'completed-unseen' | 'error' | null
  readAt: number | null
  kept: boolean
  updatedAt: number
}
