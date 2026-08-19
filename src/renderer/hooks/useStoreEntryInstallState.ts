/**
 * Resolve whether a store entry is already installed and whether an update is
 * available for it. Shared by the store grid card and the detail view so both
 * derive install state the same way. The matching logic lives in
 * `utils/store-install-state` so it stays unit-testable.
 */

import { useMemo } from 'react'
import { useAppsStore } from '../stores/apps.store'
import { useAppsPageStore } from '../stores/apps-page.store'
import { findInstalledApp, findEntryUpdate } from '../utils/store-install-state'
import type { RegistryEntry, UpdateInfo } from '../../shared/store/store-types'
import type { InstalledApp } from '../../shared/apps/app-types'

export interface StoreEntryInstallState {
  /** The installed app matching this entry, or null when not installed. */
  installedApp: InstalledApp | null
  /** Update info when a newer version is available for the installed app. */
  updateInfo: UpdateInfo | null
}

export function useStoreEntryInstallState(
  entry: RegistryEntry | null | undefined,
  registryId: string | null | undefined,
): StoreEntryInstallState {
  const apps = useAppsStore(state => state.apps)
  const availableUpdates = useAppsPageStore(state => state.availableUpdates)

  const installedApp = useMemo(
    () => findInstalledApp(entry, registryId, apps),
    [apps, entry, registryId],
  )
  const updateInfo = useMemo(
    () => findEntryUpdate(installedApp, availableUpdates),
    [availableUpdates, installedApp],
  )

  return { installedApp, updateInfo }
}
