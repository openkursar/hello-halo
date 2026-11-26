import { useEffect, useState } from 'react'
import { useTranslation } from '../../i18n'
import { useOrgSignInStore } from '../../stores/org-sign-in.store'
import { orgSignInCardView } from '../org-sign-in/org-sign-in-view'
import { OrgSignInNotice } from '../org-sign-in/OrgSignInNotice'

export function OrganizationSetupActions({ onContinue, hasModel }: { onContinue: () => Promise<void>; hasModel: boolean }) {
  const { t } = useTranslation()
  const { state, readFailed, start, signIn, retry, lastResult } = useOrgSignInStore()
  const [busy, setBusy] = useState(false)
  useEffect(() => { start() }, [start])
  const view = orgSignInCardView(state, readFailed, true)
  const name = state?.name || t('Organization')
  const run = async (login: boolean) => {
    setBusy(true)
    try {
      if (!login || await signIn() === 'succeeded') await onContinue()
    } finally { setBusy(false) }
  }
  const primary = 'w-full rounded-lg bg-primary px-4 py-3 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-60'
  return (
    <div className="space-y-3 text-center">
      {view.notice && <OrgSignInNotice notice={view.notice} />}
      {view.offerRetry && <button type="button" disabled={busy} onClick={() => void retry()} className={primary}>{t('Retry')}</button>}
      {view.offerSignIn && <button type="button" disabled={busy || state?.signingIn} onClick={() => void run(true)} className={primary}>{t('Sign in to {{name}}', { name })}</button>}
      {lastResult === 'failed' && <p role="alert" className="text-sm text-destructive">{t('Sign-in did not complete. Please try again.')}</p>}
      {lastResult === 'expired' && <p role="alert" className="text-sm text-destructive">{t('The sign-in page timed out. Please try again.')}</p>}
      <button type="button" disabled={busy || state?.signingIn} onClick={() => void run(false)} className={view.signedIn && !view.offerSignIn ? primary : 'min-h-11 text-sm text-muted-foreground hover:text-foreground'}>
        {view.signedIn ? t('Continue') : t('Skip organization sign-in')}
      </button>
      {!hasModel && <p className="text-xs text-muted-foreground">{t('Next, choose a model or configure one later.')}</p>}
    </div>
  )
}
