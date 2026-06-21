/**
 * Unit tests for apps/manager
 *
 * Tests the App lifecycle management layer including:
 * - Installation flow (DB record + work directory creation)
 * - Status transitions (state machine enforcement)
 * - Configuration updates
 * - Uninstall (with and without purge)
 * - Query/filtering (listApps, getApp)
 * - Permissions management
 * - Event notification (onAppStatusChange)
 * - Error cases
 *
 * All tests use :memory: databases for speed and isolation.
 * File system operations use temporary directories cleaned up after each test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import { AppManagerStore } from '../../../../src/main/apps/manager/store'
import { createAppManagerService } from '../../../../src/main/apps/manager/service'
import type { AppManagerDeps } from '../../../../src/main/apps/manager/service'
import { MIGRATION_NAMESPACE, migrations } from '../../../../src/main/apps/manager/migrations'
import type { AppManagerService, AppStatus, InstalledApp } from '../../../../src/main/apps/manager/types'
import {
  AppNotFoundError,
  AppAlreadyInstalledError,
  InvalidStatusTransitionError,
  SpaceNotFoundError,
} from '../../../../src/main/apps/manager/errors'
import type { AppSpec } from '../../../../src/main/apps/spec/schema'

// ============================================
// Test Fixtures
// ============================================

/** Minimal valid AppSpec for testing */
function createTestSpec(overrides?: Partial<AppSpec>): AppSpec {
  return {
    spec_version: '1',
    name: 'test-app',
    version: '1.0.0',
    author: 'Test Author',
    description: 'A test app',
    type: 'automation',
    system_prompt: 'You are a test bot.',
    ...overrides,
  } as AppSpec
}

/** Space paths for testing */
const TEST_SPACE_ID = 'space-001'
const TEST_SPACE_ID_2 = 'space-002'

// ============================================
// Test Setup
// ============================================

describe('AppManager', () => {
  let dbManager: DatabaseManager
  let store: AppManagerStore
  let service: AppManagerService
  let spacePaths: Record<string, string>

  /**
   * Create fresh service instance with in-memory DB and temp directories.
   * Uses the global __HALO_TEST_DIR__ from setup.ts for filesystem paths.
   */
  function setup(): void {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
    store = new AppManagerStore(db)

    // Create space directories in the test temp dir
    const testDir = globalThis.__HALO_TEST_DIR__
    spacePaths = {
      [TEST_SPACE_ID]: join(testDir, 'spaces', TEST_SPACE_ID),
      [TEST_SPACE_ID_2]: join(testDir, 'spaces', TEST_SPACE_ID_2),
    }

    const globalDir = join(testDir, 'global')

    for (const spacePath of Object.values(spacePaths)) {
      mkdirSync(spacePath, { recursive: true })
    }
    mkdirSync(globalDir, { recursive: true })

    const deps: AppManagerDeps = {
      store,
      getSpacePath: (spaceId: string) => spacePaths[spaceId] ?? null,
      getAppDataPath: (spaceId: string) => spacePaths[spaceId] ?? null,
      getGlobalAppDir: () => globalDir,
    }

    service = createAppManagerService(deps)
  }

  beforeEach(() => {
    setup()
  })

  afterEach(() => {
    dbManager.closeAll()
  })

  // ===========================================================================
  // Installation
  // ===========================================================================

  describe('install', () => {
    it('should install an App and return a UUID', async () => {
      const spec = createTestSpec()
      const appId = await service.install(TEST_SPACE_ID, spec)

      expect(appId).toBeDefined()
      expect(typeof appId).toBe('string')
      expect(appId.length).toBeGreaterThan(0)
      // UUID v4 format
      expect(appId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    })

    it('should create the work directory and memory subdirectory', async () => {
      const spec = createTestSpec()
      const appId = await service.install(TEST_SPACE_ID, spec)

      const workDir = join(spacePaths[TEST_SPACE_ID], '.halo', 'apps', appId)
      const memoryDir = join(workDir, 'memory')

      expect(existsSync(workDir)).toBe(true)
      expect(existsSync(memoryDir)).toBe(true)
    })

    it('should persist the App in the database with correct fields', async () => {
      const spec = createTestSpec({ name: 'price-checker' })
      const userConfig = { url: 'https://example.com', interval: 30 }

      const appId = await service.install(TEST_SPACE_ID, spec, userConfig)
      const app = service.getApp(appId)

      expect(app).not.toBeNull()
      expect(app!.id).toBe(appId)
      expect(app!.specId).toBe('price-checker')
      expect(app!.spaceId).toBe(TEST_SPACE_ID)
      expect(app!.spec.name).toBe('price-checker')
      expect(app!.status).toBe('active')
      expect(app!.userConfig).toEqual(userConfig)
      expect(app!.userOverrides).toEqual({})
      expect(app!.permissions).toEqual({ granted: [], denied: [] })
      expect(app!.installedAt).toBeGreaterThan(0)
      expect(app!.lastRunAt).toBeUndefined()
      expect(app!.lastRunOutcome).toBeUndefined()
      expect(app!.errorMessage).toBeUndefined()
      expect(app!.pendingEscalationId).toBeUndefined()
    })

    it('should use empty object as default userConfig', async () => {
      const appId = await service.install(TEST_SPACE_ID, createTestSpec())
      const app = service.getApp(appId)!

      expect(app.userConfig).toEqual({})
    })

    it('should throw AppAlreadyInstalledError for duplicate automation spec+space', async () => {
      const spec = createTestSpec({ name: 'unique-app', type: 'automation' })
      await service.install(TEST_SPACE_ID, spec)

      await expect(
        service.install(TEST_SPACE_ID, spec)
      ).rejects.toThrow(AppAlreadyInstalledError)
    })

    it('should overwrite an existing active skill instead of throwing', async () => {
      // Skills are content-only (prompt + files) — re-installing should
      // refresh the row in place rather than fail with a conflict error.
      const original = {
        spec_version: '1',
        name: 'shared-skill',
        version: '1.0.0',
        description: 'first version',
        type: 'skill',
        skill_content: 'original content',
      } as unknown as AppSpec
      const updated = {
        ...original,
        version: '2.0.0',
        description: 'second version',
        skill_content: 'updated content',
      } as unknown as AppSpec

      const id1 = await service.install(TEST_SPACE_ID, original)
      const id2 = await service.install(TEST_SPACE_ID, updated, { foo: 'bar' })

      // Same DB row reused — overwrite is in place, not a fresh row.
      expect(id2).toBe(id1)

      const app = service.getApp(id1)!
      expect(app.spec.version).toBe('2.0.0')
      expect(app.spec.description).toBe('second version')
      expect((app.spec as unknown as { skill_content: string }).skill_content).toBe('updated content')
      expect(app.userConfig).toEqual({ foo: 'bar' })
      expect(app.status).toBe('active')
    })

    it('should preserve previous userConfig when re-installing skill without new config', async () => {
      const spec = {
        spec_version: '1',
        name: 'configured-skill',
        version: '1.0.0',
        description: 'a skill',
        type: 'skill',
        skill_content: 'v1',
      } as unknown as AppSpec

      const id1 = await service.install(TEST_SPACE_ID, spec, { keep: 'me' })
      const id2 = await service.install(TEST_SPACE_ID, { ...spec, version: '1.1.0' } as AppSpec)

      expect(id2).toBe(id1)
      const app = service.getApp(id1)!
      // Existing userConfig is preserved when the re-install omits one.
      expect(app.userConfig).toEqual({ keep: 'me' })
      expect(app.spec.version).toBe('1.1.0')
    })

    it('should still reject duplicate MCP spec+space (runtime state is not safe to overwrite)', async () => {
      const spec = {
        spec_version: '1',
        name: 'shared-mcp',
        version: '1.0.0',
        description: 'an mcp',
        type: 'mcp',
        mcp_server: { type: 'stdio', command: 'echo', args: ['hi'] },
      } as unknown as AppSpec

      await service.install(TEST_SPACE_ID, spec)
      await expect(
        service.install(TEST_SPACE_ID, spec)
      ).rejects.toThrow(AppAlreadyInstalledError)
    })

    it('should allow same spec in different spaces', async () => {
      const spec = createTestSpec({ name: 'shared-app' })

      const id1 = await service.install(TEST_SPACE_ID, spec)
      const id2 = await service.install(TEST_SPACE_ID_2, spec)

      expect(id1).not.toBe(id2)

      const app1 = service.getApp(id1)!
      const app2 = service.getApp(id2)!

      expect(app1.spaceId).toBe(TEST_SPACE_ID)
      expect(app2.spaceId).toBe(TEST_SPACE_ID_2)
    })

    it('should throw SpaceNotFoundError for non-existent space', async () => {
      await expect(
        service.install('non-existent-space', createTestSpec())
      ).rejects.toThrow(SpaceNotFoundError)
    })
  })

  // ===========================================================================
  // Uninstall
  // ===========================================================================

  describe('uninstall', () => {
    it('should soft-delete the App (set status to uninstalled)', async () => {
      const appId = await service.install(TEST_SPACE_ID, createTestSpec())
      expect(service.getApp(appId)).not.toBeNull()

      await service.uninstall(appId)

      // Soft-delete: record remains in DB with status = 'uninstalled'
      const app = service.getApp(appId)
      expect(app).not.toBeNull()
      expect(app!.status).toBe('uninstalled')
      expect(app!.uninstalledAt).toBeGreaterThan(0)
    })

    it('should preserve work directory (soft-delete does not purge)', async () => {
      const appId = await service.install(TEST_SPACE_ID, createTestSpec())
      const workDir = join(spacePaths[TEST_SPACE_ID], '.halo', 'apps', appId)
      expect(existsSync(workDir)).toBe(true)

      await service.uninstall(appId)
      expect(existsSync(workDir)).toBe(true) // Still there
    })

    it('should notify status change handler on uninstall', async () => {
      const handler = vi.fn()
      service.onAppStatusChange(handler)

      const appId = await service.install(TEST_SPACE_ID, createTestSpec())
      await service.uninstall(appId)

      expect(handler).toHaveBeenCalledWith(appId, 'active', 'uninstalled')
    })

    it('should throw AppNotFoundError for non-existent App', async () => {
      await expect(
        service.uninstall('non-existent-id')
      ).rejects.toThrow(AppNotFoundError)
    })
  })

  // ===========================================================================
  // Reinstall
  // ===========================================================================

  describe('reinstall', () => {
    it('should transition uninstalled -> active', async () => {
      const appId = await service.install(TEST_SPACE_ID, createTestSpec())
      await service.uninstall(appId)
      expect(service.getApp(appId)!.status).toBe('uninstalled')

      service.reinstall(appId)

      const app = service.getApp(appId)!
      expect(app.status).toBe('active')
      expect(app.uninstalledAt).toBeUndefined()
    })

    it('should throw for non-uninstalled App', async () => {
      const appId = await service.install(TEST_SPACE_ID, createTestSpec())
      // App is 'active', not 'uninstalled'
      expect(() => service.reinstall(appId)).toThrow(InvalidStatusTransitionError)
    })

    it('should throw AppNotFoundError for non-existent App', () => {
      expect(() => service.reinstall('non-existent')).toThrow(AppNotFoundError)
    })
  })

  // ===========================================================================
  // Permanent Deletion (deleteApp)
  // ===========================================================================

  describe('deleteApp', () => {
    it('should permanently remove an uninstalled App from the database', async () => {
      const appId = await service.install(TEST_SPACE_ID, createTestSpec())
      await service.uninstall(appId)
      expect(service.getApp(appId)).not.toBeNull()

      await service.deleteApp(appId)
      expect(service.getApp(appId)).toBeNull()
    })

    it('should purge work directory on permanent deletion', async () => {
      const appId = await service.install(TEST_SPACE_ID, createTestSpec())
      const workDir = join(spacePaths[TEST_SPACE_ID], '.halo', 'apps', appId)
      expect(existsSync(workDir)).toBe(true)

      await service.uninstall(appId)
      await service.deleteApp(appId)
      expect(existsSync(workDir)).toBe(false)
    })

    it('should throw for non-uninstalled App (must uninstall first)', async () => {
      const appId = await service.install(TEST_SPACE_ID, createTestSpec())
      // App is 'active', cannot hard-delete directly
      await expect(service.deleteApp(appId)).rejects.toThrow(InvalidStatusTransitionError)
    })

    it('should throw AppNotFoundError for non-existent App', async () => {
      await expect(service.deleteApp('non-existent')).rejects.toThrow(AppNotFoundError)
    })
  })

  // ===========================================================================
  // Status Transitions -- State Machine
  // ===========================================================================

  describe('status transitions', () => {

    describe('pause', () => {
      it('should transition active -> paused', async () => {
        const appId = await service.install(TEST_SPACE_ID, createTestSpec())
        service.pause(appId)

        const app = service.getApp(appId)!
        expect(app.status).toBe('paused')
      })

      it('should throw for paused -> paused (already paused)', async () => {
        const appId = await service.install(TEST_SPACE_ID, createTestSpec())
        service.pause(appId)

        expect(() => service.pause(appId)).toThrow(InvalidStatusTransitionError)
      })

      it('should throw for non-existent App', () => {
        expect(() => service.pause('non-existent')).toThrow(AppNotFoundError)
      })
    })

    describe('resume', () => {
      it('should transition paused -> active', async () => {
        const appId = await service.install(TEST_SPACE_ID, createTestSpec())
        service.pause(appId)
        service.resume(appId)

        expect(service.getApp(appId)!.status).toBe('active')
      })

      it('should transition error -> active', async () => {
        const appId = await service.install(TEST_SPACE_ID, createTestSpec())
        service.updateStatus(appId, 'error', { errorMessage: 'test error' })
        service.resume(appId)

        const app = service.getApp(appId)!
        expect(app.status).toBe('active')
        // Error fields should be cleared on resume (null from DB -> undefined in domain)
        expect(app.errorMessage).toBeUndefined()
      })

      it('should transition needs_login -> active', async () => {
        const appId = await service.install(TEST_SPACE_ID, createTestSpec())
        service.updateStatus(appId, 'needs_login')
        service.resume(appId)

        expect(service.getApp(appId)!.status).toBe('active')
      })

      it('should throw for active -> active (already active)', async () => {
        const appId = await service.install(TEST_SPACE_ID, createTestSpec())
        expect(() => service.resume(appId)).toThrow(InvalidStatusTransitionError)
      })
    })

    describe('updateStatus', () => {
      it('should transition active -> error with error message', async () => {
        const appId = await service.install(TEST_SPACE_ID, createTestSpec())
        service.updateStatus(appId, 'error', { errorMessage: 'API rate limit exceeded' })

        const app = service.getApp(appId)!
        expect(app.status).toBe('error')
        expect(app.errorMessage).toBe('API rate limit exceeded')
      })

      it('should transition active -> needs_login', async () => {
        const appId = await service.install(TEST_SPACE_ID, createTestSpec())
        service.updateStatus(appId, 'needs_login')

        expect(service.getApp(appId)!.status).toBe('needs_login')
      })

      it('should transition active -> waiting_user with escalation ID', async () => {
        const appId = await service.install(TEST_SPACE_ID, createTestSpec())
        service.updateStatus(appId, 'waiting_user', { pendingEscalationId: 'esc-123' })

        const app = service.getApp(appId)!
        expect(app.status).toBe('waiting_user')
        expect(app.pendingEscalationId).toBe('esc-123')
      })

      it('should transition waiting_user -> active', async () => {
        const appId = await service.install(TEST_SPACE_ID, createTestSpec())
        service.updateStatus(appId, 'waiting_user', { pendingEscalationId: 'esc-123' })
        service.updateStatus(appId, 'active')

        const app = service.getApp(appId)!
        expect(app.status).toBe('active')
        // Escalation ID should be cleared (null from DB -> undefined in domain)
        expect(app.pendingEscalationId).toBeUndefined()
      })

      it('should transition waiting_user -> error', async () => {
        const appId = await service.install(TEST_SPACE_ID, createTestSpec())
        service.updateStatus(appId, 'waiting_user')
        service.updateStatus(appId, 'error', { errorMessage: 'escalation timeout' })

        expect(service.getApp(appId)!.status).toBe('error')
      })

      it('should be a no-op when setting the same status', async () => {
        const appId = await service.install(TEST_SPACE_ID, createTestSpec())
        // active -> active should not throw, just update metadata
        service.updateStatus(appId, 'active')

        expect(service.getApp(appId)!.status).toBe('active')
      })

      it('should update extra fields on same-status update', async () => {
        const appId = await service.install(TEST_SPACE_ID, createTestSpec())
        service.updateStatus(appId, 'error', { errorMessage: 'first error' })
        service.updateStatus(appId, 'error', { errorMessage: 'updated error' })

        expect(service.getApp(appId)!.errorMessage).toBe('updated error')
      })
    })

    describe('invalid transitions', () => {
      const invalidTransitions: Array<[AppStatus, AppStatus]> = [
        // paused can only go to active
        ['paused', 'error'],
        ['paused', 'needs_login'],
        ['paused', 'waiting_user'],
        // error can go to active or paused, NOT to needs_login or waiting_user
        ['error', 'needs_login'],
        ['error', 'waiting_user'],
        // needs_login can go to active or paused, NOT to error or waiting_user
        ['needs_login', 'error'],
        ['needs_login', 'waiting_user'],
      ]

      for (const [from, to] of invalidTransitions) {
        it(`should reject transition: ${from} -> ${to}`, async () => {
          const appId = await service.install(TEST_SPACE_ID, createTestSpec())

          // Set up the 'from' state (active is default)
          if (from !== 'active') {
            // Need to first get to the 'from' state from 'active'
            if (from === 'paused') {
              service.pause(appId)
            } else {
              service.updateStatus(appId, from as AppStatus)
            }
          }

          expect(() => service.updateStatus(appId, to as AppStatus)).toThrow(
            InvalidStatusTransitionError
          )
        })
      }
    })
  })

  // ===========================================================================
  // Full Lifecycle Flow
  // ===========================================================================

  describe('full lifecycle', () => {
    it('should support install -> pause -> resume -> uninstall', async () => {
      const spec = createTestSpec({ name: 'lifecycle-test' })
      const appId = await service.install(TEST_SPACE_ID, spec)

      // Initially active
      expect(service.getApp(appId)!.status).toBe('active')

      // Pause
      service.pause(appId)
      expect(service.getApp(appId)!.status).toBe('paused')

      // Resume
      service.resume(appId)
      expect(service.getApp(appId)!.status).toBe('active')

      // Uninstall (soft-delete)
      await service.uninstall(appId)
      expect(service.getApp(appId)!.status).toBe('uninstalled')
    })

    it('should support install -> error -> resume -> pause -> uninstall -> deleteApp', async () => {
      const spec = createTestSpec({ name: 'error-recovery' })
      const appId = await service.install(TEST_SPACE_ID, spec)

      // Error
      service.updateStatus(appId, 'error', { errorMessage: 'Something broke' })
      expect(service.getApp(appId)!.status).toBe('error')
      expect(service.getApp(appId)!.errorMessage).toBe('Something broke')

      // Resume (from error)
      service.resume(appId)
      expect(service.getApp(appId)!.status).toBe('active')

      // Pause
      service.pause(appId)
      expect(service.getApp(appId)!.status).toBe('paused')

      // Uninstall (soft-delete) — work directory preserved
      const workDir = service.getAppWorkDir(appId)
      expect(existsSync(workDir)).toBe(true)

      await service.uninstall(appId)
      expect(service.getApp(appId)!.status).toBe('uninstalled')
      expect(existsSync(workDir)).toBe(true) // Soft-delete preserves files

      // Permanent deletion — work directory purged, record removed
      await service.deleteApp(appId)
      expect(service.getApp(appId)).toBeNull()
      expect(existsSync(workDir)).toBe(false)
    })

    it('should support install -> uninstall -> reinstall -> uninstall -> deleteApp', async () => {
      const spec = createTestSpec({ name: 'reinstall-lifecycle' })
      const appId = await service.install(TEST_SPACE_ID, spec)

      // Uninstall
      await service.uninstall(appId)
      expect(service.getApp(appId)!.status).toBe('uninstalled')

      // Reinstall
      service.reinstall(appId)
      expect(service.getApp(appId)!.status).toBe('active')
      expect(service.getApp(appId)!.uninstalledAt).toBeUndefined()

      // Uninstall again
      await service.uninstall(appId)
      expect(service.getApp(appId)!.status).toBe('uninstalled')

      // Permanent deletion
      await service.deleteApp(appId)
      expect(service.getApp(appId)).toBeNull()
    })

    it('should support install -> waiting_user -> active -> uninstall', async () => {
      const spec = createTestSpec({ name: 'escalation-flow' })
      const appId = await service.install(TEST_SPACE_ID, spec)

      // Escalation
      service.updateStatus(appId, 'waiting_user', {
        pendingEscalationId: 'esc-001',
        errorMessage: 'Should I buy BTC?',
      })
      expect(service.getApp(appId)!.status).toBe('waiting_user')
      expect(service.getApp(appId)!.pendingEscalationId).toBe('esc-001')

      // Resolved
      service.updateStatus(appId, 'active')
      expect(service.getApp(appId)!.status).toBe('active')

      await service.uninstall(appId)
    })
  })

  // ===========================================================================
  // Configuration
  // ===========================================================================

  describe('configuration', () => {
    it('should update user config', async () => {
      const appId = await service.install(TEST_SPACE_ID, createTestSpec())

      service.updateConfig(appId, { url: 'https://new-url.com', threshold: 10 })

      const app = service.getApp(appId)!
      expect(app.userConfig).toEqual({ url: 'https://new-url.com', threshold: 10 })
    })

    it('should replace entire config on update', async () => {
      const appId = await service.install(
        TEST_SPACE_ID,
        createTestSpec(),
        { a: 1, b: 2 }
      )

      service.updateConfig(appId, { c: 3 })

      const app = service.getApp(appId)!
      expect(app.userConfig).toEqual({ c: 3 }) // a and b are gone
    })

    it('should throw AppNotFoundError for non-existent App', () => {
      expect(() => service.updateConfig('non-existent', {})).toThrow(AppNotFoundError)
    })
  })

  describe('updateFrequency', () => {
    it('should set frequency override for a subscription', async () => {
      const appId = await service.install(TEST_SPACE_ID, createTestSpec())

      service.updateFrequency(appId, 'sub-1', '15m')

      const app = service.getApp(appId)!
      expect(app.userOverrides.frequency).toEqual({ 'sub-1': '15m' })
    })

    it('should accumulate multiple frequency overrides', async () => {
      const appId = await service.install(TEST_SPACE_ID, createTestSpec())

      service.updateFrequency(appId, 'sub-1', '15m')
      service.updateFrequency(appId, 'sub-2', '1h')

      const app = service.getApp(appId)!
      expect(app.userOverrides.frequency).toEqual({
        'sub-1': '15m',
        'sub-2': '1h',
      })
    })
  })

  // ===========================================================================
  // Run Tracking
  // ===========================================================================

  describe('updateLastRun', () => {
    it('should record last run outcome', async () => {
      const appId = await service.install(TEST_SPACE_ID, createTestSpec())

      service.updateLastRun(appId, 'useful')

      const app = service.getApp(appId)!
      expect(app.lastRunOutcome).toBe('useful')
      expect(app.lastRunAt).toBeGreaterThan(0)
    })

    it('should record error outcome with message', async () => {
      const appId = await service.install(TEST_SPACE_ID, createTestSpec())

      service.updateLastRun(appId, 'error', 'Network timeout')

      const app = service.getApp(appId)!
      expect(app.lastRunOutcome).toBe('error')
      expect(app.errorMessage).toBe('Network timeout')
    })
  })

  // ===========================================================================
  // Queries
  // ===========================================================================

  describe('getApp', () => {
    it('should return null for non-existent App', () => {
      expect(service.getApp('non-existent')).toBeNull()
    })

    it('should return the installed App', async () => {
      const appId = await service.install(TEST_SPACE_ID, createTestSpec())
      const app = service.getApp(appId)

      expect(app).not.toBeNull()
      expect(app!.id).toBe(appId)
    })
  })

  describe('listApps', () => {
    it('should return empty array when no Apps are installed', () => {
      expect(service.listApps()).toEqual([])
    })

    it('should return all installed Apps', async () => {
      await service.install(TEST_SPACE_ID, createTestSpec({ name: 'app-1' }))
      await service.install(TEST_SPACE_ID, createTestSpec({ name: 'app-2' }))

      const apps = service.listApps()
      expect(apps).toHaveLength(2)
    })

    it('should filter by spaceId', async () => {
      await service.install(TEST_SPACE_ID, createTestSpec({ name: 'app-a' }))
      await service.install(TEST_SPACE_ID_2, createTestSpec({ name: 'app-b' }))

      const apps = service.listApps({ spaceId: TEST_SPACE_ID })
      expect(apps).toHaveLength(1)
      expect(apps[0].spaceId).toBe(TEST_SPACE_ID)
    })

    it('should filter by status', async () => {
      const id1 = await service.install(TEST_SPACE_ID, createTestSpec({ name: 'app-1' }))
      await service.install(TEST_SPACE_ID, createTestSpec({ name: 'app-2' }))
      service.pause(id1)

      const paused = service.listApps({ status: 'paused' })
      expect(paused).toHaveLength(1)
      expect(paused[0].id).toBe(id1)

      const active = service.listApps({ status: 'active' })
      expect(active).toHaveLength(1)
    })

    it('should filter by type', async () => {
      await service.install(
        TEST_SPACE_ID,
        createTestSpec({ name: 'auto-app', type: 'automation', system_prompt: 'test' })
      )
      await service.install(
        TEST_SPACE_ID,
        createTestSpec({ name: 'skill-app', type: 'skill', system_prompt: 'test' })
      )

      const automations = service.listApps({ type: 'automation' })
      expect(automations).toHaveLength(1)
      expect(automations[0].spec.type).toBe('automation')

      const skills = service.listApps({ type: 'skill' })
      expect(skills).toHaveLength(1)
      expect(skills[0].spec.type).toBe('skill')
    })

    it('should combine filters', async () => {
      const id1 = await service.install(
        TEST_SPACE_ID,
        createTestSpec({ name: 'app-1', type: 'automation', system_prompt: 'test' })
      )
      await service.install(
        TEST_SPACE_ID,
        createTestSpec({ name: 'app-2', type: 'skill', system_prompt: 'test' })
      )
      await service.install(
        TEST_SPACE_ID_2,
        createTestSpec({ name: 'app-3', type: 'automation', system_prompt: 'test' })
      )
      service.pause(id1)

      const result = service.listApps({
        spaceId: TEST_SPACE_ID,
        status: 'paused',
        type: 'automation',
      })
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe(id1)
    })

    it('should sort by installedAt descending', async () => {
      const id1 = await service.install(TEST_SPACE_ID, createTestSpec({ name: 'app-first' }))
      // Small delay to ensure different timestamps
      await new Promise(resolve => setTimeout(resolve, 10))
      const id2 = await service.install(TEST_SPACE_ID, createTestSpec({ name: 'app-second' }))

      const apps = service.listApps()
      // Most recent first
      expect(apps[0].id).toBe(id2)
      expect(apps[1].id).toBe(id1)
    })
  })

  // ===========================================================================
  // Permissions
  // ===========================================================================

  describe('permissions', () => {
    it('should grant a permission', async () => {
      const appId = await service.install(TEST_SPACE_ID, createTestSpec())

      service.grantPermission(appId, 'filesystem:read')

      const app = service.getApp(appId)!
      expect(app.permissions.granted).toContain('filesystem:read')
    })

    it('should not duplicate granted permissions', async () => {
      const appId = await service.install(TEST_SPACE_ID, createTestSpec())

      service.grantPermission(appId, 'filesystem:read')
      service.grantPermission(appId, 'filesystem:read')

      const app = service.getApp(appId)!
      expect(app.permissions.granted.filter(p => p === 'filesystem:read')).toHaveLength(1)
    })

    it('should revoke a permission', async () => {
      const appId = await service.install(TEST_SPACE_ID, createTestSpec())

      service.grantPermission(appId, 'filesystem:read')
      service.revokePermission(appId, 'filesystem:read')

      const app = service.getApp(appId)!
      expect(app.permissions.granted).not.toContain('filesystem:read')
      expect(app.permissions.denied).toContain('filesystem:read')
    })

    it('should move permission from denied to granted', async () => {
      const appId = await service.install(TEST_SPACE_ID, createTestSpec())

      service.revokePermission(appId, 'filesystem:read')
      expect(service.getApp(appId)!.permissions.denied).toContain('filesystem:read')

      service.grantPermission(appId, 'filesystem:read')
      const app = service.getApp(appId)!
      expect(app.permissions.granted).toContain('filesystem:read')
      expect(app.permissions.denied).not.toContain('filesystem:read')
    })
  })

  // ===========================================================================
  // File System
  // ===========================================================================

  describe('getAppWorkDir', () => {
    it('should return the work directory path', async () => {
      const appId = await service.install(TEST_SPACE_ID, createTestSpec())
      const workDir = service.getAppWorkDir(appId)

      expect(workDir).toBe(join(spacePaths[TEST_SPACE_ID], '.halo', 'apps', appId))
      expect(existsSync(workDir)).toBe(true)
    })

    it('should auto-create work directory if missing', async () => {
      const appId = await service.install(TEST_SPACE_ID, createTestSpec())
      const workDir = join(spacePaths[TEST_SPACE_ID], '.halo', 'apps', appId)

      // Remove the directory
      const { rmSync } = require('fs')
      rmSync(workDir, { recursive: true, force: true })
      expect(existsSync(workDir)).toBe(false)

      // getAppWorkDir should recreate it
      const result = service.getAppWorkDir(appId)
      expect(existsSync(result)).toBe(true)
      expect(existsSync(join(result, 'memory'))).toBe(true)
    })

    it('should throw AppNotFoundError for non-existent App', () => {
      expect(() => service.getAppWorkDir('non-existent')).toThrow(AppNotFoundError)
    })
  })

  // ===========================================================================
  // clearAppMemory
  // ===========================================================================

  describe('clearAppMemory', () => {
    it('should delete memory.md and return file count', async () => {
      const { writeFileSync, mkdirSync } = require('fs')
      const appId = await service.install(TEST_SPACE_ID, createTestSpec())
      const workDir = service.getAppWorkDir(appId)

      // Create memory.md
      writeFileSync(join(workDir, 'memory.md'), '# now\n## State\n- runs: 5\n')

      const removed = service.clearAppMemory(appId)

      expect(removed).toBe(1)
      expect(existsSync(join(workDir, 'memory.md'))).toBe(false)
    })

    it('should delete run files under memory/ and runs/ and return total count', async () => {
      const { writeFileSync, mkdirSync } = require('fs')
      const appId = await service.install(TEST_SPACE_ID, createTestSpec())
      const workDir = service.getAppWorkDir(appId)
      const runDir = join(workDir, 'memory', 'run')
      const runsDir = join(workDir, 'runs')

      mkdirSync(runDir, { recursive: true })
      mkdirSync(runsDir, { recursive: true })
      writeFileSync(join(workDir, 'memory.md'), '# now\n')
      writeFileSync(join(runDir, '2026-01-01-0000-run.md'), 'run summary 1')
      writeFileSync(join(runDir, '2026-01-02-0000-run.md'), 'run summary 2')
      writeFileSync(join(runsDir, 'run-1.json'), '{}')
      writeFileSync(join(runsDir, 'run-2.json'), '{}')

      const removed = service.clearAppMemory(appId)

      expect(removed).toBe(5) // memory.md + 2 memory/run files + 2 runs/ files
      expect(existsSync(join(workDir, 'memory.md'))).toBe(false)
      expect(existsSync(join(workDir, 'memory'))).toBe(true) // dir preserved
      expect(existsSync(join(workDir, 'runs'))).toBe(true)   // dir preserved
    })

    it('should return 0 when no memory files exist', async () => {
      const appId = await service.install(TEST_SPACE_ID, createTestSpec())
      const removed = service.clearAppMemory(appId)
      expect(removed).toBe(0)
    })

    it('should throw AppNotFoundError for non-existent App', () => {
      expect(() => service.clearAppMemory('non-existent')).toThrow(AppNotFoundError)
    })
  })

  describe('onAppStatusChange', () => {
    it('should notify handler on status change', async () => {
      const handler = vi.fn()
      service.onAppStatusChange(handler)

      const appId = await service.install(TEST_SPACE_ID, createTestSpec())
      service.pause(appId)

      expect(handler).toHaveBeenCalledTimes(1)
      expect(handler).toHaveBeenCalledWith(appId, 'active', 'paused')
    })

    it('should notify multiple handlers', async () => {
      const handler1 = vi.fn()
      const handler2 = vi.fn()
      service.onAppStatusChange(handler1)
      service.onAppStatusChange(handler2)

      const appId = await service.install(TEST_SPACE_ID, createTestSpec())
      service.pause(appId)

      expect(handler1).toHaveBeenCalledTimes(1)
      expect(handler2).toHaveBeenCalledTimes(1)
    })

    it('should return an unsubscribe function', async () => {
      const handler = vi.fn()
      const unsubscribe = service.onAppStatusChange(handler)

      const appId = await service.install(TEST_SPACE_ID, createTestSpec())
      service.pause(appId)
      expect(handler).toHaveBeenCalledTimes(1)

      // Unsubscribe
      unsubscribe()

      service.resume(appId)
      // Should not have been called again
      expect(handler).toHaveBeenCalledTimes(1)
    })

    it('should not throw when handler errors', async () => {
      const errorHandler = vi.fn(() => {
        throw new Error('Handler error')
      })
      const goodHandler = vi.fn()

      service.onAppStatusChange(errorHandler)
      service.onAppStatusChange(goodHandler)

      const appId = await service.install(TEST_SPACE_ID, createTestSpec())

      // Should not throw
      expect(() => service.pause(appId)).not.toThrow()

      // Both handlers were called
      expect(errorHandler).toHaveBeenCalledTimes(1)
      expect(goodHandler).toHaveBeenCalledTimes(1)
    })

    it('should not notify on same-status updateStatus', async () => {
      const handler = vi.fn()
      service.onAppStatusChange(handler)

      const appId = await service.install(TEST_SPACE_ID, createTestSpec())
      // active -> active is a no-op for notifications
      service.updateStatus(appId, 'active')

      expect(handler).not.toHaveBeenCalled()
    })
  })

  // ===========================================================================
  // Move to Space
  // ===========================================================================

  describe('moveToSpace', () => {
    it('should update spaceId from one space to another', async () => {
      const spec  = createTestSpec({ name: 'movable-app', type: 'skill' })
      const appId = await service.install(TEST_SPACE_ID, spec)

      expect(service.getApp(appId)!.spaceId).toBe(TEST_SPACE_ID)

      await service.moveToSpace(appId, TEST_SPACE_ID_2)

      expect(service.getApp(appId)!.spaceId).toBe(TEST_SPACE_ID_2)
    })

    it('should update spaceId from a space to global (null)', async () => {
      const spec  = createTestSpec({ name: 'space-to-global', type: 'skill' })
      const appId = await service.install(TEST_SPACE_ID, spec)

      await service.moveToSpace(appId, null)

      expect(service.getApp(appId)!.spaceId).toBeNull()
    })

    it('should update spaceId from global to a space', async () => {
      const spec  = createTestSpec({ name: 'global-to-space', type: 'skill' })
      const appId = await service.install(null, spec)

      expect(service.getApp(appId)!.spaceId).toBeNull()

      await service.moveToSpace(appId, TEST_SPACE_ID)

      expect(service.getApp(appId)!.spaceId).toBe(TEST_SPACE_ID)
    })

    it('should be a no-op when moving to the current scope', async () => {
      const spec  = createTestSpec({ name: 'noop-move', type: 'skill' })
      const appId = await service.install(TEST_SPACE_ID, spec)

      // Should not throw and should leave spaceId unchanged
      await service.moveToSpace(appId, TEST_SPACE_ID)

      expect(service.getApp(appId)!.spaceId).toBe(TEST_SPACE_ID)
    })

    it('should throw AppNotFoundError for non-existent app', async () => {
      await expect(
        service.moveToSpace('non-existent-id', TEST_SPACE_ID)
      ).rejects.toThrow(AppNotFoundError)
    })

    it('should throw SpaceNotFoundError for unknown target space', async () => {
      const spec  = createTestSpec({ name: 'bad-target-space', type: 'skill' })
      const appId = await service.install(TEST_SPACE_ID, spec)

      await expect(
        service.moveToSpace(appId, 'non-existent-space')
      ).rejects.toThrow(SpaceNotFoundError)
    })

    it('should throw AppAlreadyInstalledError when same specId exists in target scope', async () => {
      const spec   = createTestSpec({ name: 'conflict-app', type: 'skill' })
      const appId1 = await service.install(TEST_SPACE_ID, spec)
      // Install the same spec in the target space
      await service.install(TEST_SPACE_ID_2, spec)

      await expect(
        service.moveToSpace(appId1, TEST_SPACE_ID_2)
      ).rejects.toThrow(AppAlreadyInstalledError)

      // Original spaceId must be unchanged
      expect(service.getApp(appId1)!.spaceId).toBe(TEST_SPACE_ID)
    })

    it('should throw for uninstalled apps', async () => {
      const spec  = createTestSpec({ name: 'uninstalled-move', type: 'skill' })
      const appId = await service.install(TEST_SPACE_ID, spec)
      await service.uninstall(appId)

      await expect(
        service.moveToSpace(appId, TEST_SPACE_ID_2)
      ).rejects.toThrow(InvalidStatusTransitionError)
    })

    it('should preserve app status and other fields after move', async () => {
      const spec  = createTestSpec({ name: 'preserve-fields', type: 'skill' })
      const appId = await service.install(TEST_SPACE_ID, spec, { key: 'value' })
      service.pause(appId)

      await service.moveToSpace(appId, TEST_SPACE_ID_2)

      const app = service.getApp(appId)!
      expect(app.status).toBe('paused')
      expect(app.userConfig).toEqual({ key: 'value' })
      expect(app.spaceId).toBe(TEST_SPACE_ID_2)
    })
  })

  // ===========================================================================
  // Error Types
  // ===========================================================================

  describe('error types', () => {
    it('AppNotFoundError should contain appId', () => {
      const error = new AppNotFoundError('test-id')
      expect(error.name).toBe('AppNotFoundError')
      expect(error.appId).toBe('test-id')
      expect(error.message).toContain('test-id')
    })

    it('InvalidStatusTransitionError should contain transition details', () => {
      const error = new InvalidStatusTransitionError('test-id', 'paused', 'error')
      expect(error.name).toBe('InvalidStatusTransitionError')
      expect(error.appId).toBe('test-id')
      expect(error.fromStatus).toBe('paused')
      expect(error.toStatus).toBe('error')
      expect(error.message).toContain('paused')
      expect(error.message).toContain('error')
    })

    it('AppAlreadyInstalledError should contain spec and space', () => {
      const error = new AppAlreadyInstalledError('my-app', 'space-1')
      expect(error.name).toBe('AppAlreadyInstalledError')
      expect(error.specId).toBe('my-app')
      expect(error.spaceId).toBe('space-1')
    })

    it('SpaceNotFoundError should contain spaceId', () => {
      const error = new SpaceNotFoundError('space-x')
      expect(error.name).toBe('SpaceNotFoundError')
      expect(error.spaceId).toBe('space-x')
    })
  })

  // ===========================================================================
  // Store -- Direct Tests
  // ===========================================================================

  describe('AppManagerStore', () => {
    it('should handle getById for non-existent ID', () => {
      expect(store.getById('non-existent')).toBeNull()
    })

    it('should handle getBySpecAndSpace for non-existent combination', () => {
      expect(store.getBySpecAndSpace('spec', 'space')).toBeNull()
    })

    it('should return false when deleting non-existent ID', () => {
      expect(store.delete('non-existent')).toBe(false)
    })

    it('should return empty array from list when no records exist', () => {
      expect(store.list()).toEqual([])
    })
  })

  // ===========================================================================
  // Migrations
  // ===========================================================================

  describe('migrations', () => {
    it('should create the installed_apps table', () => {
      const db = dbManager.getAppDatabase()
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='installed_apps'")
        .all() as Array<{ name: string }>
      expect(tables).toHaveLength(1)
    })

    it('should create indexes', () => {
      const db = dbManager.getAppDatabase()
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_installed_apps%'")
        .all() as Array<{ name: string }>
      const indexNames = indexes.map(i => i.name)
      expect(indexNames).toContain('idx_installed_apps_space')
      expect(indexNames).toContain('idx_installed_apps_status')
    })

    it('should enforce UNIQUE(spec_id, space_id) constraint', () => {
      const db = dbManager.getAppDatabase()
      const now = Date.now()

      db.prepare(`
        INSERT INTO installed_apps (id, spec_id, space_id, spec_json, status, installed_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('id-1', 'spec-1', 'space-1', '{}', 'active', now)

      expect(() =>
        db.prepare(`
          INSERT INTO installed_apps (id, spec_id, space_id, spec_json, status, installed_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run('id-2', 'spec-1', 'space-1', '{}', 'active', now)
      ).toThrow()
    })

    it('should allow same spec_id in different spaces', () => {
      const db = dbManager.getAppDatabase()
      const now = Date.now()

      db.prepare(`
        INSERT INTO installed_apps (id, spec_id, space_id, spec_json, status, installed_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('id-a', 'spec-1', 'space-1', '{}', 'active', now)

      expect(() =>
        db.prepare(`
          INSERT INTO installed_apps (id, spec_id, space_id, spec_json, status, installed_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run('id-b', 'spec-1', 'space-2', '{}', 'active', now)
      ).not.toThrow()
    })

    it('should be idempotent (running migrations twice)', () => {
      const newManager = createDatabaseManager(':memory:')
      const db = newManager.getAppDatabase()

      newManager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
      newManager.runMigrations(db, MIGRATION_NAMESPACE, migrations) // Should not throw

      newManager.closeAll()
    })

    it('migration v4 backfills upgrade_strategy=auto for existing rows', () => {
      const newManager = createDatabaseManager(':memory:')
      const db = newManager.getAppDatabase()

      // Only run migrations 1..3 to simulate pre-v4 state
      newManager.runMigrations(db, MIGRATION_NAMESPACE, migrations.slice(0, 3))
      const now = Date.now()
      db.prepare(`
        INSERT INTO installed_apps (id, spec_id, space_id, spec_json, status, installed_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('legacy-app', 'legacy-spec', null, '{}', 'active', now)

      // Now run all migrations (incl. v4) — should backfill
      newManager.runMigrations(db, MIGRATION_NAMESPACE, migrations)

      const row = db.prepare(`SELECT upgrade_strategy FROM installed_apps WHERE id = ?`).get('legacy-app') as { upgrade_strategy: string }
      expect(row.upgrade_strategy).toBe('auto')

      newManager.closeAll()
    })
  })

  // ===========================================================================
  // Upgrade Strategy
  // ===========================================================================

  describe('setUpgradeStrategy', () => {
    it('defaults to auto on install', async () => {
      const appId = await service.install(TEST_SPACE_ID, createTestSpec({ name: 'upg-default' }))
      const app = service.getApp(appId)!
      expect(app.upgradeStrategy).toBe('auto')
    })

    it('persists every valid strategy value', async () => {
      const appId = await service.install(TEST_SPACE_ID, createTestSpec({ name: 'upg-roundtrip' }))
      for (const strategy of ['notify', 'manual', 'auto'] as const) {
        service.setUpgradeStrategy(appId, strategy)
        expect(service.getApp(appId)!.upgradeStrategy).toBe(strategy)
      }
    })

    it('rejects unknown strategy values', async () => {
      const appId = await service.install(TEST_SPACE_ID, createTestSpec({ name: 'upg-bad' }))
      expect(() => service.setUpgradeStrategy(appId, 'turbo' as never)).toThrow()
    })

    it('throws AppNotFoundError when target app does not exist', () => {
      expect(() => service.setUpgradeStrategy('missing', 'auto')).toThrow(AppNotFoundError)
    })
  })
})
