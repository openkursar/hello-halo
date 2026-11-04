/**
 * Resolve whether a store entry is already installed and whether an update is
 * available for it. Shared by the store grid card and the detail view so both
 * derive install state the same way. The matching logic lives in
 * `utils/store-install-state` so it stays unit-testable.
 */

import { useMemo } from 'react'
import { useAppsStore } from '../stores/apps.store'
import { useAppsPageStore } from '../stores/apps-page.store'
import { useSpaceStore } from '../stores/space.store'
import { findInstalledApps, findInstallableSpaceIds, findInstallsUpdate } from '../utils/store-install-state'
import type { RegistryEntry, UpdateInfo } from '../../shared/store/store-types'
import type { InstalledApp } from '../../shared/apps/app-types'

export interface StoreEntryInstallState {
  /** The first install of this entry, or null when not installed. */
  installedApp: InstalledApp | null
  /** Every install of this entry, one per workspace or Global. */
  installedApps: InstalledApp[]
  /** Workspaces the entry is not installed in yet. */
  installableSpaceIds: string[]
  /** The first pending update among the installs. */
  updateInfo: UpdateInfo | null
}

export function useStoreEntryInstallState(
  entry: RegistryEntry | null | undefined,
  registryId: string | null | undefined,
): StoreEntryInstallState {
  const apps = useAppsStore(state => state.apps)
  const availableUpdates = useAppsPageStore(state => state.availableUpdates)

  const haloSpace = useSpaceStore(state => state.haloSpace)
  const spaces = useSpaceStore(state => state.spaces)

  const installedApps = useMemo(
    () => findInstalledApps(entry, registryId, apps),
    [apps, entry, registryId],
  )
  const installableSpaceIds = useMemo(
    () => findInstallableSpaceIds(
      installedApps,
      [...(haloSpace ? [haloSpace.id] : []), ...spaces.map(space => space.id)],
    ),
    [installedApps, haloSpace, spaces],
  )
  const updateInfo = useMemo(
    () => findInstallsUpdate(installedApps, availableUpdates),
    [availableUpdates, installedApps],
  )

  return { installedApp: installedApps[0] ?? null, installedApps, installableSpaceIds, updateInfo }
}
