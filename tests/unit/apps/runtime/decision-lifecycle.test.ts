import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import { migrations as managerMigrations } from '../../../../src/main/apps/manager/migrations'
import { migrations } from '../../../../src/main/apps/runtime/migrations'
import { ActivityStore } from '../../../../src/main/apps/runtime/store'
import { Semaphore } from '../../../../src/main/apps/runtime/concurrency'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import type { EscalationAnswerPayload } from '../../../../src/shared/apps/app-types'

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
  afterEach(() => {
    vi.restoreAllMocks()
    manager.closeAll()
  })

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

  function asked(id: string, questions: { question: string; choices?: string[] }[]): void {
    store.insertRun({ runId: id, appId: 'person', sessionKey: `session-${id}`, status: 'waiting_user', triggerType: 'manual', startedAt: Date.now() })
    store.insertEntry({ id, appId: 'person', runId: id, type: 'escalation', ts: Date.now(), content: { summary: 'Audit done', questions } })
  }

  it('accepts a one-question request answered flat or as a list, and treats both as the same answer', () => {
    asked('one', [{ question: 'Which fix path?', choices: ['A', 'B', 'C'] }])
    expect(store.acceptDecision('person', 'one', { ts: 1, choice: 'A' }).continuation?.status).toBe('queued')
    expect(store.acceptDecision('person', 'one', { ts: 2, answers: [{ choice: 'A' }] }).userResponse?.choice).toBe('A')
    expect(() => store.acceptDecision('person', 'one', { ts: 3, choice: 'B' })).toThrow(/differently/)
    expect(store.getQueuedContinuations()).toHaveLength(1)

    asked('list', [{ question: 'Which fix path?' }])
    expect(store.acceptDecision('person', 'list', { ts: 1, answers: [{ text: 'A, but after release' }] }).continuation?.status).toBe('queued')
  })

  it('rejects answers that leave a question blank or do not match the questions asked', () => {
    asked('one', [{ question: 'Which fix path?' }])
    expect(() => store.acceptDecision('person', 'one', { ts: 1, text: '   ' })).toThrow(/every question/)
    expect(() => store.acceptDecision('person', 'one', { ts: 1, answers: [{ choice: 'A' }, { choice: 'B' }] })).toThrow(/every question/)
    asked('two', [{ question: 'Fix path?', choices: ['A', 'B'] }, { question: 'Release window?' }])
    expect(() => store.acceptDecision('person', 'two', { ts: 1, choice: 'A' })).toThrow(/every question/)
    expect(() => store.acceptDecision('person', 'two', { ts: 1, answers: [{ choice: 'A' }, {}] })).toThrow(/every question/)
    expect(store.acceptDecision('person', 'two', { ts: 1, answers: [{ choice: 'A' }, { text: 'Before 10.30' }] }).continuation?.status).toBe('queued')
    question('legacy')
    expect(() => store.acceptDecision('person', 'legacy', { ts: 1 })).toThrow(/every question/)
    expect(store.getEntry('one')?.userResponse).toBeUndefined()
  })

  it.each([
    ['null response', null, 'objects'],
    ['missing response', undefined, 'objects'],
    ['string response', 'Approve', 'objects'],
    ['number response', 42, 'objects'],
    ['boolean response', false, 'objects'],
    ['array response', [], 'objects'],
    ['numeric choice', { choice: 1 }, 'strings'],
    ['null choice', { choice: null, text: 'Approve' }, 'strings'],
    ['object choice', { choice: {}, text: 'Approve' }, 'strings'],
    ['boolean text', { choice: 'Approve', text: false }, 'strings'],
    ['null text', { choice: 'Approve', text: null }, 'strings'],
    ['array text', { choice: 'Approve', text: [] }, 'strings'],
    ['empty answers with flat fallback', { text: 'Approve', answers: [] }, 'non-empty array'],
    ['null answers with flat fallback', { text: 'Approve', answers: null }, 'non-empty array'],
    ['false answers with flat fallback', { text: 'Approve', answers: false }, 'non-empty array'],
    ['string answers', { answers: 'Approve' }, 'non-empty array'],
    ['array-like answers', { answers: { 0: { text: 'Approve' }, length: 1 } }, 'non-empty array'],
    ['null answer item', { answers: [null] }, 'objects'],
    ['missing answer item', { answers: [undefined] }, 'objects'],
    ['sparse answers', { answers: new Array(1) }, 'objects'],
    ['array answer item', { answers: [[]] }, 'objects'],
    ['string answer item', { answers: ['Approve'] }, 'objects'],
    ['numeric answer item', { answers: [1] }, 'objects'],
    ['numeric nested text', { answers: [{ text: 1 }] }, 'strings'],
    ['object nested choice', { answers: [{ choice: {}, text: 'Approve' }] }, 'strings'],
    ['invalid unused flat text', { text: null, answers: [{ choice: 'Approve' }] }, 'strings'],
    ['empty flat answer', {}, 'every question'],
    ['blank flat answer', { choice: ' \t', text: '\n ' }, 'every question'],
    ['empty answer item', { answers: [{}] }, 'every question'],
    ['blank answer item', { answers: [{ choice: '', text: ' \n' }] }, 'every question'],
    ['too many answers', { answers: [{ choice: 'Approve' }, { text: 'Later' }] }, 'every question'],
    ['unknown choice', { choice: 'Other' }, 'exactly match'],
    ['different choice case', { choice: 'approve' }, 'exactly match'],
    ['padded choice', { choice: ' Approve ' }, 'exactly match'],
    ['unknown choice with valid text', { choice: 'Other', text: 'Approve' }, 'exactly match'],
    ['unknown flat choice with valid answers', { choice: 'Other', answers: [{ choice: 'Approve' }] }, 'exactly match'],
  ] as Array<[string, unknown, string]>)('rejects %s without writing or queueing, then accepts a corrected answer', (_label, response, reason) => {
    asked('invalid', [{ question: 'Proceed?', choices: ['Approve', 'Reject'] }])
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const before = manager.getAppDatabase().prepare('SELECT total_changes() AS count').get()

    expect(() => store.acceptDecision('person', 'invalid', response)).toThrow(reason)

    expect(manager.getAppDatabase().prepare('SELECT total_changes() AS count').get()).toEqual(before)
    expect(store.getEntry('invalid')?.userResponse).toBeUndefined()
    expect(store.getEntry('invalid')?.continuation).toBeUndefined()
    expect(store.getQueuedContinuations()).toEqual([])
    expect(store.getPendingEscalation('person', 'invalid')).not.toBeNull()
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('[Runtime] Decision answer rejected', {
      appId: 'person', entryId: 'invalid', reason: expect.stringContaining(reason),
    })

    const accepted = store.acceptDecision('person', 'invalid', { choice: 'Approve' })
    expect(accepted.userResponse?.choice).toBe('Approve')
    expect(accepted.continuation?.status).toBe('queued')
    expect(store.getQueuedContinuations()).toHaveLength(1)
  })

  it.each(['<exact choice selected by the owner>', '<the owner’s answer>'])(
    'rejects the exact trimmed template %s in either field without losing the next real answer', placeholder => {
      asked('template', [{ question: 'Proceed?', choices: ['Approve', placeholder] }])
      const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const invalid: EscalationAnswerPayload[] = [
        { choice: ` ${placeholder}\n` },
        { text: `\t${placeholder} ` },
        { choice: placeholder, text: 'Proceed tomorrow' },
        { choice: 'Approve', text: placeholder },
        { answers: [{ choice: placeholder }] },
        { answers: [{ text: placeholder }] },
        { text: placeholder, answers: [{ choice: 'Approve' }] },
      ]
      const before = manager.getAppDatabase().prepare('SELECT total_changes() AS count').get()
      for (const response of invalid) {
        expect(() => store.acceptDecision('person', 'template', response)).toThrow(/answer template/)
      }
      expect(manager.getAppDatabase().prepare('SELECT total_changes() AS count').get()).toEqual(before)
      expect(log).toHaveBeenCalledTimes(invalid.length)
      expect(store.getEntry('template')?.userResponse).toBeUndefined()
      expect(store.getQueuedContinuations()).toEqual([])
      expect(store.acceptDecision('person', 'template', { text: 'Proceed tomorrow' }).continuation?.status).toBe('queued')
    },
  )

  it('matches each choice to its own question and rejects choices for free-form questions', () => {
    asked('mixed', [
      { question: 'Proceed?', choices: ['Approve', 'Reject'] },
      { question: 'When?', choices: ['Now', 'Later'] },
      { question: 'Anything else?' },
    ])
    const invalid = [
      [{ choice: 'Now' }, { choice: 'Approve' }, { text: 'No' }],
      [{ choice: 'Approve' }, { choice: 'Later' }, { choice: 'Anything', text: 'No' }],
    ]
    for (const answers of invalid) {
      expect(() => store.acceptDecision('person', 'mixed', { answers })).toThrow(/exactly match/)
      expect(store.getEntry('mixed')?.userResponse).toBeUndefined()
      expect(store.getEntry('mixed')?.continuation).toBeUndefined()
    }
    question('free-form')
    expect(() => store.acceptDecision('person', 'free-form', { choice: 'Yes' })).toThrow(/exactly match/)
    const answers = [{ choice: 'Approve', text: 'After review' }, { text: 'Tomorrow' }, { text: 'No' }]
    expect(store.acceptDecision('person', 'mixed', { answers }).userResponse?.answers).toEqual(answers)
    expect(store.getQueuedContinuations()).toHaveLength(1)
  })

  it.each([
    { text: 'Choose a different approach' },
    { choice: 'Approve', text: 'After the review' },
    { choice: '', text: 'Choose a different approach' },
    { choice: ' \t', text: 'Choose a different approach' },
    { choice: 'Approve', text: ' \n' },
    { text: ' <the owner’s answer> is a literal example, not my answer ' },
    { text: "<the owner's answer>" },
    { text: '<exact choice selected by the owner> with additional instructions' },
    { text: '待确认' },
  ])('preserves free text and choice-plus-text in both single-question shapes: %j', answer => {
    for (const shape of ['flat', 'list']) {
      asked(shape, [{ question: 'Proceed?', choices: ['Approve', 'Reject'] }])
      const payload = shape === 'flat' ? answer : { answers: [answer] }
      const accepted = store.acceptDecision('person', shape, payload)
      expect(accepted.userResponse).toEqual({ ...payload, ts: expect.any(Number) })
      const retry = shape === 'flat' ? { answers: [answer] } : answer
      expect(store.acceptDecision('person', shape, retry)).toEqual(accepted)
      expect(() => store.acceptDecision('person', shape, { text: 'Changed my mind' })).toThrow(/differently/)
      expect(store.getEntry(shape)?.userResponse).toEqual(accepted.userResponse)
    }
    expect(store.getQueuedContinuations()).toHaveLength(2)
  })

  it('preserves valid flat fields when an answers list supplies the effective answer', () => {
    asked('combined', [{ question: 'Proceed?', choices: ['Approve', 'Reject'] }])
    const response = { choice: 'Approve', text: 'Additional context', answers: [{ text: 'Proceed tomorrow' }] }
    const accepted = store.acceptDecision('person', 'combined', response)
    expect(accepted.userResponse).toEqual({ ...response, ts: expect.any(Number) })
    expect(store.acceptDecision('person', 'combined', { answers: response.answers })).toEqual(accepted)
    expect(store.getQueuedContinuations()).toHaveLength(1)
  })

  it('keeps legacy single-question choices and ignores malformed retry attempts', () => {
    store.insertEntry({ id: 'legacy-choice', appId: 'person', runId: 'chat', type: 'escalation', ts: Date.now(),
      content: { summary: 'Proceed?', question: 'Which path?', choices: ['A', 'B'] } })
    expect(() => store.acceptDecision('person', 'legacy-choice', { choice: 'C' })).toThrow(/exactly match/)
    const accepted = store.acceptDecision('person', 'legacy-choice', { choice: 'A', text: 'After review' })
    expect(() => store.acceptDecision('person', 'legacy-choice', { answers: [null] })).toThrow(/objects/)
    expect(store.getEntry('legacy-choice')).toEqual(accepted)
    expect(store.getQueuedContinuations()).toHaveLength(1)
  })

  it('logs only decision identity and reason, never the invalid answer or extra credentials', () => {
    asked('private', [{ question: 'Proceed?', choices: ['Approve', 'Reject'] }])
    const log = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(() => store.acceptDecision('person', 'private', {
      choice: 'private-owner-answer', text: 'private-owner-explanation', token: 'private-credential-marker',
    })).toThrow(/exactly match/)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('[Runtime] Decision answer rejected', {
      appId: 'person', entryId: 'private',
      reason: 'Decision choice must exactly match an offered choice; use text for a free-form answer',
    })
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

  it('dismisses one request without forging an answer, closing its work or touching the others', () => {
    question('team', undefined, 'team-a')
    question('solo')
    const dismissed = store.dismissDecision('team')
    expect(dismissed?.content.resolution?.reason).toBe('dismissed')
    expect(dismissed?.userResponse).toBeUndefined()
    expect(store.isRunClosed('team')).toBe(false)
    expect(store.getAllPendingEscalations().map(entry => entry.id)).toEqual(['solo'])
    expect(() => store.acceptDecision('person', 'team', { ts: 1, text: 'yes' })).toThrow('closed')
    expect(store.dismissDecision('team')).toBeNull()
  })

  it('leaves an answered request alone and cancels work still queued behind a dismissed one', () => {
    question('answered')
    question('queued')
    store.acceptDecision('person', 'answered', { ts: 1, text: 'yes' })
    store.updateContinuation('answered', 'completed')
    expect(store.dismissDecision('answered')).toBeNull()
    expect(store.getEntry('answered')?.userResponse?.text).toBe('yes')
    store.acceptDecision('person', 'queued', { ts: 1, text: 'go' })
    expect(store.dismissDecision('queued')?.continuation?.status).toBe('cancelled')
    expect(store.getEntry('queued')?.userResponse?.text).toBe('go')
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

  it('carries stopped people alongside the questions, unpaginated and with their recorded cause', () => {
    question('a')
    const db = manager.getAppDatabase()
    db.prepare(`INSERT INTO installed_apps(id, spec_id, space_id, spec_json, status, error_message, installed_at)
      VALUES ('stopped', 'stopped-spec', 'space', '{"type":"automation","name":"Scout"}', 'error', 'Auto-disabled after 3 consecutive errors', 1)`).run()
    db.prepare(`INSERT INTO installed_apps(id, spec_id, space_id, spec_json, status, installed_at)
      VALUES ('gone', 'gone-spec', 'space', '{"type":"automation"}', 'uninstalled', 1)`).run()
    db.prepare(`INSERT INTO installed_apps(id, spec_id, space_id, spec_json, status, installed_at)
      VALUES ('tool', 'tool-spec', 'space', '{"type":"mcp"}', 'error', 1)`).run()
    const inbox = store.getPendingInbox({ limit: 1 })
    expect(inbox.blocked).toEqual([{ appId: 'stopped', name: 'Scout', reason: 'auto_disabled', message: 'Auto-disabled after 3 consecutive errors' }])
    // One question plus one stopped person: the badge counts work, not questions.
    expect(inbox.total).toBe(2)
    expect(store.getPendingInbox({ limit: 1, afterTs: inbox.entries[0].ts, afterId: inbox.entries[0].id }).blocked).toHaveLength(1)
    db.prepare("UPDATE installed_apps SET status = 'active', error_message = NULL WHERE id = 'stopped'").run()
    expect(store.getPendingInbox().blocked).toEqual([])
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
