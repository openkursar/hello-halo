/**
 * QuotaPill — header chip showing the active source's remaining metered quota.
 *
 * Renders nothing unless the source's provider actually reports quota
 * (`supported && snapshot`), so open-source builds — where no provider reports
 * quota — show no pill and issue no requests. Clicking opens QuotaPopover.
 *
 * All refresh logic lives in `useSourceQuota`; this component only draws state.
 */

import { useState } from 'react'
import { Cloud, AlertTriangle } from 'lucide-react'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { useSourceQuota } from '../../hooks/useSourceQuota'
import { resolveLocalizedText } from '../../../shared/types'
import { formatQuotaNumber } from './quotaFormat'
import { QuotaPopover } from './QuotaPopover'

interface QuotaPillProps {
  /** Current active source id; undefined disables the pill entirely. */
  sourceId: string | undefined
}

/** Below this remaining/total ratio the pill switches to a warning palette. */
const LOW_RATIO = 0.25

export function QuotaPill({ sourceId }: QuotaPillProps) {
  const { t } = useTranslation()
  const { snapshot, supported, stale, refresh } = useSourceQuota(sourceId)
  const [open, setOpen] = useState(false)

  if (!supported || !snapshot) return null

  const { remaining, total, symbol, unit } = snapshot
  const hasBar = total > 0
  const ratio = hasBar ? Math.max(0, Math.min(1, remaining / total)) : 0
  const low = hasBar && ratio < LOW_RATIO
  // Currency symbol renders as a prefix; a unit word renders as a suffix.
  const unitLabel = !symbol && unit ? resolveLocalizedText(unit, getCurrentLanguage()) : ''

  const toggle = () => {
    setOpen(prev => {
      const next = !prev
      if (next) refresh()
      return next
    })
  }

  return (
    <div className="relative">
      <button
        onClick={toggle}
        title={t('Remaining quota')}
        aria-expanded={open}
        className={`flex h-[26px] items-center gap-[5px] px-[9px] rounded-full border text-[11px] transition-colors ease-halo ${
          low
            ? 'bg-amber-500/[0.12] border-amber-500/[0.35] hover:border-amber-500'
            : 'bg-primary/[0.12] border-primary/[0.18] hover:border-primary'
        }`}
      >
        <Cloud className={`w-3.5 h-3.5 shrink-0 ${low ? 'text-amber-500' : 'text-accent-on-dark'}`} />
        <span className={`font-bold tabular-nums ${low ? 'text-amber-600 dark:text-amber-500' : 'text-accent-on-dark'}`}>
          {symbol}{formatQuotaNumber(remaining)}
        </span>
        {/* Unit + mini progress bar — desktop only to keep the mobile header tight */}
        {unitLabel && <span className="hidden sm:inline text-muted-foreground">{unitLabel}</span>}
        {hasBar && (
          <span className="hidden sm:block w-[46px] h-1 rounded-[2px] bg-surface-hover overflow-hidden">
            <span
              className={`block h-full rounded-[2px] ${low ? 'bg-amber-500' : 'bg-primary'}`}
              style={{ width: `${ratio * 100}%` }}
            />
          </span>
        )}
        {stale && <AlertTriangle className="w-3 h-3 shrink-0 text-amber-500" />}
      </button>

      {open && <QuotaPopover snapshot={snapshot} stale={stale} onClose={() => setOpen(false)} />}
    </div>
  )
}
