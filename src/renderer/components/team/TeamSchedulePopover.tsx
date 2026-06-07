/**
 * TeamSchedulePopover — configure a team's schedule trigger.
 *
 * A team is a first-class triggerable entity (like a digital human): it can run
 * on a schedule. This popover edits the team's single schedule trigger — enable
 * toggle + interval/cron picker (reusing the digital-human SchedulePicker) — and
 * persists via the team trigger API. Manual run and HTTP trigger always remain
 * available regardless of this setting.
 */

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import { SchedulePicker } from '../apps/SchedulePicker'
import { Switch } from '../ui/Switch'
import type { ScheduleValue } from '../apps/schedule-utils'
import type { TeamTrigger, TeamScheduleConfig } from '../../../shared/apps/team-types'

interface TeamSchedulePopoverProps {
  teamId: string
  onClose: () => void
}

/** Map a stored schedule trigger config to the picker's value shape. */
function configToValue(config: TeamScheduleConfig): ScheduleValue {
  if (config.cron) return { type: 'cron', cron: config.cron }
  return { type: 'every', every: config.every || '1h' }
}

/** Map the picker's value back to a stored schedule config. */
function valueToConfig(value: ScheduleValue): TeamScheduleConfig {
  return value.type === 'cron' ? { cron: value.cron } : { every: value.every }
}

export function TeamSchedulePopover({ teamId, onClose }: TeamSchedulePopoverProps) {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [trigger, setTrigger] = useState<TeamTrigger | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [value, setValue] = useState<ScheduleValue>({ type: 'every', every: '1h' })

  // Load the team's existing schedule trigger (first one, if any).
  useEffect(() => {
    let cancelled = false
    void api.teamListTriggers(teamId).then((res) => {
      if (cancelled) return
      const list = (res?.success ? (res.data as TeamTrigger[]) : []) ?? []
      const schedule = list.find((tr) => tr.sourceType === 'schedule') ?? null
      setTrigger(schedule)
      if (schedule) {
        setEnabled(schedule.enabled)
        setValue(configToValue(schedule.config as TeamScheduleConfig))
      }
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [teamId])

  async function save() {
    setSaving(true)
    try {
      await api.teamSetTrigger(
        teamId,
        { sourceType: 'schedule', config: valueToConfig(value), enabled },
        trigger?.id
      )
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="absolute right-0 z-30 mt-1 w-[20rem] max-w-[90vw] rounded-lg border border-border bg-popover p-3 shadow-lg">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">{t('Schedule')}</h3>
        <button onClick={onClose} className="p-0.5 text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>

      {loading ? (
        <p className="py-4 text-center text-xs text-muted-foreground">{t('Loading…')}</p>
      ) : (
        <div className="space-y-3">
          <label className="flex items-center justify-between gap-2">
            <span className="text-sm text-foreground">{t('Run on a schedule')}</span>
            <Switch checked={enabled} onCheckedChange={setEnabled} size="sm" />
          </label>

          {enabled && (
            <SchedulePicker value={value} onChange={setValue} />
          )}

          <p className="text-xs text-muted-foreground">
            {t('Manual run and HTTP trigger stay available regardless of this setting.')}
          </p>

          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={onClose}
              className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-secondary"
            >
              {t('Cancel')}
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {saving ? t('Saving…') : t('Save')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
