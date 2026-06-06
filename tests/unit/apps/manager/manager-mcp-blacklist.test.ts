/**
 * AppManager — MCP command blacklist enforcement
 *
 * The manager is the install-time choke point for the
 * `security.mcpCommandBlacklist` policy. These tests verify that:
 *
 *   1. Open-source builds (no blacklist) install MCP servers normally.
 *   2. install() throws McpCommandBlockedError when the command matches.
 *   3. updateSpec() throws too, so the PATCH path cannot smuggle a
 *      blocked command in after the initial install.
 *   4. Non-MCP specs are never checked (defense-in-depth doesn't bleed
 *      into automation / skill / extension installs).
 *
 * The auth-loader is mocked so each test controls the blacklist without
 * touching the on-disk product.json.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync } from 'fs'
import { join } from 'path'

vi.mock('../../../../src/main/foundation/product-config', () => ({
  loadProductConfig: vi.fn(() => ({ name: 'test', version: '0.0.0', authProviders: [] })),
}))

import { loadProductConfig } from '../../../../src/main/foundation/product-config'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import { AppManagerStore } from '../../../../src/main/apps/manager/store'
import { createAppManagerService } from '../../../../src/main/apps/manager/service'
import type { AppManagerDeps } from '../../../../src/main/apps/manager/service'
import { MIGRATION_NAMESPACE, migrations } from '../../../../src/main/apps/manager/migrations'
import type { AppManagerService } from '../../../../src/main/apps/manager/types'
import { McpCommandBlockedError } from '../../../../src/main/apps/manager/errors'
import type { AppSpec } from '../../../../src/main/apps/spec/schema'

type MockedLoader = ReturnType<typeof vi.fn>

function setBlacklist(blacklist?: string[]): void {
  ;(loadProductConfig as unknown as MockedLoader).mockReturnValue({
    name: 'test',
    version: '0.0.0',
    authProviders: [],
    ...(blacklist !== undefined ? { security: { mcpCommandBlacklist: blacklist } } : {}),
  })
}

function makeMcpSpec(command: string, overrides?: Partial<AppSpec>): AppSpec {
  return {
    spec_version: '1',
    name: `mcp-${command.replace(/[^a-z0-9]/gi, '-')}-${Math.random().toString(36).slice(2, 8)}`,
    version: '1.0.0',
    author: 'Test Author',
    description: 'test mcp',
    type: 'mcp',
    mcp_server: { type: 'stdio', command, args: [] },
    ...overrides,
  } as unknown as AppSpec
}

const TEST_SPACE_ID = 'space-blacklist'

describe('AppManager — MCP command blacklist', () => {
  let dbManager: DatabaseManager
  let service: AppManagerService
  let spacePath: string

  beforeEach(() => {
    vi.clearAllMocks()
    // Default: no blacklist (open-source build behavior).
    setBlacklist(undefined)

    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
    const store = new AppManagerStore(db)

    const testDir = globalThis.__HALO_TEST_DIR__
    spacePath = join(testDir, 'spaces', TEST_SPACE_ID)
    const globalDir = join(testDir, 'global-blacklist')
    mkdirSync(spacePath, { recursive: true })
    mkdirSync(globalDir, { recursive: true })

    const deps: AppManagerDeps = {
      store,
      getSpacePath: (id: string) => (id === TEST_SPACE_ID ? spacePath : null),
      getAppDataPath: (id: string) => (id === TEST_SPACE_ID ? spacePath : null),
      getGlobalAppDir: () => globalDir,
    }
    service = createAppManagerService(deps)
  })

  afterEach(() => {
    dbManager.closeAll()
  })

  // ---------------------------------------------------------------------------
  // Open-source default
  // ---------------------------------------------------------------------------

  describe('open-source default (no blacklist)', () => {
    it('installs any stdio MCP command when the blacklist is unset', async () => {
      setBlacklist(undefined)
      const appId = await service.install(TEST_SPACE_ID, makeMcpSpec('echo'))
      expect(service.getApp(appId)).not.toBeNull()
    })

    it('treats an empty blacklist the same as omitted (no enforcement)', async () => {
      setBlacklist([])
      const appId = await service.install(TEST_SPACE_ID, makeMcpSpec('rm'))
      expect(service.getApp(appId)).not.toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // Install enforcement
  // ---------------------------------------------------------------------------

  describe('install() enforcement', () => {
    it('throws McpCommandBlockedError when the command basename matches', async () => {
      setBlacklist(['rm', 'sudo'])
      await expect(
        service.install(TEST_SPACE_ID, makeMcpSpec('rm')),
      ).rejects.toBeInstanceOf(McpCommandBlockedError)
    })

    it('strips POSIX path prefix before matching', async () => {
      setBlacklist(['rm'])
      await expect(
        service.install(TEST_SPACE_ID, makeMcpSpec('/usr/bin/rm')),
      ).rejects.toBeInstanceOf(McpCommandBlockedError)
    })

    it('strips .exe suffix and is case-insensitive', async () => {
      setBlacklist(['cmd'])
      await expect(
        service.install(TEST_SPACE_ID, makeMcpSpec('C:\\Windows\\System32\\CMD.EXE')),
      ).rejects.toBeInstanceOf(McpCommandBlockedError)
    })

    it('preserves the offending command on the thrown error for logging', async () => {
      setBlacklist(['powershell'])
      let caught: unknown = null
      try {
        await service.install(TEST_SPACE_ID, makeMcpSpec('powershell.exe'))
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(McpCommandBlockedError)
      expect((caught as McpCommandBlockedError).command).toBe('powershell.exe')
    })

    it('does not insert a DB row when the install is blocked', async () => {
      setBlacklist(['rm'])
      const spec = makeMcpSpec('rm', { name: 'blocked-rm-app' })
      await expect(service.install(TEST_SPACE_ID, spec)).rejects.toBeInstanceOf(McpCommandBlockedError)
      // No row inserted — the spec name must remain free for a later allowed install.
      expect(service.listApps()).toEqual([])
    })

    it('allows commands not in the blacklist', async () => {
      setBlacklist(['rm', 'sudo'])
      const appId = await service.install(TEST_SPACE_ID, makeMcpSpec('echo'))
      expect(service.getApp(appId)).not.toBeNull()
    })

    it('does not check non-MCP specs', async () => {
      setBlacklist(['rm'])
      const automation = {
        spec_version: '1',
        name: 'auto-with-rm-name',
        version: '1.0.0',
        author: 'Test Author',
        description: 'a',
        type: 'automation',
        system_prompt: 'rm -rf nothing',
      } as unknown as AppSpec
      const appId = await service.install(TEST_SPACE_ID, automation)
      expect(service.getApp(appId)).not.toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // updateSpec enforcement (PATCH guard)
  // ---------------------------------------------------------------------------

  describe('updateSpec() enforcement', () => {
    it('throws McpCommandBlockedError when a patch changes command to a blocked value', async () => {
      // Install with an allowed command first (policy is empty during install).
      setBlacklist(undefined)
      const appId = await service.install(TEST_SPACE_ID, makeMcpSpec('echo'))

      // Now tighten the policy and try to swap in a blocked command.
      setBlacklist(['rm'])
      expect(() =>
        service.updateSpec(appId, { mcp_server: { type: 'stdio', command: 'rm', args: [] } }),
      ).toThrow(McpCommandBlockedError)
    })

    it('still permits unrelated patches when the existing command is allowed', async () => {
      setBlacklist(['rm'])
      const appId = await service.install(TEST_SPACE_ID, makeMcpSpec('echo'))
      // Patch only changes description — must not be blocked.
      expect(() => service.updateSpec(appId, { description: 'updated' })).not.toThrow()
      expect(service.getApp(appId)!.spec.description).toBe('updated')
    })
  })
})
