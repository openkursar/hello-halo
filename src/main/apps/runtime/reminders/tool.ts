/**
 * The reminder tools a digital human has in its own conversations. Each server
 * is bound to one conversation: what it sets comes back there, and only that
 * conversation's reminders can be listed or cancelled from it — a group never
 * sees, or stops, the owner's private reminders.
 */

import { z } from 'zod'
import { tool, createSdkMcpServer } from '../../../services/agent/resolved-sdk'
import {
  describeReminderSchedule,
  formatLocalTime,
  getConversationReminders,
  ReminderError,
  type ConversationReminder,
  type ReminderSetter,
} from './index'

export const REMINDERS_MCP_SERVER_NAME = 'halo-reminders'

export interface RemindersToolScope {
  appId: string
  conversationId: string
  /**
   * Who the turn calling the tool answers to, read when the tool is called: a
   * session outlives the turn it was built for, so a value captured at build
   * time would name an earlier sender.
   */
  currentSetter: () => ReminderSetter | undefined
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) }
}

function describe(reminder: ConversationReminder): string {
  const next = reminder.nextAt !== null ? `next ${formatLocalTime(reminder.nextAt)}` : 'already came due'
  return `- ${reminder.id}: ${describeReminderSchedule(reminder.schedule)} (${next}) — ${reminder.message}`
}

export function createRemindersMcpServer(scope: RemindersToolScope) {
  const unavailable = () => textResult('Reminders are not available right now.', true)

  const setReminder = tool(
    'set_reminder',
    'Set a reminder for THIS conversation. When it comes due, your message comes back to you here as a new turn and you ' +
    'act on it — tell the person their hour is up, post the daily prompt in this group, check something and report. ' +
    'Use it for anything wanted later in this conversation, once ("in an hour", "tomorrow at 9") or repeating ' +
    '("every day at 9"). Never create a digital human for a reminder. Give exactly one of after_minutes, at, every, cron; ' +
    "times are this computer's local time. Tell the person when it is set for.",
    {
      message: z.string().describe(
        'What to do or say when it comes due, written so you can act on it with no memory of this conversation ' +
        '(include who asked when it matters).'
      ),
      after_minutes: z.number().optional().describe('Once, this many minutes from now (60 for "in an hour").'),
      at: z.string().optional().describe('Once, at this local date and time, e.g. "2026-10-07T09:00" (an ISO time with an offset also works).'),
      every: z.string().optional().describe('Repeating at this interval: "30m", "2h", "1d"; at least 5 minutes.'),
      cron: z.string().optional().describe('Repeating on this 5-field cron in local time, e.g. "0 9 * * *"; at least 5 minutes apart.'),
    },
    async (input) => {
      const reminders = getConversationReminders()
      if (!reminders) return unavailable()
      try {
        const reminder = reminders.set({
          appId: scope.appId,
          conversationId: scope.conversationId,
          message: input.message,
          when: { afterMinutes: input.after_minutes, at: input.at, every: input.every, cron: input.cron },
          setBy: scope.currentSetter(),
        })
        const next = reminder.nextAt !== null ? formatLocalTime(reminder.nextAt) : 'unknown'
        return textResult(
          `Reminder set (id ${reminder.id}): ${describeReminderSchedule(reminder.schedule)}, first due ${next} local time ` +
          `(now ${formatLocalTime(Date.now())}).`
        )
      } catch (error) {
        if (error instanceof ReminderError) return textResult(error.message, true)
        console.error('[Reminders] set_reminder failed:', error)
        return textResult('The reminder could not be set.', true)
      }
    }
  )

  const listReminders = tool(
    'list_reminders',
    'List the reminders set in this conversation, with when each comes due next.',
    {},
    async () => {
      const reminders = getConversationReminders()
      if (!reminders) return unavailable()
      const listed = reminders.listForConversation(scope.appId, scope.conversationId)
      const now = `Now: ${formatLocalTime(Date.now())} local time.`
      return textResult(listed.length === 0 ? `No reminders in this conversation. ${now}` : `${now}\n${listed.map(describe).join('\n')}`)
    }
  )

  const cancelReminder = tool(
    'cancel_reminder',
    'Cancel a reminder set in this conversation, by the id set_reminder or list_reminders gave.',
    { id: z.string().describe('The reminder id.') },
    async ({ id }) => {
      const reminders = getConversationReminders()
      if (!reminders) return unavailable()
      return reminders.cancel(scope.appId, id.trim(), scope.conversationId)
        ? textResult('Reminder cancelled.')
        : textResult('No reminder with that id in this conversation. Use list_reminders to see them.', true)
    }
  )

  return createSdkMcpServer({ name: REMINDERS_MCP_SERVER_NAME, version: '1.0.0', tools: [setReminder, listReminders, cancelReminder] })
}
