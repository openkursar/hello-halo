/**
 * The reminders a digital human set for itself in its conversations — what each
 * is for, when it comes due and which conversation it returns to — so they can
 * be seen and stopped from its page rather than only by asking it.
 */

import { useCallback, useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { api } from '../../api'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import type { ConversationReminderView } from '../../../shared/apps/conversation-reminders'
import { formatCronHumanReadable, formatFrequency } from './schedule-utils'

type Translate = (key: string, options?: Record<string, unknown>) => string

function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString(getCurrentLanguage(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function describeTiming(reminder: ConversationReminderView, t: Translate): string {
  const { schedule, nextAt } = reminder
  if (schedule.kind === 'once') return t('Once, {{time}}', { time: formatWhen(schedule.at) })
  const repeat = schedule.kind === 'every'
    ? formatFrequency(schedule.every, t)
    : formatCronHumanReadable(schedule.cron, getCurrentLanguage())
  return nextAt !== null ? t('{{repeat}}, next {{time}}', { repeat, time: formatWhen(nextAt) }) : repeat
}

function describeConversation(reminder: ConversationReminderView, t: Translate): string {
  const { kind, name } = reminder.conversation
  if (kind === 'default') return t('Main chat')
  return name ?? (kind === 'im' ? t('IM chat') : t('Chat session'))
}

export function AppRemindersSection({ appId }: { appId: string }) {
  const { t } = useTranslation()
  const [reminders, setReminders] = useState<ConversationReminderView[] | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [cancelling, setCancelling] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await api.appListReminders(appId)
    setLoadFailed(!res.success)
    setReminders(res.success && res.data ? res.data : [])
  }, [appId])

  useEffect(() => {
    void load()
  }, [load])

  async function handleCancel(reminderId: string) {
    setCancelling(reminderId)
    try {
      await api.appCancelReminder(appId, reminderId)
      await load()
    } finally {
      setCancelling(null)
    }
  }

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('Reminders')}</h3>
      {loadFailed && (
        <p className="text-xs text-destructive">{t('Reminders could not be loaded.')}</p>
      )}
      {!loadFailed && reminders !== null && reminders.length === 0 && (
        <p className="text-xs text-muted-foreground">
          {t('None. Ask this digital human in a conversation to remind you of something, and the reminder shows here.')}
        </p>
      )}
      {reminders !== null && reminders.length > 0 && (
        <ul className="space-y-1.5">
          {reminders.map(reminder => (
            <li key={reminder.id} className="flex items-start justify-between gap-3 rounded-lg border border-border px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm text-foreground whitespace-pre-wrap break-words line-clamp-3" title={reminder.message}>{reminder.message}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {describeTiming(reminder, t)} · {describeConversation(reminder, t)}
                  {reminder.setBy ? ` · ${t('asked by {{name}}', { name: reminder.setBy })}` : ''}
                </p>
              </div>
              <button
                onClick={() => void handleCancel(reminder.id)}
                disabled={cancelling === reminder.id}
                className="flex-shrink-0 p-1 text-muted-foreground hover:text-foreground rounded-md transition-colors disabled:opacity-50"
                aria-label={t('Cancel this reminder')}
                title={t('Cancel this reminder')}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
