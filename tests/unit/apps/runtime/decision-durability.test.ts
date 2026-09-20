import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import { migrations as managerMigrations } from '../../../../src/main/apps/manager/migrations'
import { migrations } from '../../../../src/main/apps/runtime/migrations'
import { ActivityStore } from '../../../../src/main/apps/runtime/store'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'

describe('decision disk durability and competing connections', () => {
  let directory: string
  let databasePath: string
  let connections: DatabaseManager[]
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'halo-decision-durability-'))
    databasePath = join(directory, 'app.db')
    connections = []
  })
  afterEach(() => {
    vi.restoreAllMocks()
    connections.forEach(connection => connection.closeAll())
    rmSync(directory, { recursive: true, force: true })
  })
  function open(version = 7): { manager: DatabaseManager; store: ActivityStore } {
    const manager = createDatabaseManager(databasePath)
    connections.push(manager)
    const db = manager.getAppDatabase()
    manager.runMigrations(db, 'app_manager', managerMigrations)
    manager.runMigrations(db, 'app_runtime', migrations.filter(migration => migration.version <= version))
    db.pragma('busy_timeout = 20')
    return { manager, store: version === 7 ? new ActivityStore(db) : undefined! }
  }
  function seed(manager: DatabaseManager, store: ActivityStore): void {
    manager.getAppDatabase().prepare(`INSERT INTO installed_apps(id, spec_id, space_id, spec_json, installed_at) VALUES ('person', 'spec', 'original-space', '{"type":"automation"}', 1)`).run()
    store.insertRun({ runId: 'run', appId: 'person', sessionKey: 'original-thread', status: 'waiting_user', triggerType: 'manual', startedAt: 1,
      environment: { spaceId: 'original-space', spacePath: '/original/storage', workDir: '/original/work', memoryDir: '/original/memory', mcpBindings: { mail: 'original-account' } } })
    store.updateRunSessionId('run', 'original-engine-session')
    store.insertEntry({ id: 'decision', appId: 'person', runId: 'run', type: 'escalation', ts: 1, content: { summary: 'Approve?' } })
  }

  it('reopens the disk file with the same accepted answer, source, original context and recoverable outbox', () => {
    const first = open()
    seed(first.manager, first.store)
    const accepted = first.store.acceptDecision('person', 'decision', { ts: 1, text: 'Approved' })
    first.store.updateContinuation('decision', 'running')
    first.manager.closeAll()
    const second = open()
    expect(second.store.getEntry('decision')?.userResponse).toEqual(accepted.userResponse)
    expect(second.store.getEntry('decision')?.content.source).toEqual(accepted.content.source)
    expect(second.store.getRun('run')).toMatchObject({ sessionKey: 'original-thread', sessionId: 'original-engine-session', environment: {
      spaceId: 'original-space', spacePath: '/original/storage', workDir: '/original/work', memoryDir: '/original/memory', mcpBindings: { mail: 'original-account' },
    } })
    expect(second.store.recoverContinuations()).toBe(1)
    expect(second.store.recoverContinuations()).toBe(0)
    expect(second.store.getQueuedContinuations().map(entry => entry.id)).toEqual(['decision'])
    second.store.acceptDecision('person', 'decision', { ts: 2, text: 'Approved' })
    expect(second.store.getQueuedContinuations()).toHaveLength(1)
  })

  it('does not resurrect a task closed by a second connection after the answer transaction read', () => {
    const first = open()
    seed(first.manager, first.store)
    const second = open()
    const read = first.store.getEntry.bind(first.store)
    vi.spyOn(first.store, 'getEntry').mockImplementationOnce(id => {
      const entry = read(id)
      second.store.closeRun('run')
      return entry
    })
    expect(() => first.store.acceptDecision('person', 'decision', { ts: 1, text: 'Approved' })).toThrow(/locked|busy/i)
    first.manager.closeAll()
    second.manager.closeAll()
    const reopened = open()
    expect(reopened.store.isRunClosed('run')).toBe(true)
    expect(reopened.store.getEntry('decision')?.userResponse).toBeUndefined()
    expect(reopened.store.getEntry('decision')?.content.resolution?.reason).toBe('task_closed')
    expect(reopened.store.getQueuedContinuations()).toEqual([])
  })

  it('preserves the winning answer but cancels its continuation when another connection closes next', () => {
    const first = open()
    seed(first.manager, first.store)
    const second = open()
    first.store.acceptDecision('person', 'decision', { ts: 1, text: 'Approved' })
    expect(() => second.store.acceptDecision('person', 'decision', { ts: 2, text: 'Rejected' })).toThrow(/differently/)
    second.store.closeRun('run')
    first.manager.closeAll()
    second.manager.closeAll()
    const reopened = open()
    expect(reopened.store.getEntry('decision')?.userResponse?.text).toBe('Approved')
    expect(reopened.store.getEntry('decision')?.continuation?.status).toBe('cancelled')
    expect(reopened.store.recoverContinuations()).toBe(0)
    expect(reopened.store.getQueuedContinuations()).toEqual([])
  })

  it('rolls back migration schema, audit snapshot and changed rows together, then safely retries after reopen', () => {
    const original = open(6)
    const db = original.manager.getAppDatabase()
    db.prepare(`INSERT INTO installed_apps(id, spec_id, space_id, spec_json, installed_at) VALUES ('person', 'spec', 'space', '{"type":"automation"}', 1)`).run()
    const response = JSON.stringify({ ts: 2, text: '[Auto-closed] Escalation orphaned by app state change.' })
    const insert = db.prepare(`INSERT INTO activity_entries(id, app_id, run_id, type, ts, content_json, user_response_json) VALUES (?, 'person', 'old-run', 'escalation', 1, '{"summary":"Proceed?"}', ?)`)
    insert.run('old-closed', response)
    insert.run('old-pending', null)
    const originalRows = db.prepare('SELECT id, content_json, user_response_json FROM activity_entries ORDER BY id').all()
    db.exec(`CREATE TRIGGER migration_io_failure BEFORE UPDATE ON activity_entries WHEN NEW.id = 'old-pending' BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END;`)
    expect(() => original.manager.runMigrations(db, 'app_runtime', migrations)).toThrow('simulated storage failure')
    original.manager.closeAll()
    const retry = open(6)
    const reopenedDb = retry.manager.getAppDatabase()
    expect(reopenedDb.prepare('SELECT id, content_json, user_response_json FROM activity_entries ORDER BY id').all()).toEqual(originalRows)
    expect(reopenedDb.prepare("SELECT version FROM _migrations WHERE namespace = 'app_runtime'").get()).toEqual({ version: 6 })
    expect(reopenedDb.prepare("SELECT name FROM sqlite_master WHERE name IN ('runtime_decision_migration_backup', 'decision_continuations')").all()).toEqual([])
    reopenedDb.exec('DROP TRIGGER migration_io_failure')
    retry.manager.runMigrations(reopenedDb, 'app_runtime', migrations)
    expect(reopenedDb.prepare('SELECT id, content_json, user_response_json FROM runtime_decision_migration_backup ORDER BY id').all()).toEqual(originalRows)
    const migrated = new ActivityStore(reopenedDb)
    expect(migrated.getEntry('old-closed')?.content.resolution).toMatchObject({ reason: 'legacy_system_closed', attribution: 'unverified' })
    expect(migrated.getPendingEntries('person').map(entry => entry.id)).toEqual(['old-pending'])
  })
})
