/**
 * Unit tests for apps/manager — app session invalidation events
 *
 * onAppSessionInvalidate fires when an app's OWN config changes in a way that
 * is baked into a chat session at creation time (permissions, config values,
 * system_prompt, requires.mcps). The runtime subscribes and rebuilds the app's
 * chat session so the change auto-applies on the next message. No-op saves and
 * cosmetic edits (rename, full-spec YAML save with unchanged values) must NOT
 * fire it, so a warm session is never torn down needlessly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import { AppManagerStore } from '../../../../src/main/apps/manager/store'
import { createAppManagerService, onAppSessionInvalidate } from '../../../../src/main/apps/manager/service'
import type { AppManagerDeps } from '../../../../src/main/apps/manager/service'
import { MIGRATION_NAMESPACE, migrations } from '../../../../src/main/apps/manager/migrations'
import type { AppManagerService } from '../../../../src/main/apps/manager/types'
import type { AppSpec } from '../../../../src/main/apps/spec/schema'

const TEST_SPACE_ID = 'space-001'

function createAutomationSpec(name = 'test-dh'): AppSpec {
  return {
    spec_version: '1',
    name,
    version: '1.0.0',
    author: 'Test Author',
    description: 'A test digital human',
    type: 'automation',
    system_prompt: 'You are a test bot.',
  } as unknown as AppSpec
}

describe('AppManager session invalidation events', () => {
  let dbManager: DatabaseManager
  let service: AppManagerService
  let invalidated: string[]
  let unsubscribe: () => void

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, MIGRATION_NAMESPACE, migrations)

    const testDir = globalThis.__HALO_TEST_DIR__
    const spacePath = join(testDir, 'spaces', TEST_SPACE_ID)
    mkdirSync(spacePath, { recursive: true })
    const globalDir = join(testDir, 'global')
    mkdirSync(globalDir, { recursive: true })

    const deps: AppManagerDeps = {
      store: new AppManagerStore(db),
      getSpacePath: (spaceId: string) => (spaceId === TEST_SPACE_ID ? spacePath : null),
      getAppDataPath: (spaceId: string) => (spaceId === TEST_SPACE_ID ? spacePath : null),
      getGlobalAppDir: () => globalDir,
    }
    service = createAppManagerService(deps)

    invalidated = []
    unsubscribe = onAppSessionInvalidate((appId) => invalidated.push(appId))
  })

  afterEach(() => {
    unsubscribe()
    dbManager.closeAll()
    vi.clearAllMocks()
  })

  it('fires on grant and revoke', async () => {
    const appId = await service.install(TEST_SPACE_ID, createAutomationSpec())
    invalidated.length = 0

    service.grantPermission(appId, 'ai-terminal')
    expect(invalidated).toEqual([appId])

    service.revokePermission(appId, 'ai-terminal')
    expect(invalidated).toEqual([appId, appId])
  })

  it('does NOT fire on a no-op grant or no-op revoke', async () => {
    const appId = await service.install(TEST_SPACE_ID, createAutomationSpec())
    service.grantPermission(appId, 'ai-terminal')
    invalidated.length = 0

    // Repeating the same grant must not tear down a warm session.
    service.grantPermission(appId, 'ai-terminal')
    expect(invalidated).toEqual([])

    service.revokePermission(appId, 'ai-terminal')
    invalidated.length = 0

    // Repeating the same revoke must not either.
    service.revokePermission(appId, 'ai-terminal')
    expect(invalidated).toEqual([])
  })

  it('fires on updateConfig with a real change', async () => {
    const appId = await service.install(TEST_SPACE_ID, createAutomationSpec())
    invalidated.length = 0

    service.updateConfig(appId, { url: 'https://example.com' })
    expect(invalidated).toEqual([appId])
  })

  it('does NOT fire on a no-op updateConfig (unchanged values)', async () => {
    const appId = await service.install(TEST_SPACE_ID, createAutomationSpec())
    service.updateConfig(appId, { url: 'https://example.com' })
    invalidated.length = 0

    // Saving the identical config must not tear down a warm session.
    service.updateConfig(appId, { url: 'https://example.com' })
    expect(invalidated).toEqual([])
  })

  it('fires on updateSpec when a session-affecting field changes value', async () => {
    const appId = await service.install(TEST_SPACE_ID, createAutomationSpec())
    invalidated.length = 0

    service.updateSpec(appId, { system_prompt: 'New prompt.' })
    expect(invalidated).toEqual([appId])

    service.updateSpec(appId, { requires: { mcps: [{ id: 'postgres', enabled: false }] } })
    expect(invalidated).toEqual([appId, appId])
  })

  it('does NOT fire on a cosmetic updateSpec (rename / description only)', async () => {
    const appId = await service.install(TEST_SPACE_ID, createAutomationSpec())
    invalidated.length = 0

    service.updateSpec(appId, { name: 'Renamed', description: 'New description' })
    expect(invalidated).toEqual([])
  })

  it('does NOT fire on a full-spec patch with unchanged session-affecting values (YAML save)', async () => {
    const spec = createAutomationSpec()
    const appId = await service.install(TEST_SPACE_ID, spec)
    invalidated.length = 0

    // YAML tab sends the complete spec as the patch. Session-affecting keys are
    // present but their VALUES are unchanged — only the rename differs.
    service.updateSpec(appId, { ...spec, name: 'Renamed via YAML' } as unknown as Record<string, unknown>)
    expect(invalidated).toEqual([])
  })
})
