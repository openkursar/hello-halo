import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createDatabaseManager, type DatabaseManager } from '../../../src/main/platform/store'
import { initAppManager, shutdownAppManager, type AppManagerService } from '../../../src/main/apps/manager'
import type { McpSpec } from '../../../src/main/apps/spec'

const { registerHandlers } = vi.hoisted(() => ({ registerHandlers: vi.fn() }))
vi.mock('../../../src/main/ipc/rpc', () => ({ registerRawRpcHandlers: registerHandlers }))

import { registerCliConfigHandlers } from '../../../src/main/ipc/cli-config'

type Action = { name: string; action: 'skip' | 'overwrite' }
type Result = { success: boolean; data: { results: Array<{ name: string; status: string; error?: string }> } }

const spec = (name: string): McpSpec => ({
  spec_version: '1', name, type: 'mcp', version: '1.0', author: 'Fixture author', description: 'Existing connection description',
  mcp_server: { transport: 'streamable-http', command: 'http://127.0.0.1:9/old', headers: { 'X-Fixture': 'old' } },
})
const incoming = { type: 'http', url: 'http://127.0.0.1:9/new', headers: { 'X-Fixture': 'new' }, env: { FIXTURE_VALUE: 'new' } }

describe('CLI MCP import through real files and App Manager', () => {
  let database: DatabaseManager
  let manager: AppManagerService
  let source: string
  let migrate: (actions: Action[]) => Promise<Result>

  beforeEach(async () => {
    vi.stubEnv('HALO_DATA_DIR', join(globalThis.__HALO_TEST_DIR__, '.halo'))
    database = createDatabaseManager(':memory:')
    manager = await initAppManager({ db: database })
    source = join(globalThis.__HALO_TEST_DIR__, '.claude.json')
    registerCliConfigHandlers()
    migrate = registerHandlers.mock.calls.at(-1)![1].cliConfigMigrateMcp
  })

  afterEach(async () => {
    await shutdownAppManager()
    database.closeAll()
    vi.unstubAllEnvs()
  })

  it('skips without writes, then overwrites the selected definition in place and preserves the source and controls', async () => {
    const target = await manager.install(null, spec('selected'), { FIXTURE_VALUE: 'old', REMOVED_VALUE: 'old-only' })
    const control = await manager.install(null, spec('control'), { FIXTURE_VALUE: 'control' })
    manager.pause(target)
    manager.grantPermission(target, 'fixture-granted')
    manager.revokePermission(target, 'fixture-denied')
    manager.updateOverrides(target, { disabledTools: ['fixture-tool'] })
    writeFileSync(source, JSON.stringify({ fixtureControl: 'unchanged', mcpServers: { selected: incoming, omitted: incoming } }))
    const bytes = readFileSync(source)
    const before = manager.getApp(target)!
    const controlBefore = manager.getApp(control)
    expect(await migrate([{ name: 'selected', action: 'skip' }, { name: 'omitted', action: 'skip' }])).toEqual({
      success: true, data: { results: [{ name: 'selected', status: 'skipped' }, { name: 'omitted', status: 'skipped' }] },
    })
    expect(manager.getApp(target)).toEqual(before)
    expect(await migrate([{ name: 'selected', action: 'overwrite' }, { name: 'omitted', action: 'skip' }])).toEqual({
      success: true, data: { results: [{ name: 'selected', status: 'merged' }, { name: 'omitted', status: 'skipped' }] },
    })
    expect(manager.getApp(target)).toEqual({ ...before,
      spec: { ...before.spec, mcp_server: { transport: 'streamable-http', command: incoming.url, headers: incoming.headers } },
      userConfig: incoming.env,
    })
    expect(manager.getApp(control)).toEqual(controlBefore)
    expect(manager.listApps({ type: 'mcp' })).toHaveLength(2)
    expect(readFileSync(source)).toEqual(bytes)
  })

  it('retains the ordinary first-install and previously-uninstalled MCP paths', async () => {
    const oldId = await manager.install(null, spec('retired'), { FIXTURE_VALUE: 'old' })
    await manager.uninstall(oldId)
    writeFileSync(source, JSON.stringify({ mcpServers: { new: incoming, retired: incoming } }))
    const bytes = readFileSync(source)
    const result = await migrate([{ name: 'new', action: 'overwrite' }, { name: 'retired', action: 'overwrite' }])
    expect(result).toEqual({ success: true, data: { results: [{ name: 'new', status: 'merged' }, { name: 'retired', status: 'merged' }] } })
    const apps = manager.listApps({ type: 'mcp' })
    expect(apps).toHaveLength(2)
    expect(apps.find(app => app.specId === 'retired')).toMatchObject({ id: oldId, status: 'active', userConfig: incoming.env })
    expect(apps.find(app => app.specId === 'new')).toMatchObject({ status: 'active', userConfig: incoming.env })
    expect(readFileSync(source)).toEqual(bytes)
  })

  it('reports an occupied name of another app type as an error without replacing it', async () => {
    const id = await manager.install(null, {
      spec_version: '1', name: 'occupied', type: 'skill', version: '1.0', description: 'An unrelated skill',
      skill_content: '---\nname: occupied\ndescription: An unrelated skill\n---\n\nKeep this instruction.\n',
    })
    const before = manager.getApp(id)
    writeFileSync(source, JSON.stringify({ mcpServers: { occupied: incoming } }))
    const bytes = readFileSync(source)
    const result = await migrate([{ name: 'occupied', action: 'overwrite' }])
    expect(result.success).toBe(true)
    expect(result.data.results).toEqual([{ name: 'occupied', status: 'error', error: expect.any(String) }])
    expect(manager.getApp(id)).toEqual(before)
    expect(manager.listApps({ type: 'mcp' })).toEqual([])
    expect(readFileSync(source)).toEqual(bytes)
  })

  it('reports storage rejection without changing either value or its source file', async () => {
    const id = await manager.install(null, spec('rejected'), { FIXTURE_VALUE: 'old' })
    const before = manager.getApp(id)
    writeFileSync(source, JSON.stringify({ mcpServers: { rejected: incoming } }))
    const bytes = readFileSync(source)
    database.getAppDatabase().exec(`CREATE TRIGGER reject_import BEFORE UPDATE OF user_config_json ON installed_apps
      BEGIN SELECT RAISE(ABORT, 'fixture storage refusal'); END`)
    const result = await migrate([{ name: 'rejected', action: 'overwrite' }])
    expect(result.data.results).toEqual([{ name: 'rejected', status: 'error', error: expect.stringContaining('fixture storage refusal') }])
    expect(manager.getApp(id)).toEqual(before)
    expect(readFileSync(source)).toEqual(bytes)
  })

  it('does not treat an unknown action as permission to overwrite', async () => {
    const id = await manager.install(null, spec('unknown-action'), { FIXTURE_VALUE: 'old' })
    const before = manager.getApp(id)
    writeFileSync(source, JSON.stringify({ mcpServers: { 'unknown-action': incoming } }))
    const result = await migrate([{ name: 'unknown-action', action: 'unexpected' as Action['action'] }])
    expect(result.data.results).toEqual([{ name: 'unknown-action', status: 'error', error: 'Unsupported MCP import action' }])
    expect(manager.getApp(id)).toEqual(before)
  })
})
