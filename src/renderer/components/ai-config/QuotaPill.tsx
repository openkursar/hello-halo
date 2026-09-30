/**
 * QuotaPill — a small ring beside the composer's send button showing how much
 * of the active source's metered quota is left; hovering or focusing it opens
 * QuotaPopover with the numbers.
 *
 * Renders nothing unless the source's provider actually reports quota
 * (`supported && snapshot`), so open-source builds — where no provider reports
 * quota — show no pill and issue no requests.
 *
 * All refresh logic lives in `useSourceQuota`; this component only draws state.
 */

import { useEffect, useRef, useState } from 'react'
import { Cloud, AlertTriangle } from 'lucide-react'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { useSourceQuota } from '../../hooks/useSourceQuota'
import { useAppStore } from '../../stores/app.store'
import { resolveLocalizedText } from '../../../shared/types'
import { formatQuotaNumber } from './quotaFormat'
import { QuotaPopover } from './QuotaPopover'
import { trackHome } from '../../services/home-telemetry'

interface QuotaPillProps {
  /** Current active source id; undefined disables the pill entirely. */
  sourceId: string | undefined
}

/** Below this remaining/total ratio the pill switches to a warning palette. */
const LOW_RATIO = 0.25
/** Hovering across the ring shouldn't refetch each time; the popover's numbers can be this old. */
const REFRESH_MIN_INTERVAL_MS = 30_000

export function QuotaPill({ sourceId }: QuotaPillProps) {
  const { t } = useTranslation()
  const { snapshot, supported, stale, refresh } = useSourceQuota(sourceId)
  const sourceName = useAppStore(state => {
    const src = state.config?.aiSources
    return src?.version === 2 ? src.sources.find(s => s.id === sourceId)?.name : undefined
  })
  const [open, setOpen] = useState(false)

  // A short delay before closing lets the pointer cross from the ring to the
  // panel (and back) without it flickering shut.
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastRefreshAt = useRef(0)
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current) }, [])
  useEffect(() => {
    if (!open) return
    const handleKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open])
  const show = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = null
    if (open) return
    trackHome('home.composer.quota', { action: 'open', low })
    if (Date.now() - lastRefreshAt.current >= REFRESH_MIN_INTERVAL_MS) {
      lastRefreshAt.current = Date.now()
      refresh()
    }
    setOpen(true)
  }
  const hide = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setOpen(false), 150)
  }
  // A tap (no hover to leave) toggles; with a mouse, hover has already opened it.
  const toggle = () => {
    if (!open) show()
    else if (!window.matchMedia('(hover: hover)').matches) setOpen(false)
  }

  if (!supported || !snapshot) return null

  const { remaining, total, symbol, unit } = snapshot
  const hasBar = total > 0
  const ratio = hasBar ? Math.max(0, Math.min(1, remaining / total)) : 0
  const low = hasBar && ratio < LOW_RATIO
  // Currency symbol renders as a prefix; a unit word renders as a suffix.
  const unitLabel = !symbol && unit ? resolveLocalizedText(unit, getCurrentLanguage()) : ''

  const amount = `${symbol ?? ''}${formatQuotaNumber(remaining)}${unitLabel ? ` ${unitLabel}` : ''}`
  const label = `${t('Remaining quota')}: ${amount}`
  // r=7 in a 20-unit box; the arc starts at 12 o'clock and runs clockwise.
  const circumference = 2 * Math.PI * 7

  return (
    <div className="relative flex items-center" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      <button
        type="button"
        onClick={toggle}
        aria-label={label}
        aria-expanded={open}
        className="relative flex h-8 w-6 items-center justify-center rounded-sm transition-colors ease-halo hover:bg-secondary"
      >
        {hasBar ? (
          <svg viewBox="0 0 20 20" className="h-4 w-4 translate-y-px -rotate-90" aria-hidden="true">
            <circle cx="10" cy="10" r="7" fill="none" strokeWidth="2.4" className="stroke-border" />
            <circle
              cx="10" cy="10" r="7" fill="none" strokeWidth="2.4" strokeLinecap="round"
              className={low ? 'stroke-amber-500' : 'stroke-primary'}
              strokeDasharray={`${ratio * circumference} ${circumference}`}
            />
          </svg>
        ) : (
          <Cloud className="w-4 h-4 text-faint-foreground" />
        )}
        {stale && <AlertTriangle className="absolute right-0.5 top-0.5 w-2.5 h-2.5 text-amber-500" />}
      </button>

      {open && <QuotaPopover snapshot={snapshot} stale={stale} sourceName={sourceName} />}
    </div>
  )
}
