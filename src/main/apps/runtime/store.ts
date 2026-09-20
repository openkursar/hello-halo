/**
 * apps/runtime -- Activity Store
 *
 * SQLite CRUD operations for automation_runs and activity_entries.
 * All methods are synchronous (better-sqlite3 is synchronous).
 */

import type Database from 'better-sqlite3'
import type {
  AutomationRun,
  ExecutionEnvironment,
  EscalationContinuation,
  ActivityEntry,
  ActivityEntryContent,
  ActivityEntryType,
  ActivityQueryOptions,
  PendingDecisionQuery,
  EscalationResponse,
  RunStatus,
  TriggerType,
} from './types'

// ============================================
// Internal Row Types (flat DB shape)
// ============================================

interface RunRow {
  run_id: string
  app_id: string
  session_key: string
  status: string
  trigger_type: string
  trigger_data_json: string | null
  started_at: number
  finished_at: number | null
  duration_ms: number | null
  tokens_used: number | null
  error_message: string | null
  session_id: string | null
  environment_json: string | null
}

interface EntryRow {
  id: string
  app_id: string
  run_id: string
  type: string
  ts: number
  session_key: string | null
  content_json: string
  user_response_json: string | null
}

// ============================================
// Row <-> Domain Conversions
// ============================================

function rowToRun(row: RunRow): AutomationRun {
  return {
    runId: row.run_id,
    appId: row.app_id,
    sessionKey: row.session_key,
    status: row.status as RunStatus,
    triggerType: row.trigger_type as TriggerType,
    triggerData: row.trigger_data_json ? JSON.parse(row.trigger_data_json) : undefined,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    tokensUsed: row.tokens_used ?? undefined,
    errorMessage: row.error_message ?? undefined,
    sessionId: row.session_id ?? undefined,
    environment: row.environment_json ? JSON.parse(row.environment_json) : undefined,
  }
}

function rowToEntry(row: EntryRow): ActivityEntry {
  return {
    id: row.id,
    appId: row.app_id,
    runId: row.run_id,
    type: row.type as ActivityEntryType,
    ts: row.ts,
    sessionKey: row.session_key ?? undefined,
    content: JSON.parse(row.content_json) as ActivityEntryContent,
    userResponse: row.user_response_json
      ? (JSON.parse(row.user_response_json) as EscalationResponse)
      : undefined,
  }
}

// ============================================
// Activity Store
// ============================================

/** Default retention period: 1 year in milliseconds */
const DEFAULT_RETENTION_MS = 365 * 24 * 60 * 60 * 1000

/**
 * SQLite store for automation runs and activity entries.
 *
 * Uses prepared statements for performance.
 * All methods are synchronous (better-sqlite3).
 */
export class ActivityStore {
  private readonly db: Database.Database

  // Prepared statements
  private readonly stmtInsertRun: Database.Statement
  private readonly stmtGetRun: Database.Statement
  private readonly stmtGetRunsForApp: Database.Statement
  private readonly stmtUpdateRunStatus: Database.Statement
  private readonly stmtUpdateRunComplete: Database.Statement
  private readonly stmtInsertEntry: Database.Statement
  private readonly stmtGetEntry: Database.Statement
  private readonly stmtUpdateEntryResponse: Database.Statement
  private readonly stmtGetPendingEscalation: Database.Statement
  private readonly stmtGetAllPendingEscalations: Database.Statement
  private readonly stmtHasPendingSoloEscalation: Database.Statement
  private readonly stmtGetRunningRunForApp: Database.Statement
  private readonly stmtGetLatestRunForApp: Database.Statement
  private readonly stmtGetEntriesForRun: Database.Statement
  private readonly stmtUpdateRunSessionId: Database.Statement
  private readonly stmtReopenRun: Database.Statement

  constructor(db: Database.Database) {
    this.db = db

    // ── Run statements ──────────────────────────

    this.stmtInsertRun = db.prepare(`
      INSERT INTO automation_runs
        (run_id, app_id, session_key, status, trigger_type, trigger_data_json, started_at, environment_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)

    this.stmtGetRun = db.prepare(`
      SELECT * FROM automation_runs WHERE run_id = ?
    `)

    this.stmtGetRunsForApp = db.prepare(`
      SELECT * FROM automation_runs WHERE app_id = ? ORDER BY started_at DESC LIMIT ?
    `)

    this.stmtUpdateRunStatus = db.prepare(`
      UPDATE automation_runs SET status = ?, error_message = ? WHERE run_id = ?
    `)

    this.stmtUpdateRunComplete = db.prepare(`
      UPDATE automation_runs
      SET status = ?, finished_at = ?, duration_ms = ?, tokens_used = ?, error_message = ?
      WHERE run_id = ?
    `)

    this.stmtGetRunningRunForApp = db.prepare(`
      SELECT * FROM automation_runs WHERE app_id = ? AND status = 'running' LIMIT 1
    `)

    this.stmtGetLatestRunForApp = db.prepare(`
      SELECT * FROM automation_runs WHERE app_id = ? ORDER BY started_at DESC LIMIT 1
    `)

    // ── Entry statements ────────────────────────

    this.stmtInsertEntry = db.prepare(`
      INSERT INTO activity_entries
        (id, app_id, run_id, type, ts, session_key, content_json, user_response_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)

    this.stmtGetEntry = db.prepare(`
      SELECT * FROM activity_entries WHERE id = ?
    `)

    this.stmtUpdateEntryResponse = db.prepare(`
      UPDATE activity_entries SET user_response_json = ? WHERE id = ?
    `)

    this.stmtGetPendingEscalation = db.prepare(`
      SELECT * FROM activity_entries
      WHERE app_id = ? AND id = ? AND type = 'escalation' AND user_response_json IS NULL AND json_extract(content_json, '$.resolution') IS NULL
    `)

    this.stmtGetAllPendingEscalations = db.prepare(`
      SELECT * FROM activity_entries
      WHERE type = 'escalation' AND user_response_json IS NULL AND json_extract(content_json, '$.resolution') IS NULL
      ORDER BY ts ASC
    `)

    this.stmtHasPendingSoloEscalation = db.prepare(`
      SELECT 1 FROM activity_entries
      WHERE app_id = ? AND type = 'escalation' AND user_response_json IS NULL
        AND json_extract(content_json, '$.resolution') IS NULL
        AND json_extract(content_json, '$.teamContext.epochId') IS NULL
      LIMIT 1
    `)

    this.stmtGetEntriesForRun = db.prepare(`
      SELECT * FROM activity_entries WHERE run_id = ? ORDER BY ts DESC
    `)

    this.stmtUpdateRunSessionId = db.prepare(`
      UPDATE automation_runs SET session_id = ? WHERE run_id = ?
    `)

    // Reopen any terminal run (error/waiting_user/ok) back to 'running', clearing
    // finished_at, duration_ms, and error_message so it appears live again. 'ok' is
    // included so a user can resume a normally-completed run with a follow-up
    // ("this part is wrong, fix it"). A run already 'running' is never reopened.
    this.stmtReopenRun = db.prepare(`
      UPDATE automation_runs
      SET status = 'running', finished_at = NULL, duration_ms = NULL, error_message = NULL, stopped_at = NULL
      WHERE run_id = ? AND status IN ('error', 'waiting_user', 'ok')
    `)
  }

  // ── Run Operations ────────────────────────────

  /** Insert a new automation run record */
  insertRun(run: {
    runId: string
    appId: string
    sessionKey: string
    status: RunStatus
    triggerType: TriggerType
    triggerData?: Record<string, unknown>
    startedAt: number
    environment?: ExecutionEnvironment
  }): void {
    this.stmtInsertRun.run(
      run.runId,
      run.appId,
      run.sessionKey,
      run.status,
      run.triggerType,
      run.triggerData ? JSON.stringify(run.triggerData) : null,
      run.startedAt,
      run.environment ? JSON.stringify(run.environment) : null
    )
  }

  /** Get a run by ID */
  getRun(runId: string): AutomationRun | null {
    const row = this.stmtGetRun.get(runId) as RunRow | undefined
    return row ? rowToRun(row) : null
  }

  /** Get runs for an App, ordered by most recent first */
  getRunsForApp(appId: string, limit = 50): AutomationRun[] {
    const rows = this.stmtGetRunsForApp.all(appId, limit) as RunRow[]
    return rows.map(rowToRun)
  }

  /** Update run status (without completion data) */
  updateRunStatus(runId: string, status: RunStatus, errorMessage?: string): void {
    this.stmtUpdateRunStatus.run(status, errorMessage ?? null, runId)
  }

  /** Complete a run with final results */
  completeRun(runId: string, data: {
    status: RunStatus
    finishedAt: number
    durationMs: number
    tokensUsed?: number
    errorMessage?: string
  }): void {
    this.stmtUpdateRunComplete.run(
      data.status,
      data.finishedAt,
      data.durationMs,
      data.tokensUsed ?? null,
      data.errorMessage ?? null,
      runId
    )
  }

  /** Get a currently running run for an App (if any) */
  getRunningRunForApp(appId: string): AutomationRun | null {
    const row = this.stmtGetRunningRunForApp.get(appId) as RunRow | undefined
    return row ? rowToRun(row) : null
  }

  /** Get the latest run for an App */
  getLatestRunForApp(appId: string): AutomationRun | null {
    const row = this.stmtGetLatestRunForApp.get(appId) as RunRow | undefined
    return row ? rowToRun(row) : null
  }

  /** Save V2 session ID on a run (for escalation context recovery) */
  updateRunSessionId(runId: string, sessionId: string): void {
    this.stmtUpdateRunSessionId.run(sessionId, runId)
  }

  /**
   * Reopen a failed or waiting run back to running state.
   *
   * Used by user-initiated continue (error → running) and
   * escalation follow-up (waiting_user → running). Only transitions
   * from 'error' or 'waiting_user'; other statuses are no-ops.
   */
  reopenRun(runId: string): void {
    this.stmtReopenRun.run(runId)
  }

  /** Every run the database still believes is executing. */
  listRunningRuns(): AutomationRun[] {
    const rows = this.db
      .prepare(`SELECT * FROM automation_runs WHERE status = 'running' ORDER BY started_at ASC`)
      .all() as RunRow[]
    return rows.map(rowToRun)
  }

  /**
   * Fail the given runs, which a caller has established are no longer executing.
   *
   * A run only reaches a terminal status from inside the process executing it,
   * so a crash or a forced quit strands the row at 'running' forever: pruning
   * skips it and the UI reads it as neither live nor finished.
   */
  failRuns(runIds: string[], errorMessage: string): AutomationRun[] {
    if (runIds.length === 0) return []
    const finishedAt = Date.now()
    const placeholders = runIds.map(() => '?').join(', ')
    const rows = this.db.prepare(`
      UPDATE automation_runs
      SET status = 'error',
          finished_at = ?,
          duration_ms = ? - started_at,
          error_message = ?
      WHERE status = 'running' AND run_id IN (${placeholders})
      RETURNING *
    `).all(finishedAt, finishedAt, errorMessage, ...runIds) as RunRow[]
    return rows.map(rowToRun)
  }

  // ── Entry Operations ──────────────────────────

  /** Insert an activity entry */
  insertEntry(entry: ActivityEntry): void {
    const team = entry.content.teamContext
    const run = this.getRun(entry.runId)
    entry.content.source ??= team?.teamId && team?.epochId
      ? { kind: 'team', appId: entry.appId, teamId: team.teamId, epochId: team.epochId, taskId: team.taskId, memberId: entry.appId, sessionKey: entry.sessionKey }
      : run
        ? { kind: 'automation', appId: entry.appId, runId: run.runId, sessionKey: run.sessionKey }
        : { kind: entry.sessionKey?.startsWith('app-chat:') ? 'chat' : 'unknown', appId: entry.appId, sessionKey: entry.sessionKey }
    if (entry.type === 'run_error' && run) {
      entry.content.stopped = this.wasRunStopped(run.runId) || undefined
      entry.content.resumeAvailable = !!run.sessionId && !this.isRunClosed(run.runId) && !this.hasUnfinishedRunDecision(run.runId)
    }
    if (entry.type === 'escalation' && entry.content.deadlineAt === undefined && !team) {
      const policy = this.db.prepare(`SELECT COALESCE(json_extract(a.spec_json, '$.escalation.timeout_hours'), l.timeout_hours) AS hours
        FROM installed_apps a LEFT JOIN runtime_legacy_deadlines l ON l.app_id = a.id WHERE a.id = ?`).get(entry.appId) as { hours: number | null } | undefined
      if (policy?.hours != null) entry.content.deadlineAt = entry.ts + policy.hours * 3600000
    }
    this.stmtInsertEntry.run(
      entry.id,
      entry.appId,
      entry.runId,
      entry.type,
      entry.ts,
      entry.sessionKey ?? null,
      JSON.stringify(entry.content),
      entry.userResponse ? JSON.stringify(entry.userResponse) : null
    )
  }

  /** Get a single entry by ID */
  getEntry(entryId: string): ActivityEntry | null {
    const row = this.stmtGetEntry.get(entryId) as EntryRow | undefined
    return row ? this.withContinuation(rowToEntry(row)) : null
  }

  /** Get entries for an App with optional filtering */
  getEntriesForApp(appId: string, options?: ActivityQueryOptions): ActivityEntry[] {
    const limit = Math.min(500, Math.max(1, Math.floor(options?.limit || 50)))
    const offset = Math.max(0, Math.floor(options?.offset || 0))
    const predicates = ['app_id = ?']
    const values: (string | number)[] = [appId]
    if (options?.type) { predicates.push('type = ?'); values.push(options.type) }
    if (options?.since !== undefined) {
      if (options.beforeId) {
        predicates.push('(ts < ? OR (ts = ? AND id < ?))')
        values.push(options.since, options.since, options.beforeId)
      } else {
        predicates.push('ts < ?')
        values.push(options.since)
      }
    }
    if (options?.teamId) { predicates.push("json_extract(content_json, '$.teamContext.teamId') = ?"); values.push(options.teamId) }
    if (options?.epochId) { predicates.push("json_extract(content_json, '$.teamContext.epochId') = ?"); values.push(options.epochId) }
    const rows = this.db.prepare(`SELECT * FROM activity_entries WHERE ${predicates.join(' AND ')} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`).all(...values, limit, offset) as EntryRow[]

    return rows.map(row => this.withContinuation(rowToEntry(row)))
  }

  /** Update an entry with a user response (for escalation) */
  updateEntryResponse(entryId: string, response: EscalationResponse): void {
    this.stmtUpdateEntryResponse.run(JSON.stringify(response), entryId)
  }

  /** Get a pending (unanswered) escalation entry */
  getPendingEscalation(appId: string, entryId: string): ActivityEntry | null {
    const row = this.stmtGetPendingEscalation.get(appId, entryId) as EntryRow | undefined
    return row ? this.withContinuation(rowToEntry(row)) : null
  }

  /** Get all activity entries for a specific run */
  getEntriesForRun(runId: string): ActivityEntry[] {
    const rows = this.stmtGetEntriesForRun.all(runId) as EntryRow[]
    return rows.map(row => this.withContinuation(rowToEntry(row)))
  }

  /** Get all pending (unanswered) escalation entries across all apps, oldest first */
  getPendingInbox(options?: PendingDecisionQuery): import('../../../shared/apps/app-types').PendingDecisionInbox {
    const limit = Math.min(500, Math.max(1, Math.floor(options?.limit ?? 100)))
    const filter = `e.type = 'escalation' AND e.user_response_json IS NULL
      AND json_extract(e.content_json, '$.resolution') IS NULL
      AND a.status != 'uninstalled' AND a.uninstalled_at IS NULL`
    const cursor = options?.afterTs !== undefined && options.afterId
      ? 'AND (e.ts > ? OR (e.ts = ? AND e.id > ?))' : ''
    const values: (string | number)[] = []
    if (cursor) values.push(options!.afterTs!, options!.afterTs!, options!.afterId!)
    values.push(limit)
    const rows = this.db.prepare(`SELECT e.*, json_extract(a.spec_json, '$.name') AS app_name FROM activity_entries e JOIN installed_apps a ON a.id = e.app_id
      WHERE ${filter} ${cursor} ORDER BY e.ts, e.id LIMIT ?`).all(...values) as (EntryRow & { app_name: string | null })[]
    const total = (this.db.prepare(`SELECT COUNT(*) AS count FROM activity_entries e JOIN installed_apps a ON a.id = e.app_id
      WHERE ${filter}`).get() as { count: number }).count
    return { entries: rows.map(rowToEntry), total, names: Object.fromEntries(rows.flatMap(row => row.app_name ? [[row.app_id, row.app_name]] : [])) }
  }

  getPendingEntries(appId: string, options?: PendingDecisionQuery): ActivityEntry[] {
    const limit = Math.min(500, Math.max(1, Math.floor(options?.limit ?? 100)))
    const cursor = options?.afterTs !== undefined && options.afterId
      ? 'AND (ts > ? OR (ts = ? AND id > ?))' : ''
    const values: (string | number)[] = [appId]
    if (cursor) values.push(options!.afterTs!, options!.afterTs!, options!.afterId!)
    values.push(limit)
    const rows = this.db.prepare(`SELECT * FROM activity_entries WHERE app_id = ? AND type = 'escalation'
      AND user_response_json IS NULL AND json_extract(content_json, '$.resolution') IS NULL ${cursor}
      ORDER BY ts, id LIMIT ?`).all(...values) as EntryRow[]
    return rows.map(row => this.withContinuation(rowToEntry(row)))
  }

  getAllPendingEscalations(): ActivityEntry[] {
    const rows = this.stmtGetAllPendingEscalations.all() as EntryRow[]
    return rows.map(row => this.withContinuation(rowToEntry(row)))
  }

  /**
   * Whether the app is waiting on a human for anything outside a team task.
   *
   * An app can hold several such questions at once: each run escalates
   * independently, and one whose question is still unanswered must stay
   * answerable after a later run has raised its own.
   */
  hasPendingSoloEscalation(appId: string): boolean {
    return !!this.stmtHasPendingSoloEscalation.get(appId)
  }

  hasPendingEscalation(appId: string, teamId: string, epochId?: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM activity_entries
      WHERE app_id = ? AND type = 'escalation' AND user_response_json IS NULL
        AND json_extract(content_json, '$.resolution') IS NULL
        AND json_extract(content_json, '$.teamContext.teamId') = ?
        ${epochId ? "AND json_extract(content_json, '$.teamContext.epochId') = ?" : ''}
      LIMIT 1`).get(...(epochId ? [appId, teamId, epochId] : [appId, teamId]))
  }

  closeTaskEscalations(teamId: string, epochId: string): ActivityEntry[] {
    return this.db.transaction(() => {
      const ids = this.db.prepare(`SELECT id FROM activity_entries WHERE json_extract(content_json, '$.teamContext.teamId') = ?
        AND json_extract(content_json, '$.teamContext.epochId') = ?`).all(teamId, epochId) as { id: string }[]
      return ids.map(({ id }) => this.closeDecision(id)).filter((entry): entry is ActivityEntry => !!entry)
    })()
  }

  private withContinuation(entry: ActivityEntry): ActivityEntry {
    const row = this.db.prepare('SELECT * FROM decision_continuations WHERE entry_id = ?').get(entry.id) as
      { status: EscalationContinuation['status']; attempts: number; updated_at: number; error: string | null } | undefined
    if (row) entry.continuation = { status: row.status, attempts: row.attempts, updatedAt: row.updated_at, error: row.error ?? undefined }
    return entry
  }

  acceptDecision(appId: string, entryId: string, response: EscalationResponse): ActivityEntry {
    return this.db.transaction(() => {
      const entry = this.getEntry(entryId)
      if (!entry || entry.appId !== appId || entry.type !== 'escalation') throw new Error('Decision not found')
      if (entry.userResponse) {
        const answer = (value: EscalationResponse) => JSON.stringify({ choice: value.choice, text: value.text, answers: value.answers })
        if (answer(entry.userResponse) !== answer(response)) throw new Error('This decision has already been answered differently')
        return entry
      }
      if (entry.content.resolution || this.isRunClosed(entry.runId)) throw new Error('This decision is closed')
      if (entry.content.deadlineReviewRequired) throw new Error('Confirm the historical deadline before answering')
      if (entry.content.deadlineAt !== undefined && entry.content.deadlineAt <= Date.now()) throw new Error('This decision has expired')
      const questions = entry.content.questions
      if (questions?.length && (response.answers?.length !== questions.length || response.answers.some(answer => !answer.choice?.trim() && !answer.text?.trim()))) {
        throw new Error('Answer every question before submitting')
      }
      if (!questions?.length && !response.choice?.trim() && !response.text?.trim()) throw new Error('An answer is required')
      const now = Date.now()
      this.stmtUpdateEntryResponse.run(JSON.stringify({ ...response, ts: now }), entryId)
      this.db.prepare(`INSERT INTO decision_continuations(entry_id, app_id, status, updated_at) VALUES (?, ?, 'queued', ?)`).run(entryId, appId, now)
      return this.getEntry(entryId)!
    })()
  }

  getQueuedContinuations(): ActivityEntry[] {
    const rows = this.db.prepare(`SELECT e.* FROM activity_entries e JOIN decision_continuations c ON c.entry_id = e.id
      WHERE c.status = 'queued' ORDER BY c.updated_at, e.id`).all() as EntryRow[]
    return rows.map(row => this.withContinuation(rowToEntry(row)))
  }

  updateContinuation(entryId: string, status: EscalationContinuation['status'], error?: string): void {
    this.db.prepare(`UPDATE decision_continuations SET status = ?, error = ?, updated_at = ?,
      attempts = attempts + CASE WHEN ? = 'running' THEN 1 ELSE 0 END
      WHERE entry_id = ? AND status != 'cancelled'`).run(status, error ?? null, Date.now(), status, entryId)
  }

  needsDecisionReceipt(entryId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM decision_continuations WHERE entry_id = ? AND receipt_published = 0').get(entryId)
  }

  markDecisionReceiptPublished(entryId: string): void {
    this.db.prepare('UPDATE decision_continuations SET receipt_published = 1 WHERE entry_id = ?').run(entryId)
  }

  getContinuationSummary(): Record<string, number> {
    return Object.fromEntries((this.db.prepare('SELECT status, COUNT(*) AS count FROM decision_continuations GROUP BY status').all() as { status: string; count: number }[]).map(row => [row.status, row.count]))
  }

  recoverContinuations(): number {
    return this.db.prepare(`UPDATE decision_continuations SET status = 'queued', updated_at = ?
      WHERE status = 'running'`).run(Date.now()).changes
  }

  getDirectoryDecisionCounts(): Record<string, { pending: number; solo: number; continuations: number }> {
    const result: Record<string, { pending: number; solo: number; continuations: number }> = {}
    const pending = this.db.prepare(`SELECT app_id, COUNT(*) AS pending,
      SUM(CASE WHEN json_extract(content_json, '$.teamContext.epochId') IS NULL THEN 1 ELSE 0 END) AS solo
      FROM activity_entries WHERE type = 'escalation' AND user_response_json IS NULL
      AND json_extract(content_json, '$.resolution') IS NULL GROUP BY app_id`).all() as Array<{ app_id: string; pending: number; solo: number }>
    for (const row of pending) result[row.app_id] = { pending: row.pending, solo: row.solo, continuations: 0 }
    const continuations = this.db.prepare(`SELECT app_id, COUNT(*) AS count FROM decision_continuations
      WHERE status IN ('queued', 'running') GROUP BY app_id`).all() as Array<{ app_id: string; count: number }>
    for (const row of continuations) (result[row.app_id] ??= { pending: 0, solo: 0, continuations: 0 }).continuations = row.count
    return result
  }

  getDirectoryRecentRuns(appIds: string[]): Array<{ appId: string; runId: string; sessionKey: string; startedAt: number; durationMs?: number; status: string; stopped: number; closed: number }> {
    if (appIds.length > 100) throw new Error('Directory batch exceeds 100 people')
    return this.db.prepare(`SELECT r.app_id AS appId, r.run_id AS runId, r.session_key AS sessionKey,
      r.started_at AS startedAt, r.duration_ms AS durationMs, r.status, r.stopped_at IS NOT NULL AS stopped,
      EXISTS(SELECT 1 FROM runtime_closed_runs closed WHERE closed.run_id = r.run_id) AS closed FROM json_each(?) person JOIN automation_runs r
      ON r.run_id IN (SELECT run_id FROM automation_runs WHERE app_id = person.value ORDER BY started_at DESC, run_id DESC LIMIT 5)
      ORDER BY r.started_at DESC, r.run_id DESC`).all(JSON.stringify(appIds)) as Array<{ appId: string; runId: string; sessionKey: string; startedAt: number; durationMs?: number; status: string; stopped: number; closed: number }>
  }

  getDecisionCounts(appId: string): { pending: number; solo: number; continuations: number } {
    const counts = this.db.prepare(`SELECT COUNT(*) AS pending,
      COALESCE(SUM(CASE WHEN json_extract(content_json, '$.teamContext.epochId') IS NULL THEN 1 ELSE 0 END), 0) AS solo
      FROM activity_entries WHERE app_id = ? AND type = 'escalation' AND user_response_json IS NULL
      AND json_extract(content_json, '$.resolution') IS NULL`).get(appId) as { pending: number; solo: number }
    const continuation = this.db.prepare(`SELECT COUNT(*) AS count FROM decision_continuations WHERE app_id = ? AND status IN ('queued', 'running')`).get(appId) as { count: number }
    return { ...counts, continuations: continuation.count }
  }

  hasQueuedSoloContinuation(appId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM decision_continuations c JOIN activity_entries e ON e.id = c.entry_id
      WHERE c.app_id = ? AND c.status IN ('queued', 'running') AND json_extract(e.content_json, '$.teamContext') IS NULL LIMIT 1`).get(appId)
  }

  confirmDeadline(appId: string, entryId: string, deadlineAt: number | null): ActivityEntry {
    const entry = this.getPendingEscalation(appId, entryId)
    if (!entry) throw new Error('Decision no longer pending')
    if (deadlineAt !== null && (!Number.isFinite(deadlineAt) || deadlineAt <= Date.now())) throw new Error('Choose a future deadline')
    if (entry.content.deadlineReviewRequired && entry.content.deadlineAt !== undefined) {
      entry.content.deadlineReview = {
        originalDeadlineAt: entry.content.deadlineReview?.originalDeadlineAt ?? entry.content.deadlineAt,
        confirmedAt: Date.now(), deadlineAt,
      }
    }
    entry.content.deadlineAt = deadlineAt ?? undefined
    entry.content.deadlineReviewRequired = undefined
    this.db.prepare('UPDATE activity_entries SET content_json = ? WHERE id = ?').run(JSON.stringify(entry.content), entryId)
    console.log('[Runtime] Decision deadline confirmed', { appId, entryId, deadlineAt })
    return entry
  }

  expireDecisions(now: number): ActivityEntry[] {
    const rows = this.db.prepare(`UPDATE activity_entries SET content_json = json_set(content_json, '$.resolution', json(?))
      WHERE type = 'escalation' AND user_response_json IS NULL AND json_extract(content_json, '$.resolution') IS NULL
      AND COALESCE(json_extract(content_json, '$.deadlineReviewRequired'), 0) = 0
      AND json_extract(content_json, '$.deadlineAt') <= ? RETURNING *`).all(JSON.stringify({ reason: 'expired', ts: now }), now) as EntryRow[]
    return rows.map(row => this.withContinuation(rowToEntry(row)))
  }

  private closeDecision(entryId: string): ActivityEntry | null {
    const entry = this.getEntry(entryId)
    if (!entry || entry.type !== 'escalation') return null
    const canCancelContinuation = entry.continuation && ['queued', 'running', 'failed'].includes(entry.continuation.status)
    if ((entry.userResponse || entry.content.resolution) && !canCancelContinuation) return null
    if (canCancelContinuation) this.updateContinuation(entryId, 'cancelled')
    if (!entry.userResponse && !entry.content.resolution) {
      entry.content.resolution = { reason: 'task_closed', ts: Date.now() }
      delete entry.content.deadlineReviewRequired
      this.db.prepare('UPDATE activity_entries SET content_json = ? WHERE id = ?').run(JSON.stringify(entry.content), entryId)
    }
    return this.getEntry(entryId)
  }

  closeRun(runId: string): ActivityEntry[] {
    return this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO runtime_closed_runs VALUES (?, ?)').run(runId, Date.now())
      return this.getEntriesForRun(runId).map(entry => this.closeDecision(entry.id)).filter((entry): entry is ActivityEntry => !!entry)
    })()
  }

  hasUnfinishedRunDecision(runId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM activity_entries e LEFT JOIN decision_continuations c ON c.entry_id = e.id
      WHERE e.run_id = ? AND e.type = 'escalation' AND (
        (e.user_response_json IS NULL AND json_extract(e.content_json, '$.resolution') IS NULL)
        OR json_extract(e.content_json, '$.resolution.reason') = 'expired'
        OR c.status IN ('queued', 'running', 'failed')) LIMIT 1`).get(runId)
  }

  markRunStopped(runId: string): void {
    this.db.prepare('UPDATE automation_runs SET stopped_at = ? WHERE run_id = ?').run(Date.now(), runId)
  }

  wasRunStopped(runId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM automation_runs WHERE run_id = ? AND stopped_at IS NOT NULL').get(runId)
  }

  isRunClosed(runId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM runtime_closed_runs WHERE run_id = ?').get(runId)
  }

  pinRunEnvironments(appId: string, environment: ExecutionEnvironment): void {
    this.db.prepare('UPDATE automation_runs SET environment_json = ? WHERE app_id = ? AND environment_json IS NULL').run(JSON.stringify(environment), appId)
  }

  pinRunEnvironment(runId: string, environment: ExecutionEnvironment): void {
    this.db.prepare('UPDATE automation_runs SET environment_json = ? WHERE run_id = ? AND environment_json IS NULL')
      .run(JSON.stringify(environment), runId)
  }

  getSessionEnvironment(sessionKey: string): ExecutionEnvironment | undefined {
    const row = this.db.prepare('SELECT environment_json FROM app_session_environments WHERE session_key = ?').get(sessionKey) as { environment_json: string } | undefined
    return row ? JSON.parse(row.environment_json) : undefined
  }

  pinSessionEnvironment(sessionKey: string, appId: string, environment: ExecutionEnvironment): ExecutionEnvironment {
    this.db.prepare('INSERT OR IGNORE INTO app_session_environments VALUES (?, ?, ?)').run(sessionKey, appId, JSON.stringify(environment))
    return this.getSessionEnvironment(sessionKey)!
  }

  deleteSessionEnvironment(sessionKey: string): void {
    this.db.prepare('DELETE FROM app_session_environments WHERE session_key = ?').run(sessionKey)
  }

  countSessionEnvironments(appId: string): number {
    const sessions = this.listSessionEnvironments(appId)
    const storageKeys = new Set<string>()
    for (const session of sessions) {
      const legacyPrefix = `legacy-file:${appId}:`
      const chatPrefix = `app-chat:${appId}`
      if (!session.sessionKey.startsWith(chatPrefix) && !session.sessionKey.startsWith(legacyPrefix)) continue
      const runId = session.sessionKey.startsWith(legacyPrefix) ? session.sessionKey.slice(legacyPrefix.length)
        : session.sessionKey === chatPrefix ? 'chat' : `chat-${session.sessionKey.slice(chatPrefix.length + 1).replace(/:/g, '-')}`
      if (runId !== 'chat' && !runId.startsWith('chat-')) continue
      storageKeys.add(JSON.stringify([session.environment.spacePath, runId]))
    }
    return storageKeys.size
  }

  listRetainedCapabilityEnvironments(): Array<{ appId: string; sessionKey?: string; environment: ExecutionEnvironment }> {
    const sessions = this.db.prepare(`SELECT app_id, session_key, environment_json FROM app_session_environments
      WHERE session_key LIKE 'app-chat:%' OR session_key LIKE 'legacy-file:%'`).all() as Array<{ app_id: string; session_key: string; environment_json: string }>
    const runs = this.db.prepare(`SELECT app_id, environment_json FROM automation_runs WHERE run_id IN (
      SELECT run_id FROM automation_runs WHERE status IN ('running', 'waiting_user') AND stopped_at IS NULL
      UNION SELECT e.run_id FROM activity_entries e
        WHERE e.type = 'escalation' AND e.user_response_json IS NULL
          AND (json_extract(e.content_json, '$.resolution') IS NULL OR json_extract(e.content_json, '$.resolution.reason') = 'expired')
      UNION SELECT e.run_id FROM decision_continuations c JOIN activity_entries e ON e.id = c.entry_id
        WHERE c.status IN ('queued', 'running', 'failed')
      ) AND environment_json IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM runtime_closed_runs closed WHERE closed.run_id = automation_runs.run_id
      )`).all() as Array<{ app_id: string; environment_json: string }>
    return [
      ...sessions.map(row => ({ appId: row.app_id, sessionKey: row.session_key, environment: JSON.parse(row.environment_json) })),
      ...runs.map(row => ({ appId: row.app_id, environment: JSON.parse(row.environment_json) })),
    ]
  }

  listSessionEnvironments(appId: string): Array<{ sessionKey: string; environment: ExecutionEnvironment }> {
    const rows = this.db.prepare('SELECT session_key, environment_json FROM app_session_environments WHERE app_id = ?')
      .all(appId) as Array<{ session_key: string; environment_json: string }>
    return rows.map(row => ({ sessionKey: row.session_key, environment: JSON.parse(row.environment_json) }))
  }

  // ── Data Lifecycle ──────────────────────────

  /**
   * Remove old completed runs and their associated activity entries.
   *
   * Deletes runs (and cascade-deletes their entries) where:
   * - The run is finished (status != 'running' and status != 'waiting_user')
   * - The run's started_at is older than the retention cutoff
   *
   * @param retentionMs - Maximum age in milliseconds. Defaults to 1 year.
   * @returns Number of runs deleted (entries are cascade-deleted).
   */
  pruneOldData(retentionMs: number = DEFAULT_RETENTION_MS): number {
    const cutoff = Date.now() - retentionMs
    // activity_entries no longer carries a run_id FK (chat/team entries use a
    // sentinel run with no parent), so a run delete no longer cascades to its
    // entries — remove them explicitly first to keep cleanup behaviour intact.
    return this.db.transaction(() => {
      this.db.prepare(`
        DELETE FROM activity_entries
        WHERE run_id IN (
          SELECT run_id FROM automation_runs
          WHERE started_at < ? AND status NOT IN ('running', 'waiting_user')
          AND NOT EXISTS (SELECT 1 FROM activity_entries e WHERE e.run_id = automation_runs.run_id AND e.type = 'escalation'
            AND e.user_response_json IS NULL AND json_extract(e.content_json, '$.resolution') IS NULL)
          AND NOT EXISTS (SELECT 1 FROM decision_continuations c JOIN activity_entries e ON e.id = c.entry_id
            WHERE e.run_id = automation_runs.run_id AND c.status IN ('queued', 'running', 'failed'))
        )
      `).run(cutoff)
      const result = this.db.prepare(`
        DELETE FROM automation_runs
        WHERE started_at < ?
          AND status NOT IN ('running', 'waiting_user')
          AND NOT EXISTS (SELECT 1 FROM activity_entries e WHERE e.run_id = automation_runs.run_id)
      `).run(cutoff)
      return result.changes
    })()
  }
}
