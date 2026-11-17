import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { createDatabaseManager, type DatabaseManager } from '../../../../src/main/platform/store'
import { AppManagerStore } from '../../../../src/main/apps/manager/store'
import { createAppManagerService, type AppManagerDeps } from '../../../../src/main/apps/manager/service'
import { migrations } from '../../../../src/main/apps/manager/migrations'
import { prepareAppDataRelocation } from '../../../../src/main/apps/manager/data-relocation'
import type { AppManagerService, AppStatus } from '../../../../src/main/apps/manager/types'
import { AppAlreadyInstalledError, SpaceNotFoundError } from '../../../../src/main/apps/manager/errors'
import { ActivityStore } from '../../../../src/main/apps/runtime/store'
import { migrations as runtimeMigrations } from '../../../../src/main/apps/runtime/migrations'
import type { ExecutionEnvironment } from '../../../../src/shared/apps/app-types'
import type { AppSpec } from '../../../../src/main/apps/spec'

vi.mock('fs', async importOriginal => {
  const original = await importOriginal<typeof import('fs')>()
  return { ...original, statSync: vi.fn(original.statSync) }
})
vi.mock('fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('fs/promises')>()
  return { ...original, rename: vi.fn(original.rename), rmdir: vi.fn(original.rmdir) }
})
vi.mock('../../../../src/main/services/tlon', () => ({
  seedAppKnowledgeBases: vi.fn(),
  unbindAppFromAllKBs: vi.fn(),
}))
const real = await vi.importActual<typeof import('fs/promises')>('fs/promises')
const realSync = await vi.importActual<typeof import('fs')>('fs')

function spec(name = 'shared-person'): AppSpec {
  return { spec_version: '1', name, version: '1.0.0', author: 'Test author', description: 'Relocation fixture',
    type: 'automation', system_prompt: 'Retain my identity and all my records.',
    store: { slug: name, tags: [] } }
}

function put(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {}
  function walk(directory: string, prefix: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const key = join(prefix, entry.name)
      if (entry.isDirectory()) { result[key] = 'directory'; walk(join(directory, entry.name), key) }
      else result[key] = readFileSync(join(directory, entry.name)).toString('base64')
    }
  }
  if (existsSync(root)) walk(root, '')
  return result
}

describe('manager workspace relocation with runtime persistence', () => {
  let database: DatabaseManager
  let store: AppManagerStore
  let activity: ActivityStore
  let manager: AppManagerService
  let deps: AppManagerDeps
  let spaces: Record<string, string>
  let root: string
  let globalDir: string

  function appRoot(appId: string, spaceId: string): string {
    return join(spaces[spaceId], '.halo', 'apps', appId)
  }
  function journal(appId: string): string { return join(globalDir, 'app-relocations', appId) }
  function environment(appId: string, spaceId: string, automation = false): ExecutionEnvironment {
    return { spaceId, spacePath: spaces[spaceId], workDir: automation ? appRoot(appId, spaceId) : join(root, 'projects', spaceId),
      memoryDir: appRoot(appId, spaceId), mcpBindings: { crm: `crm-${spaceId}` } }
  }
  function relocatedEnvironment(appId: string, spaceId: string, automation = false): ExecutionEnvironment {
    return { ...environment(appId, spaceId, automation), pendingConnectionNotice: true }
  }
  function rows(table: string): unknown[] {
    return database.getAppDatabase().prepare(`SELECT * FROM ${table} ORDER BY 1`).all()
  }
  function seedHistory(appId: string, spaceId: string): void {
    const old = environment(appId, spaceId)
    for (const key of [`app-chat:${appId}:desktop`, `app-chat:${appId}:im`, `team-environment:${appId}:team`]) {
      activity.pinSessionEnvironment(key, appId, old)
    }
    for (const [index, status] of ['ok', 'waiting_user', 'error'].entries()) {
      activity.insertRun({ runId: `${appId}-run-${index}`, appId, sessionKey: `${appId}-run-session-${index}`,
        status: status as 'ok' | 'waiting_user' | 'error', triggerType: 'schedule', startedAt: 100 + index,
        environment: index === 2 ? undefined : environment(appId, spaceId, true) })
    }
    activity.insertEntry({ id: `${appId}-decision`, appId, runId: `${appId}-run-1`, type: 'escalation', ts: 200,
      sessionKey: `app-chat:${appId}:im`, content: { summary: 'Retain this unanswered decision' } })
  }
  function relocate(appId: string, targetSpaceId = 'target', fromSpaceId = 'origin'): Promise<{ fileCount: number }> {
    return manager.relocateAutomationData(appId, targetSpaceId, {
      sources: [{ path: appRoot(appId, fromSpaceId), spaceId: fromSpaceId }],
      commitEnvironments: () => activity.relocateAppEnvironments(appId,
        environment(appId, targetSpaceId), environment(appId, targetSpaceId, true)),
    })
  }

  beforeEach(() => {
    root = realpathSync(globalThis.__HALO_TEST_DIR__)
    spaces = Object.fromEntries(['origin', 'target', 'third', 'halo-temp'].map(id => [id, join(root, 'spaces', id)]))
    for (const directory of Object.values(spaces)) mkdirSync(directory, { recursive: true })
    globalDir = join(root, 'private')
    mkdirSync(globalDir)
    database = createDatabaseManager(':memory:')
    const db = database.getAppDatabase()
    database.runMigrations(db, 'app_manager', migrations)
    database.runMigrations(db, 'app_runtime', runtimeMigrations)
    store = new AppManagerStore(db)
    activity = new ActivityStore(db)
    deps = { store, getSpacePath: id => spaces[id] ?? null, getAppDataPath: id => spaces[id] ?? null, getGlobalAppDir: () => globalDir }
    manager = createAppManagerService(deps)
    vi.mocked(fs.rename).mockImplementation(real.rename)
    vi.mocked(fs.rmdir).mockImplementation(real.rmdir)
    vi.mocked(statSync).mockImplementation(realSync.statSync)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => { database.closeAll(); vi.restoreAllMocks() })

  it.each(['active', 'paused', 'waiting_user', 'error', 'needs_login', 'uninstalled'] as AppStatus[])(
    'preserves a %s person and all same-name target identities without touching project files', async status => {
      const appId = await manager.install('origin', spec(), { setting: 'retained', enabled: false })
      const occupant = await manager.install('target', spec(), { setting: 'target active' })
      const removed = await manager.install('third', spec(), { setting: 'target removed' })
      await manager.uninstall(removed)
      await relocate(removed, 'target', 'third')
      manager.updateOverrides(appId, { notificationLevel: 'none', tags: ['Retained'], memory: { enabled: false } })
      manager.grantPermission(appId, 'filesystem:read')
      manager.revokePermission(appId, 'shell')
      manager.setUpgradeStrategy(appId, 'manual')
      manager.addIgnoredVersion(appId, '2.0.0')
      manager.updateLastRun(appId, 'error', 'Retain last-run diagnosis')
      if (status !== 'active') manager.updateStatus(appId, status, { pendingEscalationId: 'original-decision', errorMessage: 'Retain state' })
      seedHistory(appId, 'origin')
      seedHistory(occupant, 'target')
      const before = rows('installed_apps') as Array<Record<string, unknown>>
      const entries = rows('activity_entries')
      const runs = rows('automation_runs') as Array<Record<string, unknown>>
      const sessions = rows('app_session_environments') as Array<Record<string, unknown>>
      const otherHistory = activity.listAppEnvironments(occupant)
      for (const [id, spaceId] of [[appId, 'origin'], [occupant, 'target'], [removed, 'target']]) {
        put(join(appRoot(id, spaceId), 'memory.md'), `${id} memory`)
        put(join(appRoot(id, spaceId), 'runs', 'history.jsonl'), `${id} history`)
      }
      put(join(root, 'projects', 'origin', 'source.ts'), 'origin project bytes')
      put(join(root, 'projects', 'target', 'source.ts'), 'target project bytes')
      put(join(spaces.origin, 'project.txt'), 'legacy project alongside .halo')
      const projects = snapshot(join(root, 'projects'))
      const changed = vi.fn(() => {
        expect(database.getAppDatabase().inTransaction).toBe(false)
        expect(activity.getSessionEnvironment(`app-chat:${appId}:im`)).toEqual(relocatedEnvironment(appId, 'target'))
      })
      manager.onAppAuthorityChanged(changed)

      const result = await relocate(appId)

      expect(result.fileCount).toBe(2)
      const expected = before.map(row => row.id === appId ? { ...row, space_id: 'target', data_path: null } : row)
      expect(rows('installed_apps')).toEqual(expected)
      expect(rows('activity_entries')).toEqual(entries)
      expect(rows('automation_runs')).toEqual(runs.map(row => row.app_id === appId
        ? { ...row, environment_json: JSON.stringify(relocatedEnvironment(appId, 'target', true)) } : row))
      expect(rows('app_session_environments')).toEqual(sessions.map(row => row.app_id === appId
        ? { ...row, environment_json: JSON.stringify(relocatedEnvironment(appId, 'target')) } : row))
      expect(activity.listAppEnvironments(occupant)).toEqual(otherHistory)
      for (const item of activity.listSessionEnvironments(appId)) expect(item.environment).toEqual(relocatedEnvironment(appId, 'target'))
      for (const run of activity.getRunsForApp(appId)) expect(run.environment).toEqual(relocatedEnvironment(appId, 'target', true))
      expect(manager.listApps({ spaceId: 'target' }).map(app => app.id).sort()).toEqual([appId, occupant, removed].sort())
      expect(readFileSync(join(appRoot(appId, 'target'), 'memory.md'), 'utf8')).toBe(`${appId} memory`)
      expect(readFileSync(join(appRoot(occupant, 'target'), 'memory.md'), 'utf8')).toBe(`${occupant} memory`)
      expect(readFileSync(join(appRoot(removed, 'target'), 'memory.md'), 'utf8')).toBe(`${removed} memory`)
      expect(existsSync(appRoot(appId, 'origin'))).toBe(false)
      expect(snapshot(join(root, 'projects'))).toEqual(projects)
      expect(readFileSync(join(spaces.origin, 'project.txt'), 'utf8')).toBe('legacy project alongside .halo')
      expect(store.listDataRelocations()).toEqual([])
      expect(existsSync(journal(appId))).toBe(false)
      expect(changed).toHaveBeenCalledTimes(1)
      expect(changed).toHaveBeenCalledWith(appId)
      await expect(manager.install('target', spec())).rejects.toThrow(AppAlreadyInstalledError)
    })

  it('repairs a split legacy layout into the current space without losing later conversations or collision files', async () => {
    const appId = await manager.install('target', spec())
    const legacy = appRoot(appId, 'origin')
    const intermediate = appRoot(appId, 'third')
    const target = appRoot(appId, 'target')
    put(join(legacy, 'memory.md'), 'original memory')
    put(join(legacy, 'runs', 'desktop.jsonl'), 'original desktop conversation')
    put(join(intermediate, 'runs', 'im.jsonl'), 'intermediate IM conversation')
    put(join(target, 'memory.md'), 'current memory')
    put(join(target, 'runs', 'new.jsonl'), 'latest conversation')
    seedHistory(appId, 'origin')
    database.getAppDatabase().prepare('UPDATE installed_apps SET data_path = ? WHERE id = ?').run(legacy, appId)
    const before = rows('installed_apps') as Array<Record<string, unknown>>

    await manager.relocateAutomationData(appId, 'target', {
      sources: [{ path: legacy, spaceId: 'origin' }, { path: intermediate, spaceId: 'third' }],
      commitEnvironments: () => activity.relocateAppEnvironments(appId, environment(appId, 'target'), environment(appId, 'target', true)),
    })

    expect(rows('installed_apps')).toEqual(before.map(row => ({ ...row, data_path: null })))
    expect(manager.listLegacyDataAppIds()).toEqual([])
    expect(manager.getAppWorkDir(appId)).toBe(target)
    expect(readFileSync(join(target, 'memory.md'), 'utf8')).toBe('current memory')
    expect(readFileSync(join(target, 'memory.md.from-origin'), 'utf8')).toBe('original memory')
    expect(readFileSync(join(target, 'runs', 'desktop.jsonl'), 'utf8')).toBe('original desktop conversation')
    expect(readFileSync(join(target, 'runs', 'im.jsonl'), 'utf8')).toBe('intermediate IM conversation')
    expect(readFileSync(join(target, 'runs', 'new.jsonl'), 'utf8')).toBe('latest conversation')
    expect(existsSync(legacy)).toBe(false)
    expect(existsSync(intermediate)).toBe(false)
    expect(activity.listAppEnvironments(appId).every(item => item.spaceId === 'target')).toBe(true)
    expect(store.listDataRelocations()).toEqual([])
  })

  it.each(['throw', 'promise'] as const)('rolls back both file trees and all SQLite writes when the runtime callback returns %s', async failure => {
    const appId = await manager.install('origin', spec())
    seedHistory(appId, 'origin')
    const source = appRoot(appId, 'origin')
    const target = appRoot(appId, 'target')
    put(join(source, 'memory.md'), 'old memory')
    put(join(source, 'runs', 'old.jsonl'), 'old history')
    put(join(target, 'memory.md'), 'new memory')
    put(join(target, 'runs', 'new.jsonl'), 'new history')
    database.getAppDatabase().prepare('UPDATE installed_apps SET data_path = ? WHERE id = ?').run(source, appId)
    const files = [snapshot(source), snapshot(target)]
    const tables = ['installed_apps', 'app_session_environments', 'automation_runs', 'activity_entries']
    const before = tables.map(rows)
    const changed = vi.fn()
    manager.onAppAuthorityChanged(changed)
    const callback = vi.fn(() => {
      expect(database.getAppDatabase().inTransaction).toBe(true)
      expect(store.getById(appId)?.spaceId).toBe('target')
      expect(readFileSync(join(target, 'runs', 'old.jsonl'), 'utf8')).toBe('old history')
      activity.relocateAppEnvironments(appId, environment(appId, 'target'), environment(appId, 'target', true))
      database.getAppDatabase().prepare('UPDATE installed_apps SET user_config_json = ? WHERE id = ?').run('{"should":"rollback"}', appId)
      if (failure === 'throw') throw new Error('Injected runtime transaction failure')
      return Promise.resolve('invalid async transaction')
    })

    await expect(manager.relocateAutomationData(appId, 'target', {
      sources: [{ path: source, spaceId: 'origin' }], commitEnvironments: callback,
    })).rejects.toThrow(failure === 'throw' ? 'Injected runtime transaction failure' : 'commit synchronously')

    expect(callback).toHaveBeenCalledTimes(1)
    expect(tables.map(rows)).toEqual(before)
    expect([snapshot(source), snapshot(target)]).toEqual(files)
    expect(store.listDataRelocations()).toEqual([])
    expect(existsSync(journal(appId))).toBe(false)
    expect(manager.getAppWorkDir(appId)).toBe(source)
    expect(changed).not.toHaveBeenCalled()
  })

  it('does not commit records if moving the files fails', async () => {
    const appId = await manager.install('origin', spec())
    put(join(appRoot(appId, 'origin'), 'memory.md'), 'memory')
    const before = rows('installed_apps')
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (String(from) === appRoot(appId, 'origin')) throw Object.assign(new Error('disk failed'), { code: 'EIO' })
      return real.rename(from, to)
    })
    const commit = vi.fn()
    await expect(manager.relocateAutomationData(appId, 'target', {
      sources: [{ path: appRoot(appId, 'origin'), spaceId: 'origin' }], commitEnvironments: commit,
    })).rejects.toThrow('disk failed')
    expect(rows('installed_apps')).toEqual(before)
    expect(readFileSync(join(appRoot(appId, 'origin'), 'memory.md'), 'utf8')).toBe('memory')
    expect(existsSync(appRoot(appId, 'target'))).toBe(false)
    expect(commit).not.toHaveBeenCalled()
  })

  it('keeps writers blocked after failed rollback and retries startup recovery idempotently', async () => {
    const appId = await manager.install('origin', spec())
    const source = appRoot(appId, 'origin')
    const target = appRoot(appId, 'target')
    put(join(source, 'memory.md'), 'must survive rollback')
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (String(from) === target && String(to) === source) throw Object.assign(new Error('rollback disk failed'), { code: 'EIO' })
      return real.rename(from, to)
    })
    await expect(manager.relocateAutomationData(appId, 'target', {
      sources: [{ path: source, spaceId: 'origin' }], commitEnvironments: () => { throw new Error('DB failure') },
    })).rejects.toBeInstanceOf(AggregateError)
    expect(store.getById(appId)?.spaceId).toBe('origin')
    expect(store.listDataRelocations()).toEqual([{ appId, journalPath: journal(appId), targetSpaceId: 'target', committed: false }])
    expect(() => manager.getAppWorkDir(appId)).toThrow('file recovery')
    expect(() => manager.assertAppDataAvailable(appId)).toThrow('file recovery')
    manager = createAppManagerService(deps)
    expect(() => manager.getAppWorkDir(appId)).toThrow('file recovery')
    expect(() => manager.assertAppDataAvailable(appId)).toThrow('file recovery')
    await expect(manager.recoverDataRelocations()).resolves.toEqual([appId])
    expect(() => manager.getAppWorkDir(appId)).toThrow('file recovery')
    expect(() => manager.assertAppDataAvailable(appId)).toThrow('file recovery')
    vi.mocked(fs.rename).mockImplementation(real.rename)
    await expect(manager.recoverDataRelocations()).resolves.toEqual([])
    const restored = snapshot(source)
    await expect(manager.recoverDataRelocations()).resolves.toEqual([])
    expect(snapshot(source)).toEqual(restored)
    expect(readFileSync(join(source, 'memory.md'), 'utf8')).toBe('must survive rollback')
    expect(() => manager.assertAppDataAvailable(appId)).not.toThrow()
    expect(manager.getAppWorkDir(appId)).toBe(source)
    expect(existsSync(target)).toBe(false)
    expect(store.listDataRelocations()).toEqual([])
  })

  it.each([false, true])('recovers a prior journal with committed=%s before a new move starts', async committed => {
    const appId = await manager.install('origin', spec())
    seedHistory(appId, 'origin')
    put(join(appRoot(appId, 'origin'), 'memory.md'), 'retained after restart')
    store.beginDataRelocation(appId, journal(appId), 'target')
    await prepareAppDataRelocation({ appId, target: appRoot(appId, 'target'),
      sources: [{ path: appRoot(appId, 'origin'), spaceId: 'origin' }], journalPath: journal(appId) })
    if (committed) store.commitDataRelocation(appId, 'target', () => activity.relocateAppEnvironments(appId,
      environment(appId, 'target'), environment(appId, 'target', true)))
    manager = createAppManagerService(deps)

    await relocate(appId, 'third', committed ? 'target' : 'origin')

    expect(store.getById(appId)?.spaceId).toBe('third')
    expect(readFileSync(join(appRoot(appId, 'third'), 'memory.md'), 'utf8')).toBe('retained after restart')
    expect(activity.listAppEnvironments(appId).every(item => item.spaceId === 'third')).toBe(true)
    expect(existsSync(appRoot(appId, 'origin'))).toBe(false)
    expect(existsSync(appRoot(appId, 'target'))).toBe(false)
    expect(store.listDataRelocations()).toEqual([])
  })

  it('retains a committed cleanup failure and recovers it without undoing files or records', async () => {
    const appId = await manager.install('origin', spec())
    seedHistory(appId, 'origin')
    put(join(appRoot(appId, 'origin'), 'memory.md'), 'committed memory')
    vi.mocked(fs.rmdir).mockImplementation(async path => {
      if (String(path) === journal(appId)) throw Object.assign(new Error('cleanup disk failed'), { code: 'EIO' })
      return real.rmdir(path)
    })
    await expect(relocate(appId)).resolves.toEqual({ fileCount: 1 })
    expect(store.listDataRelocations()[0]?.committed).toBe(true)
    expect(manager.getAppWorkDir(appId)).toBe(appRoot(appId, 'target'))
    manager = createAppManagerService(deps)
    const records = rows('installed_apps')
    const history = activity.listAppEnvironments(appId)
    const files = snapshot(appRoot(appId, 'target'))
    await expect(manager.recoverDataRelocations()).resolves.toEqual([appId])
    expect(rows('installed_apps')).toEqual(records)
    vi.mocked(fs.rmdir).mockImplementation(real.rmdir)
    await expect(manager.recoverDataRelocations()).resolves.toEqual([])
    await expect(manager.recoverDataRelocations()).resolves.toEqual([])
    expect(rows('installed_apps')).toEqual(records)
    expect(activity.listAppEnvironments(appId)).toEqual(history)
    expect(snapshot(appRoot(appId, 'target'))).toEqual(files)
    expect(existsSync(appRoot(appId, 'origin'))).toBe(false)
    expect(store.listDataRelocations()).toEqual([])
  })

  it.each(['active', 'uninstalled'] as const)('refuses workspace cleanup before relocating a %s digital human, preserving every resource', async status => {
    const person = await manager.install('origin', spec())
    const resource = await manager.install('origin', { spec_version: '1', name: 'resource', version: '1.0.0', author: 'Test author', description: 'Resource fixture', type: 'mcp', mcp_server: { transport: 'stdio', command: 'node', args: [] } })
    if (status === 'uninstalled') await manager.uninstall(person)
    const before = rows('installed_apps')
    const files = snapshot(spaces.origin)
    const removed = vi.fn()
    manager.onAppUninstalled(removed)
    await expect(manager.deleteAppsInSpace('origin')).rejects.toThrow('relocated before deleting')
    expect(rows('installed_apps')).toEqual(before)
    expect(snapshot(spaces.origin)).toEqual(files)
    expect(removed).not.toHaveBeenCalled()
    await relocate(person, 'halo-temp')
    await expect(manager.deleteAppsInSpace('origin')).resolves.toBe(1)
    expect(manager.getApp(resource)).toBeNull()
    expect(manager.getApp(person)?.spaceId).toBe('halo-temp')
  })

  it('restricts deletion and retention pruning while a relocation journal owns the installation', async () => {
    const appId = await manager.install('origin', spec())
    seedHistory(appId, 'origin')
    await manager.uninstall(appId)
    database.getAppDatabase().prepare('UPDATE installed_apps SET uninstalled_at = 1 WHERE id = ?').run(appId)
    store.beginDataRelocation(appId, journal(appId), 'target')
    const history = rows('automation_runs')
    expect(() => store.delete(appId)).toThrow('FOREIGN KEY constraint failed')
    expect(store.pruneUninstalledApps(1)).toBe(0)
    expect(store.getById(appId)).not.toBeNull()
    expect(rows('automation_runs')).toEqual(history)
    expect(store.listDataRelocations()).toHaveLength(1)
    store.finishDataRelocation(appId)
    expect(store.pruneUninstalledApps(1)).toBe(1)
    expect(rows('automation_runs')).toEqual([])
  })

  it('clears missing legacy storage but never treats an unreadable or non-directory path as missing', async () => {
    const appId = await manager.install('origin', spec())
    const legacy = join(root, 'legacy', 'app')
    database.getAppDatabase().prepare('UPDATE installed_apps SET data_path = ? WHERE id = ?').run(legacy, appId)
    expect(manager.listLegacyDataAppIds()).toEqual([appId])
    expect(manager.getAppWorkDir(appId)).toBe(appRoot(appId, 'origin'))
    expect(store.getById(appId)?.dataPath).toBeUndefined()
    expect(manager.listLegacyDataAppIds()).toEqual([])
    expect(existsSync(legacy)).toBe(false)
    put(join(root, 'not-a-directory'), 'ordinary file')
    for (const invalid of [join(root, 'not-a-directory'), join(root, 'not-a-directory', 'child')]) {
      database.getAppDatabase().prepare('UPDATE installed_apps SET data_path = ? WHERE id = ?').run(invalid, appId)
      expect(() => manager.getAppWorkDir(appId)).toThrow()
      expect(store.getById(appId)?.dataPath).toBe(invalid)
    }
  })

  it.each(['EACCES', 'EPERM', 'EIO'])('preserves legacy data_path and fails closed for %s instead of erasing the binding', async code => {
    const appId = await manager.install('origin', spec())
    const legacy = join(root, 'legacy', appId)
    put(join(legacy, 'memory.md'), 'retained unreadable memory')
    database.getAppDatabase().prepare('UPDATE installed_apps SET data_path = ? WHERE id = ?').run(legacy, appId)
    const failure = Object.assign(new Error(`Injected ${code}`), { code })
    vi.mocked(statSync).mockImplementation((...args) => {
      if (String(args[0]) === legacy) throw failure
      return realSync.statSync(...args)
    })
    expect(() => manager.getAppWorkDir(appId)).toThrow(failure)
    expect(store.getById(appId)?.dataPath).toBe(legacy)
    expect(readFileSync(join(legacy, 'memory.md'), 'utf8')).toBe('retained unreadable memory')
  })

  it('falls back to Halo workspace after a workspace disappears but retains existing legacy memory for async repair', async () => {
    const appId = await manager.install('origin', spec())
    const legacy = appRoot(appId, 'origin')
    put(join(legacy, 'memory.md'), 'keep legacy memory')
    database.getAppDatabase().prepare('UPDATE installed_apps SET data_path = ? WHERE id = ?').run(legacy, appId)
    delete spaces.origin
    expect(manager.getAppWorkDir(appId)).toBe(legacy)
    expect(store.getById(appId)).toMatchObject({ spaceId: 'halo-temp', dataPath: legacy })
    await manager.relocateAutomationData(appId, 'halo-temp', {
      sources: [{ path: legacy, spaceId: 'origin' }], commitEnvironments: () => {},
    })
    expect(manager.getAppWorkDir(appId)).toBe(appRoot(appId, 'halo-temp'))
    expect(readFileSync(join(appRoot(appId, 'halo-temp'), 'memory.md'), 'utf8')).toBe('keep legacy memory')
    expect(store.getById(appId)?.dataPath).toBeUndefined()
  })

  it('repairs a missing current workspace without legacy memory and rejects an absent relocation destination', async () => {
    const appId = await manager.install('origin', spec())
    const source = spaces.origin
    delete spaces.origin
    rmSync(source, { recursive: true, force: true })
    expect(manager.getAppWorkDir(appId)).toBe(appRoot(appId, 'halo-temp'))
    expect(store.getById(appId)?.spaceId).toBe('halo-temp')
    const commit = vi.fn()
    await expect(manager.relocateAutomationData(appId, 'missing', { sources: [], commitEnvironments: commit })).rejects.toThrow(SpaceNotFoundError)
    expect(commit).not.toHaveBeenCalled()
    expect(store.listDataRelocations()).toEqual([])
  })
})
