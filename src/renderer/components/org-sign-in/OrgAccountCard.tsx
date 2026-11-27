/**
 * The organization sign-in as one card among the AI model accounts. It shows
 * the account, whether each capability works, and the model account that came
 * with the sign-in, which is chosen and edited here like any other account.
 */
import { useState, type ReactNode } from 'react'
import { Building2, Check, ChevronRight, Edit2, Loader2, LogOut } from 'lucide-react'
import type { AISource } from '../../../shared/types/ai-sources'
import { useTranslation, getCurrentLanguage } from '../../i18n'
import { isElectron } from '../../api/transport'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { useOrgSignInStore } from '../../stores/org-sign-in.store'
import { Disclosure } from '../ui/Disclosure'
import { OrgCapabilityList } from './OrgCapabilityList'
import { OrgSignInNotice } from './OrgSignInNotice'
import { joinLabels, orgSignInCardView } from './org-sign-in-view'

/** Where the card is found when no model account came with the sign-in. */
export const ORG_CARD_ID = 'organization-sign-in'

interface OrgAccountCardProps {
  /** The model account that came with this sign-in, if any. */
  account?: AISource
  chosen: boolean
  expanded: boolean
  busy: boolean
  /** The account's editor, open in place of the details. */
  editor?: ReactNode
  onToggle: () => void
  onChoose: () => void
  onEdit: () => void
}

export function OrgAccountCard({ account, chosen, expanded, busy, editor, onToggle, onChoose, onEdit }: OrgAccountCardProps) {
  const { t } = useTranslation()
  const state = useOrgSignInStore(s => s.state)
  const readFailed = useOrgSignInStore(s => s.readFailed)
  const lastResult = useOrgSignInStore(s => s.lastResult)
  const signIn = useOrgSignInStore(s => s.signIn)
  const signOut = useOrgSignInStore(s => s.signOut)
  const retry = useOrgSignInStore(s => s.retry)
  const [confirming, setConfirming] = useState(false)
  const [forgetDevice, setForgetDevice] = useState(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const desktop = isElectron()
  const view = orgSignInCardView(state, readFailed, desktop)
  const { signedIn, notice, expired } = view
  const name = state?.name || t('Organization')
  const language = getCurrentLanguage()
  const disabled = busy || working

  const run = async (action: () => Promise<unknown>) => {
    setWorking(true)
    setError(null)
    try {
      await action()
    } catch (failure) {
      console.warn('[OrgSignIn] Could not complete the organization sign-out action', failure)
      setError(t('Could not confirm sign-out. Please try again.'))
    } finally {
      setWorking(false)
    }
  }

  const consequences = () => {
    const reachable = view.working.map(capability => capability.label)
    return [
      reachable.length ? t('{{list}} will stop working until you sign in again.', { list: joinLabels(reachable, language) }) : null,
      account && chosen ? t('New messages that use {{model}} will fail.', { model: account.model || name }) : null,
    ].filter(Boolean).join('\n\n')
  }
  const askSignOut = () => {
    setForgetDevice(false)
    setConfirming(true)
  }
  const confirmSignOut = () => {
    setConfirming(false)
    void run(() => signOut(forgetDevice ? 'device' : 'session'))
  }

  const pending = state?.signingIn || notice === 'pending'
  const attention = notice === 'withdrawal' || notice === 'issue-failed'
    ? t('Some access needs your attention')
    : signedIn && expired.length ? t('{{capability}} needs signing in again', { capability: joinLabels(expired.map(c => c.label), language) }) : null
  const summary = account
    ? account.model || t('No model selected')
    : pending ? t('Checking your sign-in…')
      : view.working.length ? t('{{list}} connected', { list: joinLabels(view.working.map(c => c.label), language) }) : null
  const signInLabel = state?.signingIn ? t('Waiting for sign-in…') : view.nothingWorks ? t('Sign in') : t('Sign in again')
  const actionClass = 'flex min-h-11 items-center gap-1 rounded-md px-3 py-1.5 text-sm transition-colors disabled:opacity-50 sm:min-h-0'

  return (
    <div
      data-ai-source-id={account?.id ?? ORG_CARD_ID}
      data-testid="org-account-card"
      data-status={view.status}
      tabIndex={-1}
      className={`scroll-mt-4 rounded-lg border transition-colors ${chosen ? 'border-primary/50 bg-primary/[0.04] theme-dark:bg-primary/10' : 'border-border bg-card'} ${editor ? 'shadow-soft' : ''}`}
    >
      <div data-ai-source-header className={`flex items-center gap-3 p-3 ${editor ? '' : 'cursor-pointer'}`} onClick={editor ? undefined : onToggle}>
        {account ? (
          <button
            type="button"
            aria-pressed={chosen}
            aria-label={t('Use {{name}} for new chats', { name })}
            disabled={disabled}
            onClick={event => {
              event.stopPropagation()
              if (!chosen) onChoose()
            }}
            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${chosen ? 'border-primary bg-primary' : 'border-border hover:border-primary'}`}
          >
            {chosen && <Check size={12} className="text-primary-foreground" />}
          </button>
        ) : <span aria-hidden="true" className="w-5 shrink-0" />}
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-secondary">
          {pending ? <Loader2 size={16} className="animate-spin text-muted-foreground" /> : <Building2 size={16} className="text-muted-foreground" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className={`${editor ? 'break-words sm:truncate' : 'truncate'} font-medium text-foreground`} title={name}>{name}</div>
          {summary && <div className="truncate text-xs text-muted-foreground">{summary}</div>}
          {state?.account && <div className="truncate text-xs text-muted-foreground" title={state.account.displayName}>{state.account.displayName}</div>}
          {attention && <div className="text-xs text-halo-warning">{attention}</div>}
          {editor && <span className="text-xs text-muted-foreground sm:hidden">{t('Editing')}</span>}
        </div>
        {editor ? <span className="hidden text-xs text-muted-foreground sm:inline">{t('Editing')}</span> : (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={t('{{name}} details', { name })}
            onClick={event => {
              event.stopPropagation()
              onToggle()
            }}
            className="-m-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary"
          >
            <ChevronRight size={18} aria-hidden className={`transition-transform ${expanded ? 'rotate-90' : ''}`} />
          </button>
        )}
      </div>

      {editor ? (
        <div className="border-t border-border p-3 sm:p-4 animate-slide-down motion-reduce:animate-none">{editor}</div>
      ) : expanded && (
        <div className="space-y-3 border-t border-border p-3" data-testid="org-account-details">
          {notice && <OrgSignInNotice notice={notice} />}
          {state && (!notice || notice === 'issue-failed') && <OrgCapabilityList capabilities={state.capabilities} />}
          {lastResult === 'failed' && <p className="text-xs text-halo-warning">{t('Sign-in did not complete. Please try again.')}</p>}
          {lastResult === 'expired' && <p className="text-xs text-halo-warning">{t('The sign-in page timed out. Please try again.')}</p>}

          {view.tools.length > 0 && (
            <Disclosure title={t('Tools that use this sign-in')}>
              <ul className="space-y-1">
                {view.tools.map(tool => (
                  <li key={tool.toolId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm" data-testid="org-account-tool" data-access={tool.access}>
                    <span className="min-w-0 truncate font-mono text-xs" title={tool.toolId}>{tool.toolId}</span>
                    <span className={`text-xs ${tool.access === 'ready' ? 'text-halo-success' : tool.access === 'maybe-still-valid' ? 'text-halo-warning' : 'text-muted-foreground'}`}>
                      {tool.access === 'ready' ? t('Access ready') : tool.access === 'maybe-still-valid' ? t('Earlier access may still work') : t('No access')}
                    </span>
                  </li>
                ))}
              </ul>
            </Disclosure>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            {account && (
              <button type="button" data-ai-source-edit onClick={onEdit} disabled={disabled} className={`${actionClass} bg-secondary text-muted-foreground hover:bg-surface-hover`}>
                <Edit2 size={14} />{t('Edit')}
              </button>
            )}
            {view.offerRetry && (
              <button type="button" onClick={() => void run(retry)} disabled={disabled || state?.signingIn} className={`${actionClass} bg-primary font-medium text-primary-foreground hover:bg-primary-hover`}>
                {t('Retry')}
              </button>
            )}
            {desktop && view.offerSignIn && (
              <button type="button" data-testid="org-account-sign-in" onClick={() => void signIn()} disabled={disabled || state?.signingIn} className={`${actionClass} bg-primary font-medium text-primary-foreground hover:bg-primary-hover`}>
                {signInLabel}
              </button>
            )}
            {desktop && signedIn && notice !== 'withdrawal' && (
              <button type="button" onClick={askSignOut} disabled={disabled} className={`${actionClass} bg-secondary text-muted-foreground hover:bg-surface-hover hover:text-foreground`}>
                {working ? <Loader2 size={14} className="animate-spin" /> : <LogOut size={14} />}{t('Sign out')}
              </button>
            )}
          </div>
          {!desktop && notice !== 'incompatible' && !view.offerRetry && <p className="text-xs text-muted-foreground">{t('Manage organization sign-in from the Halo desktop app.')}</p>}
          {error && notice !== 'withdrawal' && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
        </div>
      )}
      {confirming && (
        <ConfirmDialog
          title={t('Sign out of {{name}}?', { name })}
          message={consequences() || t('You can sign in again at any time.')}
          details={state?.canUnbindDevice ? (
            <label className="flex cursor-pointer items-start gap-2 pt-2 text-xs text-foreground">
              <input type="checkbox" checked={forgetDevice} onChange={event => setForgetDevice(event.target.checked)} className="mt-0.5 accent-primary" />
              <span>
                {t('Also remove this computer\'s authorization')}
                <span className="mt-0.5 block text-muted-foreground">{t('Choose this when handing over or sharing this computer. Next time you sign in, you will need to confirm this computer again.')}</span>
              </span>
            </label>
          ) : undefined}
          confirmLabel={t('Sign out')}
          cancelLabel={t('Cancel')}
          onConfirm={confirmSignOut}
          onCancel={() => setConfirming(false)}
          variant="danger"
        />
      )}
    </div>
  )
}
