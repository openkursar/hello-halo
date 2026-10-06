/**
 * ConfigUnreadableBanner — the configuration file exists but cannot be read.
 *
 * Halo then runs on built-in defaults and refuses to save, so the file — and
 * everything in it — stays as it was until someone repairs it. Without this
 * the app simply looks freshly installed, and settings re-entered there seem
 * to save while nothing reaches the disk. The banner says what happened and
 * where the file is; a save made meanwhile brings it back with a "not saved"
 * notice.
 *
 * Once the file reads again the banner clears and the app's settings are
 * reloaded: until then they are the defaults Halo fell back to, and a save
 * built on them would replace what the file holds.
 */

import { useEffect, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { api } from '../../api'
import type { ApiResponse } from '../../api/_shared'
import { CONFIG_NOT_SAVED_EVENT } from '../../api/config.api'
import { CONFIG_RELOAD_REQUIRED_CODE } from '../../../shared/rpc/contracts/config.contract'
import { useAppStore } from '../../stores/app.store'
import { useNotificationStore, type ToastVariant } from '../../stores/notification.store'
import i18n, { useTranslation } from '../../i18n'
import { usePlatform } from '../layout/Header'
import { isElectron, isCapacitor } from '../../api/transport'

interface ConfigUnreadableBannerProps {
  /** Vertical offset in px, to stack below another fixed top banner. */
  topOffset?: number
}

interface ConfigUnreadableNoticeProps {
  path: string
  topOffset: number
  onCheckAgain: () => void
  onHide: () => void
}

export function ConfigUnreadableNotice({ path, topOffset, onCheckAgain, onHide }: ConfigUnreadableNoticeProps) {
  const { t } = useTranslation()
  const platform = usePlatform()

  // Same reservation for the native window controls as CredentialAlertBanner,
  // so the buttons never sit under them.
  const overlayPadding =
    isElectron() && !isCapacitor()
      ? platform.isMac
        ? 'pl-20 pr-4'
        : 'pl-4 pr-36'
      : 'px-4'

  return (
    <div
      className={`fixed inset-x-0 z-40 flex items-center justify-between gap-3 py-2 bg-halo-warning/95 border-b border-halo-warning safe-area-top drag-region ${overlayPadding}`}
      style={{
        top: topOffset,
        paddingTop: 'max(8px, var(--sat))',
        ...(isElectron() && platform.isLinux && !isCapacitor() ? {
          paddingLeft: 'max(1rem, env(titlebar-area-x, 0px))',
          paddingRight: 'max(1rem, calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, calc(100vw - 9rem / var(--display-scale, 1)))))',
        } : {}),
      }}
      role="alert"
    >
      <div className="flex items-center gap-2 min-w-0 text-sm text-foreground">
        <AlertTriangle className="w-4 h-4 flex-shrink-0" />
        {/* Wraps rather than truncates: on a narrow screen the path is the part worth keeping. */}
        <span className="min-w-0 break-words">
          {t('The configuration file cannot be read. Halo has paused saving settings to protect your data.')}
          {' '}
          <span className="no-drag select-text break-all font-mono text-xs">{path}</span>
        </span>
      </div>
      {/* Interactive controls must opt out of the drag region to stay clickable. */}
      <div className="no-drag flex items-center gap-2 flex-shrink-0">
        <button
          onClick={onCheckAgain}
          className="text-sm font-medium text-foreground hover:underline"
        >
          {t('Check again')}
        </button>
        <button
          onClick={onHide}
          className="p-1 rounded hover:bg-foreground/10 transition-colors"
          title={t('Hide for now')}
          aria-label={t('Hide for now')}
        >
          <X className="w-4 h-4 text-foreground" />
        </button>
      </div>
    </div>
  )
}

interface ReadFailureWatchDeps {
  fetchFailure: () => Promise<ApiResponse<{ path: string } | null>>
  /** The unreadable file's path to show, or null. */
  showPath: (path: string | null) => void
  /** Replace the app's settings with what the file holds now. */
  reloadSettings: () => void
  /** The file reads again after a check found it could not. */
  onRecovered: () => void
}

/**
 * Whether config.json can be read, as the banner shows it, and the moment it
 * can be again — which is when the settings the app fell back to must be
 * replaced with the file's.
 */
export function createReadFailureWatch(deps: ReadFailureWatchDeps) {
  let shown: string | null = null
  return {
    async check(): Promise<void> {
      const res = await deps.fetchFailure()
      if (!res?.success) return
      const next = res.data?.path ?? null
      const recovered = shown !== null && next === null
      shown = next
      deps.showPath(next)
      if (recovered) {
        deps.reloadSettings()
        deps.onRecovered()
      }
    },
    /** Main refused a save built on settings older than its last failed read; the file itself reads fine. */
    reloadRequired(): void {
      shown = null
      deps.showPath(null)
      deps.reloadSettings()
    },
  }
}

function showToast(id: string, variant: ToastVariant, title: string, body: string): void {
  useNotificationStore.getState().show({ id, variant, title, body, duration: 8000 })
}

export function ConfigUnreadableBanner({ topOffset = 0 }: ConfigUnreadableBannerProps) {
  const [path, setPath] = useState<string | null>(null)
  const [hidden, setHidden] = useState(false)
  const [watch] = useState(() => createReadFailureWatch({
    fetchFailure: () => api.getConfigReadFailure(),
    showPath: setPath,
    reloadSettings: () => { void useAppStore.getState().refreshConfig() },
    onRecovered: () => showToast(
      'config-readable-again',
      'success',
      i18n.t('Settings reloaded'),
      i18n.t('The configuration file can be read again, so Halo reloaded your settings from it.'),
    ),
  }))

  useEffect(() => {
    void watch.check()
    const onNotSaved = (event: Event) => {
      if ((event as CustomEvent<{ code?: string }>).detail?.code === CONFIG_RELOAD_REQUIRED_CODE) {
        watch.reloadRequired()
        showToast(
          'config-not-saved',
          'warning',
          i18n.t('Not saved'),
          i18n.t('Halo reloaded your settings from the configuration file. Please make the change again.'),
        )
        return
      }
      setHidden(false)
      void watch.check()
      showToast(
        'config-not-saved',
        'warning',
        i18n.t('Not saved'),
        i18n.t('Halo cannot read its configuration file, so this change was not saved.'),
      )
    }
    window.addEventListener(CONFIG_NOT_SAVED_EVENT, onNotSaved)
    return () => window.removeEventListener(CONFIG_NOT_SAVED_EVENT, onNotSaved)
  }, [watch])

  // A repaired file should clear the banner when the user comes back from the
  // editor; while the file reads fine there is nothing to re-check.
  useEffect(() => {
    if (!path) return
    const onFocus = () => { void watch.check() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [path, watch])

  if (!path || hidden) return null

  return (
    <ConfigUnreadableNotice
      path={path}
      topOffset={topOffset}
      onCheckAgain={() => { void watch.check() }}
      onHide={() => setHidden(true)}
    />
  )
}
