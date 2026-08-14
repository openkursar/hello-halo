/**
 * My Publications — the store's second-level view listing the signed-in
 * creator's own published apps with their status, and actions to publish a new
 * version / resubmit / take an app down.
 */

import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, Loader2, AlertCircle } from 'lucide-react'
import { api } from '../../api'
import { STORE_NOT_SIGNED_IN, type MyPublication, type StoreSignInStatus } from '../../../shared/store/store-types'
import type { AppType } from '../../../shared/apps/spec-types'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { getCurrentLanguage, useTranslation } from '../../i18n'
import { ShareToStoreDialog, type RepublishTarget } from './ShareToStoreDialog'
import { StoreUpdatable } from './StoreUpdatable'
import { StoreNotice } from './StoreNotice'
import { AppTypeIcon } from './AppTypeIcon'
import { AppTypeTag } from './AppTypeTag'
import { useConfirmDialog } from '../../hooks/useConfirmDialog'
import { useNotificationStore } from '../../stores/notification.store'

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <h2 className="text-[13px] font-semibold tracking-[0.5px] text-foreground">{children}</h2>
    </div>
  )
}

type Translate = (key: string) => string

function statusLabel(t: Translate, status: MyPublication['status'], takedownBy?: MyPublication['takedownBy']): string {
  switch (status) {
    case 'hidden': return takedownBy === 'admin' ? t('Removed by ops') : t('Taken down')
    case 'rejected': return t('Rejected')
    default: return t('Listed')
  }
}

function statusClass(status: MyPublication['status']): string {
  switch (status) {
    case 'hidden': return 'bg-secondary text-muted-foreground'
    case 'rejected': return 'bg-red-500/10 text-red-400'
    default: return 'bg-halo-success/10 text-halo-success'
  }
}

export function StoreMine() {
  const { t } = useTranslation()
  const setStoreMineOpen = useAppsPageStore(s => s.setStoreMineOpen)
  const selectStoreApp = useAppsPageStore(s => s.selectStoreApp)
  const [items, setItems] = useState<MyPublication[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busySlug, setBusySlug] = useState<string | null>(null)
  const [showPublish, setShowPublish] = useState(false)
  // Republishing a known publication skips the type step — its type is fixed.
  const [publishType, setPublishType] = useState<'automation' | 'skill' | undefined>(undefined)
  // The listing the publish dialog was opened for: it points the dialog at the
  // local app that would update it, and supplies the version to increment from
  // when the update arrives as a re-imported package instead.
  const [publishTarget, setPublishTarget] = useState<RepublishTarget | undefined>(undefined)
  const [signingIn, setSigningIn] = useState(false)
  // Distinguishes "signed out but can sign in" from the misconfiguration where
  // the store requires an account yet this build ships no identity provider —
  // the latter must explain the situation, not offer a dead sign-in button.
  const [signInStatus, setSignInStatus] = useState<StoreSignInStatus | null>(null)
  const { showConfirm, DialogComponent: confirmDialog } = useConfirmDialog()
  const showToast = useNotificationStore(s => s.show)

  const load = useCallback(async () => {
    setLoading(true)
    const res = await api.storeGetMyPublications()
    if (res.success) {
      setItems((res.data as MyPublication[]) ?? [])
      setError(null)
    } else {
      setError(res.error || 'error')
      setItems(null)
    }
    setLoading(false)
  }, [])

  // Launch the identity provider's sign-in (system-browser OAuth) from the
  // not-signed-in notice, then reload once a token is available.
  const handleSignIn = useCallback(async (force = false) => {
    if (signingIn) return
    setSigningIn(true)
    try {
      const res = await api.storeEnsureSignedIn(force)
      if (res.success && res.data) await load()
    } finally {
      setSigningIn(false)
    }
  }, [signingIn, load])

  useEffect(() => {
    void load()
  }, [load])

  // Resolve why sign-in is blocked only when the not-signed-in notice is shown,
  // so the signed-in path pays no extra probe.
  useEffect(() => {
    if (error !== STORE_NOT_SIGNED_IN) return
    let cancelled = false
    void api.storeGetSignInStatus().then(res => {
      if (!cancelled && res.success) setSignInStatus(res.data ?? null)
    })
    return () => { cancelled = true }
  }, [error])

  useEffect(() => {
    void api.trackEvent('store.mine.view', {})
  }, [])

  const handleUnpublish = useCallback(async (slug: string) => {
    const ok = await showConfirm({
      title: t('Take this app down?'),
      message: t('It will be removed from the store and users can no longer find or install it. You can relist it later by publishing a new version.'),
      confirmLabel: t('Take down'),
      cancelLabel: t('Cancel'),
      variant: 'danger',
    })
    if (!ok) return
    setBusySlug(slug)
    void api.trackEvent('store.unpublish', { appId: slug })
    const res = await api.storeUnpublish({ slug })
    setBusySlug(null)
    if (res.success) void load()
    else showToast({ title: res.error || t('Take down failed. Please try again.'), variant: 'error', duration: 4000 })
  }, [load, showConfirm, showToast, t])

  // Tagged `mine` so the browse funnel can exclude it: an author reopening their
  // own publication is not catalog traffic, but it does open a detail, so it has
  // to be emitted for the click and view sides to cover the same openings.
  //
  // A publication carries no type once it leaves the public index — which is
  // exactly the taken-down state this page exists to show. The dimension is left
  // off there rather than filled with a value that is not an app type.
  const openDetail = useCallback((pub: MyPublication) => {
    void api.trackEvent('store.card.click', {
      appId: pub.slug,
      ...(pub.type ? { appType: pub.type } : {}),
      source: 'mine',
    })
    void selectStoreApp(pub.slug)
  }, [selectStoreApp])

  const openPublish = useCallback((pub: MyPublication) => {
    setPublishType(pub.type === 'skill' || pub.type === 'automation' ? pub.type : undefined)
    setPublishTarget({
      slug: pub.slug,
      version: pub.version,
      name: pub.displayName ?? pub.name ?? '',
      // The index's canonical name is the command identifier for a skill; for
      // any other type it is the presentable name `name` already carries.
      commandName: pub.type === 'skill' ? pub.name : undefined,
    })
    setShowPublish(true)
  }, [])

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background">
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[880px] mx-auto w-full px-4 sm:px-6 pt-5 pb-8">
          {/* Back link above the content, matching the detail page (no header bar,
              no bottom border, no publish button). */}
          <button
            onClick={() => setStoreMineOpen(false)}
            className="flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-primary transition-colors mb-5"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            {t('Back to Store')}
          </button>
          {loading ? (
            <div className="flex justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : error === STORE_NOT_SIGNED_IN && signInStatus === 'unavailable' ? (
            <StoreNotice
              icon={<AlertCircle className="w-6 h-6 text-amber-500" />}
              title={t('Sign-in is unavailable in this build')}
              desc={t('This store requires an account to view your publications, but this build has no identity provider configured. Contact your administrator to enable sign-in.')}
            />
          ) : error === STORE_NOT_SIGNED_IN && signInStatus === 'signed-in' ? (
            <StoreNotice
              icon={<AlertCircle className="w-6 h-6 text-amber-500" />}
              title={t('Could not verify your account')}
              desc={t('You are signed in, but the store could not verify your session. Sign in again, or ask your administrator to check the store server.')}
              action={
                <button
                  onClick={() => handleSignIn(true)}
                  disabled={signingIn}
                  className="flex items-center gap-1.5 px-4 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-60"
                >
                  {signingIn && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {t('Sign in again')}
                </button>
              }
            />
          ) : error === STORE_NOT_SIGNED_IN ? (
            <StoreNotice
              icon={<AlertCircle className="w-6 h-6 text-amber-500" />}
              title={t('Sign in to view your publications')}
              desc={t('Your publications are tied to your account. Sign in to see and manage them.')}
              action={
                <button
                  onClick={() => handleSignIn(false)}
                  disabled={signingIn}
                  className="flex items-center gap-1.5 px-4 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-60"
                >
                  {signingIn && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  {t('Sign in')}
                </button>
              }
            />
          ) : error ? (
            <StoreNotice
              icon={<AlertCircle className="w-6 h-6 text-red-400" />}
              title={t('Failed to load your publications')}
              desc={error}
              action={
                <button
                  onClick={load}
                  className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
                >
                  {t('Retry')}
                </button>
              }
            />
          ) : (
            <section>
              <SectionLabel>{t('My Publications')}</SectionLabel>
              <div className="overflow-x-auto rounded-[10px] border border-border/60 bg-background">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground border-b border-border/60">
                      <th className="font-medium py-2.5 px-3">{t('App')}</th>
                      <th className="font-medium py-2.5 px-3">{t('Type')}</th>
                      <th className="font-medium py-2.5 px-3">{t('Version')}</th>
                      <th className="font-medium py-2.5 px-3">{t('Status')}</th>
                      <th className="font-medium py-2.5 px-3">{t('Installs')}</th>
                      <th className="font-medium py-2.5 px-3 text-right">{t('Actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!items || items.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-12 text-center text-[13px] text-muted-foreground">
                          {t('No data')}
                        </td>
                      </tr>
                    ) : (
                      items.map(pub => (
                        <MineRow
                          key={`${pub.slug}@${pub.version}`}
                          pub={pub}
                          busy={busySlug === pub.slug}
                          onOpen={() => openDetail(pub)}
                          onUnpublish={() => handleUnpublish(pub.slug)}
                          onPublishVersion={() => openPublish(pub)}
                        />
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <StoreUpdatable />
        </div>
      </div>

      {showPublish && (
        <ShareToStoreDialog initialType={publishType} entry="mine" republishTarget={publishTarget} onClose={() => { setShowPublish(false); void load() }} />
      )}
      {confirmDialog}
    </div>
  )
}

interface MineRowProps {
  pub: MyPublication
  busy: boolean
  onOpen: () => void
  onUnpublish: () => void
  onPublishVersion: () => void
}

function MineRow({ pub, busy, onOpen, onUnpublish, onPublishVersion }: MineRowProps) {
  const { t } = useTranslation()
  const isHidden = pub.status === 'hidden'
  // Only the creator's own takedown can be undone by the creator; an admin
  // takedown is a moderation decision and offers no creator action. Legacy
  // hidden records carry no source and count as admin.
  const isSelfTakedown = isHidden && pub.takedownBy === 'self'
  const primaryLabel = pub.status === 'rejected' ? t('Resubmit') : t('Publish new version')
  // A skill's index name is its command identifier, so prefer the authored one.
  const pubLabel = pub.displayName || pub.name || pub.slug
  const appType = pub.type as AppType | undefined
  const installs = pub.installs && pub.installs > 0
    ? new Intl.NumberFormat(getCurrentLanguage(), { notation: 'compact', maximumFractionDigits: 1 }).format(pub.installs)
    : '—'

  return (
    <tr className="border-b border-border/60 last:border-0 align-middle">
      <td className="py-2.5 px-3">
        <div className="flex items-center gap-2 min-w-0">
          {appType && <AppTypeIcon type={appType} name={pubLabel} size="sm" />}
          <button
            onClick={onOpen}
            className="min-w-0 truncate font-medium text-foreground text-left hover:text-primary transition-colors"
          >
            {pubLabel}
          </button>
        </div>
      </td>
      <td className="py-2.5 px-3">{appType ? <AppTypeTag type={appType} /> : <span className="text-xs text-muted-foreground">—</span>}</td>
      <td className="py-2.5 px-3 font-mono text-xs text-muted-foreground whitespace-nowrap">v{pub.version}</td>
      <td className="py-2.5 px-3">
        <span className={`inline-block px-1.5 py-px rounded text-[10.5px] leading-4 ${statusClass(pub.status)}`}>
          {statusLabel(t, pub.status, pub.takedownBy)}
        </span>
        {pub.status === 'rejected' && pub.rejectReason && (
          <div className="text-xs text-red-400 mt-1">{pub.rejectReason}</div>
        )}
      </td>
      <td className="py-2.5 px-3 font-mono text-xs text-muted-foreground whitespace-nowrap">{installs}</td>
      <td className="py-2.5 px-3">
        <div className="flex items-center justify-end gap-3 whitespace-nowrap">
          {isHidden ? (
            // Coming back is a republish, not a visibility toggle: a hidden app
            // leaves the public index, which frees its skill name for another
            // author, and only the publish path re-runs that uniqueness check.
            isSelfTakedown && (
              <button onClick={onPublishVersion} className="text-xs font-medium text-halo-success hover:text-halo-success/80 transition-colors">
                {t('Relist')}
              </button>
            )
          ) : (
            <>
              <button onClick={onPublishVersion} className="text-xs font-medium text-primary hover:text-primary/80 transition-colors">
                {primaryLabel}
              </button>
              <button
                onClick={onUnpublish}
                disabled={busy}
                className="flex items-center gap-1 text-xs font-medium text-red-400 hover:text-red-500 transition-colors disabled:opacity-60"
              >
                {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                {t('Take down')}
              </button>
            </>
          )}
        </div>
      </td>
    </tr>
  )
}
