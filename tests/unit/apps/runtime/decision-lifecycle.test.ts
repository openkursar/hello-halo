import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import { migrations as managerMigrations } from '../../../../src/main/apps/manager/migrations'
import { migrations } from '../../../../src/main/apps/runtime/migrations'
import { ActivityStore } from '../../../../src/main/apps/runtime/store'
import { Semaphore } from '../../../../src/main/apps/runtime/concurrency'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'

describe('durable decisions', () => {
  let manager: DatabaseManager
  let store: ActivityStore
  beforeEach(() => {
    manager = createDatabaseManager(':memory:')
    const db = manager.getAppDatabase()
    manager.runMigrations(db, 'app_manager', managerMigrations)
    manager.runMigrations(db, 'app_runtime', migrations)
    db.prepare(`INSERT INTO installed_apps(id, spec_id, space_id, spec_json, installed_at) VALUES ('person', 'spec', 'space', '{"type":"automation"}', 1)`).run()
    store = new ActivityStore(db)
  })
  afterEach(() => manager.closeAll())

  function question(id: string, deadlineAt?: number, team?: string): void {
    store.insertRun({ runId: id, appId: 'person', sessionKey: `session-${id}`, status: 'waiting_user', triggerType: 'manual', startedAt: Date.now() })
    store.insertEntry({ id, appId: 'person', runId: id, type: 'escalation', ts: Date.now(), content: {
      summary: 'Proceed?', deadlineAt, ...(team ? { teamContext: { teamId: team, epochId: `task-${id}` } } : {}),
    } })
  }

  it('atomically accepts one answer and one continuation, with idempotent retries', () => {
    question('a')
    const response = { ts: 1, text: 'Proceed' }
    const accepted = store.acceptDecision('person', 'a', response)
    expect(accepted.userResponse?.ts).toBeGreaterThan(1)
    expect(accepted.continuation?.status).toBe('queued')
    store.acceptDecision('person', 'a', { ...response, ts: 2 })
    expect(store.getQueuedContinuations()).toHaveLength(1)
    expect(() => store.acceptDecision('person', 'a', { ts: 3, text: 'Stop' })).toThrow(/differently/)
    expect(store.getEntry('a')?.userResponse?.text).toBe('Proceed')
  })

  it('rolls the answer back when scheduling cannot persist', () => {
    question('a')
    manager.getAppDatabase().exec(`CREATE TRIGGER fail_outbox BEFORE INSERT ON decision_continuations BEGIN SELECT RAISE(ABORT, 'disk failure'); END;`)
    expect(() => store.acceptDecision('person', 'a', { ts: 1, text: 'yes' })).toThrow('disk failure')
    expect(store.getEntry('a')?.userResponse).toBeUndefined()
  })

  it('expires one request without a forged answer, another request or a global error', () => {
    question('old', Date.now() - 1)
    question('future', Date.now() + 60000)
    question('team', undefined, 'team')
    expect(store.expireDecisions(Date.now()).map(entry => entry.id)).toEqual(['old'])
    expect(store.getEntry('old')?.content.resolution?.reason).toBe('expired')
    expect(store.getEntry('old')?.userResponse).toBeUndefined()
    expect(store.hasUnfinishedRunDecision('old')).toBe(true)
    expect(store.getAllPendingEscalations()).toHaveLength(2)
    expect(() => store.acceptDecision('person', 'old', { ts: 1, text: 'yes' })).toThrow('closed')
  })

  it('keeps accepted answers when a deadline passes and when a process restarts', () => {
    question('a', Date.now() + 10000)
    store.acceptDecision('person', 'a', { ts: 1, text: 'yes' })
    store.updateContinuation('a', 'running')
    store = new ActivityStore(manager.getAppDatabase())
    expect(store.recoverContinuations()).toBe(1)
    expect(store.getQueuedContinuations()[0].userResponse?.text).toBe('yes')
    expect(store.expireDecisions(Date.now() + 20000)).toEqual([])
    store.updateContinuation('a', 'failed', 'Network unavailable')
    expect(store.getEntry('a')?.userResponse?.text).toBe('yes')
    expect(store.getEntry('a')?.continuation?.error).toBe('Network unavailable')
  })

  it('closes only the owning task and cancels accepted work without erasing its answer', () => {
    question('a', undefined, 'team-a')
    question('b', undefined, 'team-b')
    question('solo')
    store.acceptDecision('person', 'a', { ts: 1, text: 'yes' })
    store.closeTaskEscalations('team-a', 'task-a')
    expect(store.getEntry('a')?.continuation?.status).toBe('cancelled')
    expect(store.getEntry('a')?.userResponse?.text).toBe('yes')
    expect(store.getAllPendingEscalations().map(entry => entry.id).sort()).toEqual(['b', 'solo'])
    store.closeRun('solo')
    expect(() => store.acceptDecision('person', 'solo', { ts: 1, text: 'yes' })).toThrow('closed')
    expect(store.getEntry('solo')?.userResponse).toBeUndefined()
  })

  it('includes coordinator decisions in the bounded inbox and excludes uninstalled people', () => {
    question('a')
    manager.getAppDatabase().prepare(`INSERT INTO installed_apps(id, spec_id, space_id, spec_json, installed_at) VALUES ('coordinator', 'lead', 'space', '{"type":"automation"}', 1)`).run()
    store.insertEntry({ id: 'team-question', appId: 'coordinator', runId: 'chat', type: 'escalation', ts: Date.now() + 10,
      content: { summary: 'Team approval', teamContext: { teamId: 'team', epochId: 'task' } } })
    const first = store.getPendingInbox({ limit: 1 })
    expect(first.entries).toHaveLength(1)
    expect(first.total).toBe(2)
    const next = store.getPendingInbox({ limit: 1, afterTs: first.entries[0].ts, afterId: first.entries[0].id })
    expect(next.entries[0].appId).toBe('coordinator')
    manager.getAppDatabase().prepare("UPDATE installed_apps SET status = 'uninstalled', uninstalled_at = ? WHERE id = 'coordinator'").run(Date.now())
    expect(store.getPendingInbox().total).toBe(1)
  })

  it('keeps stable cursors across equal timestamps and answered earlier pages', () => {
    for (const id of ['a', 'b', 'c']) question(id)
    manager.getAppDatabase().prepare('UPDATE activity_entries SET ts = 10').run()
    const first = store.getPendingEntries('person', { limit: 1 })[0]
    expect(first.id).toBe('a')
    store.acceptDecision('person', 'a', { ts: 1, text: 'yes' })
    expect(store.getPendingEntries('person', { limit: 2, afterTs: first.ts, afterId: first.id }).map(entry => entry.id)).toEqual(['b', 'c'])
    const history = store.getEntriesForApp('person', { limit: 1 })[0]
    expect(history.id).toBe('c')
    expect(store.getEntriesForApp('person', { limit: 2, since: history.ts, beforeId: history.id }).map(entry => entry.id)).toEqual(['b', 'a'])
  })

  it('does not assign a default deadline to a newly installed person', () => {
    question('a')
    expect(store.getEntry('a')?.content.deadlineAt).toBeUndefined()
  })

  it('protects pending decisions and failed continuations from retention pruning', () => {
    question('a')
    store.acceptDecision('person', 'a', { ts: 1, text: 'yes' })
    store.updateContinuation('a', 'failed', 'retry needed')
    store.updateRunStatus('a', 'error')
    manager.getAppDatabase().prepare('UPDATE automation_runs SET started_at = 0').run()
    expect(store.pruneOldData(1)).toBe(0)
    expect(store.getEntry('a')?.userResponse?.text).toBe('yes')
  })
})

describe('decision migration', () => {
  it('retains expired historical questions for explicit deadline review and preserves audit data', () => {
    const manager = createDatabaseManager(':memory:')
    try {
      const db = manager.getAppDatabase()
      manager.runMigrations(db, 'app_manager', managerMigrations)
      manager.runMigrations(db, 'app_runtime', migrations.filter(migration => migration.version <= 6))
      db.prepare(`INSERT INTO installed_apps(id, spec_id, space_id, spec_json, installed_at) VALUES ('old', 'spec', 'space', '{"type":"automation"}', 1)`).run()
      const insert = db.prepare(`INSERT INTO activity_entries(id, app_id, run_id, type, ts, content_json, user_response_json) VALUES (?, 'old', 'chat', 'escalation', 1, '{"summary":"Proceed?"}', ?)`)
      insert.run('pending', null)
      insert.run('system', JSON.stringify({ ts: 2, text: '[Auto-closed] Escalation orphaned by app state change.' }))
      insert.run('person', JSON.stringify({ ts: 2, text: 'Yes' }))
      manager.runMigrations(db, 'app_runtime', migrations)
      const store = new ActivityStore(db)
      expect(store.getEntry('pending')?.content).toMatchObject({ deadlineAt: 86400001, deadlineReviewRequired: true, source: { kind: 'unknown' } })
      expect(store.expireDecisions(Date.now())).toEqual([])
      expect(() => store.acceptDecision('old', 'pending', { ts: 1, text: 'yes' })).toThrow(/historical deadline/)
      store.confirmDeadline('old', 'pending', null)
      expect(store.getEntry('pending')?.content.deadlineReview).toMatchObject({ originalDeadlineAt: 86400001, deadlineAt: null })
      expect(store.getEntry('pending')?.content.deadlineReview?.confirmedAt).toBeGreaterThan(0)
      expect(store.acceptDecision('old', 'pending', { ts: 1, text: 'yes' }).continuation?.status).toBe('queued')
      expect(store.getEntry('system')?.userResponse).toBeUndefined()
      expect(store.getEntry('system')?.content.resolution).toMatchObject({ reason: 'legacy_system_closed', attribution: 'unverified', legacyText: '[Auto-closed] Escalation orphaned by app state change.' })
      expect(store.getEntry('person')?.userResponse?.text).toBe('Yes')
      expect(db.prepare('SELECT COUNT(*) AS count FROM runtime_decision_migration_backup').get()).toEqual({ count: 3 })
    } finally { manager.closeAll() }
  })
})

it('removes cancelled automatic work from the resource queue immediately', async () => {
  const semaphore = new Semaphore(1)
  semaphore.tryAcquire()
  const controller = new AbortController()
  const queued = semaphore.acquire(controller.signal)
  controller.abort()
  await expect(queued).rejects.toThrow('cancelled')
  expect(semaphore.waitingCount).toBe(0)
  expect(semaphore.activeCount).toBe(1)
  semaphore.release()
  expect(semaphore.activeCount).toBe(0)
})
