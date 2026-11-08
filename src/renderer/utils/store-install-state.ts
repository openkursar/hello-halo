/**
 * Pure resolution of a store entry's install state. Kept free of React/store
 * access so it is unit-testable and shared by the grid card and detail view.
 */

import type { RegistryEntry, UpdateInfo } from '../../shared/store/store-types'
import type { InstalledApp } from '../../shared/apps/app-types'

/**
 * Every live install of a store entry — one per workspace (or Global) it was added
 * to. A match requires the same store slug and registry; installs that predate
 * `registry_id` are matched by slug alone, only when there is no exact match.
 */
export function findInstalledApps(
  entry: RegistryEntry | null | undefined,
  registryId: string | null | undefined,
  apps: InstalledApp[],
): InstalledApp[] {
  if (!entry || !registryId) return []
  const live = apps.filter(a => a.status !== 'uninstalled')
  const exact = live.filter(a => a.spec.store?.slug === entry.slug && a.spec.store?.registry_id === registryId)
  if (exact.length) return exact
  return live.filter(a => a.spec.store?.slug === entry.slug && !a.spec.store?.registry_id)
}

/** The first install of a store entry, or null when it is installed nowhere. */
export function findInstalledApp(
  entry: RegistryEntry | null | undefined,
  registryId: string | null | undefined,
  apps: InstalledApp[],
): InstalledApp | null {
  return findInstalledApps(entry, registryId, apps)[0] ?? null
}

/**
 * Workspaces the entry can still be installed into. A Global install already
 * covers every workspace.
 */
export function findInstallableSpaceIds(installs: InstalledApp[], spaceIds: string[]): string[] {
  if (installs.some(app => app.spaceId === null)) return []
  const taken = new Set(installs.map(app => app.spaceId))
  return spaceIds.filter(id => !taken.has(id))
}

/** The default and dedicated workspaces an install dialog offers; all when `availableSpaceIds` is omitted. */
export function offeredInstallSpaces<T extends { id: string }>(
  haloSpace: T | null | undefined,
  spaces: T[],
  availableSpaceIds: string[] | undefined,
): { haloSpace: T | null; spaces: T[] } {
  if (!availableSpaceIds) return { haloSpace: haloSpace ?? null, spaces }
  return {
    haloSpace: haloSpace && availableSpaceIds.includes(haloSpace.id) ? haloSpace : null,
    spaces: spaces.filter(space => availableSpaceIds.includes(space.id)),
  }
}

/** The first pending update among an entry's installs, or null when all are up to date. */
export function findInstallsUpdate(
  installs: InstalledApp[],
  availableUpdates: UpdateInfo[],
): UpdateInfo | null {
  for (const app of installs) {
    const update = findEntryUpdate(app, availableUpdates)
    if (update) return update
  }
  return null
}

/** Find the pending update for an installed app, or null when up to date. */
export function findEntryUpdate(
  installedApp: InstalledApp | null,
  availableUpdates: UpdateInfo[],
): UpdateInfo | null {
  if (!installedApp) return null
  return availableUpdates.find(u => u.appId === installedApp.id) ?? null
}
