import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import { migrations as managerMigrations } from '../../../../src/main/apps/manager/migrations'
import { migrations } from '../../../../src/main/apps/runtime/migrations'
import { ActivityStore } from '../../../../src/main/apps/runtime/store'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import type { AppManagerService, InstalledApp } from '../../../../src/main/apps/manager/types'

const fixtures = vi.hoisted(() => ({ spaces: new Map<string, any>(), skills: new Map<string, any[]>(), sessions: [] as any[], deniedPath: undefined as string | undefined }))
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, statSync: (...args: Parameters<typeof actual.statSync>) => {
    if (args[0] === fixtures.deniedPath) throw Object.assign(new Error('storage access denied'), { code: 'EACCES' })
    return actual.statSync(...args)
  } }
})
vi.mock('../../../../src/main/services/space.service', () => ({
  getSpace: (id: string) => fixtures.spaces.get(id) ?? null,
  getSpaceDir: (id: string) => fixtures.spaces.get(id)?.workingDir ?? fixtures.spaces.get(id)?.path ?? '',
}))

import { buildExecutionEnvironment, resolveChatEnvironment, resolveChatRecordEnvironment, resolveExecutionEnvironment, validateExecutionEnvironment, validateEnvironmentConnections, legacySessionEnvironmentKey, teamEnvironmentKey, missingConnections } from '../../../../src/main/apps/runtime/execution-environment'
import { WorkingDirectoryUnavailableError } from '../../../../src/main/services/agent'
import { previewAppSpaceChange } from '../../../../src/main/apps/runtime/space-change'
import type { AppRuntimeService } from '../../../../src/main/apps/runtime/types'

vi.mock('../../../../src/main/apps/skill-discovery', () => ({ listAvailableSkills: (id: string) => fixtures.skills.get(id) ?? [] }))
vi.mock('../../../../src/main/apps/team', () => ({ getTeamStore: () => ({ listMembersByAppId: () => [{ teamId: 'team' }] }) }))
vi.mock('../../../../src/main/apps/runtime/im-session-registry', () => ({ getImSessionRegistry: () => ({ getAllSessions: () => fixtures.sessions }) }))

describe('execution environment relocation and recovery', () => {
  let root: string
  let database: DatabaseManager
  let store: ActivityStore
  let app: InstalledApp
  let manager: AppManagerService
  let connections: Record<string, InstalledApp[]>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'halo-environment-'))
    fixtures.spaces.clear(); fixtures.skills.clear(); fixtures.sessions = []; fixtures.deniedPath = undefined
    for (const id of ['a', 'b', 'c', 'halo-temp']) {
      const path = join(root, id)
      const workingDir = join(path, 'work')
      mkdirSync(join(path, '.halo', 'apps', 'person', 'runs'), { recursive: true })
      mkdirSync(workingDir)
      fixtures.spaces.set(id, { id, name: id, path, workingDir, isTemp: id === 'halo-temp' })
    }
    database = createDatabaseManager(':memory:')
    const db = database.getAppDatabase()
    database.runMigrations(db, 'app_manager', managerMigrations)
    database.runMigrations(db, 'app_runtime', migrations)
    db.prepare(`INSERT INTO installed_apps(id, spec_id, space_id, spec_json, installed_at) VALUES ('person', 'person', 'a', '{"type":"automation"}', 1)`).run()
    store = new ActivityStore(db)
    app = { id: 'person', specId: 'person', spaceId: 'a', status: 'active', spec: { type: 'automation', name: 'Person', requires: { mcps: [{ id: 'calendar' }] } } } as InstalledApp
    connections = { a: [], b: [], c: [], 'halo-temp': [] }
    manager = {
      getApp: () => app,
      getAppWorkDir: vi.fn(() => {
        if (!app.spaceId || !fixtures.spaces.has(app.spaceId)) app = { ...app, spaceId: 'halo-temp' }
        if (app.dataPath && !existsSync(app.dataPath)) app = { ...app, dataPath: undefined }
        const path = app.dataPath ?? join(fixtures.spaces.get(app.spaceId!).path, '.halo', 'apps', app.id)
        mkdirSync(path, { recursive: true })
        return path
      }),
      listEffectiveMcpApps: (id: string) => connections[id],
    } as unknown as AppManagerService
  })
  afterEach(() => { database.closeAll(); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks() })

  function connection(id: string, specId = 'calendar', status = 'active'): InstalledApp {
    return { id, specId, status, spec: { name: specId } } as InstalledApp
  }

  function relocate(spaceId: string): void {
    const chat = buildExecutionEnvironment(app, manager, spaceId, 'chat')
    const automation = buildExecutionEnvironment(app, manager, spaceId)
    database.getAppDatabase().transaction(() => {
      database.getAppDatabase().prepare('UPDATE installed_apps SET space_id = ?, data_path = NULL WHERE id = ?').run(spaceId, app.id)
      store.relocateAppEnvironments(app.id, chat, automation)
    })()
    app = { ...app, spaceId, dataPath: undefined }
  }

  it('describes an uncreated destination without using legacy memory or mutating the filesystem', () => {
    app = { ...app, dataPath: join(root, 'deleted-memory') }
    const target = fixtures.spaces.get('b')
    rmSync(target.path, { recursive: true })

    expect(buildExecutionEnvironment(app, manager, 'b')).toEqual({
      spaceId: 'b', spacePath: target.path, workDir: target.workingDir,
      memoryDir: join(target.path, '.halo', 'apps', app.id), mcpBindings: {},
    })
    expect(manager.getAppWorkDir).not.toHaveBeenCalled()
    expect(existsSync(target.path)).toBe(false)
  })

  it('rewrites every session and every run, including legacy, team, backfill and cleared records', () => {
    connections.b = [connection('declared-b'), connection('inherited-b', 'search')]
    const original = resolveExecutionEnvironment(app, manager)
    const sessionKeys = ['app-chat:person', 'app-chat:person:wecom-bot:group:chat', teamEnvironmentKey(app.id, 'team'), legacySessionEnvironmentKey(app.id, 'chat-http-direct-old'), 'environment-backfill:person']
    for (const key of sessionKeys) store.pinSessionEnvironment(key, app.id, original)
    for (const [runId, status] of [['waiting', 'waiting_user'], ['done', 'ok'], ['closed', 'error'], ['cleared', 'ok'], ['skipped', 'skipped']] as const) {
      store.insertRun({ runId, appId: app.id, sessionKey: runId, status, triggerType: 'manual', startedAt: 1, environment: original })
    }
    store.insertRun({ runId: 'legacy', appId: app.id, sessionKey: 'legacy', status: 'ok', triggerType: 'manual', startedAt: 0 })
    store.closeRun('closed')
    store.markTranscriptCleared('cleared')
    store.insertEntry({ id: 'question', appId: app.id, runId: 'waiting', type: 'escalation', ts: 1, content: { summary: 'Proceed?' } })
    const decision = store.getEntry('question')
    const destination = buildExecutionEnvironment(app, manager, 'b', 'chat')
    expect(store.relocateAppEnvironments(app.id, destination, buildExecutionEnvironment(app, manager, 'b'))).toBe(11)

    store = new ActivityStore(database.getAppDatabase())
    for (const key of sessionKeys) expect(store.getSessionEnvironment(key)).toEqual({ ...destination, pendingConnectionNotice: true })
    for (const run of store.getRunsForApp(app.id)) {
      expect(run.environment).toEqual({ ...destination, mcpBindings: { calendar: 'declared-b' }, pendingConnectionNotice: true })
    }
    expect(store.getEntry('question')).toEqual(decision)
    expect(store.getDecisionCounts(app.id).pending).toBe(1)
    expect(store.isRunClosed('closed')).toBe(true)
    expect(store.getRun('cleared')?.transcriptClearedAt).toBeDefined()
    expect(store.listAppIdsPinnedInSpace('a')).toEqual([])
    expect(store.listAppIdsPinnedInSpace('b')).toEqual([app.id])
  })

  it('participates in the same database transaction as app location and leaves decisions intact on rollback', () => {
    const original = resolveChatEnvironment(app, manager, store, 'app-chat:person')
    store.insertRun({ runId: 'run', appId: app.id, sessionKey: 'run', status: 'waiting_user', triggerType: 'manual', startedAt: 1, environment: original })
    store.insertEntry({ id: 'question', appId: app.id, runId: 'run', type: 'escalation', ts: 1, content: { summary: 'Proceed?' } })
    const db = database.getAppDatabase()
    const destination = buildExecutionEnvironment(app, manager, 'b')
    expect(() => db.transaction(() => {
      db.prepare('UPDATE installed_apps SET space_id = ? WHERE id = ?').run('b', app.id)
      store.relocateAppEnvironments(app.id, destination, destination)
      expect(store.getRun('run')?.environment?.spaceId).toBe('b')
      throw new Error('commit failed')
    })()).toThrow('commit failed')

    expect(db.prepare('SELECT space_id FROM installed_apps WHERE id = ?').get(app.id)).toEqual({ space_id: 'a' })
    expect(store.getSessionEnvironment('app-chat:person')).toEqual(original)
    expect(store.getRun('run')?.environment).toEqual(original)
    expect(store.getPendingEscalation(app.id, 'question')).not.toBeNull()
  })

  it('keeps a failed environment rewrite atomic even when the caller has no outer transaction', () => {
    const original = resolveChatEnvironment(app, manager, store, 'app-chat:person')
    store.insertRun({ runId: 'run', appId: app.id, sessionKey: 'run', status: 'ok', triggerType: 'manual', startedAt: 1, environment: original })
    database.getAppDatabase().exec(`CREATE TRIGGER reject_environment BEFORE UPDATE OF environment_json ON automation_runs
      BEGIN SELECT RAISE(ABORT, 'run rewrite failed'); END`)
    const destination = buildExecutionEnvironment(app, manager, 'b')
    expect(() => store.relocateAppEnvironments(app.id, destination, destination)).toThrow('run rewrite failed')
    expect(store.getSessionEnvironment('app-chat:person')).toEqual(original)
    expect(store.getRun('run')?.environment).toEqual(original)
  })

  it('upserts exact session keys and replaces run environments without changing other people', () => {
    const db = database.getAppDatabase()
    db.prepare(`INSERT INTO installed_apps(id, spec_id, space_id, spec_json, installed_at) VALUES ('other', 'other', 'a', '{"type":"automation"}', 1)`).run()
    const original = resolveExecutionEnvironment(app, manager)
    store.pinSessionEnvironment('app-chat:other', 'other', original)
    store.insertRun({ runId: 'other-run', appId: 'other', sessionKey: 'other', status: 'ok', triggerType: 'manual', startedAt: 1, environment: original })
    store.insertRun({ runId: 'legacy', appId: app.id, sessionKey: 'run', status: 'ok', triggerType: 'manual', startedAt: 1 })
    const destination = buildExecutionEnvironment(app, manager, 'b')
    expect(store.replaceSessionEnvironment('app-chat:person', app.id, destination)).toEqual(destination)
    expect(store.replaceSessionEnvironment('app-chat:person', app.id, original)).toEqual(original)
    expect(() => store.replaceSessionEnvironment('app-chat:other', app.id, destination)).toThrow(/another execution actor/)
    store.replaceRunEnvironment('legacy', destination)
    store.relocateAppEnvironments(app.id, destination, destination)
    expect(store.getRun('legacy')?.environment).toEqual(destination)
    expect(store.getSessionEnvironment('app-chat:other')).toEqual(original)
    expect(store.getRun('other-run')?.environment).toEqual(original)
  })

  it('discovers source environments from all runs, not only retained work', () => {
    const a = buildExecutionEnvironment(app, manager, 'a')
    const b = buildExecutionEnvironment(app, manager, 'b')
    const c = buildExecutionEnvironment(app, manager, 'c')
    store.pinSessionEnvironment('environment-backfill:person', app.id, a)
    store.pinSessionEnvironment(teamEnvironmentKey(app.id, 'team'), app.id, a)
    store.insertRun({ runId: 'done', appId: app.id, sessionKey: 'done', status: 'ok', triggerType: 'manual', startedAt: 1, environment: b })
    store.insertRun({ runId: 'closed', appId: app.id, sessionKey: 'closed', status: 'ok', triggerType: 'manual', startedAt: 1, environment: c })
    store.closeRun('closed')
    store.markTranscriptCleared('closed')
    expect(store.listAppEnvironments(app.id)).toEqual(expect.arrayContaining([a, b, c]))
    expect(store.listAppEnvironments(app.id)).toHaveLength(3)
    expect(store.listAppIdsPinnedInSpace('b')).toEqual([app.id])
    expect(store.listAppIdsPinnedInSpace('c')).toEqual([app.id])
  })

  it('keeps every old chat and team key on the latest workspace through repeated relocations', () => {
    const key = 'app-chat:person:team:team:epoch'
    resolveChatEnvironment(app, manager, store, key, 'team')
    relocate('b')
    resolveChatEnvironment(app, manager, store, 'app-chat:person:local:direct:new')
    relocate('c')
    rmSync(fixtures.spaces.get('a').path, { recursive: true })
    rmSync(fixtures.spaces.get('b').path, { recursive: true })
    store = new ActivityStore(database.getAppDatabase())
    for (const conversationId of [key, 'app-chat:person:team:team:next', 'app-chat:person:local:direct:new']) {
      const current = resolveChatEnvironment(app, manager, store, conversationId, conversationId === key || conversationId.endsWith(':next') ? 'team' : undefined)
      expect(current.spaceId).toBe('c')
      expect(current.memoryDir).toBe(join(fixtures.spaces.get('c').path, '.halo', 'apps', app.id))
    }
  })

  it.each(['space', 'storage', 'memory'] as const)('repairs a missing pinned %s and persists the exact chat, legacy alias and team key once', missing => {
    const key = 'app-chat:person:team:team:epoch'
    const legacyKey = legacySessionEnvironmentKey(app.id, 'chat-team-team-epoch')
    const original = resolveExecutionEnvironment(app, manager)
    store.pinSessionEnvironment(legacyKey, app.id, original)
    store.pinSessionEnvironment(teamEnvironmentKey(app.id, 'team'), app.id, original)
    app = { ...app, spaceId: 'b' }
    if (missing === 'space') fixtures.spaces.delete('a')
    if (missing === 'storage') rmSync(fixtures.spaces.get('a').path, { recursive: true })
    if (missing === 'memory') rmSync(original.memoryDir, { recursive: true })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const current = resolveChatEnvironment(app, manager, store, key, 'team')
    expect(current.spaceId).toBe('b')
    for (const sessionKey of [key, legacyKey, teamEnvironmentKey(app.id, 'team')]) expect(store.getSessionEnvironment(sessionKey)).toEqual(current)
    store = new ActivityStore(database.getAppDatabase())
    expect(resolveChatEnvironment(app, manager, store, key, 'team')).toEqual(current)
    expect(warning).toHaveBeenCalledTimes(1)
  })

  it('recreates missing same-space memory instead of blocking the existing conversation', () => {
    const key = 'app-chat:person'
    const original = resolveChatEnvironment(app, manager, store, key)
    rmSync(original.memoryDir, { recursive: true })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(resolveChatEnvironment(app, manager, store, key)).toEqual(original)
    expect(existsSync(original.memoryDir)).toBe(true)
    expect(resolveChatEnvironment(app, manager, store, key)).toEqual(original)
    expect(warning).toHaveBeenCalledTimes(1)
  })

  it('recreates missing current storage through the manager without changing its workspace', () => {
    const key = 'app-chat:person'
    const original = resolveChatEnvironment(app, manager, store, key)
    fixtures.spaces.get('a').workingDir = undefined
    original.workDir = original.spacePath
    store.replaceSessionEnvironment(key, app.id, original)
    rmSync(original.spacePath, { recursive: true })
    expect(resolveChatEnvironment(app, manager, store, key)).toEqual(original)
    expect(existsSync(original.memoryDir)).toBe(true)
  })

  it('repairs a missing legacy memory location through the manager and re-reads its app record', () => {
    app = { ...app, spaceId: 'b', dataPath: join(root, 'gone-legacy-memory') }
    expect(resolveExecutionEnvironment(app, manager).memoryDir).toBe(join(fixtures.spaces.get('b').path, '.halo', 'apps', app.id))
    expect(app.dataPath).toBeUndefined()
    app = { ...app, spaceId: 'deleted-space' }
    expect(resolveExecutionEnvironment(app, manager).spaceId).toBe('halo-temp')
    expect(app.spaceId).toBe('halo-temp')
  })

  it('recovers an original run environment and hands the actual environment to its persistence callback', () => {
    const original = resolveExecutionEnvironment(app, manager)
    store.insertRun({ runId: 'run', appId: app.id, sessionKey: 'run', status: 'waiting_user', triggerType: 'manual', startedAt: 1, environment: original })
    app = { ...app, spaceId: 'b' }
    fixtures.spaces.delete('a')
    const recovered = validateExecutionEnvironment(original, {
      app, manager, onRecovered: environment => store.replaceRunEnvironment('run', environment),
    })
    expect(recovered.spaceId).toBe('b')
    expect(store.getRun('run')?.environment).toEqual(recovered)
    expect(validateExecutionEnvironment(recovered, { app, manager })).toBe(recovered)
  })

  it.each(['replaced', 'removed', 'added'] as const)('persists a pending connection notice when missing storage recovery finds a %s binding', change => {
    connections.a = change === 'added' ? [] : [connection('original')]
    connections.b = change === 'removed' ? [] : [connection('replacement')]
    const key = 'app-chat:person'
    const original = resolveChatEnvironment(app, manager, store, key)
    app = { ...app, spaceId: 'b' }
    rmSync(original.memoryDir, { recursive: true })

    const recovered = resolveChatEnvironment(app, manager, store, key)
    expect(recovered.pendingConnectionNotice).toBe(true)
    expect(store.getSessionEnvironment(key)).toEqual(recovered)
    expect(validateEnvironmentConnections(recovered, app, manager, 'chat').changed).toBe(false)
    store = new ActivityStore(database.getAppDatabase())
    expect(resolveChatEnvironment(app, manager, store, key).pendingConnectionNotice).toBe(true)
    delete recovered.pendingConnectionNotice
    store.replaceSessionEnvironment(key, app.id, recovered)
    expect(resolveChatEnvironment(app, manager, store, key).pendingConnectionNotice).toBeUndefined()
  })

  it('preserves a previous unannounced connection change through another storage recovery', () => {
    connections.a = [connection('original')]
    const original = { ...resolveExecutionEnvironment(app, manager), pendingConnectionNotice: true }
    rmSync(original.memoryDir, { recursive: true })
    const onRecovered = vi.fn()
    const recovered = validateExecutionEnvironment(original, { app, manager, onRecovered })
    expect(recovered.mcpBindings).toEqual(original.mcpBindings)
    expect(recovered.pendingConnectionNotice).toBe(true)
    expect(onRecovered).toHaveBeenCalledWith(expect.objectContaining({ pendingConnectionNotice: true }))
  })

  it.each(['paused', 'error', 'needs_login'] as const)('does not queue a new connection notice when recovered storage still uses the same %s account', status => {
    connections.a = [connection('original')]
    const original = resolveExecutionEnvironment(app, manager)
    connections.a[0].status = status
    rmSync(original.memoryDir, { recursive: true })
    const recovered = validateExecutionEnvironment(original, { app, manager })
    expect(recovered.mcpBindings).toEqual(original.mcpBindings)
    expect(recovered.pendingConnectionNotice).toBeUndefined()
  })

  it('sets the pending notice before the recovered run environment is persisted', () => {
    connections.a = [connection('original')]
    connections.b = [connection('replacement')]
    const original = resolveExecutionEnvironment(app, manager)
    store.insertRun({ runId: 'run', appId: app.id, sessionKey: 'run', status: 'waiting_user', triggerType: 'manual', startedAt: 1, environment: original })
    app = { ...app, spaceId: 'b' }
    fixtures.spaces.delete('a')
    const recovered = validateExecutionEnvironment(original, {
      app, manager, onRecovered: environment => store.replaceRunEnvironment('run', environment),
    })
    expect(recovered.pendingConnectionNotice).toBe(true)
    expect(store.getRun('run')?.environment).toEqual(recovered)
  })

  it('does not treat permission-denied storage checks as missing data eligible for recovery', () => {
    const original = resolveExecutionEnvironment(app, manager)
    fixtures.deniedPath = original.memoryDir
    const onRecovered = vi.fn()
    expect(() => validateExecutionEnvironment(original, { app, manager, onRecovered })).toThrow('storage access denied')
    expect(onRecovered).not.toHaveBeenCalled()
  })

  it.each(['execution', 'chat', 'history', 'validation'] as const)('refuses %s before existing pinned storage can bypass retained relocation recovery', entry => {
    const key = 'app-chat:person'
    const original = resolveChatEnvironment(app, manager, store, key)
    const getAppWorkDir = vi.mocked(manager.getAppWorkDir)
    getAppWorkDir.mockClear()
    manager.assertAppDataAvailable = vi.fn(() => { throw new Error('workspace move needs file recovery') })
    const run = () => entry === 'execution' ? resolveExecutionEnvironment(app, manager)
      : entry === 'chat' ? resolveChatEnvironment(app, manager, store, key)
        : entry === 'history' ? resolveChatRecordEnvironment(app, manager, store, key)
          : validateExecutionEnvironment(original, { app, manager })
    expect(run).toThrow('workspace move needs file recovery')
    expect(getAppWorkDir).not.toHaveBeenCalled()
    expect(store.getSessionEnvironment(key)).toEqual(original)
  })

  it('keeps existing transcript storage readable when its project directory is missing', () => {
    const key = 'app-chat:person'
    const original = resolveChatEnvironment(app, manager, store, key)
    rmSync(original.workDir, { recursive: true })
    expect(resolveChatRecordEnvironment(app, manager, store, key)).toEqual(original)
    expect(() => resolveChatEnvironment(app, manager, store, key)).toThrow(WorkingDirectoryUnavailableError)
  })

  it('recovers missing transcript storage without requiring the current project directory', () => {
    const key = 'app-chat:person'
    connections.a = [connection('original')]
    const original = resolveChatEnvironment(app, manager, store, key)
    app = { ...app, spaceId: 'b' }
    connections.b = [connection('replacement')]
    rmSync(original.memoryDir, { recursive: true })
    rmSync(fixtures.spaces.get('b').workingDir, { recursive: true })
    const current = resolveChatRecordEnvironment(app, manager, store, key)
    expect(current.spaceId).toBe('b')
    expect(current.pendingConnectionNotice).toBe(true)
    expect(store.getSessionEnvironment(key)).toEqual(current)
    expect(() => resolveChatEnvironment(app, manager, store, key)).toThrow(WorkingDirectoryUnavailableError)
  })

  it('resolves a transcript without a pinned environment when the current project is unavailable', () => {
    const key = 'app-chat:person:local:direct:unopened'
    rmSync(fixtures.spaces.get('a').workingDir, { recursive: true })
    const environment = resolveChatRecordEnvironment(app, manager, store, key)
    expect(environment.spacePath).toBe(fixtures.spaces.get('a').path)
    expect(store.getSessionEnvironment(key)).toEqual(environment)
    expect(() => resolveChatEnvironment(app, manager, store, key)).toThrow(WorkingDirectoryUnavailableError)
  })

  it('preserves the typed missing-project error even when memory also needs recovery', () => {
    const original = resolveChatEnvironment(app, manager, store, 'app-chat:person')
    rmSync(original.workDir, { recursive: true })
    rmSync(original.memoryDir, { recursive: true })
    expect(() => resolveChatEnvironment(app, manager, store, 'app-chat:person')).toThrow(WorkingDirectoryUnavailableError)
    expect(() => resolveExecutionEnvironment(app, manager)).toThrow(WorkingDirectoryUnavailableError)
  })

  it('does not treat unreadable storage as deleted or overwrite its environment', () => {
    const original = resolveChatEnvironment(app, manager, store, 'app-chat:person')
    manager.getAppWorkDir = () => { throw Object.assign(new Error('storage access denied'), { code: 'EACCES' }) }
    rmSync(original.memoryDir, { recursive: true })
    expect(() => resolveChatEnvironment(app, manager, store, 'app-chat:person')).toThrow('storage access denied')
    expect(store.getSessionEnvironment('app-chat:person')).toEqual(original)
  })

  it('reports all pending decisions and distinguishes same-name connection instances and skill overrides', () => {
    connections.a = [{ ...connection('account-a'), spaceId: 'a', spec: { name: 'Calendar' } } as InstalledApp]
    connections.b = [{ ...connection('account-b'), spaceId: 'b', spec: { name: 'Calendar' } } as InstalledApp]
    fixtures.skills.set('a', [{ name: 'Review', path: '/a/review', scope: 'space' }])
    fixtures.skills.set('b', [{ name: 'Review', path: '/b/review', scope: 'space' }])
    for (let index = 0; index < 135; index++) store.insertEntry({ id: `question-${index}`, appId: app.id, runId: 'old', type: 'escalation', ts: index, content: { summary: 'Proceed?' } })
    const runtime = { getAppState: () => ({ status: 'idle' }) } as unknown as AppRuntimeService
    const preview = previewAppSpaceChange({ manager, store, runtime }, app.id, 'b')
    expect(preview.pendingDecisionCount).toBe(135)
    expect(preview.removedConnections).toEqual(['Calendar (a)'])
    expect(preview.addedConnections).toEqual(['Calendar (b)'])
    expect(preview.removedSkills).toEqual(['Review (a)'])
    expect(preview.addedSkills).toEqual(['Review (b)'])
  })

  it('deduplicates file aliases and canonical keys while excluding backfill and team anchors from session counts', () => {
    const environment = resolveChatEnvironment(app, manager, store, 'app-chat:person')
    store.pinSessionEnvironment(legacySessionEnvironmentKey(app.id, 'chat'), app.id, environment)
    store.pinSessionEnvironment(teamEnvironmentKey(app.id, 'team'), app.id, environment)
    store.pinSessionEnvironment('environment-backfill:person', app.id, environment)
    expect(store.countSessionEnvironments(app.id)).toBe(1)
    const runtime = { getAppState: () => ({ status: 'idle' }) } as unknown as AppRuntimeService
    expect(previewAppSpaceChange({ manager, store, runtime }, app.id, 'b').retainedSessionCount).toBe(1)
  })

  it('keeps capability retention limited to open work independently of full historical relocation', () => {
    const environment = resolveExecutionEnvironment(app, manager)
    store.pinSessionEnvironment('app-chat:person:local:direct:live', app.id, environment)
    store.pinSessionEnvironment('app-chat:person:local:direct:deleted', app.id, environment)
    store.deleteSessionEnvironment('app-chat:person:local:direct:deleted')
    store.pinSessionEnvironment('environment-backfill:person', app.id, environment)
    for (const [runId, status] of [['live', 'running'], ['done', 'ok'], ['closed', 'waiting_user']] as const) {
      store.insertRun({ runId, appId: app.id, sessionKey: runId, status, triggerType: 'manual', startedAt: 1, environment })
    }
    store.closeRun('closed')
    const retained = store.listRetainedCapabilityEnvironments()
    expect(retained).toHaveLength(2)
    expect(retained.filter(work => work.sessionKey).map(work => work.sessionKey)).toEqual(['app-chat:person:local:direct:live'])
    expect(retained.filter(work => !work.sessionKey)).toHaveLength(1)
  })

  it('switches replaced connections, removes missing ones and warns only when the bindings change', () => {
    connections.a = [connection('original')]
    const environment = resolveExecutionEnvironment(app, manager)
    connections.a = [connection('replacement')]
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(validateEnvironmentConnections(environment, app, manager)).toEqual({ changed: true, changedSpecIds: ['calendar'] })
    expect(environment.mcpBindings).toEqual({ calendar: 'replacement' })
    expect(validateEnvironmentConnections(environment, app, manager).changed).toBe(false)
    connections.a = []
    expect(validateEnvironmentConnections(environment, app, manager).changed).toBe(true)
    expect(environment.mcpBindings).toEqual({})
    expect(validateEnvironmentConnections(environment, app, manager).changed).toBe(false)
    expect(warning).toHaveBeenCalledTimes(2)
  })

  it.each(['paused', 'error', 'needs_login'] as const)('does not report an identity change when the same connection is %s', status => {
    connections.a = [connection('original')]
    const environment = resolveChatEnvironment(app, manager, store, 'app-chat:person')
    connections.a[0].status = status
    expect(validateEnvironmentConnections(environment, app, manager, 'chat').changed).toBe(false)
    expect(environment.mcpBindings).toEqual({ calendar: 'original' })
    expect(missingConnections(app, manager, 'a')[0].state).toBe(status === 'paused' ? 'disabled' : status)
    connections.a[0].status = 'active'
    expect(validateEnvironmentConnections(environment, app, manager, 'chat').changed).toBe(false)
  })

  it.each(['paused', 'error', 'needs_login'] as const)('captures an initially %s connection without a false identity-change notice', status => {
    connections.a = [connection('original', 'calendar', status)]
    const environment = resolveExecutionEnvironment(app, manager)
    expect(environment.mcpBindings).toEqual({ calendar: 'original' })
    expect(validateEnvironmentConnections(environment, app, manager).changed).toBe(false)
    connections.a[0].status = 'active'
    expect(validateEnvironmentConnections(environment, app, manager).changed).toBe(false)
  })

  it.each(['active', 'paused', 'error', 'needs_login'] as const)('follows a new authorized connection identity even if its status is %s', status => {
    connections.a = [connection('original')]
    const environment = resolveChatEnvironment(app, manager, store, 'app-chat:person')
    connections.a = [connection('replacement', 'calendar', status)]
    expect(validateEnvironmentConnections(environment, app, manager, 'chat').changed).toBe(true)
    expect(environment.mcpBindings).toEqual({ calendar: 'replacement' })
    expect(validateEnvironmentConnections(environment, app, manager, 'chat').changed).toBe(false)
  })

  it('inherits new chat connections without granting undeclared independent-task connections and removes revoked bindings', () => {
    connections.a = [connection('declared')]
    const run = resolveExecutionEnvironment(app, manager)
    const chat = resolveChatEnvironment(app, manager, store, 'app-chat:person')
    connections.a.push(connection('inherited', 'search'))
    expect(validateEnvironmentConnections(run, app, manager).changed).toBe(false)
    expect(validateEnvironmentConnections(chat, app, manager, 'chat')).toEqual({ changed: true, changedSpecIds: ['search'] })
    expect(chat.mcpBindings).toEqual({ calendar: 'declared', search: 'inherited' })
    app.spec.requires!.mcps!.push({ id: 'search', enabled: false })
    expect(validateEnvironmentConnections(chat, app, manager, 'chat').changed).toBe(true)
    expect(chat.mcpBindings).toEqual({ calendar: 'declared' })
    expect(validateEnvironmentConnections(chat, app, manager, 'chat').changed).toBe(false)
    app.spec.requires!.mcps![0].enabled = false
    expect(validateEnvironmentConnections(run, app, manager).changed).toBe(true)
    expect(run.mcpBindings).toEqual({})
  })
})

describe('missingConnections', () => {
  const person = (mcps: Array<{ id: string; enabled?: boolean }>) =>
    ({ id: 'person', spec: { type: 'automation', name: 'Person', requires: { mcps } } }) as unknown as InstalledApp
  const connection = (specId: string, status: string, name = specId) =>
    ({ id: `${specId}-${status}`, specId, status, spec: { type: 'mcp', name } }) as unknown as InstalledApp
  const manager = (installed: InstalledApp[]) => ({ listEffectiveMcpApps: () => installed })

  it('names each declared connection a run cannot use, and why', () => {
    const missing = missingConnections(
      person([{ id: 'docs' }, { id: 'mail' }, { id: 'crm' }, { id: 'sheets' }, { id: 'calendar' }]),
      manager([
        connection('mail', 'paused', 'Mail'),
        connection('crm', 'needs_login', 'CRM'),
        connection('sheets', 'error', 'Sheets'),
        connection('calendar', 'active', 'Calendar'),
      ]),
      'space',
    )

    expect(missing).toEqual([
      { id: 'docs', name: 'docs', state: 'not_installed' },
      { id: 'mail', name: 'Mail', state: 'disabled' },
      { id: 'crm', name: 'CRM', state: 'needs_login' },
      { id: 'sheets', name: 'Sheets', state: 'error' },
    ])
  })

  it('leaves out what the owner switched off and the built-in capabilities', () => {
    expect(missingConnections(person([{ id: 'docs', enabled: false }, { id: 'ai-browser' }, { id: 'web-search' }]), manager([]), 'space')).toEqual([])
  })

  it('counts a connection as usable when any instance of it is running', () => {
    expect(missingConnections(person([{ id: 'docs' }]), manager([connection('docs', 'paused'), connection('docs', 'active')]), 'space')).toEqual([])
  })
})
