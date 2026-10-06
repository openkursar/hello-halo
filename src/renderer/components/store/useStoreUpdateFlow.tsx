/**
 * Drives the "receive update" flow shared by the store grid card and the
 * detail view: opens the confirmation dialog and runs the chosen path
 * (install a new copy, overwrite in place, or skip this version). Callers
 * render `dialogs` and trigger `start()` from their update control.
 */

import { useMemo, useState } from 'react'
import { useTranslation } from '../../i18n'
import { api } from '../../api'
import { useAppsStore } from '../../stores/apps.store'
import { useAppsPageStore } from '../../stores/apps-page.store'
import { useNotificationStore } from '../../stores/notification.store'
import { getEntryVersions } from '../../../shared/store/store-meta'
import { StoreUpdateDialog } from './StoreUpdateDialog'
import type { UpgradePreview } from './StoreUpdateDialog'
import { StoreInstallDialog } from './StoreInstallDialog'
import { specFieldList } from '../apps/spec-field-label'
import type { RegistryEntry, UpdateInfo, StoreAppDetail } from '../../../shared/store/store-types'

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
  const { t, i18n } = useTranslation()
  const [phase, setPhase] = useState<Phase>('idle')
  const [copyDetail, setCopyDetail] = useState<StoreAppDetail | null>(null)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<UpgradePreview | undefined>(undefined)
  // Only a digital human keeps the user's version of what differs from the author's.
  const keepsEdits = entry?.type === 'automation'

  const start = () => {
    setPhase('confirm')
    if (!keepsEdits || !updateInfo) {
      setPreview(undefined)
      return
    }
    const appId = updateInfo.appId
    setPreview({ status: 'loading' })
    api.storePreviewUpgrade(appId)
      .then(res => {
        if (!res.success || !res.data) throw new Error(res.error ?? 'Preview unavailable')
        setPreview({ status: 'ready', kept: res.data.kept, editsKnown: res.data.editsKnown })
      })
      .catch(err => {
        console.warn('[StoreUpdateFlow] Upgrade preview unavailable', { appId, error: err })
        setPreview({ status: 'unavailable' })
      })
  }

  const changelog = useMemo(() => {
    if (!entry || !updateInfo) return undefined
    return getEntryVersions(entry).find(v => v.version === updateInfo.latestVersion)?.changelog
  }, [entry, updateInfo])

  const overwrite = async () => {
    if (!updateInfo || busy) return
    void api.trackEvent('store.update.overwrite', { appId: entry?.slug, toVersion: updateInfo.latestVersion })
    setBusy(true)
    try {
      const res = await api.storeApplyUpgrade(updateInfo.appId, 'force')
      if (res.success) {
        refreshInstalled()
        const kept = (res.data as { kept?: string[] } | undefined)?.kept ?? []
        useNotificationStore.getState().show({
          title: t('Updated'),
          body: kept.length > 0
            ? t('Upgraded to v{{version}}. These differ from the author’s new version and kept your current version: {{items}}', {
              version: updateInfo.latestVersion,
              items: specFieldList(kept, t, i18n.language),
            })
            : t('Upgraded to v{{version}}', { version: updateInfo.latestVersion }),
          variant: 'success',
          duration: kept.length > 0 ? 6000 : 3000,
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
      void api.trackEvent('store.update.keep_current', { appId: entry?.slug, toVersion: updateInfo.latestVersion })
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
          preview={preview}
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

  return { start, busy, dialogs }
}
