/**
 * A digital human that stopped and cannot restart itself, rendered as one more
 * item in the list of things waiting on its owner rather than as a status of
 * its own — anything shown as needing the owner has to carry the way out of it,
 * and for both stop reasons that way out is resume.
 */

import { useState } from 'react'
import { OctagonAlert, RefreshCw } from 'lucide-react'
import type { BlockedReason } from '../../../shared/apps/app-types'
import { useAppsStore } from '../../stores/apps.store'
import { useTranslation } from '../../i18n'

export function blockedHeadline(reason: BlockedReason, t: (key: string) => string): string {
  return reason === 'needs_login'
    ? t('Stopped: a sign-in it depends on expired')
    : t('Stopped itself after repeated failures')
}

export function BlockedCard({ appId, reason, message, onResumed }: {
  appId: string
  reason: BlockedReason
  /** What the runtime recorded when it stopped. */
  message?: string
  onResumed?: () => void
}) {
  const { t } = useTranslation()
  const resumeApp = useAppsStore(state => state.resumeApp)
  const [resuming, setResuming] = useState(false)
  const [failed, setFailed] = useState(false)
  const resume = async () => {
    if (resuming) return
    setResuming(true); setFailed(false)
    try {
      const ok = await resumeApp(appId)
      setFailed(!ok)
      if (ok) onResumed?.()
    } finally { setResuming(false) }
  }
  return (
    <div className="space-y-3 rounded-xl border border-halo-error/30 bg-halo-error/5 p-4">
      <p className="flex items-start gap-2 text-sm font-medium">
        <OctagonAlert size={16} className="mt-0.5 shrink-0 text-halo-error" />
        {blockedHeadline(reason, t)}
      </p>
      {message && <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{message}</p>}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">
          {reason === 'needs_login'
            ? t('Sign in again in the browser, then resume. Automatic tasks stay off until you do.')
            : t('Automatic tasks stay off until you resume. Check the last run first if the cause is unclear.')}
        </span>
        <button
          disabled={resuming}
          onClick={() => void resume()}
          className="flex min-h-9 items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs text-primary-foreground disabled:opacity-50"
        >
          <RefreshCw size={14} className={resuming ? 'animate-spin' : ''} />
          {resuming ? t('Resuming…') : t('Resume work')}
        </button>
      </div>
      {failed && <p role="alert" className="text-xs text-destructive">{t('Could not resume. Please try again.')}</p>}
    </div>
  )
}
