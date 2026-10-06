/**
 * Reminders a digital human sets for itself inside one of its conversations:
 * at the time given, the reminder comes back to that same conversation as a
 * new turn. Shared by the runtime that keeps them and the page that lists them.
 */

export type ReminderSchedule =
  | { kind: 'once'; at: number }
  | { kind: 'every'; every: string }
  | { kind: 'cron'; cron: string }

/** Which of the digital human's conversations a reminder returns to. */
export interface ReminderConversation {
  kind: 'default' | 'local' | 'im' | 'http'
  /** The session's name where it has one; the default chat has none. */
  name?: string
}

export interface ConversationReminderView {
  id: string
  appId: string
  conversationId: string
  conversation: ReminderConversation
  /** What the digital human is to do when it comes due, in its own words. */
  message: string
  schedule: ReminderSchedule
  /** Next time it comes due; null when a one-off has already come due. */
  nextAt: number | null
  createdAt: number
  /** The IM sender who asked for it; absent in the owner's own chats. */
  setBy?: string
}
