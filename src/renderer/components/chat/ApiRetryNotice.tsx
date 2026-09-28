/**
 * ApiRetryNotice — a model request failed and the engine will send it again.
 *
 * Shown in the live turn for as long as the wait lasts, so a slow recovery
 * reads as "retrying, and here is why" rather than an endless spinner. The
 * countdown runs on this client's clock from the deadline the store fixed when
 * the notice arrived.
 */

import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useTranslation } from '../../i18n'
import type { ApiRetryNotice as ApiRetryNoticeState } from '../../types'

interface ApiRetryNoticeProps {
  retry: ApiRetryNoticeState
  /** Stops the turn — and with it the retries. Omitted where the surface offers no stop. */
  onStop?: () => void
}

/** Milliseconds left until `deadline`, refreshed once a second until it passes. */
function useRemainingMs(deadline: number): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    setNow(Date.now())
    if (deadline <= Date.now()) return
    const timer = setInterval(() => {
      const current = Date.now()
      setNow(current)
      if (current >= deadline) clearInterval(timer)
    }, 1000)
    return () => clearInterval(timer)
  }, [deadline])

  return Math.max(0, deadline - now)
}

export function ApiRetryNotice({ retry, onStop }: ApiRetryNoticeProps) {
  const { t } = useTranslation()
  const remainingMs = useRemainingMs(retry.retryAt)
  const seconds = Math.ceil(remainingMs / 1000)

  const title = (() => {
    if (retry.errorStatus === null && retry.errorKind === 'unknown') return t('Could not reach the model service')
    if (retry.errorStatus === 529) return t('The model service is overloaded')
    switch (retry.errorKind) {
      case 'rate_limit': return t('The model service is limiting requests')
      case 'server_error': return t('The model service returned an error')
      case 'authentication_failed': return t('The model service rejected the credentials')
      case 'billing_error': return t('The model provider reported a billing problem')
      default: return t('The model request failed')
    }
  })()

  const progress = retry.delayMs > 0 ? 1 - remainingMs / retry.delayMs : 1

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-3 overflow-hidden rounded-xl border border-halo-warning/30 bg-halo-warning/5 animate-fade-in"
    >
      <div className="flex items-start gap-2.5 px-3 pt-2.5 pb-2 sm:px-4">
        <RefreshCw
          size={15}
          aria-hidden
          className="mt-0.5 shrink-0 text-halo-warning animate-spin [animation-duration:2.4s]"
        />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium text-foreground">{title}</span>
            {retry.errorStatus !== null && (
              <span className="rounded bg-halo-warning/10 px-1.5 py-px font-mono text-[11px] text-halo-warning">
                HTTP {retry.errorStatus}
              </span>
            )}
          </div>

          {retry.errorMessage && (
            <p
              className="mt-1 break-words text-xs text-muted-foreground line-clamp-2"
              title={retry.errorMessage}
            >
              {retry.errorMessage}
            </p>
          )}

          <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <span aria-hidden className="tabular-nums text-foreground/80">
              {seconds > 0
                ? t('Retrying in {{seconds}}s', { seconds })
                : t('Retrying now…')}
            </span>
            <span aria-hidden>·</span>
            <span>
              {t('Attempt {{attempt}} of {{max}}', { attempt: retry.attempt, max: retry.maxRetries })}
            </span>
          </p>
        </div>

        {onStop && (
          <button
            type="button"
            onClick={onStop}
            className="min-h-9 shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground sm:min-h-0 sm:px-2.5
              hover:bg-destructive/10 hover:text-destructive active:bg-destructive/20
              transition-colors"
            title={t('Stop generation (Esc)')}
          >
            {t('Stop')}
          </button>
        )}
      </div>

      <div className="h-0.5 bg-halo-warning/10" aria-hidden>
        <div
          key={retry.retryAt}
          className="h-full bg-halo-warning/50"
          style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%`, transition: 'width 1s linear' }}
        />
      </div>
    </div>
  )
}
