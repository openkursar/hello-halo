/**
 * Unit tests for the store entry install-state resolution.
 *
 * Guards the slug + registry_id matching (including the legacy slug-only
 * fallback) and the update lookup shared by the store card and detail view.
 */

import { describe, it, expect } from 'vitest'
import { findInstalledApp, findEntryUpdate } from '../../../src/renderer/utils/store-install-state'
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
