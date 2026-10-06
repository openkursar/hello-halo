/**
 * A built-in digital human updated together with Halo goes through the same
 * upgrade merge as a store update, so the bundle cannot overwrite the user's
 * edits either.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

const { getAppRuntimeMock } = vi.hoisted(() => ({ getAppRuntimeMock: vi.fn() }))

vi.mock('../../../../src/main/apps/runtime', () => ({ getAppRuntime: getAppRuntimeMock }))

import { loadBuiltinApps } from '../../../../src/main/apps/manager/builtin-loader'
import type { AppManagerService, InstalledApp } from '../../../../src/main/apps/manager/types'

/** Bundle one built-in digital human at `version`, where the loader looks for it. */
function writeBundle(version: string): void {
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
  ].join('\n'))
}

function installedBuiltin(version: string): InstalledApp {
  return {
    id: 'app-1',
    specId: 'daily-report',
    spaceId: 'space-1',
    status: 'active',
    spec: {
      spec_version: '1',
      name: 'daily-report',
      version,
      author: 'halo',
      description: 'Daily sales',
      type: 'automation',
      system_prompt: 'Mine.',
      store: { tags: [], install_source: 'builtin' },
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
  }
}

describe('loadBuiltinApps upgrades', () => {
  const syncAppSubscriptions = vi.fn()

  beforeEach(() => {
    getAppRuntimeMock.mockReturnValue({ syncAppSubscriptions })
  })

  it('upgrades through the manager’s merge and reschedules the digital human', async () => {
    writeBundle('1.1.0')
    const manager = managerWith(installedBuiltin('1.0.0'))

    await loadBuiltinApps(manager as unknown as AppManagerService)

    expect(manager.upgradeSpec).toHaveBeenCalledWith('app-1', expect.objectContaining({
      version: '1.1.0',
      store: expect.objectContaining({ install_source: 'builtin' }),
    }))
    expect(manager.updateSpec).not.toHaveBeenCalled()
    expect(syncAppSubscriptions).toHaveBeenCalledWith('app-1')
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
