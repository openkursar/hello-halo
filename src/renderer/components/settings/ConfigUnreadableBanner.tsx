/**
 * ConfigUnreadableBanner — the configuration file exists but cannot be read.
 *
 * Halo then runs on built-in defaults and refuses to save, so the file — and
 * everything in it — stays as it was until someone repairs it. Without this
 * the app simply looks freshly installed, and settings re-entered there seem
 * to save while nothing reaches the disk. The banner says what happened and
 * where the file is; a save made meanwhile brings it back with a "not saved"
 * notice. It clears once the file reads again.
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { api } from '../../api'
import { CONFIG_NOT_SAVED_EVENT } from '../../api/config.api'
import { useNotificationStore } from '../../stores/notification.store'
import { useTranslation } from '../../i18n'
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
        >
          <X className="w-4 h-4 text-foreground" />
        </button>
      </div>
    </div>
  )
}

export function ConfigUnreadableBanner({ topOffset = 0 }: ConfigUnreadableBannerProps) {
  const { t } = useTranslation()
  const [path, setPath] = useState<string | null>(null)
  const [hidden, setHidden] = useState(false)

  const check = useCallback(() => {
    void api.getConfigReadFailure().then((res) => {
      if (res?.success) setPath(res.data?.path ?? null)
    })
  }, [])

  useEffect(() => {
    check()
    const onNotSaved = () => {
      setHidden(false)
      check()
      useNotificationStore.getState().show({
        id: 'config-not-saved',
        variant: 'warning',
        title: t('Not saved'),
        body: t('Halo cannot read its configuration file, so this change was not saved.'),
        duration: 8000,
      })
    }
    window.addEventListener(CONFIG_NOT_SAVED_EVENT, onNotSaved)
    return () => window.removeEventListener(CONFIG_NOT_SAVED_EVENT, onNotSaved)
  }, [check, t])

  // A repaired file should clear the banner when the user comes back from the
  // editor; while the file reads fine there is nothing to re-check.
  useEffect(() => {
    if (!path) return
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [path, check])

  if (!path || hidden) return null

  return (
    <ConfigUnreadableNotice
      path={path}
      topOffset={topOffset}
      onCheckAgain={check}
      onHide={() => setHidden(true)}
    />
  )
}
