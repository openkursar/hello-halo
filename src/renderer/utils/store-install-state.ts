/**
 * Pure resolution of a store entry's install state. Kept free of React/store
 * access so it is unit-testable and shared by the grid card and detail view.
 */

import type { RegistryEntry, UpdateInfo } from '../../shared/store/store-types'
import type { InstalledApp } from '../../shared/apps/app-types'

/**
 * Find the installed app that corresponds to a store entry. A match requires
 * the same store slug and registry; installs that predate `registry_id` are
 * matched by slug alone as a fallback.
 */
export function findInstalledApp(
  entry: RegistryEntry | null | undefined,
  registryId: string | null | undefined,
  apps: InstalledApp[],
): InstalledApp | null {
  if (!entry || !registryId) return null

  const exact = apps.find(a => {
    const storeSlug = a.spec.store?.slug
    const storeRegistryId = a.spec.store?.registry_id
    return storeSlug === entry.slug && storeRegistryId === registryId
  })
  if (exact) return exact

  return apps.find(a => {
    const storeSlug = a.spec.store?.slug
    const storeRegistryId = a.spec.store?.registry_id
    return storeSlug === entry.slug && !storeRegistryId
  }) ?? null
}

/** Find the pending update for an installed app, or null when up to date. */
export function findEntryUpdate(
  installedApp: InstalledApp | null,
  availableUpdates: UpdateInfo[],
): UpdateInfo | null {
  if (!installedApp) return null
  return availableUpdates.find(u => u.appId === installedApp.id) ?? null
}
