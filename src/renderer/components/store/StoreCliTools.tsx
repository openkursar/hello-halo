/**
 * Command-line tools — the store's second-level view listing the CLI tools an
 * administrator has approved for this account, with what is installed here.
 *
 * Nothing is downloaded until the user installs a version from this page; the
 * main process verifies the package against the catalog before it becomes
 * available to new tasks. A revoked tool offers no action.
 */

import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, Loader2, AlertCircle, SquareTerminal } from 'lucide-react'
import { api } from '../../api'
import {
  STORE_NOT_SIGNED_IN,
  type CliCatalogTool,
  type CliCatalogVersion,
  type StoreSignInStatus,
} from '../../../shared/store/store-types'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { getCurrentLanguage, useTranslation } from '../../i18n'
import { StoreNotice } from './StoreNotice'
import { useNotificationStore } from '../../stores/notification.store'

type Translate = (key: string, options?: Record<string, unknown>) => string

/** The version an install would bring: the catalog's latest when it runs here, else the newest that does. */
function installTarget(tool: CliCatalogTool): CliCatalogVersion | null {
  const latest = tool.versions.find(v => v.version === tool.latest)
  if (latest?.supported) return latest
  return tool.versions.find(v => v.supported) ?? null
}

function formatSize(bytes: number): string {
  const units = ['byte', 'kilobyte', 'megabyte'] as const
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return new Intl.NumberFormat(getCurrentLanguage(), {
    style: 'unit',
    unit: units[unit],
    unitDisplay: 'short',
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value)
}

function sideEffectsLabel(t: Translate, value: CliCatalogVersion['sideEffects']): string | null {
  if (value === 'read-only') return t('Read-only')
  if (value === 'writes') return t('Can change data')
  return null
}

function authLabel(t: Translate, value: CliCatalogVersion['auth']): string | null {
  if (value === 'none') return t('No sign-in needed')
  if (value === 'env-ref') return t('Uses a configured credential')
  if (value === 'external-login') return t('Signs in on its own')
  return null
}

export function StoreCliTools() {
  const { t } = useTranslation()
  const setStoreCliOpen = useAppsPageStore(s => s.setStoreCliOpen)
  const [tools, setTools] = useState<CliCatalogTool[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [signingIn, setSigningIn] = useState(false)
  const [signInStatus, setSignInStatus] = useState<StoreSignInStatus | null>(null)
  const showToast = useNotificationStore(s => s.show)

  const load = useCallback(async () => {
    setLoading(true)
    const res = await api.storeGetCliCatalog()
    if (res.success) {
      setTools(res.data?.tools ?? [])
      setError(null)
    } else {
      setError(res.error || 'error')
      setTools(null)
    }
    setLoading(false)
  }, [])

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

  useEffect(() => {
    if (error !== STORE_NOT_SIGNED_IN) return
    let cancelled = false
    void api.storeGetSignInStatus().then(res => {
      if (!cancelled && res.success) setSignInStatus(res.data ?? null)
    })
    return () => { cancelled = true }
  }, [error])

  const handleInstall = useCallback(async (tool: CliCatalogTool, version: string) => {
    setBusyId(tool.id)
    const res = await api.storeInstallCliTool({ id: tool.id, version })
    setBusyId(null)
    if (res.success && res.data) {
      const updated = res.data
      setTools(prev => prev?.map(item => (item.id === updated.id ? updated : item)) ?? prev)
      showToast({
        title: t('{{name}} {{version}} installed. New tasks can use it.', { name: tool.displayName, version }),
        variant: 'success',
        duration: 4000,
      })
    } else {
      showToast({ title: res.error || t('Install failed. Please try again.'), variant: 'error', duration: 5000 })
      void load()
    }
  }, [load, showToast, t])

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background">
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[880px] mx-auto w-full px-4 sm:px-6 pt-5 pb-8">
          <button
            onClick={() => setStoreCliOpen(false)}
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
              icon={<AlertCircle className="w-6 h-6 text-halo-warning" />}
              title={t('Sign-in is unavailable in this build')}
              desc={t('This store offers command-line tools to signed-in accounts, but this build has no identity provider configured. Contact your administrator to enable sign-in.')}
            />
          ) : error === STORE_NOT_SIGNED_IN && signInStatus === 'signed-in' ? (
            <StoreNotice
              icon={<AlertCircle className="w-6 h-6 text-halo-warning" />}
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
              icon={<AlertCircle className="w-6 h-6 text-halo-warning" />}
              title={t('Sign in to see command-line tools')}
              desc={t('Your administrator chooses which command-line tools your account can install. Sign in to see them.')}
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
              icon={<AlertCircle className="w-6 h-6 text-destructive" />}
              title={t('Failed to load command-line tools')}
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
              <div className="mb-3">
                <h2 className="text-[13px] font-semibold tracking-[0.5px] text-foreground">{t('Command-line tools')}</h2>
                <p className="text-xs text-muted-foreground mt-1">
                  {t('Approved by your administrator. Install the ones you need; tasks started afterwards can use them.')}
                </p>
              </div>
              {!tools || tools.length === 0 ? (
                <div className="rounded-[10px] border border-border-soft bg-card py-12 text-center text-[13px] text-muted-foreground">
                  {t('No command-line tools are available yet')}
                </div>
              ) : (
                <ul className="flex flex-col gap-2">
                  {tools.map(tool => (
                    <CliToolRow
                      key={tool.id}
                      tool={tool}
                      busy={busyId === tool.id}
                      disabled={busyId !== null}
                      onInstall={version => handleInstall(tool, version)}
                    />
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  )
}

interface CliToolRowProps {
  tool: CliCatalogTool
  busy: boolean
  disabled: boolean
  onInstall: (version: string) => void
}

function CliToolRow({ tool, busy, disabled, onInstall }: CliToolRowProps) {
  const { t } = useTranslation()
  const target = installTarget(tool)
  const current = tool.installed?.current ?? null
  const shown = target ?? tool.versions[0]
  const facts = [
    sideEffectsLabel(t, shown.sideEffects),
    authLabel(t, shown.auth),
    shown.size > 0 ? formatSize(shown.size) : null,
  ].filter((fact): fact is string => fact !== null)

  // An up-to-date tool needs no action; its badge already says it is installed.
  const action: React.ReactNode = !tool.revoked && target && current !== target.version ? (
    <button
      onClick={() => onInstall(target.version)}
      disabled={disabled}
      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-60"
    >
      {busy && <Loader2 className="w-3 h-3 animate-spin" />}
      {current ? t('Update to {{version}}', { version: target.version }) : t('Install')}
    </button>
  ) : null

  return (
    <li className="rounded-[10px] border border-border-soft bg-card px-3 sm:px-4 py-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="flex min-w-0 gap-3">
          <div className="w-8 h-8 flex-shrink-0 rounded-lg bg-secondary flex items-center justify-center">
            <SquareTerminal className="w-4 h-4 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-medium text-sm text-foreground break-all">{tool.displayName}</span>
              <span className="font-mono text-[11px] text-muted-foreground">v{shown.version}</span>
              {tool.revoked && (
                <span className="inline-block px-1.5 py-px rounded text-[10.5px] leading-4 bg-destructive/10 text-destructive">
                  {t('Revoked')}
                </span>
              )}
              {!tool.revoked && current && (
                <span className="inline-block px-1.5 py-px rounded text-[10.5px] leading-4 bg-halo-success/10 text-halo-success">
                  {t('Installed {{version}}', { version: current })}
                </span>
              )}
            </div>
            <div className="font-mono text-[11px] text-muted-foreground mt-0.5 break-all">{tool.id}</div>
            {shown.commands.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {shown.commands.map(command => (
                  <code key={command} className="px-1.5 py-px rounded bg-secondary text-[11px] text-foreground">
                    {command}
                  </code>
                ))}
              </div>
            )}
            {facts.length > 0 && (
              <div className="text-xs text-muted-foreground mt-1.5">{facts.join(' · ')}</div>
            )}
            {tool.revoked ? (
              <div className="text-xs text-destructive mt-1.5">
                {t('Revoked by your administrator. New tasks can no longer use it.')}
              </div>
            ) : !target ? (
              <div className="text-xs text-halo-warning mt-1.5">{t('Not available for this device')}</div>
            ) : null}
          </div>
        </div>
        {action && <div className="flex flex-shrink-0 justify-end sm:pt-0.5">{action}</div>}
      </div>
    </li>
  )
}
