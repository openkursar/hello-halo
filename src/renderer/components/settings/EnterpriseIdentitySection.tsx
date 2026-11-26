/**
 * Organization sign-in card in Settings. An ordinary account card: who is
 * signed in, what each capability can do now, and the actions. Signing in
 * opens the organization's own page in a separate window. Renders nothing in a
 * build without organization sign-in.
 */
import { useEffect, useState } from 'react'
import { Building2, LogOut } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { isElectron, orgSignInOffered } from '../../api/transport'
import { useConfirmDialog } from '../../hooks/useConfirmDialog'
import { Disclosure } from '../ui/Disclosure'
import { useOrgSignInStore } from '../../stores/org-sign-in.store'
import { OrgCapabilityList } from '../org-sign-in/OrgCapabilityList'
import { orgSignInCardView } from '../org-sign-in/org-sign-in-view'
import { OrgSignInNotice } from '../org-sign-in/OrgSignInNotice'

export interface EnterpriseIdentitySectionProps {
  /** Tells the page whether to list this section in its navigation. */
  onAvailabilityChange?: (available: boolean) => void
}

export function EnterpriseIdentitySection(props: EnterpriseIdentitySectionProps) {
  return orgSignInOffered() ? <OrgSignInCard {...props} /> : null
}

function OrgSignInCard({ onAvailabilityChange }: EnterpriseIdentitySectionProps) {
  const { t } = useTranslation()
  const state = useOrgSignInStore(s => s.state)
  const lastResult = useOrgSignInStore(s => s.lastResult)
  const readFailed = useOrgSignInStore(s => s.readFailed)
  const retry = useOrgSignInStore(s => s.retry)
  const start = useOrgSignInStore(s => s.start)
  const signIn = useOrgSignInStore(s => s.signIn)
  const signOut = useOrgSignInStore(s => s.signOut)
  const { showConfirm, DialogComponent } = useConfirmDialog()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const desktop = isElectron()

  useEffect(() => { start() }, [start])
  const view = orgSignInCardView(state, readFailed, desktop)
  const { available, signedIn, nothingWorks, notice } = view
  useEffect(() => { onAvailabilityChange?.(available) }, [available, onAvailabilityChange])
  if (!available) return null

  const name = state?.name || t('Organization')

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      console.warn('[OrgSignIn] Could not complete the organization sign-out action', err)
      setError(t('Could not confirm sign-out. Please try again.'))
    } finally {
      setBusy(false)
    }
  }
  const unbind = async () => {
    const confirmed = await showConfirm({
      title: t('Remove this device?'),
      message: t('This signs you out and removes this computer from {{name}}. Next time you sign in, you need to confirm this device again.', { name }),
      confirmLabel: t('Remove'),
      cancelLabel: t('Cancel'),
      variant: 'danger',
    })
    if (confirmed) await run(() => signOut('device'))
  }

  return (
    <section id="enterprise-identity" className="bg-card rounded-xl border border-border-faint p-4 sm:p-6" data-testid="enterprise-identity-section">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-secondary">
          <Building2 className="w-4 h-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-medium truncate">{name}</h2>
          <p className="text-sm text-muted-foreground">
            {signedIn && state?.account
              ? state.account.displayName
              : t('Sign in so Halo can reach internal systems and more for you. Your password and credentials never reach the AI.')}
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-2 rounded-lg border border-border px-4 py-3" data-testid="enterprise-identity-status" data-status={view.status}>
        {notice && <OrgSignInNotice notice={notice} />}
        {state && (!notice || notice === 'issue-failed') && <OrgCapabilityList capabilities={state.capabilities} />}
      </div>
      {lastResult === 'failed' && <p className="mt-3 text-xs text-halo-warning">{t('Sign-in did not complete. Please try again.')}</p>}
      {lastResult === 'expired' && <p className="mt-3 text-xs text-halo-warning">{t('The sign-in page timed out. Please try again.')}</p>}

      {view.tools.length > 0 && (
        <div className="mt-4">
          <Disclosure title={t('Tools that use this sign-in')}>
            <ul className="space-y-1">
              {view.tools.map(tool => (
                <li key={tool.toolId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm" data-testid="enterprise-identity-tool" data-access={tool.access}>
                  <span className="min-w-0 truncate font-mono text-xs" title={tool.toolId}>{tool.toolId}</span>
                  <span className={`text-xs ${tool.access === 'ready' ? 'text-halo-success' : tool.access === 'maybe-still-valid' ? 'text-halo-warning' : 'text-muted-foreground'}`}>
                    {tool.access === 'ready' ? t('Access ready') : tool.access === 'maybe-still-valid' ? t('Earlier access may still work') : t('No access')}
                  </span>
                </li>
              ))}
            </ul>
          </Disclosure>
        </div>
      )}

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        {view.offerRetry && (
          <button type="button" onClick={() => void run(retry)} disabled={busy || state?.signingIn}
            className="min-h-11 sm:min-h-9 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-60">
            {t('Retry')}
          </button>
        )}
        {desktop ? (
          <>
            {view.offerSignIn && (
              <button
                type="button"
                onClick={() => void run(signIn)}
                disabled={busy || state?.signingIn}
                className="min-h-11 sm:min-h-9 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-60"
                data-testid="enterprise-identity-sign-in"
              >
                {state?.signingIn ? t('Waiting for sign-in…') : nothingWorks ? t('Sign in') : view.expired.length ? t('Sign in again') : t('Add another sign-in method')}
              </button>
            )}
            {signedIn && notice !== 'withdrawal' && (
              <button
                type="button"
                onClick={() => void run(() => signOut('session'))}
                disabled={busy}
                className="flex min-h-11 sm:min-h-9 items-center justify-center gap-1.5 rounded-lg border border-border px-4 text-sm hover:bg-secondary disabled:opacity-60"
              >
                <LogOut className="w-3.5 h-3.5" />
                {t('Sign out')}
              </button>
            )}
            {state?.canUnbindDevice && signedIn && notice !== 'withdrawal' && (
              <button
                type="button"
                onClick={() => void unbind()}
                disabled={busy}
                className="min-h-11 sm:min-h-9 rounded-lg px-4 text-sm text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-60 sm:ml-auto"
              >
                {t('Remove this device')}
              </button>
            )}
          </>
        ) : (
          notice === 'incompatible' || view.offerRetry ? null : <p className="text-xs text-muted-foreground">{notice ? t('Manage organization sign-in from the Halo desktop app.') : t('Sign in from the Halo desktop app.')}</p>
        )}
      </div>
      {error && notice !== 'withdrawal' && <p className="mt-2 text-xs text-destructive break-words">{error}</p>}
      {DialogComponent}
    </section>
  )
}
