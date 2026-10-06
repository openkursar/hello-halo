/**
 * Unit tests for apps/manager — MCP change event payloads
 *
 * The onMcpAppsChange event carries per-app change details (appId, specId,
 * action) so subscribers (session invalidation, connection probe / status
 * cache) can react per-server. These tests pin the payload contract across
 * the full MCP app lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import { AppManagerStore } from '../../../../src/main/apps/manager/store'
import { createAppManagerService, onMcpAppsChange } from '../../../../src/main/apps/manager/service'
import type { AppManagerDeps } from '../../../../src/main/apps/manager/service'
import { MIGRATION_NAMESPACE, migrations } from '../../../../src/main/apps/manager/migrations'
import type { AppManagerService } from '../../../../src/main/apps/manager/types'
import type { AppSpec } from '../../../../src/main/apps/spec/schema'
import type { McpAppChange } from '../../../../src/main/services/app-bridge'

const TEST_SPACE_ID = 'space-001'

function createMcpSpec(name = 'test-mcp'): AppSpec {
  return {
    spec_version: '1',
    name,
    version: '1.0.0',
    author: 'Test Author',
    description: 'A test MCP server',
    type: 'mcp',
    mcp_server: {
      transport: 'streamable-http',
      command: 'http://127.0.0.1:9/mcp'
    }
  } as unknown as AppSpec
}

describe('AppManager MCP change events', () => {
  let dbManager: DatabaseManager
  let service: AppManagerService
  let events: Array<{ spaceId: string | null; change?: McpAppChange }>
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

    events = []
    unsubscribe = onMcpAppsChange((spaceId, change) => events.push({ spaceId, change }))
  })

  afterEach(() => {
    unsubscribe()
    dbManager.closeAll()
    vi.clearAllMocks()
  })

  it('emits per-app details across the MCP lifecycle', async () => {
    const appId = await service.install(TEST_SPACE_ID, createMcpSpec())
    expect(events.at(-1)).toEqual({
      spaceId: TEST_SPACE_ID,
      change: { appId, specId: 'test-mcp', action: 'installed' }
    })

    service.pause(appId)
    expect(events.at(-1)?.change).toEqual({ appId, specId: 'test-mcp', action: 'paused' })

    service.resume(appId)
    expect(events.at(-1)?.change).toEqual({ appId, specId: 'test-mcp', action: 'resumed' })

    service.updateSpec(appId, { description: 'updated description' })
    expect(events.at(-1)?.change).toEqual({ appId, specId: 'test-mcp', action: 'updated' })

    await service.uninstall(appId)
    expect(events.at(-1)?.change).toEqual({ appId, specId: 'test-mcp', action: 'uninstalled' })

    service.reinstall(appId)
    expect(events.at(-1)?.change).toEqual({ appId, specId: 'test-mcp', action: 'reinstalled' })
  })

  it('tells sessions when a server\'s tools are turned on or off, and only then', async () => {
    const appId = await service.install(TEST_SPACE_ID, createMcpSpec())
    events.length = 0

    service.updateOverrides(appId, { disabledTools: ['drop_table', ' drop_table', 'run_sql'] })
    expect(service.getApp(appId)?.userOverrides.disabledTools).toEqual(['drop_table', 'run_sql'])
    expect(events).toEqual([{ spaceId: TEST_SPACE_ID, change: { appId, specId: 'test-mcp', action: 'tools' } }])

    service.updateOverrides(appId, { disabledTools: ['run_sql', 'drop_table'] })
    service.updateOverrides(appId, { notificationLevel: 'all' })
    expect(events).toHaveLength(1)

    service.updateOverrides(appId, { disabledTools: undefined })
    expect(service.getApp(appId)?.userOverrides.disabledTools).toBeUndefined()
    expect(events.at(-1)?.change).toEqual({ appId, specId: 'test-mcp', action: 'tools' })
  })

  it('refuses turned-off tools that are not a list of names, and on apps that are not MCP servers', async () => {
    const mcpId = await service.install(TEST_SPACE_ID, createMcpSpec())
    expect(() => service.updateOverrides(mcpId, { disabledTools: 'drop_table' as never })).toThrow('disabledTools must be a list of at most 1000 tool names')
    expect(() => service.updateOverrides(mcpId, { disabledTools: ['ok', ' '] })).toThrow('disabledTools must be a list')
    expect(() => service.updateOverrides(mcpId, { disabledTools: ['x'.repeat(257)] })).toThrow('disabledTools must be a list')
    expect(() => service.updateOverrides(mcpId, { disabledTools: Array.from({ length: 1001 }, (_, i) => `t${i}`) })).toThrow('disabledTools must be a list')

    const automationId = await service.install(TEST_SPACE_ID, {
      spec_version: '1', name: 'test-automation', version: '1.0.0', author: 'Test Author',
      description: 'Not an MCP app', type: 'automation', system_prompt: 'You are a test bot.',
    } as unknown as AppSpec)
    expect(() => service.updateOverrides(automationId, { disabledTools: ['x'] })).toThrow('disabledTools applies to MCP servers only')
  })

  it('does not emit MCP change events for non-MCP apps', async () => {
    const spec = {
      spec_version: '1',
      name: 'test-automation',
      version: '1.0.0',
      author: 'Test Author',
      description: 'Not an MCP app',
      type: 'automation',
      system_prompt: 'You are a test bot.'
    } as unknown as AppSpec

    const appId = await service.install(TEST_SPACE_ID, spec)
    service.pause(appId)
    service.resume(appId)

    expect(events).toEqual([])
  })
})
