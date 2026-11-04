/**
 * Unit tests for the store entry install-state resolution.
 *
 * Guards the slug + registry_id matching (including the legacy slug-only
 * fallback) and the update lookup shared by the store card and detail view.
 */

import { describe, it, expect } from 'vitest'
import {
  findInstalledApp,
  findInstalledApps,
  findInstallableSpaceIds,
  findInstallsUpdate,
  offeredInstallSpaces,
  findEntryUpdate,
} from '../../../src/renderer/utils/store-install-state'
import type { RegistryEntry, UpdateInfo } from '../../../src/shared/store/store-types'
import type { InstalledApp } from '../../../src/shared/apps/app-types'

function installedApp(id: string, slug?: string, registryId?: string): InstalledApp {
  return {
    id,
    spec: {
      store: slug ? { slug, registry_id: registryId } : undefined,
    },
  } as unknown as InstalledApp
}

function entry(slug: string): RegistryEntry {
  return { slug } as unknown as RegistryEntry
}

describe('store-install-state / findInstalledApp', () => {
  it('returns null when the entry or registryId is missing', () => {
    const apps = [installedApp('a1', 'author/app', 'official')]
    expect(findInstalledApp(null, 'official', apps)).toBeNull()
    expect(findInstalledApp(entry('author/app'), null, apps)).toBeNull()
  })

  it('matches on exact slug + registry_id', () => {
    const apps = [
      installedApp('a1', 'author/app', 'other'),
      installedApp('a2', 'author/app', 'official'),
    ]
    expect(findInstalledApp(entry('author/app'), 'official', apps)?.id).toBe('a2')
  })

  it('falls back to slug-only match for installs predating registry_id', () => {
    const apps = [installedApp('legacy', 'author/app', undefined)]
    expect(findInstalledApp(entry('author/app'), 'official', apps)?.id).toBe('legacy')
  })

  it('prefers the exact match over the legacy fallback', () => {
    const apps = [
      installedApp('legacy', 'author/app', undefined),
      installedApp('exact', 'author/app', 'official'),
    ]
    expect(findInstalledApp(entry('author/app'), 'official', apps)?.id).toBe('exact')
  })

  it('returns null when nothing matches the slug', () => {
    const apps = [installedApp('a1', 'author/other', 'official')]
    expect(findInstalledApp(entry('author/app'), 'official', apps)).toBeNull()
  })
})

describe('store-install-state / findEntryUpdate', () => {
  const update: UpdateInfo = { appId: 'a2' } as unknown as UpdateInfo

  it('returns null when there is no installed app', () => {
    expect(findEntryUpdate(null, [update])).toBeNull()
  })

  it('returns the update matching the installed app id', () => {
    const app = installedApp('a2', 'author/app', 'official')
    expect(findEntryUpdate(app, [update])).toBe(update)
  })

  it('returns null when no update targets the installed app', () => {
    const app = installedApp('a1', 'author/app', 'official')
    expect(findEntryUpdate(app, [update])).toBeNull()
  })
})

describe('store-install-state / installs across workspaces', () => {
  function inSpace(id: string, spaceId: string | null, status = 'active'): InstalledApp {
    return { ...installedApp(id, 'author/app', 'official'), spaceId, status } as InstalledApp
  }

  it('lists every live install and leaves the other workspaces installable', () => {
    const apps = [inSpace('a1', 'space-a'), inSpace('a2', 'space-b'), inSpace('a3', 'space-c', 'uninstalled')]
    const installs = findInstalledApps(entry('author/app'), 'official', apps)
    expect(installs.map(app => app.id)).toEqual(['a1', 'a2'])
    expect(findInstallableSpaceIds(installs, ['space-a', 'space-b', 'space-c'])).toEqual(['space-c'])
  })

  it('offers no workspace once a Global install covers them all', () => {
    expect(findInstallableSpaceIds([inSpace('g', null)], ['space-a'])).toEqual([])
  })

  it('finds a pending update on any install, not just the first', () => {
    const installs = [inSpace('a1', 'space-a'), inSpace('a2', 'space-b')]
    const pending = { appId: 'a2', latestVersion: '2.0.0' } as UpdateInfo
    expect(findInstallsUpdate(installs, [pending])).toBe(pending)
  })
})

describe('store-install-state / legacy installs and dialog targets', () => {
  function legacy(id: string, spaceId: string | null): InstalledApp {
    return { ...installedApp(id, 'author/app'), spaceId, status: 'active' } as InstalledApp
  }
  function exact(id: string, spaceId: string | null): InstalledApp {
    return { ...installedApp(id, 'author/app', 'official'), spaceId, status: 'active' } as InstalledApp
  }

  it('counts slug-only installs only when no exact match exists', () => {
    expect(findInstalledApps(entry('author/app'), 'official', [legacy('old', 's1'), exact('new', 's2')]).map(a => a.id))
      .toEqual(['new'])
    expect(findInstalledApps(entry('author/app'), 'official', [legacy('old', 's1')]).map(a => a.id)).toEqual(['old'])
  })

  it('treats an uninstalled copy as not installed', () => {
    const trashed = { ...exact('t', 's1'), status: 'uninstalled' } as InstalledApp
    expect(findInstalledApp(entry('author/app'), 'official', [trashed])).toBeNull()
  })

  it('leaves the default workspace out of the dialog when it already has a copy', () => {
    const halo = { id: 'halo' }
    const spaces = [{ id: 's1' }, { id: 's2' }]
    expect(offeredInstallSpaces(halo, spaces, ['s2'])).toEqual({ haloSpace: null, spaces: [{ id: 's2' }] })
    expect(offeredInstallSpaces(halo, spaces, undefined)).toEqual({ haloSpace: halo, spaces })
  })
})
