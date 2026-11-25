/**
 * Enterprise identity section
 *
 * Company sign-in for command-line tools the build ships or its catalog
 * provides. Renders nothing in a build without an enterprise identity. The
 * state is read when Settings opens, after each action and once when the
 * session is due to end; nothing polls in the background.
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Globe, LogOut, QrCode, ShieldCheck } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import { useConfirmDialog } from '../../hooks/useConfirmDialog'
import type { EnterpriseIdentityMethod, EnterpriseIdentityState } from '../../../shared/types/enterprise-identity'
import { EnterpriseIdentityScanDialog } from './EnterpriseIdentityScanDialog'
import { unwrapIdentity } from './enterprise-identity-result'

export interface EnterpriseIdentitySectionProps {
  /** Tells the page whether to list this section in its navigation. */
  onAvailabilityChange?: (available: boolean) => void
}

export function EnterpriseIdentitySection({ onAvailabilityChange }: EnterpriseIdentitySectionProps) {
  const { t } = useTranslation()
  const [state, setState] = useState<EnterpriseIdentityState | null>(null)
  const [scanMethod, setScanMethod] = useState<EnterpriseIdentityMethod | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { showConfirm, DialogComponent: SignOutConfirm } = useConfirmDialog()

  const refresh = useCallback(async () => {
    try {
      setState(unwrapIdentity(await api.enterpriseIdentityState()))
    } catch (err) {
      console.warn('[EnterpriseIdentity] state unavailable', err)
      setState(null)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  // Re-read once when the session is due to end, so an open page shows the expiry.
  const readyUntil = state?.status === 'ready' ? state.expiresAt : undefined
  useEffect(() => {
    if (!readyUntil) return
    const delay = Math.min(Math.max(readyUntil - Date.now() + 1000, 1000), 2 ** 31 - 1)
    const timer = setTimeout(() => { void refresh() }, delay)
    return () => clearTimeout(timer)
  }, [readyUntil, refresh])

  const available = state !== null && state.status !== 'unavailable'
  useEffect(() => { onAvailabilityChange?.(available) }, [available, onAvailabilityChange])

  const signOut = useCallback(async () => {
    const confirmed = await showConfirm({
      title: t('Sign out of your company account?'),
      message: t('Company tools lose access right away, including in running tasks. Next time you will need to scan the code to sign in again.'),
      confirmLabel: t('Sign out'),
      cancelLabel: t('Cancel'),
      variant: 'warning',
    })
    if (!confirmed) return
    setBusy(true)
    setError(null)
    try {
      setState(unwrapIdentity(await api.enterpriseIdentitySignOut()))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [showConfirm, t])

  const closeDialog = useCallback(() => {
    setScanMethod(null)
    void refresh()
  }, [refresh])

  if (!state || state.status === 'unavailable') return null

  const signedIn = state.status === 'ready'
  const methodLabel = state.methods.find(m => m.id === state.methodId)?.label
  const expires = state.expiresAt ? new Date(state.expiresAt).toLocaleString() : null

  return (
    <section id="enterprise-identity" className="bg-card rounded-xl border border-border-faint p-6" data-testid="enterprise-identity-section">
      <h2 className="text-lg font-medium mb-1">{t('Enterprise identity')}</h2>
      <p className="text-sm text-muted-foreground mb-4">
        {t('Sign in with your company account so company command-line tools can reach internal services. The AI never sees your sign-in.')}
      </p>

      {/* Status */}
      <div className="rounded-lg border border-border px-4 py-3 space-y-1" data-testid="enterprise-identity-status" data-status={state.status}>
        {signedIn ? (
          <>
            <div className="flex items-center gap-2 text-sm font-medium">
              <CheckCircle2 className="w-4 h-4 text-green-500" />
              <span className="truncate">{state.account?.displayName}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              {methodLabel ? t('Signed in with {{method}}', { method: methodLabel }) : t('Signed in')}
              {expires ? ` · ${t('Until {{time}}', { time: expires })}` : ''}
            </p>
          </>
        ) : state.status === 'expired' ? (
          <div className="flex items-center gap-2 text-sm">
            <AlertTriangle className="w-4 h-4 text-amber-500" />
            <span>{t('Your sign-in for {{name}} has ended. Sign in again to keep using company tools.', { name: state.account?.displayName ?? '' })}</span>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ShieldCheck className="w-4 h-4" />
            <span>{t('Not signed in')}</span>
          </div>
        )}
      </div>

      {state.lastError === 'credential-failed' && (
        <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
          {t('Some tools could not get access with this sign-in. Sign out and sign in again, or contact your administrator.')}
        </p>
      )}

      {/* Bound tools */}
      {state.boundTools.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-medium text-muted-foreground mb-2">{t('Tools that use this sign-in')}</p>
          <ul className="space-y-1">
            {state.boundTools.map(tool => (
              <li key={tool.toolId} className="flex items-center justify-between gap-3 text-sm" data-testid="enterprise-identity-tool" data-active={tool.active ? 'true' : 'false'}>
                <span className="font-mono text-xs truncate min-w-0" title={tool.toolId}>{tool.toolId}</span>
                <span className={`shrink-0 whitespace-nowrap text-xs ${tool.active ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground'}`}>
                  {tool.active ? t('Access ready') : t('No access')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Actions */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {signedIn ? (
          <button
            type="button"
            onClick={() => void signOut()}
            disabled={busy}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-border hover:bg-muted transition-colors disabled:opacity-50"
          >
            <LogOut className="w-3.5 h-3.5" />
            {t('Sign out')}
          </button>
        ) : (
          state.methods.map((method, index) => (
            <button
              key={method.id}
              type="button"
              onClick={() => setScanMethod(method)}
              data-testid={`enterprise-identity-method-${method.id}`}
              className={index === 0
                ? 'flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors'
                : 'flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-border hover:bg-muted transition-colors'}
            >
              {method.kind === 'browser' ? <Globe className="w-3.5 h-3.5" /> : <QrCode className="w-3.5 h-3.5" />}
              {t('Sign in with {{method}}', { method: method.label })}
            </button>
          ))
        )}
      </div>
      {error && <p className="mt-2 text-xs text-red-500 break-words">{error}</p>}

      {scanMethod && (
        <EnterpriseIdentityScanDialog
          open
          methodId={scanMethod.id}
          methodLabel={scanMethod.label}
          methodKind={scanMethod.kind}
          onClose={closeDialog}
          onStateChange={setState}
        />
      )}
      {SignOutConfirm}
    </section>
  )
}
