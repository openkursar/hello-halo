import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDatabaseManager, type DatabaseManager } from '../../../../src/main/platform/store'
import { AppManagerStore } from '../../../../src/main/apps/manager/store'
import { createAppManagerService, onMcpAppsChange } from '../../../../src/main/apps/manager/service'
import { migrations, MIGRATION_NAMESPACE } from '../../../../src/main/apps/manager/migrations'
import { McpCommandBlockedError } from '../../../../src/main/apps/manager/errors'
import type { AppManagerService, InstalledApp } from '../../../../src/main/apps/manager'
import { AppSpecValidationError, type McpSpec } from '../../../../src/main/apps/spec'
import type { McpAppChange } from '../../../../src/main/services/app-bridge'
import { loadProductConfig } from '../../../../src/main/foundation/product-config'

vi.mock('../../../../src/main/foundation/product-config', () => ({
  loadProductConfig: vi.fn(() => ({ name: 'test', version: '0.0.0', authProviders: [] })),
}))

const previous: McpSpec = {
  spec_version: '1', type: 'mcp', name: 'owned-connection', version: '2.0', author: 'Existing author',
  description: 'Keep this connection description', display_name: 'Existing display name',
  config_schema: [{ key: 'OLD_REQUIRED', type: 'text', label: 'Existing field', required: true }],
  store: { tags: ['fixture'], install_source: 'manual' },
  mcp_server: { transport: 'streamable-http', command: 'http://127.0.0.1:9/old', headers: { 'X-Fixture': 'old' } },
}
const incoming: McpSpec = {
  spec_version: '1', type: 'mcp', name: previous.name, version: '1.0', author: 'CLI import', description: 'Imported description',
  mcp_server: { transport: 'streamable-http', command: 'http://127.0.0.1:9/new', headers: { 'X-Fixture': 'new' } },
}
const configuration = { FIXTURE_VALUE: 'new', NUMBER_VALUE: 7, BOOLEAN_VALUE: false }

describe('explicit MCP connection imports', () => {
  let database: DatabaseManager
  let service: AppManagerService
  let events: Array<{ scope: string | null; change?: McpAppChange; observed?: InstalledApp | null }>
  let unsubscribe: () => void

  beforeEach(() => {
    vi.mocked(loadProductConfig).mockReturnValue({ name: 'test', version: '0.0.0', authProviders: [] } as never)
    database = createDatabaseManager(':memory:')
    const db = database.getAppDatabase()
    database.runMigrations(db, MIGRATION_NAMESPACE, migrations)
    const directory = join(globalThis.__HALO_TEST_DIR__, 'manager-fixture')
    mkdirSync(directory, { recursive: true })
    service = createAppManagerService({ store: new AppManagerStore(db), getSpacePath: () => directory, getAppDataPath: () => directory, getGlobalAppDir: () => directory })
    events = []
    unsubscribe = onMcpAppsChange((scope, change) => events.push({ scope, change, observed: change ? service.getApp(change.appId) : undefined }))
  })

  afterEach(() => { unsubscribe(); database.closeAll() })

  for (const status of ['active', 'paused', 'error'] as const) {
    it(`atomically replaces both values while retaining ${status} state, identity, metadata, permissions and related data`, async () => {
      const appId = await service.install(null, previous, { OLD_REQUIRED: 'old', FIXTURE_VALUE: 'old', REMOVED_VALUE: 'remove' })
      const scopedId = await service.install('other-space', previous, { FIXTURE_VALUE: 'scoped-control' })
      const unrelatedId = await service.install(null, { ...previous, name: 'unrelated' }, { FIXTURE_VALUE: 'unrelated-control' })
      service.grantPermission(appId, 'fixture-granted')
      service.revokePermission(appId, 'fixture-denied')
      service.updateOverrides(appId, { disabledTools: ['fixture-tool'], notificationLevel: 'all' })
      service.setUpgradeStrategy(appId, 'manual')
      service.addIgnoredVersion(appId, '3.0')
      service.updateLastRun(appId, 'useful')
      if (status === 'paused') service.pause(appId)
      else if (status === 'error') service.updateStatus(appId, status, { errorMessage: 'Existing failure', pendingEscalationId: 'fixture-pending' })
      const marker = join(service.getAppWorkDir(appId), 'retained.txt')
      writeFileSync(marker, 'Retain connection-associated files.\n')
      const db = database.getAppDatabase()
      db.prepare('UPDATE installed_apps SET author_spec_json = ? WHERE id = ?').run(JSON.stringify(previous), appId)
      db.exec('CREATE TABLE fixture_connection_reference (app_id TEXT REFERENCES installed_apps(id) ON DELETE CASCADE, value TEXT)')
      db.prepare('INSERT INTO fixture_connection_reference VALUES (?, ?)').run(appId, 'retained-reference')
      const oldRow = db.prepare('SELECT * FROM installed_apps WHERE id = ?').get(appId) as Record<string, unknown>
      const before = service.getApp(appId)!
      const controls = [service.getApp(scopedId), service.getApp(unrelatedId)]
      events.length = 0

      expect(await service.importMcpConnection(null, incoming, configuration)).toBe(appId)
      const expected = { ...before, spec: { ...before.spec, mcp_server: incoming.mcp_server }, userConfig: configuration }
      expect(service.getApp(appId)).toEqual(expected)
      expect(events).toEqual([{ scope: null, change: { appId, specId: previous.name, action: 'updated' }, observed: expected }])
      expect([service.getApp(scopedId), service.getApp(unrelatedId)]).toEqual(controls)
      const nextRow = db.prepare('SELECT * FROM installed_apps WHERE id = ?').get(appId) as Record<string, unknown>
      expect(nextRow).toEqual({ ...oldRow, spec_json: JSON.stringify(expected.spec), user_config_json: JSON.stringify(configuration) })
      expect(db.prepare('SELECT * FROM fixture_connection_reference').all()).toEqual([{ app_id: appId, value: 'retained-reference' }])
      expect(readFileSync(marker, 'utf8')).toBe('Retain connection-associated files.\n')
      await expect(service.install(null, incoming, {})).rejects.toThrow('already installed')
    })
  }

  it('rolls back a rejected SQLite write and emits no change event', async () => {
    const appId = await service.install(null, previous, { FIXTURE_VALUE: 'old' })
    const db = database.getAppDatabase()
    const before = db.prepare('SELECT * FROM installed_apps WHERE id = ?').get(appId)
    db.exec(`CREATE TABLE fixture_import_audit (value TEXT);
      CREATE TRIGGER reject_connection AFTER UPDATE OF user_config_json ON installed_apps BEGIN
        INSERT INTO fixture_import_audit VALUES ('uncommitted');
        SELECT RAISE(ABORT, 'fixture storage refusal');
      END`)
    events.length = 0
    await expect(service.importMcpConnection(null, incoming, configuration)).rejects.toThrow('fixture storage refusal')
    expect(db.prepare('SELECT * FROM installed_apps WHERE id = ?').get(appId)).toEqual(before)
    expect(db.prepare('SELECT * FROM fixture_import_audit').all()).toEqual([])
    expect(events).toEqual([])
  })

  it('rejects invalid definitions and blocked commands before any store update or event', async () => {
    const appId = await service.install(null, previous, { FIXTURE_VALUE: 'old' })
    const before = service.getApp(appId)
    events.length = 0
    await expect(service.importMcpConnection(null, { ...incoming, mcp_server: { transport: 'streamable-http', command: '' } }, configuration)).rejects.toBeInstanceOf(AppSpecValidationError)
    vi.mocked(loadProductConfig).mockReturnValue({ name: 'test', version: '0.0.0', authProviders: [], security: { mcpCommandBlacklist: ['blocked-fixture-command'] } } as never)
    await expect(service.importMcpConnection(null, { ...incoming, mcp_server: { transport: 'stdio', command: 'blocked-fixture-command' } }, configuration)).rejects.toBeInstanceOf(McpCommandBlockedError)
    expect(service.getApp(appId)).toEqual(before)
    expect(events).toEqual([])
  })

  it('rejects a non-MCP input and cross-type occupants, including uninstalled ones', async () => {
    const appId = await service.install(null, { spec_version: '1', name: previous.name, type: 'extension', version: '1.0', author: 'Fixture author', description: 'Retain this extension' })
    const before = service.getApp(appId)!
    events.length = 0
    await expect(service.importMcpConnection(null, before.spec as McpSpec, {})).rejects.toThrow('Only MCP connections')
    await expect(service.importMcpConnection(null, incoming, {})).rejects.toThrow('already installed')
    expect(service.getApp(appId)).toEqual(before)
    await service.uninstall(appId)
    const retired = service.getApp(appId)
    await expect(service.importMcpConnection(null, incoming, {})).rejects.toThrow('already installed')
    expect(service.getApp(appId)).toEqual(retired)
    expect(events).toEqual([])
  })
})
