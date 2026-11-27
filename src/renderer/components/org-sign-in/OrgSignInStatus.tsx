/**
 * OrgSignInStatus — the organization sign-in indicator beside the composer's
 * send controls. It also carries the selected model's quota ring, so the
 * composer shows one account indicator, not two. A build without organization
 * sign-in mounts nothing and makes no request (the composer shows QuotaPill);
 * otherwise it stays, and cannot be dismissed, because it is the place to sign
 * in from while chatting.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle, Building2, CircleAlert, Loader2 } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { isElectron, orgSignInOffered } from '../../api/transport'
import { useOrgSignInStore } from '../../stores/org-sign-in.store'
import { QuotaRing, useComposerQuota } from '../ai-config/QuotaPill'
import { QuotaDetails } from '../ai-config/QuotaPopover'
import { orgIndicatorView } from './org-sign-in-view'
import { OrgCapabilityList } from './OrgCapabilityList'
import { OrgSignInNotice } from './OrgSignInNotice'

interface OrgSignInStatusProps {
  /** The invitation above an empty conversation instead of the indicator. */
  invitation?: boolean
  /** Source whose quota the indicator shows. */
  quotaSourceId?: string
}

export function OrgSignInStatus({ invitation = false, quotaSourceId }: OrgSignInStatusProps) {
  return orgSignInOffered() ? <OrgSignInIndicator invitation={invitation} quotaSourceId={quotaSourceId} /> : null
}

function OrgSignInIndicator({ invitation, quotaSourceId }: { invitation: boolean; quotaSourceId?: string }) {
  const { t } = useTranslation()
  const state = useOrgSignInStore(s => s.state)
  const readFailed = useOrgSignInStore(s => s.readFailed)
  const lastResult = useOrgSignInStore(s => s.lastResult)
  const start = useOrgSignInStore(s => s.start)
  const retry = useOrgSignInStore(s => s.retry)
  const [retrying, setRetrying] = useState(false)
  const signIn = useOrgSignInStore(s => s.signIn)
  const [open, setOpen] = useState(false)
  // Narrow screens: the panel is placed over the chat area so it never runs under the navigation rail.
  const [narrowBox, setNarrowBox] = useState<{ left: number; right: number; bottom: number } | null>(null)
  const anchor = useRef<HTMLDivElement | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const desktop = isElectron()
  const quota = useComposerQuota(invitation ? undefined : quotaSourceId)

  useEffect(() => { start() }, [start])
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current) }, [])
  useEffect(() => {
    if (!open) return
    const handleKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open])

  const view = orgIndicatorView(state, desktop, readFailed)
  if (view.tone === 'hidden') return null

  const name = state?.name || t('Organization')
  const show = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = null
    const el = anchor.current
    if (el && window.matchMedia('(max-width: 639px)').matches) {
      const button = el.getBoundingClientRect()
      const area = (el.closest('[data-chat-area]') ?? document.body).getBoundingClientRect()
      setNarrowBox({ left: area.left + 12, right: window.innerWidth - area.right + 12, bottom: window.innerHeight - button.top + 8 })
    } else {
      setNarrowBox(null)
    }
    if (!open) quota.opened()
    setOpen(true)
  }
  const hide = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => setOpen(false), 150)
  }
  const onClick = () => {
    if (view.clickSignsIn) { void signIn(); return }
    if (!open) show()
    else if (!window.matchMedia('(hover: hover)').matches) setOpen(false)
  }

  const { notice, nothingWorks } = view
  const label = notice === 'withdrawal' ? t('Earlier access may still work until it expires.')
    : !notice && view.tone === 'attention'
    ? (nothingWorks
        ? t('Not signed in to {{name}}', { name })
        : t('{{name}}: {{capability}} needs signing in again', { name, capability: view.expired.map(c => c.label).join(', ') }))
    : view.tone === 'pending' ? t('Checking {{name}} sign-in', { name })
      : quota.snapshot ? `${name}. ${quota.label}` : name

  const icon = state?.signingIn || view.tone === 'pending'
    ? <Loader2 className="w-4 h-4 animate-spin text-faint-foreground" />
    : view.tone === 'attention'
      ? <CircleAlert className="w-4 h-4 text-halo-warning" />
      : <QuotaRing ratio={quota.ratio} low={quota.low} filled={quota.hasBar} />

  const canAct = desktop && !state?.signingIn
  const resultNote = lastResult === 'failed'
    ? t('Sign-in did not complete. Please try again.')
    : lastResult === 'expired' ? t('The sign-in page timed out. Please try again.') : null

  const invite = desktop && state?.status === 'signed-out' && !notice
  if (invitation !== invite) return null
  const inviteLabel = t('Sign in to {{name}}', { name })
  if (invite) return (
    <div className="mx-auto mb-3 w-full max-w-chat px-3 text-center">
      <button type="button" data-testid="org-sign-in-status" data-tone={view.tone} disabled={state?.signingIn} onClick={() => void signIn()} className="inline-flex min-h-11 max-w-full items-center gap-2 rounded-lg bg-primary/10 px-4 py-2 text-sm font-medium text-primary hover:bg-primary/20 disabled:opacity-60">
        <Building2 aria-hidden="true" className="h-4 w-4 shrink-0" /><span className="break-words">{inviteLabel}</span>
      </button>
      {resultNote && <p role="alert" className="mt-1 text-xs text-halo-warning">{resultNote}</p>}
    </div>
  )
  return (
    <div ref={anchor} className="relative flex items-center" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-expanded={open}
        data-testid="org-sign-in-status"
        data-tone={view.tone}
        className="relative flex h-8 w-6 items-center justify-center rounded-sm transition-colors ease-halo hover:bg-secondary"
      >
        {icon}
        {quota.stale && view.tone !== 'attention' && <AlertTriangle aria-hidden="true" className="absolute right-0.5 top-0.5 w-2.5 h-2.5 text-amber-500" />}
      </button>

      {open && placePanel(narrowBox, (
        <div
          className={narrowBox ? 'fixed z-50' : 'absolute right-0 bottom-full pb-2 z-50'}
          style={narrowBox ? { left: narrowBox.left, right: narrowBox.right, bottom: narrowBox.bottom } : undefined}
        >
          <div className={`${narrowBox ? 'w-full' : 'w-80'} bg-card border border-border rounded-lg shadow-pop p-4 space-y-3`} data-testid="org-sign-in-popover">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
              <Building2 className="w-4 h-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{name}</span>
              {state?.account && <span className="ml-auto truncate text-xs font-normal text-muted-foreground">{state.account.displayName}</span>}
            </div>

            {notice && <OrgSignInNotice notice={notice} />}
            {!notice && nothingWorks && (
              <p className="text-sm text-muted-foreground">{t('Sign in to {{name}} to reach internal systems and more. You can keep chatting without it.', { name })}</p>
            )}
            {state?.status === 'active' && !nothingWorks && (!notice || notice === 'issue-failed') && <OrgCapabilityList capabilities={state.capabilities} compact />}

            {resultNote && <p className="text-xs text-halo-warning">{resultNote}</p>}

            {view.offerRetry && (
              <button type="button" disabled={retrying || state?.signingIn} onClick={() => {
                setRetrying(true)
                void retry().finally(() => setRetrying(false))
              }} className="w-full min-h-11 sm:min-h-9 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-60">
                {t('Retry')}
              </button>
            )}
            {!desktop && notice && notice !== 'incompatible' && notice !== 'pending' && !view.offerRetry && (
              <p className="text-xs text-muted-foreground">{t('Manage organization sign-in from the Halo desktop app.')}</p>
            )}
            {!notice && view.tone === 'attention' && (
              desktop ? (
                <button
                  type="button"
                  disabled={!canAct}
                  onClick={() => void signIn()}
                  className="w-full min-h-9 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-60"
                >
                  {state?.signingIn ? t('Waiting for sign-in…') : nothingWorks ? t('Sign in') : t('Sign in again')}
                </button>
              ) : (
                <p className="text-xs text-muted-foreground">{t('Sign in from the Halo desktop app.')}</p>
              )
            )}
            {quota.snapshot && (
              <div className="border-t border-border-faint pt-3" data-testid="org-sign-in-quota">
                <QuotaDetails snapshot={quota.snapshot} stale={quota.stale} />
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

/** On narrow screens the panel leaves the composer's stacking context, so edge handles never cover it. */
function placePanel(narrowBox: { left: number } | null, panel: ReactNode): ReactNode {
  return narrowBox ? createPortal(panel, document.body) : panel
}
