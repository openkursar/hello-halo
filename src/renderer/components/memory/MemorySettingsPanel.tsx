/**
 * MemorySettingsPanel — the memory controls a space and a digital human share:
 * on/off, automatic consolidation, cadence, and the memory's current state with
 * a "consolidate now" button.
 *
 * The owner of the settings decides when a change is saved (the space dialog
 * saves with its form, the digital human panel applies at once); status and
 * "consolidate now" act immediately through the callbacks.
 */

import { useCallback, useEffect, useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { Switch } from '../ui/Switch'
import { formatFileSize } from '../../lib/utils'
import {
  MEMORY_CADENCES,
  type MemoryCadence,
  type MemorySettings,
  type MemoryStatus,
  type ResolvedMemorySettings,
} from '../../../shared/types/memory'

interface MemorySettingsPanelProps {
  settings: ResolvedMemorySettings
  onChange: (next: MemorySettings) => void
  /** While settings are loading or saving */
  disabled?: boolean
  loadStatus: () => Promise<MemoryStatus | null>
  consolidateNow: () => Promise<{ started: boolean; reason?: string } | null>
}

const STATUS_POLL_MS = 3000

export function MemorySettingsPanel({
  settings,
  onChange,
  disabled = false,
  loadStatus,
  consolidateNow,
}: MemorySettingsPanelProps) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<MemoryStatus | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setStatus(await loadStatus())
    } catch (err) {
      console.error('[MemorySettingsPanel] Failed to load memory status:', err)
    }
  }, [loadStatus])

  useEffect(() => { void refresh() }, [refresh])

  // Follow a running consolidation until it ends.
  useEffect(() => {
    if (!status?.consolidating) return
    const timer = setInterval(() => { void refresh() }, STATUS_POLL_MS)
    return () => clearInterval(timer)
  }, [status?.consolidating, refresh])

  const cadenceLabel: Record<MemoryCadence, string> = {
    diligent: t('Diligent'),
    balanced: t('Balanced'),
    economical: t('Economical'),
  }
  const cadenceHint: Record<MemoryCadence, string> = {
    diligent: t('Tidies up early and often. Best recall; uses the model most.'),
    balanced: t('Tidies up when memory has grown noticeably.'),
    economical: t('Tidies up only when memory is large. Uses the model least.'),
  }

  const handleConsolidate = async () => {
    setNotice(null)
    try {
      const result = await consolidateNow()
      if (result?.started) {
        setStatus(s => (s ? { ...s, consolidating: true } : s))
      } else if (result?.reason === 'already-running') {
        setNotice(t('Already consolidating.'))
      } else if (result?.reason === 'empty') {
        setNotice(t('Nothing to consolidate yet.'))
      } else {
        setNotice(t('Could not start consolidation.'))
      }
    } catch (err) {
      console.error('[MemorySettingsPanel] consolidateNow failed:', err)
      setNotice(t('Could not start consolidation.'))
    }
    void refresh()
  }

  const lastFailed = status?.lastAttempt && status.lastAttempt.outcome !== 'committed'

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm text-foreground">{t('Memory')}</div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('When off, the AI neither reads nor writes this memory. Existing memory is kept.')}
          </p>
        </div>
        <Switch
          checked={settings.enabled}
          disabled={disabled}
          onCheckedChange={enabled => onChange({ ...settings, enabled })}
        />
      </div>

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm text-foreground">{t('Automatic consolidation')}</div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('When off, memory is not reorganized; once its history grows long, the oldest entries are archived.')}
          </p>
        </div>
        <Switch
          checked={settings.autoConsolidate}
          disabled={disabled || !settings.enabled}
          onCheckedChange={autoConsolidate => onChange({ ...settings, autoConsolidate })}
        />
      </div>

      <div className="space-y-1.5">
        <div className="text-sm text-foreground">{t('Consolidation cadence')}</div>
        <div className="flex flex-wrap gap-1.5">
          {MEMORY_CADENCES.map(cadence => (
            <button
              key={cadence}
              type="button"
              disabled={disabled || !settings.enabled}
              onClick={() => onChange({ ...settings, cadence })}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                settings.cadence === cadence
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-secondary text-muted-foreground hover:text-foreground hover:bg-secondary/80'
              }`}
            >
              {cadenceLabel[cadence]}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {settings.autoConsolidate
            ? cadenceHint[settings.cadence]
            : t('Consolidation is off: the cadence sets how long history grows before its oldest entries are archived.')}
        </p>
      </div>

      <p className="text-xs text-muted-foreground">
        {t('Changes affect how the AI works: the tidier its memory, the better it recalls earlier conclusions.')}
      </p>

      <div className="rounded-lg bg-secondary p-3 space-y-2">
        <div className="flex flex-col gap-1 text-xs sm:flex-row sm:items-center sm:justify-between">
          <span className="text-muted-foreground">
            {status?.exists || (status?.topicCount ?? 0) > 0
              ? t('{{size}} · {{count}} topics', {
                  size: formatFileSize(status?.totalBytes ?? 0),
                  count: status?.topicCount ?? 0,
                })
              : t('No memory yet')}
          </span>
          <span className="text-muted-foreground">
            {status?.lastConsolidatedAt
              ? t('Last consolidated {{time}}', { time: new Date(status.lastConsolidatedAt).toLocaleString() })
              : t('Never consolidated')}
          </span>
        </div>
        {lastFailed && status?.lastAttempt && (
          <p className="text-xs text-muted-foreground">
            {status.lastAttempt.outcome === 'trimmed'
              ? t('Last attempt could not reorganize memory; old history was archived instead.')
              : t('Last attempt did not complete.')}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleConsolidate}
            disabled={status?.consolidating}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-foreground border border-border hover:border-primary/60 hover:text-primary rounded-lg transition-colors disabled:opacity-50"
          >
            {status?.consolidating
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <Sparkles className="w-3.5 h-3.5" />}
            {status?.consolidating ? t('Consolidating…') : t('Consolidate now')}
          </button>
          {notice && <span className="text-xs text-muted-foreground">{notice}</span>}
        </div>
      </div>
    </div>
  )
}
