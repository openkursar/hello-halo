import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import { migrations as managerMigrations } from '../../../../src/main/apps/manager/migrations'
import { migrations } from '../../../../src/main/apps/runtime/migrations'
import { ActivityStore } from '../../../../src/main/apps/runtime/store'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import type { AppManagerService, InstalledApp } from '../../../../src/main/apps/manager/types'
import type { AppRuntimeService } from '../../../../src/main/apps/runtime/types'

const fixtures = vi.hoisted(() => ({ spaces: new Map<string, any>(), skills: new Map<string, any[]>(), sessions: [] as any[] }))
vi.mock('../../../../src/main/services/space.service', () => ({
  getSpace: (id: string) => fixtures.spaces.get(id) ?? null,
  getSpaceDir: (id: string) => fixtures.spaces.get(id)?.workingDir ?? '',
}))
vi.mock('../../../../src/main/apps/skill-discovery', () => ({ listAvailableSkills: (id: string) => fixtures.skills.get(id) ?? [] }))
vi.mock('../../../../src/main/apps/team', () => ({ getTeamStore: () => ({ listMembersByAppId: () => [{ teamId: 'team' }] }) }))
vi.mock('../../../../src/main/apps/runtime/im-session-registry', () => ({ getImSessionRegistry: () => ({ getAllSessions: () => fixtures.sessions }) }))

import { resolveChatEnvironment, resolveExecutionEnvironment, validateExecutionEnvironment, validateEnvironmentConnections, legacySessionEnvironmentKey, teamEnvironmentKey } from '../../../../src/main/apps/runtime/execution-environment'
import { changeAppDefaultSpace, previewAppSpaceChange, retainAppEnvironments } from '../../../../src/main/apps/runtime/space-change'

describe('retained execution environments', () => {
  let root: string
  let database: DatabaseManager
  let store: ActivityStore
  let app: InstalledApp
  let manager: AppManagerService
  let runtime: AppRuntimeService
  let connections: Record<string, InstalledApp[]>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'halo-environment-'))
    fixtures.spaces.clear(); fixtures.skills.clear(); fixtures.sessions = []
    for (const id of ['a', 'b', 'c']) {
      const path = join(root, id)
      const workingDir = join(path, 'work')
      mkdirSync(join(path, '.halo', 'apps', 'person', 'runs'), { recursive: true })
      mkdirSync(workingDir)
      fixtures.spaces.set(id, { id, name: id, path, workingDir })
    }
    database = createDatabaseManager(':memory:')
    const db = database.getAppDatabase()
    database.runMigrations(db, 'app_manager', managerMigrations)
    database.runMigrations(db, 'app_runtime', migrations)
    db.prepare(`INSERT INTO installed_apps(id, spec_id, space_id, spec_json, installed_at) VALUES ('person', 'person', 'a', '{"type":"automation"}', 1)`).run()
    store = new ActivityStore(db)
    app = { id: 'person', specId: 'person', spaceId: 'a', status: 'active', spec: { type: 'automation', name: 'Person', requires: { mcps: [{ id: 'calendar' }] } } } as InstalledApp
    connections = { a: [], b: [], c: [] }
    manager = {
      getApp: () => app,
      getAppWorkDir: () => app.dataPath ?? join(fixtures.spaces.get(app.spaceId!).path, '.halo', 'apps', app.id),
      listEffectiveMcpApps: (id: string) => connections[id],
      moveToSpace: async (_id: string, spaceId: string) => { app = { ...app, dataPath: manager.getAppWorkDir(app.id), spaceId } },
    } as unknown as AppManagerService
    runtime = { getAppState: () => ({ status: 'idle' }), syncAppSubscriptions: vi.fn() } as unknown as AppRuntimeService
  })
  afterEach(() => { database.closeAll(); rmSync(root, { recursive: true, force: true }) })

  it('keeps legacy runs, IM files, empty sessions and team environments across repeated default moves and reload', async () => {
    const original = resolveExecutionEnvironment(app, manager)
    store.insertRun({ runId: 'run', appId: app.id, sessionKey: 'run-key', status: 'waiting_user', triggerType: 'manual', startedAt: 1 })
    writeFileSync(join(original.spacePath, '.halo/apps/person/runs/chat-http-direct-old.jsonl'), '{}\n')
    fixtures.sessions = [{ channel: 'local', chatType: 'direct', chatId: 'empty' }]
    await changeAppDefaultSpace({ manager, store, runtime }, app.id, 'b')
    const fresh = resolveChatEnvironment(app, manager, store, 'app-chat:person:local:direct:new')
    expect(fresh.spaceId).toBe('b')
    expect(fresh.memoryDir).toBe(original.memoryDir)
    await changeAppDefaultSpace({ manager, store, runtime }, app.id, 'c')
    store = new ActivityStore(database.getAppDatabase())
    expect(store.getRun('run')?.environment?.spaceId).toBe('a')
    expect(resolveChatEnvironment(app, manager, store, 'app-chat:person:http:direct:old').spaceId).toBe('a')
    expect(resolveChatEnvironment(app, manager, store, 'app-chat:person:local:direct:empty').spaceId).toBe('a')
    expect(resolveChatEnvironment(app, manager, store, 'app-chat:person:local:direct:new').spaceId).toBe('b')
    expect(store.getSessionEnvironment(teamEnvironmentKey(app.id, 'team'))?.spaceId).toBe('a')
  })

  it('blocks when original history or identity memory disappears, even if the new directory exists', async () => {
    const original = resolveChatEnvironment(app, manager, store, 'app-chat:person')
    await changeAppDefaultSpace({ manager, store, runtime }, app.id, 'b')
    rmSync(original.memoryDir, { recursive: true })
    expect(() => validateExecutionEnvironment(original)).toThrow(/unavailable/)
    expect(() => resolveExecutionEnvironment(app, manager)).toThrow(/memory directory/)
  })

  it('reports all pending decisions and distinguishes same-name connection instances and skill overrides', () => {
    connections.a = [{ id: 'account-a', specId: 'calendar', spaceId: 'a', status: 'active', spec: { name: 'Calendar' } } as InstalledApp]
    connections.b = [{ id: 'account-b', specId: 'calendar', spaceId: 'b', status: 'active', spec: { name: 'Calendar' } } as InstalledApp]
    fixtures.skills.set('a', [{ name: 'Review', path: '/a/review', scope: 'space' }])
    fixtures.skills.set('b', [{ name: 'Review', path: '/b/review', scope: 'space' }])
    for (let index = 0; index < 135; index++) store.insertEntry({ id: `question-${index}`, appId: app.id, runId: 'old', type: 'escalation', ts: index, content: { summary: 'Proceed?' } })
    const preview = previewAppSpaceChange({ manager, store, runtime }, app.id, 'b')
    expect(preview.pendingDecisionCount).toBe(135)
    expect(preview.removedConnections).toEqual(['Calendar (a)'])
    expect(preview.addedConnections).toEqual(['Calendar (b)'])
    expect(preview.removedSkills).toEqual(['Review (a)'])
    expect(preview.addedSkills).toEqual(['Review (b)'])
  })

  it('does not substitute a same-name connection after the original account is removed', () => {
    connections.a = [{ id: 'original-account', specId: 'calendar', status: 'active' } as InstalledApp]
    const environment = resolveExecutionEnvironment(app, manager)
    connections.a = [{ id: 'fallback-account', specId: 'calendar', status: 'active' } as InstalledApp]
    expect(() => validateEnvironmentConnections(environment, app, manager)).toThrow(/switch accounts/)
    app.spec.requires!.mcps![0].enabled = false
    expect(() => validateEnvironmentConnections(environment, app, manager)).not.toThrow()
  })

  it('preserves chat inheritance without adding undeclared connections to independent tasks', () => {
    connections.a = [
      { id: 'declared', specId: 'calendar', status: 'active' } as InstalledApp,
      { id: 'inherited', specId: 'search', status: 'active' } as InstalledApp,
    ]
    const run = resolveExecutionEnvironment(app, manager)
    const chat = resolveChatEnvironment(app, manager, store, 'app-chat:person')
    expect(run.mcpBindings).toEqual({ calendar: 'declared' })
    expect(chat.mcpBindings).toEqual({ calendar: 'declared', search: 'inherited' })
    connections.a[1] = { id: 'replacement', specId: 'search', status: 'active' } as InstalledApp
    expect(() => validateEnvironmentConnections(chat, app, manager, 'chat')).toThrow(/switch accounts/)
    app.spec.requires!.mcps!.push({ id: 'search', enabled: false })
    expect(() => validateEnvironmentConnections(chat, app, manager, 'chat')).not.toThrow()
  })

  it('inventory retention excludes completed, closed and deleted work', () => {
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

  it('deduplicates file aliases and canonical keys while excluding backfill and team anchors from session counts', () => {
    const environment = resolveChatEnvironment(app, manager, store, 'app-chat:person')
    store.pinSessionEnvironment(legacySessionEnvironmentKey(app.id, 'chat'), app.id, environment)
    retainAppEnvironments(manager, store, app)
    expect(store.countSessionEnvironments(app.id)).toBe(1)
    expect(previewAppSpaceChange({ manager, store, runtime }, app.id, 'b').retainedSessionCount).toBe(1)
  })
})
