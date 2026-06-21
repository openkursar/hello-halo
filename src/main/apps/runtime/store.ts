/**
 * apps/runtime -- Activity Store
 *
 * SQLite CRUD operations for automation_runs and activity_entries.
 * All methods are synchronous (better-sqlite3 is synchronous).
 */

import type Database from 'better-sqlite3'
import type {
  AutomationRun,
  ActivityEntry,
  ActivityEntryContent,
  ActivityEntryType,
  ActivityQueryOptions,
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
  private readonly stmtGetEntriesForApp: Database.Statement
  private readonly stmtGetEntriesForAppWithType: Database.Statement
  private readonly stmtGetEntriesForAppSince: Database.Statement
  private readonly stmtUpdateEntryResponse: Database.Statement
  private readonly stmtGetPendingEscalation: Database.Statement
  private readonly stmtGetAllPendingEscalations: Database.Statement
  private readonly stmtGetRunningRunForApp: Database.Statement
  private readonly stmtGetLatestRunForApp: Database.Statement
  private readonly stmtGetEntriesForRun: Database.Statement
  private readonly stmtUpdateRunSessionId: Database.Statement
  private readonly stmtReopenRun: Database.Statement
  private readonly stmtCloseOrphanEscalations: Database.Statement
  private readonly stmtCloseOrphanEscalationsAll: Database.Statement

  constructor(db: Database.Database) {
    this.db = db

    // ── Run statements ──────────────────────────

    this.stmtInsertRun = db.prepare(`
      INSERT INTO automation_runs
        (run_id, app_id, session_key, status, trigger_type, trigger_data_json, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
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

    this.stmtGetEntriesForApp = db.prepare(`
      SELECT * FROM activity_entries WHERE app_id = ? ORDER BY ts DESC LIMIT ? OFFSET ?
    `)

    this.stmtGetEntriesForAppWithType = db.prepare(`
      SELECT * FROM activity_entries WHERE app_id = ? AND type = ? ORDER BY ts DESC LIMIT ? OFFSET ?
    `)

    this.stmtGetEntriesForAppSince = db.prepare(`
      SELECT * FROM activity_entries WHERE app_id = ? AND ts < ? ORDER BY ts DESC LIMIT ? OFFSET ?
    `)

    this.stmtUpdateEntryResponse = db.prepare(`
      UPDATE activity_entries SET user_response_json = ? WHERE id = ?
    `)

    this.stmtGetPendingEscalation = db.prepare(`
      SELECT * FROM activity_entries
      WHERE app_id = ? AND id = ? AND type = 'escalation' AND user_response_json IS NULL
    `)

    this.stmtGetAllPendingEscalations = db.prepare(`
      SELECT * FROM activity_entries
      WHERE type = 'escalation' AND user_response_json IS NULL
      ORDER BY ts ASC
    `)

    // Close orphan escalation entries for an app, excluding a specific active entry.
    // Orphans are pending escalations that no longer correspond to the app's
    // current pendingEscalationId (e.g. created before a pause/resume cycle).
    this.stmtCloseOrphanEscalations = db.prepare(`
      UPDATE activity_entries
      SET user_response_json = ?
      WHERE app_id = ? AND type = 'escalation' AND user_response_json IS NULL AND id != ?
    `)

    // Close ALL pending escalation entries for an app (used when leaving waiting_user
    // state without resolving — e.g. pause, manual trigger from error).
    this.stmtCloseOrphanEscalationsAll = db.prepare(`
      UPDATE activity_entries
      SET user_response_json = ?
      WHERE app_id = ? AND type = 'escalation' AND user_response_json IS NULL
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
      SET status = 'running', finished_at = NULL, duration_ms = NULL, error_message = NULL
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
  }): void {
    this.stmtInsertRun.run(
      run.runId,
      run.appId,
      run.sessionKey,
      run.status,
      run.triggerType,
      run.triggerData ? JSON.stringify(run.triggerData) : null,
      run.startedAt
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

  // ── Entry Operations ──────────────────────────

  /** Insert an activity entry */
  insertEntry(entry: ActivityEntry): void {
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
    return row ? rowToEntry(row) : null
  }

  /** Get entries for an App with optional filtering */
  getEntriesForApp(appId: string, options?: ActivityQueryOptions): ActivityEntry[] {
    const limit = options?.limit ?? 50
    const offset = options?.offset ?? 0

    let rows: EntryRow[]

    if (options?.type) {
      rows = this.stmtGetEntriesForAppWithType.all(appId, options.type, limit, offset) as EntryRow[]
    } else if (options?.since) {
      rows = this.stmtGetEntriesForAppSince.all(appId, options.since, limit, offset) as EntryRow[]
    } else {
      rows = this.stmtGetEntriesForApp.all(appId, limit, offset) as EntryRow[]
    }

    return rows.map(rowToEntry)
  }

  /** Update an entry with a user response (for escalation) */
  updateEntryResponse(entryId: string, response: EscalationResponse): void {
    this.stmtUpdateEntryResponse.run(JSON.stringify(response), entryId)
  }

  /** Get a pending (unanswered) escalation entry */
  getPendingEscalation(appId: string, entryId: string): ActivityEntry | null {
    const row = this.stmtGetPendingEscalation.get(appId, entryId) as EntryRow | undefined
    return row ? rowToEntry(row) : null
  }

  /** Get all activity entries for a specific run */
  getEntriesForRun(runId: string): ActivityEntry[] {
    const rows = this.stmtGetEntriesForRun.all(runId) as EntryRow[]
    return rows.map(rowToEntry)
  }

  /** Get all pending (unanswered) escalation entries across all apps, oldest first */
  getAllPendingEscalations(): ActivityEntry[] {
    const rows = this.stmtGetAllPendingEscalations.all() as EntryRow[]
    return rows.map(rowToEntry)
  }

  /**
   * Close orphan escalation entries for an app.
   *
   * An "orphan" is a pending escalation entry (user_response_json IS NULL) that
   * does not match the app's current active escalation. Orphans are produced when
   * the app leaves `waiting_user` state without the escalation being resolved
   * (e.g. user pauses then resumes the app).
   *
   * @param appId - The app ID to clean up.
   * @param activeEntryId - The currently active escalation entry ID to keep open.
   *                        If omitted, ALL pending escalation entries for this app are closed.
   * @returns Number of entries closed.
   */
  closeOrphanEscalations(appId: string, activeEntryId?: string): number {
    const responseJson = JSON.stringify({
      ts: Date.now(),
      text: '[Auto-closed] Escalation orphaned by app state change.',
    })

    if (activeEntryId) {
      const result = this.stmtCloseOrphanEscalations.run(responseJson, appId, activeEntryId)
      return result.changes
    } else {
      const result = this.stmtCloseOrphanEscalationsAll.run(responseJson, appId)
      return result.changes
    }
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
    const result = this.db.prepare(`
      DELETE FROM automation_runs
      WHERE started_at < ?
        AND status NOT IN ('running', 'waiting_user')
    `).run(cutoff)
    return result.changes
  }
}
