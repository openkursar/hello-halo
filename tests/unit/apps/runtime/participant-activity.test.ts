import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import { migrations as managerMigrations } from '../../../../src/main/apps/manager/migrations'
import { migrations } from '../../../../src/main/apps/runtime/migrations'
import { TeamStore } from '../../../../src/main/apps/team/store'
import { migrations as teamMigrations } from '../../../../src/main/apps/team/migrations'
import { ActivityStore } from '../../../../src/main/apps/runtime/store'

vi.mock('../../../../src/main/services/agent/resolved-sdk', async () => import('../../../../src/main/services/agent/mcp/sdk-server'))
vi.mock('../../../../src/main/http/websocket', () => ({ broadcastToAll: vi.fn() }))
vi.mock('../../../../src/main/foundation/window.service', () => ({ sendToRenderer: vi.fn() }))
vi.mock('../../../../src/main/services/notification.service', () => ({ notifyAppEvent: vi.fn() }))
vi.mock('../../../../src/main/apps/runtime/team', () => ({ getActiveTeamRuntime: () => null }))
import { createReportToolServer } from '../../../../src/main/apps/runtime/report-tool'

let directory: string
let connections: DatabaseManager[]
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'halo-execution-actors-')); connections = [] })
afterEach(() => { vi.restoreAllMocks(); connections.forEach(connection => connection.closeAll()); rmSync(directory, { recursive: true, force: true }) })
function open(version = 9) {
  const manager = createDatabaseManager(join(directory, 'state.db'))
  connections.push(manager)
  const db = manager.getAppDatabase()
  manager.runMigrations(db, 'app_manager', managerMigrations)
  manager.runMigrations(db, 'app_runtime', migrations.filter(migration => migration.version <= version))
  return { manager, db }
}
function seedLegacy() {
  const f = open(8)
  f.db.exec(`INSERT INTO installed_apps(id,spec_id,spec_json,installed_at) VALUES ('installed','spec','{"type":"automation","name":"Installed"}',1);
    INSERT INTO app_session_environments VALUES ('existing-session','installed','{"workDir":"/retained"}');`)
  const insert = f.db.prepare(`INSERT INTO activity_entries VALUES (?, 'installed', 'chat', 'escalation', 1, 'existing-session', '{"summary":"Choose"}', '{"text":"Chosen","ts":2}')`)
  for (const [i, status] of ['queued', 'running', 'failed', 'completed', 'cancelled'].entries()) {
    const id = `decision-${i}`
    insert.run(id)
    f.db.prepare(`INSERT INTO decision_continuations VALUES (?, 'installed', ?, ?, ?, ?, ?)`).run(id, status, i, i % 2, 10 + i, i === 2 ? 'retained failure' : null)
  }
  return f
}

describe('execution actor storage migration', () => {
  it('preserves every old activity, continuation and environment while changing parent ownership', () => {
    const f = seedLegacy()
    const entries = f.db.prepare('SELECT * FROM activity_entries ORDER BY id').all()
    const continuations = f.db.prepare('SELECT * FROM decision_continuations ORDER BY entry_id').all()
    const environments = f.db.prepare('SELECT * FROM app_session_environments').all()
    f.manager.runMigrations(f.db, 'app_runtime', migrations)
    expect(f.db.prepare('SELECT * FROM activity_entries ORDER BY id').all()).toEqual(entries)
    expect(f.db.prepare('SELECT * FROM decision_continuations ORDER BY entry_id').all()).toEqual(continuations)
    expect(f.db.prepare('SELECT * FROM app_session_environments').all()).toEqual(environments)
    expect(f.db.pragma('foreign_key_check')).toEqual([])
    f.manager.closeAll()
    const reopened = open()
    const store = new ActivityStore(reopened.db)
    expect(store.getEntry('decision-2')?.continuation).toMatchObject({ status: 'failed', attempts: 2, error: 'retained failure' })
    expect(store.recoverContinuations()).toBe(1)
    expect(store.getQueuedContinuations().map(entry => entry.id).sort()).toEqual(['decision-0', 'decision-1'])
  })

  it('rolls back the entire parent/child rebuild on failure and upgrades cleanly after reopening', () => {
    const f = seedLegacy()
    const entries = f.db.prepare('SELECT * FROM activity_entries ORDER BY id').all()
    const continuations = f.db.prepare('SELECT * FROM decision_continuations ORDER BY entry_id').all()
    const exec = f.db.exec.bind(f.db)
    const injected = vi.spyOn(f.db, 'exec').mockImplementation(sql => {
      const result = exec(sql)
      if (sql.includes('CREATE TABLE runtime_execution_actors')) throw new Error('simulated migration failure')
      return result
    })
    expect(() => f.manager.runMigrations(f.db, 'app_runtime', migrations)).toThrow('simulated migration failure')
    injected.mockRestore()
    expect(f.db.prepare('SELECT * FROM activity_entries ORDER BY id').all()).toEqual(entries)
    expect(f.db.prepare('SELECT * FROM decision_continuations ORDER BY entry_id').all()).toEqual(continuations)
    expect(f.db.prepare("SELECT name FROM sqlite_master WHERE name = 'runtime_execution_actors'").get()).toBeUndefined()
    f.manager.closeAll()
    const reopened = open()
    expect(reopened.db.prepare('SELECT * FROM decision_continuations ORDER BY entry_id').all()).toEqual(continuations)
    expect(reopened.db.pragma('foreign_key_check')).toEqual([])
  })

  it('retains installed-app deletion cascades and registers subsequently installed identities', () => {
    const f = seedLegacy()
    f.manager.runMigrations(f.db, 'app_runtime', migrations)
    f.db.exec("DELETE FROM installed_apps WHERE id = 'installed'")
    for (const table of ['runtime_execution_actors', 'activity_entries', 'decision_continuations', 'app_session_environments']) {
      expect(f.db.prepare(`SELECT * FROM ${table}`).all()).toEqual([])
    }
    f.db.exec(`INSERT INTO installed_apps(id,spec_id,spec_json,installed_at) VALUES ('later','spec','{}',1)`)
    expect(f.db.prepare('SELECT installed_app_id FROM runtime_execution_actors WHERE id = ?').get('later')).toEqual({ installed_app_id: 'later' })
  })
})

describe('temporary collaborator activity', () => {
  it('persists a real report-tool decision, recovers its queue and removes only the deleted work', async () => {
    const f = open()
    let store = new ActivityStore(f.db)
    const actor = { appId: 'temporary', teamId: 'team', epochId: 'work', name: 'Reviewer' }
    store.registerParticipantActor(actor)
    store.registerParticipantActor({ appId: 'other', teamId: 'team', epochId: 'other-work', name: 'Other' })
    const server = createReportToolServer(store, { appId: actor.appId, appName: actor.name, runId: 'chat', sessionKey: 'app-chat:temporary:team:team:work',
      teamContext: { teamId: actor.teamId, epochId: actor.epochId, correlationId: 'question', fromAppId: 'lead', wait: false } })
    const result = await server.instance.callTool('report_to_user', { type: 'escalation', message: 'Which route?', choices: ['A', 'B'] })
    expect(result).not.toMatchObject({ isError: true })
    const [entry] = store.getAllPendingEscalations()
    expect(entry).toMatchObject({ appId: actor.appId, content: { teamContext: { teamId: 'team', epochId: 'work' } } })
    expect(store.getPendingInbox()).toMatchObject({ total: 1, names: { temporary: 'Reviewer' } })
    store.acceptDecision(actor.appId, entry.id, { choice: 'A' })
    store.updateContinuation(entry.id, 'running')
    f.manager.closeAll()
    const next = open()
    store = new ActivityStore(next.db)
    expect(store.recoverContinuations()).toBe(1)
    expect(store.getQueuedContinuations()).toHaveLength(1)
    expect(store.getQueuedContinuations()[0].content.teamContext?.epochId).toBe('work')
    expect(next.db.prepare('SELECT * FROM installed_apps').all()).toEqual([])
    expect(store.deleteParticipantActors('team', 'work')).toBe(1)
    expect(store.getEntry(entry.id)).toBeNull()
    expect(store.getQueuedContinuations()).toEqual([])
    expect(store.getParticipantActor('other')).not.toBeNull()
    expect(store.deleteParticipantActors('team')).toBe(1)
    expect(next.db.pragma('foreign_key_check')).toEqual([])
  })

  it('rejects identity reuse and cross-work or unscoped activity without mutating existing records', () => {
    const f = open(), store = new ActivityStore(f.db)
    store.registerParticipantActor({ appId: 'temporary', teamId: 'team', epochId: 'work' })
    expect(() => store.registerParticipantActor({ appId: 'temporary', teamId: 'team', epochId: 'another' })).toThrow(/another owner or work/)
    f.db.exec(`INSERT INTO installed_apps(id,spec_id,spec_json,installed_at) VALUES ('installed','spec','{}',1)`)
    expect(() => store.registerParticipantActor({ appId: 'installed', teamId: 'team', epochId: 'work' })).toThrow(/another owner/)
    for (const teamContext of [undefined, { teamId: 'foreign', epochId: 'work' }, { teamId: 'team', epochId: 'another' }]) {
      expect(() => store.insertEntry({ id: 'bad', appId: 'temporary', runId: 'chat', type: 'escalation', ts: 1, content: { summary: 'Question', teamContext } })).toThrow(/original team and work/)
    }
    expect(store.getAllPendingEscalations()).toEqual([])
  })
})


describe('work deletion and execution actors', () => {
  it.each(['deleteTeam', 'purgeJoinedOffice'] as const)('%s rolls back both stores when actor cleanup fails, then removes both atomically', operation => {
    const f = open()
    f.manager.runMigrations(f.db, 'app_team', teamMigrations)
    const teams = new TeamStore(f.db), activity = new ActivityStore(f.db)
    teams.insertTeam({ id: 'team', name: 'Team', owningSpaceId: 'space', goal: '', leadAppId: null,
      memberSourcing: 'manual', collabMode: 'free', escalationRouting: 'user', status: 'idle', currentEpochId: null,
      createdAt: 1, updatedAt: 1 })
    teams.insertEpoch({ id: 'work', teamId: 'team', startedAt: 1, endedAt: null, endReason: null, summary: null, lifecycle: 'conversation' })
    teams.addMember({ teamId: 'team', appId: 'lead', memberName: 'lead', role: '', isLead: true, aiProvisioned: false, addedAt: 1 })
    teams.participants.insert({ teamId: 'team', epochId: 'work', appId: 'temporary', parentAppId: 'lead', memberName: 'Reviewer', role: '',
      addedAt: 1, isLead: false, aiProvisioned: false, isTemporary: true })
    activity.registerParticipantActor({ appId: 'temporary', teamId: 'team', epochId: 'work' })
    activity.insertEntry({ id: 'question', appId: 'temporary', runId: 'chat', type: 'escalation', ts: 1,
      content: { summary: 'Proceed?', teamContext: { teamId: 'team', epochId: 'work' } } })
    activity.acceptDecision('temporary', 'question', { text: 'Proceed' })
    teams.setWorkRemovedHandler(teamId => { activity.deleteParticipantActors(teamId); throw new Error('cleanup failed') })
    expect(() => teams[operation]('team')).toThrow('cleanup failed')
    expect(teams.getTeamById('team')).not.toBeNull()
    expect(teams.getMember('team', 'lead')).not.toBeNull()
    expect(teams.participants.get('team', 'work', 'temporary')).not.toBeNull()
    expect(activity.getEntry('question')?.continuation?.status).toBe('queued')
    teams.setWorkRemovedHandler(teamId => { activity.deleteParticipantActors(teamId) })
    expect(teams[operation]('team')).toBe(true)
    expect(teams.getTeamById('team')).toBeNull()
    expect(activity.getParticipantActor('temporary')).toBeNull()
    expect(activity.getEntry('question')).toBeNull()
    expect(activity.getQueuedContinuations()).toEqual([])
    expect(f.db.pragma('foreign_key_check')).toEqual([])
  })
})
