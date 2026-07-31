/**
 * Drives the "receive update" flow shared by the store grid card and the
 * detail view: opens the confirmation dialog and runs the chosen path
 * (install a new copy, overwrite in place, or skip this version). Callers
 * render `dialogs` and trigger `start()` from their update control.
 */

import { useMemo, useState } from 'react'
import { useTranslation } from '../i18n'
import { api } from '../api'
import { useAppsStore } from '../stores/apps.store'
import { useAppsPageStore } from '../stores/apps-page.store'
import { useNotificationStore } from '../stores/notification.store'
import { getEntryVersions } from '../../shared/store/store-meta'
import { StoreUpdateDialog } from '../components/store/StoreUpdateDialog'
import { StoreInstallDialog } from '../components/store/StoreInstallDialog'
import type { RegistryEntry, UpdateInfo, StoreAppDetail } from '../../shared/store/store-types'

type Phase = 'idle' | 'confirm' | 'copy'

interface StoreUpdateFlow {
  start: () => void
  busy: boolean
  dialogs: React.ReactNode
}

function refreshInstalled(): void {
  useAppsStore.getState().loadApps()
  void useAppsPageStore.getState().checkUpdates()
}

export function useStoreUpdateFlow(
  entry: RegistryEntry | null | undefined,
  updateInfo: UpdateInfo | null | undefined,
  providedDetail?: StoreAppDetail | null,
): StoreUpdateFlow {
  const { t } = useTranslation()
  const [phase, setPhase] = useState<Phase>('idle')
  const [copyDetail, setCopyDetail] = useState<StoreAppDetail | null>(null)
  const [busy, setBusy] = useState(false)

  const changelog = useMemo(() => {
    if (!entry || !updateInfo) return undefined
    return getEntryVersions(entry).find(v => v.version === updateInfo.latestVersion)?.changelog
  }, [entry, updateInfo])

  const overwrite = async () => {
    if (!updateInfo || busy) return
    void api.trackEvent('mkt_update_overwrite', { appId: entry?.slug, toVersion: updateInfo.latestVersion })
    setBusy(true)
    try {
      const res = await api.storeApplyUpgrade(updateInfo.appId, 'force')
      if (res.success) {
        refreshInstalled()
        useNotificationStore.getState().show({
          title: t('Updated'),
          body: t('Upgraded to v{{version}}', { version: updateInfo.latestVersion }),
          variant: 'success',
          duration: 3000,
        })
      } else {
        useNotificationStore.getState().show({
          title: t('Update failed'),
          body: res.error ?? t('Please try again.'),
          variant: 'error',
          duration: 4000,
        })
      }
    } catch (err) {
      useNotificationStore.getState().show({
        title: t('Update failed'),
        body: err instanceof Error ? err.message : t('Please try again.'),
        variant: 'error',
        duration: 4000,
      })
    } finally {
      setBusy(false)
      setPhase('idle')
    }
  }

  const installCopy = async () => {
    if (busy) return
    if (updateInfo) {
      void api.trackEvent('mkt_update_keep_current', { appId: entry?.slug, toVersion: updateInfo.latestVersion })
    }
    let detail = providedDetail ?? null
    if (!detail && entry) {
      setBusy(true)
      try {
        const res = await api.storeGetAppDetail(entry.slug)
        detail = res.success && res.data ? (res.data as StoreAppDetail) : null
      } finally {
        setBusy(false)
      }
    }
    if (!detail) {
      useNotificationStore.getState().show({
        title: t('Update failed'),
        body: t('Please try again.'),
        variant: 'error',
        duration: 4000,
      })
      return
    }
    setCopyDetail(detail)
    setPhase('copy')
  }

  const ignore = async () => {
    if (!updateInfo || busy) return
    setBusy(true)
    try {
      const res = await api.storeIgnoreVersion({ appId: updateInfo.appId, version: updateInfo.latestVersion })
      if (res.success) {
        void useAppsPageStore.getState().checkUpdates()
      } else {
        useNotificationStore.getState().show({
          title: t('Update failed'),
          body: res.error ?? t('Please try again.'),
          variant: 'error',
          duration: 4000,
        })
      }
    } catch (err) {
      useNotificationStore.getState().show({
        title: t('Update failed'),
        body: err instanceof Error ? err.message : t('Please try again.'),
        variant: 'error',
        duration: 4000,
      })
    } finally {
      setBusy(false)
      setPhase('idle')
    }
  }

  const dialogs = (
    <>
      {phase === 'confirm' && updateInfo && (
        <StoreUpdateDialog
          fromVersion={updateInfo.currentVersion}
          toVersion={updateInfo.latestVersion}
          changelog={changelog}
          busy={busy}
          onInstallCopy={installCopy}
          onOverwrite={overwrite}
          onIgnore={ignore}
          onClose={() => setPhase('idle')}
        />
      )}
      {phase === 'copy' && copyDetail && (
        <StoreInstallDialog
          detail={copyDetail}
          onClose={() => {
            setCopyDetail(null)
            setPhase('idle')
          }}
          onInstalled={() => {
            setCopyDetail(null)
            setPhase('idle')
            refreshInstalled()
          }}
          showGlobalOption={entry?.type === 'skill'}
        />
      )}
    </>
  )

  return { start: () => setPhase('confirm'), busy, dialogs }
}
