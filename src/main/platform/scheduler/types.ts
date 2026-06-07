/**
 * platform/scheduler -- Type Definitions
 *
 * Public types for the job scheduling engine.
 * These types form the contract between the scheduler and its consumers
 * (primarily apps/runtime).
 *
 * Design: The scheduler is a general-purpose engine. It does not know about
 * AI, LLM, or Apps. The `metadata` field is an opaque pass-through for
 * consumer-specific data (e.g., appId, subscriptionId).
 */

// ---------------------------------------------------------------------------
// Schedule definitions
// ---------------------------------------------------------------------------

/**
 * A schedule definition for a job.
 *
 * - `every`: Repeating interval (e.g., "30m", "2h", "1d"). Uses anchor-based
 *   grid alignment to avoid drift and prevent catch-up storms after offline.
 * - `cron`: Standard cron expression with optional timezone. Evaluated via `croner`.
 * - `once`: One-shot execution at a specific timestamp. Job is disabled after
 *   execution (success or error).
 */
export type ScheduleKind = 'every' | 'cron' | 'once'

export interface ScheduleEvery {
  kind: 'every'
  /** Human-readable interval string: "30m" | "2h" | "1d" | "45s" etc. */
  every: string
}

export interface ScheduleCron {
  kind: 'cron'
  /** Standard cron expression, e.g. "0 9 * * *". */
  cron: string
  /** IANA timezone for cron evaluation. Defaults to system timezone. */
  timezone?: string
}

export interface ScheduleOnce {
  kind: 'once'
  /** Absolute timestamp in milliseconds (Date.now() style). */
  once: number
}

export type Schedule = ScheduleEvery | ScheduleCron | ScheduleOnce

// ---------------------------------------------------------------------------
// Job status
// ---------------------------------------------------------------------------

/**
 * Runtime status of a scheduler job.
 *
 * - `idle`: Waiting for next run time.
 * - `running`: Currently executing (handler has been called, awaiting result).
 * - `paused`: User explicitly paused. Will not fire until resumed.
 * - `disabled`: Auto-disabled due to repeated errors. Requires explicit resume.
 */
export type JobStatus = 'idle' | 'running' | 'paused' | 'disabled'

// ---------------------------------------------------------------------------
// Run outcome
// ---------------------------------------------------------------------------

/**
 * The outcome of a single job execution, reported by the consumer's handler.
 *
 * - `useful`: The execution produced meaningful results.
 * - `noop`: The execution ran successfully but found nothing actionable.
 * - `error`: The execution failed.
 * - `skipped`: The execution was skipped (e.g., consumer-side concurrency limit).
 */
export type RunOutcome = 'useful' | 'noop' | 'error' | 'skipped'

// ---------------------------------------------------------------------------
// Job definition
// ---------------------------------------------------------------------------

/**
 * A complete scheduler job, including both user-provided configuration
 * and scheduler-managed runtime state.
 */
export interface SchedulerJob {
  /** Unique job identifier (UUID). */
  id: string
  /** Human-readable job name. */
  name: string
  /** Schedule configuration. */
  schedule: Schedule
  /** Whether the job is enabled for scheduling. */
  enabled: boolean
  /**
   * Opaque metadata passed through to the consumer's handler.
   * The scheduler never reads or modifies this data.
   * Typical use: { appId: string, subscriptionId: string }
   */
  metadata?: Record<string, unknown>

  /**
   * Discriminator selecting which registered handler executes this job.
   * Defaults to 'app'. The scheduler routes due jobs by this value so multiple
   * domains (e.g. apps, teams) can each own a handler without depending on one
   * another. Persisted; existing rows default to 'app'.
   */
  kind?: string

  // -- Scheduler-managed runtime state --

  /**
   * Anchor timestamp for `every` schedules. The grid of run times is
   * anchorMs, anchorMs + everyMs, anchorMs + 2*everyMs, ...
   * Set to job creation time by default.
   */
  anchorMs: number
  /** Computed next run time in epoch milliseconds. */
  nextRunAtMs: number
  /** Timestamp of the last completed run (success or error). */
  lastRunAtMs?: number
  /** Epoch ms when the current execution started. Null if not running. */
  runningAtMs?: number
  /** Number of consecutive execution errors (reset on success). */
  consecutiveErrors: number
  /** Current job status. */
  status: JobStatus
  /** Timestamp when the job was created. */
  createdAt: number
  /** Timestamp when the job was last modified. */
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Job creation input
// ---------------------------------------------------------------------------

/**
 * Input for creating a new job. The consumer provides the configuration;
 * the scheduler fills in runtime state fields.
 */
export type SchedulerJobCreate = Omit<
  SchedulerJob,
  'anchorMs' | 'nextRunAtMs' | 'lastRunAtMs' | 'runningAtMs' | 'consecutiveErrors' | 'status' | 'createdAt' | 'updatedAt'
>

// ---------------------------------------------------------------------------
// Job update input
// ---------------------------------------------------------------------------

/**
 * Partial update for a job. Only the specified fields are changed.
 * Runtime state fields cannot be directly updated by the consumer.
 */
export type SchedulerJobUpdate = Partial<Pick<SchedulerJob, 'name' | 'schedule' | 'enabled' | 'metadata'>>

// ---------------------------------------------------------------------------
// Run log
// ---------------------------------------------------------------------------

/**
 * A single entry in the job run log, recording the outcome of one execution.
 */
export interface RunLogEntry {
  /** Auto-incremented log entry ID. */
  id: number
  /** The job that was executed. */
  jobId: string
  /** When the execution started (epoch ms). */
  startedAt: number
  /** When the execution finished (epoch ms). */
  finishedAt: number
  /** Duration in milliseconds. */
  durationMs: number
  /** The outcome of the execution. */
  outcome: RunOutcome
  /** Error message if outcome is 'error'. */
  error?: string
  /** Snapshot of job metadata at execution time. */
  metadata?: Record<string, unknown>
}

/**
 * Aggregated statistics for a job's run history.
 */
export interface RunStats {
  /** Total number of runs in the query window. */
  totalRuns: number
  /** Count of each outcome type. */
  useful: number
  noop: number
  error: number
  skipped: number
  /** Average duration in milliseconds. */
  avgDurationMs: number
  /** Timestamp of the last run (any outcome). */
  lastRunAt?: number
}

// ---------------------------------------------------------------------------
// Job due handler
// ---------------------------------------------------------------------------

/**
 * The callback signature for job execution. Registered via `onJobDue()`.
 *
 * The handler receives the full job object and must return a `RunOutcome`.
 * If the handler throws, the outcome is treated as `'error'`.
 *
 * The scheduler guarantees:
 * - A job's handler is never called concurrently with itself.
 * - The handler receives a snapshot of the job at execution time.
 */
export type JobDueHandler = (job: SchedulerJob) => Promise<RunOutcome>

// ---------------------------------------------------------------------------
// Filter for listing jobs
// ---------------------------------------------------------------------------

export interface JobFilter {
  /** Filter by job status. */
  status?: JobStatus
  /** Filter by metadata key-value match (shallow equality). */
  metadata?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// SchedulerService interface
// ---------------------------------------------------------------------------

/**
 * The public API of the scheduler module.
 *
 * Lifecycle: `initScheduler()` -> use service -> `service.stop()` or
 * `shutdownScheduler()` on process exit.
 */
export interface SchedulerService {
  // -- Job CRUD --

  /** Create a new job. Returns the generated job ID. */
  addJob(job: SchedulerJobCreate): string

  /** Remove a job and its run log entries. */
  removeJob(jobId: string): void

  /** Update job configuration. Runtime state fields are not directly updatable. */
  updateJob(jobId: string, updates: SchedulerJobUpdate): void

  /** Pause a job (stop scheduling, preserve state). */
  pauseJob(jobId: string): void

  /**
   * Resume a paused or disabled job.
   * Resets consecutiveErrors to 0 and recomputes nextRunAtMs.
   */
  resumeJob(jobId: string): void

  /** Get a job by ID, or null if not found. */
  getJob(jobId: string): SchedulerJob | null

  /** List jobs, optionally filtered. */
  listJobs(filter?: JobFilter): SchedulerJob[]

  // -- Execution --

  /**
   * Register the callback invoked when a job of the given `kind` is due.
   * Each kind has its own handler; registering the same kind again replaces it.
   * Jobs with no explicit kind default to 'app'. A due job whose kind has no
   * registered handler is recorded as an error (never silently dropped).
   */
  onJobDue(kind: string, handler: JobDueHandler): void

  /** Start the timer loop. Call after registering the handler. */
  start(): void

  /** Stop the timer loop. Does not cancel in-flight executions. */
  stop(): void

  // -- Observability --

  /** Get recent run log entries for a job. Default limit: 50. */
  getRunLog(jobId: string, limit?: number): RunLogEntry[]

  /** Get aggregated run statistics for a job since a given timestamp. */
  getRunStats(jobId: string, since?: number): RunStats
}
