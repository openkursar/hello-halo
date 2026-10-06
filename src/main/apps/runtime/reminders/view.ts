/**
 * A digital human's reminders as its page lists them: each with the
 * conversation it returns to, named the way the conversation list names it.
 */

import type { ConversationReminderView, ReminderConversation } from '../../../../shared/apps/conversation-reminders'
import { parseAppChatKey, parseNativeChatKey } from '../../../../shared/apps/im-keys'
import { classifySessionSource, getImSessionDisplayName } from '../../../../shared/types/im-channel'
import { getImSessionRegistry } from '../im-session-registry'
import { getConversationReminders } from './index'

function conversationOf(appId: string, conversationId: string): ReminderConversation {
  const native = parseNativeChatKey(conversationId)
  if (native?.kind === 'default') return { kind: 'default' }
  const parsed = parseAppChatKey(conversationId)
  const session = parsed ? getImSessionRegistry()?.findSession(appId, parsed.channel, parsed.chatId) : undefined
  const name = session ? getImSessionDisplayName(session) : undefined
  const source = parsed ? classifySessionSource(parsed.channel) : 'http'
  const kind: ReminderConversation['kind'] = source === 'local' ? 'local' : source === 'im' ? 'im' : 'http'
  return name ? { kind, name } : { kind }
}

export function listAppReminders(appId: string): ConversationReminderView[] {
  return (getConversationReminders()?.listForApp(appId) ?? []).map(reminder => ({
    id: reminder.id,
    appId: reminder.appId,
    conversationId: reminder.conversationId,
    conversation: conversationOf(appId, reminder.conversationId),
    message: reminder.message,
    schedule: reminder.schedule,
    nextAt: reminder.nextAt,
    createdAt: reminder.createdAt,
    ...(reminder.setBy ? { setBy: reminder.setBy.name } : {}),
  }))
}

export function cancelAppReminder(appId: string, reminderId: string): boolean {
  return getConversationReminders()?.cancel(appId, reminderId) ?? false
}
