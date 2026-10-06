/**
 * A built-in digital human updated together with Halo goes through the same
 * upgrade merge as a store update, so the bundle cannot overwrite the user's
 * edits either.
 */

import { describe, it, expect, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

import { loadBuiltinApps } from '../../../../src/main/apps/manager/builtin-loader'
import type { AppManagerService, InstalledApp } from '../../../../src/main/apps/manager/types'

/** Bundle one built-in digital human at `version`, where the loader looks for it. */
function writeBundle(version: string, slug?: string): void {
  const root = join(globalThis.__HALO_TEST_DIR__, 'app', 'resources', 'builtin-apps')
  mkdirSync(join(root, 'daily-report'), { recursive: true })
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({
    version: 1,
    sourcePath: '',
    generatedAt: `build-${version}`,
    apps: [{ specId: 'daily-report', spaceId: 'space-1', defaultStatus: 'active' }],
  }))
  writeFileSync(join(root, 'daily-report', 'spec.yaml'), [
    'name: daily-report',
    `version: "${version}"`,
    'author: halo',
    'description: Daily sales',
    'type: automation',
    'system_prompt: Summarize sales.',
    'subscriptions:',
    '  - id: daily',
    '    source:',
    '      type: schedule',
    '      config:',
    '        cron: "0 8 * * *"',
    ...(slug ? ['store:', `  slug: ${slug}`] : []),
  ].join('\n'))
}

function installedBuiltin(version: string, name = 'daily-report', slug?: string): InstalledApp {
  return {
    id: 'app-1',
    specId: name,
    spaceId: 'space-1',
    status: 'active',
    spec: {
      spec_version: '1',
      name,
      version,
      author: 'halo',
      description: 'Daily sales',
      type: 'automation',
      system_prompt: 'Mine.',
      store: { tags: [], install_source: 'builtin', ...(slug ? { slug } : {}) },
    },
    userConfig: {},
    userOverrides: {},
    permissions: { granted: [], denied: [] },
    installedAt: 1,
    upgradeStrategy: 'auto',
    knowledgeSeeded: true,
  } as InstalledApp
}

function managerWith(app: InstalledApp, original: InstalledApp['spec'] | null = null) {
  return {
    listApps: vi.fn(() => [app]),
    upgradeSpec: vi.fn(() => ({ fromVersion: app.spec.version, toVersion: '1.1.0', kept: ['system_prompt'], editsKnown: true })),
    updateSpec: vi.fn(),
    getAuthorSpec: vi.fn(() => original),
    recordAuthorSpec: vi.fn(() => true),
    install: vi.fn(),
    uninstall: vi.fn(),
    deleteApp: vi.fn(),
  }
}

describe('loadBuiltinApps upgrades', () => {
  // Rescheduling and the activity note are the runtime's reaction to the
  // manager's upgrade event, the same for every path.
  it('upgrades through the manager’s merge', async () => {
    writeBundle('1.1.0')
    const manager = managerWith(installedBuiltin('1.0.0'))

    await loadBuiltinApps(manager as unknown as AppManagerService)

    expect(manager.upgradeSpec).toHaveBeenCalledWith('app-1', expect.objectContaining({
      version: '1.1.0',
      store: expect.objectContaining({ install_source: 'builtin' }),
    }))
    expect(manager.updateSpec).not.toHaveBeenCalled()
  })

  it('records the bundled spec as the original while it is still the installed version', async () => {
    writeBundle('1.0.0')
    const manager = managerWith(installedBuiltin('1.0.0'))

    await loadBuiltinApps(manager as unknown as AppManagerService)

    expect(manager.recordAuthorSpec).toHaveBeenCalledWith('app-1', expect.objectContaining({ version: '1.0.0' }))
    expect(manager.upgradeSpec).not.toHaveBeenCalled()
  })

  it('leaves an original already recorded alone', async () => {
    writeBundle('1.0.0')
    const app = installedBuiltin('1.0.0')
    const manager = managerWith(app, app.spec)

    await loadBuiltinApps(manager as unknown as AppManagerService)

    expect(manager.recordAuthorSpec).not.toHaveBeenCalled()
  })
})

// Renaming a digital human changes its spec id. Matched by name alone, the
// bundle's next change installed a second copy and garbage-collected the
// renamed one, memory and all.
describe('loadBuiltinApps with a built-in the user renamed', () => {
  function expectUpgradedInPlace(manager: ReturnType<typeof managerWith>): void {
    expect(manager.upgradeSpec).toHaveBeenCalledWith('app-1', expect.objectContaining({ version: '1.1.0' }))
    expect(manager.install).not.toHaveBeenCalled()
    expect(manager.uninstall).not.toHaveBeenCalled()
    expect(manager.deleteApp).not.toHaveBeenCalled()
  }

  it('finds it by the bundle’s slug', async () => {
    writeBundle('1.1.0', 'daily-report')
    const manager = managerWith(installedBuiltin('1.0.0', 'My Report', 'daily-report'))

    await loadBuiltinApps(manager as unknown as AppManagerService)

    expectUpgradedInPlace(manager)
  })

  it('finds it by its original’s name when the bundle has no slug', async () => {
    writeBundle('1.1.0')
    const app = installedBuiltin('1.0.0', 'My Report')
    const manager = managerWith(app, { ...app.spec, name: 'daily-report' })

    await loadBuiltinApps(manager as unknown as AppManagerService)

    expectUpgradedInPlace(manager)
  })

  it('still removes a built-in the bundle no longer ships', async () => {
    writeBundle('1.1.0', 'daily-report')
    const app = installedBuiltin('1.0.0', 'retired-report', 'retired-report')
    const manager = managerWith(app, app.spec)

    await loadBuiltinApps(manager as unknown as AppManagerService)

    expect(manager.deleteApp).toHaveBeenCalledWith('app-1', { allowBuiltin: true })
  })
})
