/**
 * QuotaPopover — expanded metered-quota detail for the header QuotaPill.
 *
 * Pure presentation over an AuthQuotaSnapshot: total / used / remaining, an
 * optional per-segment breakdown, a reset countdown, and an external "manage
 * quota" link. Every optional field renders only when present, so a minimal
 * snapshot degrades gracefully.
 */

import { useTranslation, getCurrentLanguage } from '../../i18n'
import { api } from '../../api'
import { ExternalLink, Clock, AlertTriangle } from 'lucide-react'
import { resolveLocalizedText, type AuthQuotaSnapshot, type LocalizedText } from '../../../shared/types'
import { formatQuotaValue } from './quotaFormat'

interface QuotaPopoverProps {
  snapshot: AuthQuotaSnapshot
  /** Whether the last refresh failed (shows a "may be outdated" note). */
  stale: boolean
  onClose: () => void
}

function localized(value: LocalizedText | undefined, fallback = ''): string {
  return value ? resolveLocalizedText(value, getCurrentLanguage()) : fallback
}

/** Segment swatch colors (theme-token based, cycled for extra segments). */
const SEGMENT_SWATCHES = ['bg-primary', 'bg-primary/60', 'bg-primary/40', 'bg-primary/25']

export function QuotaPopover({ snapshot, stale, onClose }: QuotaPopoverProps) {
  const { t } = useTranslation()

  const { remaining, total, used, nextResetTime, segments, detailsUrl, detailsLabel } = snapshot
  const hasBar = total > 0
  const ratio = hasBar ? Math.max(0, Math.min(1, remaining / total)) : 0

  const formatCountdown = (epochSeconds: number): string => {
    const seconds = epochSeconds - Date.now() / 1000
    if (seconds <= 0) return t('Resetting soon')
    const days = Math.floor(seconds / 86400)
    const hours = Math.floor((seconds % 86400) / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    if (days > 0) {
      return t('${d} days ${h} hours').replace('${d}', String(days)).replace('${h}', String(hours))
    }
    if (hours > 0) {
      return t('${h} hours ${m} minutes').replace('${h}', String(hours)).replace('${m}', String(minutes))
    }
    return t('${m} minutes').replace('${m}', String(minutes))
  }

  return (
    <>
      {/* Click-outside backdrop */}
      <div className="fixed inset-0 z-40" onClick={onClose} />

      <div
        className="absolute right-0 mt-2 z-50 w-[min(20rem,calc(100vw-2rem))] bg-card border border-border rounded-xl shadow-lg p-4"
        onClick={(e) => e.stopPropagation()}
      >
        {stale && (
          <div className="flex items-center gap-1.5 mb-2 text-xs text-amber-600 dark:text-amber-500">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span>{t('Data may be outdated')}</span>
          </div>
        )}

        <div className="flex items-center justify-between text-sm py-1">
          <span className="text-muted-foreground">{t('Total quota')}</span>
          <span className="font-medium tabular-nums">{formatQuotaValue(total, snapshot)}</span>
        </div>
        <div className="flex items-center justify-between text-sm py-1">
          <span className="text-muted-foreground">{t('Used')}</span>
          <span className="font-medium tabular-nums">{formatQuotaValue(used, snapshot)}</span>
        </div>

        <div className="h-px bg-border my-2" />

        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold tabular-nums">{formatQuotaValue(remaining, snapshot)}</span>
          <span className="text-sm text-muted-foreground">{t('remaining')}</span>
        </div>

        {hasBar && (
          <div className="h-2 rounded-full bg-secondary overflow-hidden mt-2">
            <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${ratio * 100}%` }} />
          </div>
        )}

        {segments && segments.length > 0 && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 mt-3 text-xs text-muted-foreground">
            {segments.map((seg, i) => (
              <span key={i} className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-sm ${SEGMENT_SWATCHES[i % SEGMENT_SWATCHES.length]}`} />
                {localized(seg.label)} <span className="tabular-nums text-foreground">{formatQuotaValue(seg.value, snapshot)}</span>
              </span>
            ))}
          </div>
        )}

        {typeof nextResetTime === 'number' && (
          <div className="flex items-center gap-1.5 mt-3 px-2.5 py-1.5 rounded-lg bg-secondary/50 border border-border text-xs text-muted-foreground">
            <Clock className="w-3.5 h-3.5 shrink-0" />
            <span>
              {t('Time until reset:')} {formatCountdown(nextResetTime)}
            </span>
          </div>
        )}

        {detailsUrl && (
          <button
            type="button"
            onClick={() => { void api.openExternal(detailsUrl) }}
            className="w-full mt-3 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm btn-primary"
          >
            {localized(detailsLabel, t('Manage quota'))}
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </>
  )
}
