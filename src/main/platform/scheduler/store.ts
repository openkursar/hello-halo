/**
 * platform/scheduler -- SQLite Persistence Layer
 *
 * Manages the `scheduler_jobs` and `scheduler_run_log` tables.
 * All database operations are synchronous (better-sqlite3 API).
 *
 * This module is a pure data-access layer with no business logic.
 * It converts between the in-memory SchedulerJob types and their
 * SQLite row representations.
 */

import type Database from 'better-sqlite3'
import type { DatabaseManager, Migration } from '../store/types'
import type {
  SchedulerJob,
  RunLogEntry,
  RunStats,
  RunOutcome,
  Schedule,
  JobStatus,
  JobFilter
} from './types'

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

const NAMESPACE = 'scheduler'

const migrations: Migration[] = [
  {
    version: 1,
    description: 'Create scheduler_jobs and scheduler_run_log tables',
    up(db: Database.Database) {
      db.exec(`
        CREATE TABLE scheduler_jobs (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          schedule_json TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          anchor_ms INTEGER NOT NULL,
          next_run_at_ms INTEGER NOT NULL,
          last_run_at_ms INTEGER,
          running_at_ms INTEGER,
          consecutive_errors INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'idle',
          metadata_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)

      db.exec(`
        CREATE TABLE scheduler_run_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          finished_at INTEGER NOT NULL,
          duration_ms INTEGER NOT NULL,
          outcome TEXT NOT NULL,
          error TEXT,
          metadata_json TEXT,
          FOREIGN KEY (job_id) REFERENCES scheduler_jobs(id) ON DELETE CASCADE
        )
      `)

      db.exec(`
        CREATE INDEX idx_run_log_job_started
        ON scheduler_run_log(job_id, started_at DESC)
      `)
    }
  },
  {
    version: 2,
    description: 'Add kind discriminator for multi-consumer dispatch (default app)',
    up(db: Database.Database) {
      db.exec(`ALTER TABLE scheduler_jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'app'`)
    }
  }
]

// ---------------------------------------------------------------------------
// Row types (SQLite representation)
// ---------------------------------------------------------------------------

interface JobRow {
  id: string
  name: string
  schedule_json: string
  enabled: number  // SQLite boolean: 0 or 1
  anchor_ms: number
  next_run_at_ms: number
  last_run_at_ms: number | null
  running_at_ms: number | null
  consecutive_errors: number
  status: string
  metadata_json: string | null
  kind: string
  created_at: number
  updated_at: number
}

interface RunLogRow {
  id: number
  job_id: string
  started_at: number
  finished_at: number
  duration_ms: number
  outcome: string
  error: string | null
  metadata_json: string | null
}

interface RunStatsRow {
  total_runs: number
  useful_count: number
  noop_count: number
  error_count: number
  skipped_count: number
  avg_duration_ms: number | null
  last_run_at: number | null
}

// ---------------------------------------------------------------------------
// Row <-> Domain conversion
// ---------------------------------------------------------------------------

function rowToJob(row: JobRow): SchedulerJob {
  return {
    id: row.id,
    name: row.name,
    schedule: JSON.parse(row.schedule_json) as Schedule,
    enabled: row.enabled === 1,
    anchorMs: row.anchor_ms,
    nextRunAtMs: row.next_run_at_ms,
    lastRunAtMs: row.last_run_at_ms ?? undefined,
    runningAtMs: row.running_at_ms ?? undefined,
    consecutiveErrors: row.consecutive_errors,
    status: row.status as JobStatus,
    metadata: row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : undefined,
    kind: row.kind,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function rowToRunLogEntry(row: RunLogRow): RunLogEntry {
  return {
    id: row.id,
    jobId: row.job_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    outcome: row.outcome as RunOutcome,
    error: row.error ?? undefined,
    metadata: row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : undefined
  }
}

// ---------------------------------------------------------------------------
// SchedulerStore class
// ---------------------------------------------------------------------------

/**
 * Data access object for scheduler persistence.
 *
 * Wraps all SQLite queries for the scheduler's two tables.
 * Stateless -- it uses the database reference from the DatabaseManager.
 */
export class SchedulerStore {
  private db: Database.Database

  constructor(dbManager: DatabaseManager) {
    this.db = dbManager.getAppDatabase()

    // Run schema migrations
    dbManager.runMigrations(this.db, NAMESPACE, migrations)
  }

  // -----------------------------------------------------------------------
  // Job CRUD
  // -----------------------------------------------------------------------

  /**
   * Insert a new job into the database.
   */
  insertJob(job: SchedulerJob): void {
    this.db.prepare(`
      INSERT INTO scheduler_jobs (
        id, name, schedule_json, enabled, anchor_ms, next_run_at_ms,
        last_run_at_ms, running_at_ms, consecutive_errors, status,
        metadata_json, kind, created_at, updated_at
      ) VALUES (
        @id, @name, @schedule_json, @enabled, @anchor_ms, @next_run_at_ms,
        @last_run_at_ms, @running_at_ms, @consecutive_errors, @status,
        @metadata_json, @kind, @created_at, @updated_at
      )
    `).run({
      id: job.id,
      name: job.name,
      schedule_json: JSON.stringify(job.schedule),
      enabled: job.enabled ? 1 : 0,
      anchor_ms: job.anchorMs,
      next_run_at_ms: job.nextRunAtMs,
      last_run_at_ms: job.lastRunAtMs ?? null,
      running_at_ms: job.runningAtMs ?? null,
      consecutive_errors: job.consecutiveErrors,
      status: job.status,
      metadata_json: job.metadata ? JSON.stringify(job.metadata) : null,
      kind: job.kind ?? 'app',
      created_at: job.createdAt,
      updated_at: job.updatedAt
    })
  }

  /**
   * Update an existing job in the database (full replace of all mutable fields).
   */
  updateJob(job: SchedulerJob): void {
    this.db.prepare(`
      UPDATE scheduler_jobs SET
        name = @name,
        schedule_json = @schedule_json,
        enabled = @enabled,
        anchor_ms = @anchor_ms,
        next_run_at_ms = @next_run_at_ms,
        last_run_at_ms = @last_run_at_ms,
        running_at_ms = @running_at_ms,
        consecutive_errors = @consecutive_errors,
        status = @status,
        metadata_json = @metadata_json,
        kind = @kind,
        updated_at = @updated_at
      WHERE id = @id
    `).run({
      id: job.id,
      name: job.name,
      schedule_json: JSON.stringify(job.schedule),
      enabled: job.enabled ? 1 : 0,
      anchor_ms: job.anchorMs,
      next_run_at_ms: job.nextRunAtMs,
      last_run_at_ms: job.lastRunAtMs ?? null,
      running_at_ms: job.runningAtMs ?? null,
      consecutive_errors: job.consecutiveErrors,
      status: job.status,
      metadata_json: job.metadata ? JSON.stringify(job.metadata) : null,
      kind: job.kind ?? 'app',
      updated_at: job.updatedAt
    })
  }

  /**
   * Delete a job and its associated run log entries (cascade).
   */
  deleteJob(jobId: string): boolean {
    const result = this.db.prepare('DELETE FROM scheduler_jobs WHERE id = ?').run(jobId)
    return result.changes > 0
  }

  /**
   * Get a single job by ID.
   */
  getJob(jobId: string): SchedulerJob | null {
    const row = this.db.prepare('SELECT * FROM scheduler_jobs WHERE id = ?').get(jobId) as JobRow | undefined
    return row ? rowToJob(row) : null
  }

  /**
   * List all jobs, optionally filtered.
   */
  listJobs(filter?: JobFilter): SchedulerJob[] {
    let sql = 'SELECT * FROM scheduler_jobs'
    const conditions: string[] = []
    const params: Record<string, unknown> = {}

    if (filter?.status) {
      conditions.push('status = @status')
      params.status = filter.status
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ')
    }

    sql += ' ORDER BY next_run_at_ms ASC'

    const rows = this.db.prepare(sql).all(params) as JobRow[]
    let jobs = rows.map(rowToJob)

    // Apply metadata filter in-memory (metadata is JSON, not SQL-queryable)
    if (filter?.metadata) {
      const filterMeta = filter.metadata
      jobs = jobs.filter(job => {
        if (!job.metadata) return false
        return Object.entries(filterMeta).every(([key, value]) => job.metadata![key] === value)
      })
    }

    return jobs
  }

  /**
   * Get all enabled jobs (for timer tick evaluation).
   */
  getEnabledJobs(): SchedulerJob[] {
    const rows = this.db.prepare(
      'SELECT * FROM scheduler_jobs WHERE enabled = 1'
    ).all() as JobRow[]
    return rows.map(rowToJob)
  }

  /**
   * Bulk-clear stale `running_at_ms` markers (used on startup recovery).
   * Returns the number of affected jobs.
   */
  clearStaleRunningMarkers(): number {
    const result = this.db.prepare(
      `UPDATE scheduler_jobs SET running_at_ms = NULL, status = 'idle' WHERE running_at_ms IS NOT NULL AND status = 'running'`
    ).run()
    return result.changes
  }

  // -----------------------------------------------------------------------
  // Run Log
  // -----------------------------------------------------------------------

  /**
   * Insert a run log entry.
   */
  insertRunLog(entry: Omit<RunLogEntry, 'id'>): void {
    this.db.prepare(`
      INSERT INTO scheduler_run_log (
        job_id, started_at, finished_at, duration_ms, outcome, error, metadata_json
      ) VALUES (
        @job_id, @started_at, @finished_at, @duration_ms, @outcome, @error, @metadata_json
      )
    `).run({
      job_id: entry.jobId,
      started_at: entry.startedAt,
      finished_at: entry.finishedAt,
      duration_ms: entry.durationMs,
      outcome: entry.outcome,
      error: entry.error ?? null,
      metadata_json: entry.metadata ? JSON.stringify(entry.metadata) : null
    })
  }

  /**
   * Get recent run log entries for a job, newest first.
   */
  getRunLog(jobId: string, limit: number = 50): RunLogEntry[] {
    const rows = this.db.prepare(`
      SELECT * FROM scheduler_run_log
      WHERE job_id = ?
      ORDER BY started_at DESC
      LIMIT ?
    `).all(jobId, limit) as RunLogRow[]
    return rows.map(rowToRunLogEntry)
  }

  /**
   * Get aggregated run statistics for a job since a given timestamp.
   */
  getRunStats(jobId: string, sinceMs?: number): RunStats {
    const since = sinceMs ?? 0
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as total_runs,
        SUM(CASE WHEN outcome = 'useful' THEN 1 ELSE 0 END) as useful_count,
        SUM(CASE WHEN outcome = 'noop' THEN 1 ELSE 0 END) as noop_count,
        SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) as error_count,
        SUM(CASE WHEN outcome = 'skipped' THEN 1 ELSE 0 END) as skipped_count,
        AVG(duration_ms) as avg_duration_ms,
        MAX(started_at) as last_run_at
      FROM scheduler_run_log
      WHERE job_id = ? AND started_at >= ?
    `).get(jobId, since) as RunStatsRow

    return {
      totalRuns: row.total_runs,
      useful: row.useful_count,
      noop: row.noop_count,
      error: row.error_count,
      skipped: row.skipped_count,
      avgDurationMs: row.avg_duration_ms ?? 0,
      lastRunAt: row.last_run_at ?? undefined
    }
  }

  /**
   * Prune old run log entries, keeping at most `maxEntries` per job.
   * Called periodically to prevent unbounded growth.
   */
  pruneRunLog(maxEntriesPerJob: number = 1000): number {
    // Find job IDs that have more than maxEntries
    const overflowJobs = this.db.prepare(`
      SELECT job_id, COUNT(*) as cnt
      FROM scheduler_run_log
      GROUP BY job_id
      HAVING cnt > ?
    `).all(maxEntriesPerJob) as Array<{ job_id: string; cnt: number }>

    let totalPruned = 0
    for (const { job_id } of overflowJobs) {
      const result = this.db.prepare(`
        DELETE FROM scheduler_run_log
        WHERE job_id = ? AND id NOT IN (
          SELECT id FROM scheduler_run_log
          WHERE job_id = ?
          ORDER BY started_at DESC
          LIMIT ?
        )
      `).run(job_id, job_id, maxEntriesPerJob)
      totalPruned += result.changes
    }

    return totalPruned
  }
}
