import { mkdirSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDatabaseManager, type DatabaseManager } from '../../../../src/main/platform/store'
import { AppManagerStore } from '../../../../src/main/apps/manager/store'
import { createAppManagerService, onMcpAppsChange } from '../../../../src/main/apps/manager/service'
import { migrations, MIGRATION_NAMESPACE } from '../../../../src/main/apps/manager/migrations'
import type { AppManagerService } from '../../../../src/main/apps/manager'
import type { McpSpec } from '../../../../src/main/apps/spec'
import type { McpAppChange } from '../../../../src/main/services/app-bridge'

const spec: McpSpec = {
  spec_version: '1', type: 'mcp', name: 'context-fixture', version: '1.0.0',
  author: 'Fixture', description: 'Search customer orders',
  mcp_server: { transport: 'stdio', command: 'node', args: ['fixture.mjs'] },
}

describe('MCP context preferences', () => {
  let database: DatabaseManager
  let service: AppManagerService
  let events: McpAppChange[]
  let unsubscribe: () => void
  let directory: string

  function open() {
    database = createDatabaseManager(join(directory, 'databases'))
    const db = database.getAppDatabase()
    database.runMigrations(db, MIGRATION_NAMESPACE, migrations)
    service = createAppManagerService({
      store: new AppManagerStore(db), getSpacePath: () => directory,
      getAppDataPath: () => directory, getGlobalAppDir: () => directory,
    })
  }

  beforeEach(() => {
    directory = join(globalThis.__HALO_TEST_DIR__, 'context-preferences')
    mkdirSync(directory, { recursive: true })
    open()
    events = []
    unsubscribe = onMcpAppsChange((_space, change) => { if (change) events.push(change) })
  })
  afterEach(() => { unsubscribe(); database.closeAll() })

  it('merges fields, clears with JSON null and emits only effective context changes', async () => {
    const appId = await service.install(null, spec, { API_KEY: 'fixture' })
    expect(service.getApp(appId)?.userOverrides).toEqual({})
    events.length = 0
    service.updateOverrides(appId, { mcpContext: { loading: 'deferred' } })
    expect(events).toEqual([])
    service.updateOverrides(appId, { mcpContext: { loading: 'eager', summary: '  查询客户订单  ' } })
    expect(events).toEqual([{ appId, specId: spec.name, action: 'context' }])
    service.updateOverrides(appId, { mcpContext: { summary: 'Look up orders' } })
    expect(service.getApp(appId)?.userOverrides.mcpContext).toEqual({ loading: 'eager', summary: 'Look up orders' })
    service.updateOverrides(appId, { mcpContext: { summary: null } } as never)
    expect(service.getApp(appId)?.userOverrides.mcpContext).toEqual({ loading: 'eager' })
    service.updateOverrides(appId, { mcpContext: { summary: ' \n\t ' } })
    expect(events).toHaveLength(3)
    service.updateOverrides(appId, { mcpContext: null } as never)
    expect(service.getApp(appId)?.userOverrides.mcpContext).toBeUndefined()
    expect(events).toHaveLength(4)
    expect(service.getApp(appId)?.userConfig).toEqual({ API_KEY: 'fixture' })
  })

  it('accepts 512 Unicode characters and rejects invalid patches without partial writes or events', async () => {
    const appId = await service.install(null, spec)
    const summary = '🧩'.repeat(512)
    service.updateOverrides(appId, { mcpContext: { summary } })
    expect(service.getApp(appId)?.userOverrides.mcpContext?.summary).toBe(summary)
    events.length = 0
    const before = service.getApp(appId)
    for (const mcpContext of [[], 'text', 1, new Date(), new Map(), { loading: true }, { loading: 'auto' }, { summary: false },
      { summary: '🧩'.repeat(513) }, { loading: 'eager', unknown: true }]) {
      expect(() => service.updateOverrides(appId, { mcpContext, notificationLevel: 'none' } as never)).toThrow()
      expect(service.getApp(appId)).toEqual(before)
    }
    expect(events).toEqual([])
  })

  it('rejects context preferences on other app types, including a clear request', async () => {
    const appId = await service.install('space', {
      spec_version: '1', type: 'automation', name: 'person', version: '1.0.0',
      author: 'Fixture', description: 'A fixture person', system_prompt: 'Do the requested work.',
    })
    for (const mcpContext of [null, { loading: 'deferred' }, {}]) {
      expect(() => service.updateOverrides(appId, { mcpContext } as never)).toThrow('MCP servers only')
    }
    expect(service.getApp(appId)?.userOverrides).toEqual({})
  })

  it('preserves preferences through database reopen, upgrade, scope change and reinstall', async () => {
    const appId = await service.install(null, spec, { API_KEY: 'fixture' })
    const mcpContext = { loading: 'eager' as const, summary: 'Find customer orders' }
    service.updateOverrides(appId, { mcpContext, disabledTools: ['remove_customer'] })
    database.closeAll()
    open()
    expect(service.getApp(appId)?.userOverrides.mcpContext).toEqual(mcpContext)
    service.upgradeSpec(appId, { ...spec, version: '1.1.0', description: 'Updated author description' })
    service.moveToSpace(appId, 'space')
    await service.uninstall(appId)
    service.reinstall(appId)
    const app = service.getApp(appId)!
    expect(app.userOverrides).toMatchObject({ mcpContext, disabledTools: ['remove_customer'] })
    expect(app.userConfig).toEqual({ API_KEY: 'fixture' })
    expect(app.spec).not.toHaveProperty('mcpContext')
  })

  it('keeps the stronger tool-change event when permissions and context change together', async () => {
    const appId = await service.install(null, spec)
    events.length = 0
    service.updateOverrides(appId, { mcpContext: { loading: 'eager' }, disabledTools: ['remove_customer'] })
    expect(events).toEqual([{ appId, specId: spec.name, action: 'tools' }])
  })

  it('does not publish a change if persistence rejects the new preference', async () => {
    const appId = await service.install(null, spec)
    events.length = 0
    database.getAppDatabase().exec(`CREATE TRIGGER reject_context BEFORE UPDATE OF user_overrides_json
      ON installed_apps BEGIN SELECT RAISE(ABORT, 'fixture write refusal'); END`)
    expect(() => service.updateOverrides(appId, { mcpContext: { loading: 'eager' } })).toThrow('fixture write refusal')
    expect(service.getApp(appId)?.userOverrides).toEqual({})
    expect(events).toEqual([])
  })
})
