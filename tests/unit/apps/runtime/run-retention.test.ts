/**
 * A digital human keeps the process transcripts of its newest 200 runs. Older
 * runs keep their timeline line and lose their transcript, their engine
 * session and the offer to continue them — a few at a time, at the end of the
 * person's runs, and never anything still in use or not a run's own file.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../../../../src/main/services/agent', () => ({ deleteStoredSession: vi.fn() }))

import { deleteStoredSession } from '../../../../src/main/services/agent'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import { ActivityStore } from '../../../../src/main/apps/runtime/store'
import { MIGRATION_NAMESPACE as RUNTIME_NS, migrations as runtimeMigrations } from '../../../../src/main/apps/runtime/migrations'
import { MIGRATION_NAMESPACE as MANAGER_NS, migrations as managerMigrations } from '../../../../src/main/apps/manager/migrations'
import {
  clearOldRunTranscripts,
  RUN_TRANSCRIPTS_CLEARED_PER_PASS,
  RUN_TRANSCRIPTS_KEPT,
} from '../../../../src/main/apps/runtime/run-retention'

const APP = 'app-busy'
const T0 = Date.UTC(2026, 8, 1)
const MIN = 60_000

let dbManager: DatabaseManager
let store: ActivityStore
let spacePath: string
let runsDir: string

beforeEach(() => {
  vi.mocked(deleteStoredSession).mockClear()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  dbManager = createDatabaseManager(':memory:')
  const db = dbManager.getAppDatabase()
  dbManager.runMigrations(db, MANAGER_NS, managerMigrations)
  dbManager.runMigrations(db, RUNTIME_NS, runtimeMigrations)
  db.prepare(`
    INSERT INTO installed_apps (id, spec_id, space_id, spec_json, status, user_config_json, user_overrides_json, permissions_json, installed_at)
    VALUES (?, 'busy', 'space-1', '{}', 'active', '{}', '{}', '{"granted":[],"denied":[]}', ?)
  `).run(APP, T0)
  store = new ActivityStore(db)
  spacePath = mkdtempSync(join(tmpdir(), 'halo-retention-'))
  runsDir = join(spacePath, '.halo', 'apps', APP, 'runs')
  mkdirSync(runsDir, { recursive: true })
})

afterEach(() => {
  dbManager.closeAll()
  rmSync(spacePath, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const runId = (n: number) => `run-${String(n).padStart(4, '0')}`
const transcript = (n: number) => join(runsDir, `${runId(n)}.jsonl`)

/** Runs 1..count, one a minute; each wrote a transcript and has a failure entry offering to continue. */
function seedRuns(count: number, options: { status?: (n: number) => string } = {}) {
  for (let n = 1; n <= count; n++) {
    const status = options.status?.(n) ?? 'error'
    store.insertRun({
      runId: runId(n), appId: APP, sessionKey: `sk-${n}`, status: 'running', triggerType: 'schedule', startedAt: T0 + n * MIN,
      environment: { spaceId: 'space-1', spacePath, workDir: join(spacePath, 'work'), memoryDir: join(spacePath, 'memory') },
    })
    if (status !== 'running') store.completeRun(runId(n), { status: status as 'error', finishedAt: T0 + n * MIN + 1000, durationMs: 1000 })
    store.updateRunSessionId(runId(n), `engine-${n}`)
    if (status !== 'skipped') writeFileSync(transcript(n), '{"type":"user"}\n')
    store.insertEntry({ id: `entry-${n}`, appId: APP, runId: runId(n), type: 'run_error', ts: T0 + n * MIN + 1000, content: { summary: 'Failed', status: 'error' } })
  }
}

describe('clearOldRunTranscripts', () => {
  it('keeps the newest 200 and clears the rest: transcript, engine session and the offer to continue go, the timeline line stays', () => {
    seedRuns(203)
    expect(store.getEntry('entry-1')?.content.resumeAvailable).toBe(true)

    expect(clearOldRunTranscripts(store, APP, null)).toBe(3)

    for (const n of [1, 2, 3]) {
      expect(existsSync(transcript(n))).toBe(false)
      expect(store.getRun(runId(n))).toMatchObject({ transcriptClearedAt: expect.any(Number), sessionId: undefined })
      expect(store.getEntry(`entry-${n}`)?.content).toMatchObject({ summary: 'Failed' })
      expect(store.getEntry(`entry-${n}`)?.content.resumeAvailable).toBeUndefined()
      expect(deleteStoredSession).toHaveBeenCalledWith(join(spacePath, 'work'), `engine-${n}`)
    }
    expect(existsSync(transcript(4))).toBe(true)
    expect(store.getRun(runId(4))?.transcriptClearedAt).toBeUndefined()
    expect(store.getEntry('entry-4')?.content.resumeAvailable).toBe(true)
    expect(readdirSync(runsDir).filter(name => name.startsWith('run-'))).toHaveLength(RUN_TRANSCRIPTS_KEPT)

    // Nothing left past the kept number.
    expect(clearOldRunTranscripts(store, APP, null)).toBe(0)
  })

  it('drains a backlog a pass at a time', () => {
    seedRuns(RUN_TRANSCRIPTS_KEPT + 120)

    expect(clearOldRunTranscripts(store, APP, null)).toBe(RUN_TRANSCRIPTS_CLEARED_PER_PASS)
    expect(clearOldRunTranscripts(store, APP, null)).toBe(RUN_TRANSCRIPTS_CLEARED_PER_PASS)
    expect(clearOldRunTranscripts(store, APP, null)).toBe(20)
    expect(readdirSync(runsDir).filter(name => name.startsWith('run-'))).toHaveLength(RUN_TRANSCRIPTS_KEPT)
  })

  it('does not count skipped runs, which never had a transcript', () => {
    seedRuns(RUN_TRANSCRIPTS_KEPT + 10, { status: n => (n > RUN_TRANSCRIPTS_KEPT ? 'skipped' : 'error') })

    expect(clearOldRunTranscripts(store, APP, null)).toBe(0)
    expect(existsSync(transcript(1))).toBe(true)
  })

  it('never clears a run still going, waiting on a question or holding a continuation', () => {
    seedRuns(RUN_TRANSCRIPTS_KEPT + 3, { status: n => (n === 1 ? 'waiting_user' : n === 2 ? 'running' : 'error') })
    const db = dbManager.getAppDatabase()
    // Run 3 asked a question nobody answered.
    store.insertEntry({ id: 'question-3', appId: APP, runId: runId(3), type: 'escalation', ts: T0 + 3 * MIN, content: { summary: 'Proceed?', question: 'Proceed?' } })
    // Run 4 was answered and its continuation has not run yet.
    store.insertEntry({ id: 'question-4', appId: APP, runId: runId(4), type: 'escalation', ts: T0 + 4 * MIN, content: { summary: 'Proceed?' } })
    db.prepare(`UPDATE activity_entries SET user_response_json = '{"ts":1,"choice":"yes"}' WHERE id = 'question-4'`).run()
    db.prepare(`INSERT INTO decision_continuations (entry_id, app_id, status, updated_at) VALUES ('question-4', ?, 'queued', ?)`).run(APP, T0)
    seedNewer(1)

    expect(clearOldRunTranscripts(store, APP, null)).toBe(0)
    for (const n of [1, 2, 3, 4]) expect(existsSync(transcript(n))).toBe(true)
  })

  it('removes only the run’s own files, never the person’s chats beside them', () => {
    seedRuns(RUN_TRANSCRIPTS_KEPT + 1)
    writeFileSync(join(runsDir, `${runId(1)}.lineidx.json`), '{}')
    const chats = ['chat.jsonl', 'chat-wecom-bot-group-g1.jsonl', '_session-ids.json']
    for (const name of chats) writeFileSync(join(runsDir, name), '{}\n')

    expect(clearOldRunTranscripts(store, APP, null)).toBe(1)

    expect(existsSync(transcript(1))).toBe(false)
    expect(existsSync(join(runsDir, `${runId(1)}.lineidx.json`))).toBe(false)
    for (const name of chats) expect(existsSync(join(runsDir, name))).toBe(true)
  })

  it('finds the transcript of a run recorded before runs kept their environment in the person’s space', () => {
    seedRuns(RUN_TRANSCRIPTS_KEPT + 1)
    dbManager.getAppDatabase().prepare('UPDATE automation_runs SET environment_json = NULL WHERE run_id = ?').run(runId(1))

    expect(clearOldRunTranscripts(store, APP, spacePath)).toBe(1)

    expect(existsSync(transcript(1))).toBe(false)
    // No working directory recorded, so no engine session to look for.
    expect(deleteStoredSession).not.toHaveBeenCalled()
  })

  it('still clears a run whose engine session could not be deleted, and tries a failed transcript again later', () => {
    seedRuns(RUN_TRANSCRIPTS_KEPT + 1)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(deleteStoredSession).mockImplementationOnce(() => { throw new Error('EPERM') })

    expect(clearOldRunTranscripts(store, APP, null)).toBe(1)
    expect(store.getRun(runId(1))?.transcriptClearedAt).toEqual(expect.any(Number))

    // A transcript that cannot be deleted leaves its run as it was.
    seedNewer(1)
    rmSync(transcript(2))
    mkdirSync(join(transcript(2), 'locked'), { recursive: true })
    expect(clearOldRunTranscripts(store, APP, null)).toBe(0)
    expect(store.getRun(runId(2))?.transcriptClearedAt).toBeUndefined()
  })

  it('reads only the runs that still have a transcript, however long the history', () => {
    const db = dbManager.getAppDatabase()
    const prepare = vi.spyOn(db, 'prepare')
    store.listRunsPastTranscriptRetention(APP, RUN_TRANSCRIPTS_KEPT, RUN_TRANSCRIPTS_CLEARED_PER_PASS)
    const sql = prepare.mock.calls.at(-1)?.[0] as string
    prepare.mockRestore()

    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(APP, RUN_TRANSCRIPTS_KEPT, RUN_TRANSCRIPTS_CLEARED_PER_PASS) as Array<{ detail: string }>

    expect(plan.map(row => row.detail).join('\n')).toContain('idx_runs_transcript_kept')
  })
})

/** One more run, newer than the seeded ones, so the kept window moves past them. */
function seedNewer(count: number) {
  for (let i = 1; i <= count; i++) {
    const n = 10_000 + i
    store.insertRun({ runId: runId(n), appId: APP, sessionKey: `sk-${n}`, status: 'running', triggerType: 'schedule', startedAt: T0 + n * MIN })
    store.completeRun(runId(n), { status: 'ok', finishedAt: T0 + n * MIN + 1000, durationMs: 1000 })
  }
}
