/**
 * platform/scheduler -- Timer Loop & Execution Engine
 *
 * Manages the timer-driven execution loop for the scheduler.
 * Responsibilities:
 * - Periodic tick to find and execute due jobs
 * - Exponential backoff on errors
 * - Stuck job detection and recovery
 * - Startup recovery (catch-up for missed runs)
 * - Run log recording
 *
 * The timer uses recursive setTimeout (not setInterval) for precise control
 * over scheduling. The delay is clamped to MAX_TIMER_DELAY_MS to ensure
 * timely recovery from clock jumps.
 */

import { computeNextRun, parseEveryString } from './schedule'
import { SchedulerStore } from './store'
import type {
  SchedulerJob,
  JobDueHandler,
  RunOutcome,
  JobStatus
} from './types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum timer delay in milliseconds. The timer wakes at least this often,
 * even if no jobs are due. This ensures recovery from clock jumps and prevents
 * the Node.js setTimeout 32-bit overflow (max ~24.8 days).
 */
const MAX_TIMER_DELAY_MS = 60_000

/**
 * If a job's `runningAtMs` is older than this threshold, it is considered
 * stuck (process crashed during execution) and the marker is cleared.
 */
const STUCK_JOB_THRESHOLD_MS = 2 * 60 * 60 * 1000 // 2 hours

/**
 * Maximum consecutive errors before a job is auto-disabled.
 */
const MAX_CONSECUTIVE_ERRORS = 5

/**
 * Exponential backoff delays indexed by (consecutiveErrors - 1).
 * After the last entry, the delay stays constant.
 */
const ERROR_BACKOFF_MS = [
  30_000,       // 1st error  ->  30 seconds
  60_000,       // 2nd error  ->   1 minute
  5 * 60_000,   // 3rd error  ->   5 minutes
  15 * 60_000,  // 4th error  ->  15 minutes
  60 * 60_000,  // 5th+ error ->  60 minutes
]

// ---------------------------------------------------------------------------
// Backoff calculation
// ---------------------------------------------------------------------------

/**
 * Get the backoff delay in milliseconds for a given consecutive error count.
 */
function getBackoffDelay(consecutiveErrors: number): number {
  const idx = Math.min(consecutiveErrors - 1, ERROR_BACKOFF_MS.length - 1)
  return ERROR_BACKOFF_MS[Math.max(0, idx)]
}

// ---------------------------------------------------------------------------
// SchedulerTimer class
// ---------------------------------------------------------------------------

/**
 * The timer engine that drives the scheduler's execution loop.
 *
 * Usage:
 *   const timer = new SchedulerTimer(store, () => Date.now())
 *   timer.setHandler(async (job) => { ... return 'useful' })
 *   timer.start()
 *   // later
 *   timer.stop()
 */
/** Default job kind for jobs created before kind-based dispatch existed. */
const DEFAULT_JOB_KIND = 'app'

export class SchedulerTimer {
  private store: SchedulerStore
  private handlers = new Map<string, JobDueHandler>()
  private timerId: ReturnType<typeof setTimeout> | null = null
  private running = false  // Guard against concurrent tick execution
  private nowFn: () => number

  /**
   * @param store - The persistence layer for jobs and run logs.
   * @param nowFn - Function returning current epoch ms. Injectable for testing.
   */
  constructor(store: SchedulerStore, nowFn: () => number = () => Date.now()) {
    this.store = store
    this.nowFn = nowFn
  }

  /**
   * Register the handler called when a job of the given `kind` is due.
   * Each kind has its own handler; re-registering a kind replaces it.
   */
  setHandler(kind: string, handler: JobDueHandler): void {
    this.handlers.set(kind, handler)
  }

  /**
   * Start the scheduler timer loop.
   *
   * On start:
   * 1. Clear stale running markers from crashed executions.
   * 2. Run catch-up for missed jobs (at most one run per job).
   * 3. Arm the timer for the next due job.
   */
  start(): void {
    const now = this.nowFn()

    // Step 1: Clear stale running markers
    const clearedCount = this.store.clearStaleRunningMarkers()
    if (clearedCount > 0) {
      console.log(`[Scheduler] Cleared ${clearedCount} stale running marker(s) from previous session`)
    }

    // Step 2: Recompute next run times for all enabled jobs
    this.recomputeAllNextRuns(now)

    // Step 3: Run missed jobs (catch-up, at most once each)
    this.runMissedJobs(now)

    // Step 4: Arm the timer
    this.armTimer()

    const enabledJobs = this.store.getEnabledJobs()
    console.log(
      `[Scheduler] Started with ${enabledJobs.length} enabled job(s). ` +
      `Next wake: ${this.getNextWakeDescription()}`
    )
  }

  /**
   * Stop the scheduler timer loop.
   * Does not cancel in-flight job executions.
   */
  stop(): void {
    if (this.timerId !== null) {
      clearTimeout(this.timerId)
      this.timerId = null
    }
    console.log('[Scheduler] Timer stopped')
  }

  /**
   * Re-arm the timer. Called after job mutations (add/remove/update)
   * to ensure the timer wakes at the correct time.
   */
  rearm(): void {
    this.armTimer()
  }

  // -----------------------------------------------------------------------
  // Timer management
  // -----------------------------------------------------------------------

  private armTimer(): void {
    if (this.timerId !== null) {
      clearTimeout(this.timerId)
      this.timerId = null
    }

    const nextWakeMs = this.findNextWakeTime()
    if (nextWakeMs === undefined) {
      // No enabled jobs with a future run time
      return
    }

    const now = this.nowFn()
    const delay = Math.max(0, nextWakeMs - now)
    // Clamp to MAX_TIMER_DELAY_MS for recovery from clock jumps
    const clampedDelay = Math.min(delay, MAX_TIMER_DELAY_MS)

    this.timerId = setTimeout(() => {
      this.onTick().catch(err => {
        console.error('[Scheduler] Timer tick failed:', err)
      })
    }, clampedDelay)
  }

  /**
   * Find the earliest nextRunAtMs among all enabled, non-running jobs.
   */
  private findNextWakeTime(): number | undefined {
    const jobs = this.store.getEnabledJobs()
    let earliest: number | undefined

    for (const job of jobs) {
      if (job.runningAtMs != null) continue // Skip running jobs
      if (job.status === 'paused' || job.status === 'disabled') continue

      const next = job.nextRunAtMs
      if (next != null && (earliest === undefined || next < earliest)) {
        earliest = next
      }
    }

    return earliest
  }

  private getNextWakeDescription(): string {
    const nextWake = this.findNextWakeTime()
    if (nextWake === undefined) return 'no jobs scheduled'
    const delta = nextWake - this.nowFn()
    if (delta <= 0) return 'immediately'
    if (delta < 60_000) return `in ${Math.ceil(delta / 1000)}s`
    if (delta < 3_600_000) return `in ${Math.ceil(delta / 60_000)}m`
    return `in ${(delta / 3_600_000).toFixed(1)}h`
  }

  // -----------------------------------------------------------------------
  // Tick handler
  // -----------------------------------------------------------------------

  private async onTick(): Promise<void> {
    if (this.running) {
      // A previous tick is still executing. Re-arm and return.
      // This prevents concurrent tick execution.
      this.timerId = setTimeout(() => {
        this.onTick().catch(err => {
          console.error('[Scheduler] Timer tick failed:', err)
        })
      }, MAX_TIMER_DELAY_MS)
      return
    }

    this.running = true
    try {
      const now = this.nowFn()

      // Clean up stuck jobs
      this.cleanupStuckJobs(now)

      // Find due jobs
      const dueJobs = this.findDueJobs(now)
      console.debug(`[Scheduler] Tick: ${dueJobs.length} due, ${this.store.listJobs().filter(j => j.enabled).length} enabled total`)

      if (dueJobs.length === 0) {
        // No due jobs, but do maintenance recompute for any that need it
        this.maintenanceRecompute(now)
        return
      }

      // Execute due jobs sequentially
      // (The consumer is responsible for global concurrency control)
      for (const job of dueJobs) {
        await this.executeJob(job, now)
      }
    } finally {
      this.running = false
      this.armTimer()
    }
  }

  // -----------------------------------------------------------------------
  // Job execution
  // -----------------------------------------------------------------------

  /**
   * Find all jobs that are due for execution.
   *
   * A job is due if:
   * - It is enabled
   * - It has a nextRunAtMs <= now
   * - It is not currently running
   * - Its status is 'idle' (not 'paused' or 'disabled')
   */
  private findDueJobs(nowMs: number): SchedulerJob[] {
    const enabledJobs = this.store.getEnabledJobs()
    return enabledJobs.filter(job =>
      job.enabled &&
      job.status === 'idle' &&
      job.runningAtMs == null &&
      job.nextRunAtMs != null &&
      nowMs >= job.nextRunAtMs
    )
  }

  /**
   * Execute a single job: set running state, call handler, update state.
   */
  private async executeJob(job: SchedulerJob, nowMs: number): Promise<void> {
    const kind = job.kind ?? DEFAULT_JOB_KIND
    const handler = this.handlers.get(kind)

    const startedAt = this.nowFn()
    console.debug(`[Scheduler] Executing job "${job.name}" (${job.id}), kind=${kind}, schedule=${JSON.stringify(job.schedule)}, consecutiveErrors=${job.consecutiveErrors}`)

    // Mark as running
    job.runningAtMs = startedAt
    job.status = 'running'
    job.updatedAt = startedAt
    this.store.updateJob(job)

    let outcome: RunOutcome = 'error'
    let errorMessage: string | undefined

    if (!handler) {
      // No registered consumer for this kind: record an error (never silent) so
      // backoff/auto-disable applies instead of tight-looping on every tick.
      errorMessage = `No handler registered for job kind "${kind}"`
      console.error(`[Scheduler] Job "${job.name}" (${job.id}): ${errorMessage}`)
    } else {
      try {
        outcome = await handler(job)
      } catch (err) {
        outcome = 'error'
        errorMessage = err instanceof Error ? err.message : String(err)
        console.error(
          `[Scheduler] Job "${job.name}" (${job.id}) handler threw:`,
          errorMessage
        )
      }
    }

    const finishedAt = this.nowFn()
    const durationMs = Math.max(0, finishedAt - startedAt)
    console.debug(`[Scheduler] Job "${job.name}" (${job.id}) finished: outcome=${outcome}, duration=${durationMs}ms${errorMessage ? `, error=${errorMessage}` : ''}`)

    // Record run log
    this.store.insertRunLog({
      jobId: job.id,
      startedAt,
      finishedAt,
      durationMs,
      outcome,
      error: errorMessage,
      metadata: job.metadata
    })

    // Apply result to job state
    this.applyJobResult(job, outcome, errorMessage, startedAt, finishedAt)
  }

  /**
   * Apply the result of a job execution to its state.
   *
   * Handles:
   * - Clearing the running marker
   * - Updating lastRunAtMs
   * - Tracking consecutive errors and applying backoff
   * - Auto-disabling after MAX_CONSECUTIVE_ERRORS
   * - Computing the next run time
   * - Disabling `once` jobs after execution
   */
  private applyJobResult(
    job: SchedulerJob,
    outcome: RunOutcome,
    error: string | undefined,
    startedAt: number,
    finishedAt: number
  ): void {
    // Clear running state
    job.runningAtMs = undefined
    job.lastRunAtMs = startedAt
    job.updatedAt = finishedAt

    // Track consecutive errors
    if (outcome === 'error') {
      job.consecutiveErrors += 1
    } else {
      job.consecutiveErrors = 0
    }

    // Handle `once` schedule: disable after any execution
    if (job.schedule.kind === 'once') {
      job.enabled = false
      job.status = 'disabled'
      job.nextRunAtMs = 0
      this.store.updateJob(job)
      console.log(
        `[Scheduler] One-shot job "${job.name}" (${job.id}) completed with outcome: ${outcome}`
      )
      return
    }

    // Check auto-disable threshold
    if (job.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      job.enabled = false
      job.status = 'disabled'
      job.nextRunAtMs = 0
      this.store.updateJob(job)
      console.warn(
        `[Scheduler] Auto-disabled job "${job.name}" (${job.id}) after ${job.consecutiveErrors} consecutive errors`
      )
      return
    }

    // Compute next run time
    job.status = 'idle'
    const normalNext = computeNextRun(job.schedule, job.anchorMs, finishedAt)

    if (normalNext === undefined) {
      // No future run possible
      job.enabled = false
      job.status = 'disabled'
      job.nextRunAtMs = 0
      this.store.updateJob(job)
      return
    }

    if (outcome === 'error' && job.consecutiveErrors > 0) {
      // Apply exponential backoff
      const backoffDelay = getBackoffDelay(job.consecutiveErrors)
      const backoffNext = finishedAt + backoffDelay
      // Use whichever is later: normal schedule or backoff
      job.nextRunAtMs = Math.max(normalNext, backoffNext)
      console.log(
        `[Scheduler] Job "${job.name}" (${job.id}) backoff: ` +
        `${job.consecutiveErrors} errors, next run in ${Math.ceil((job.nextRunAtMs - finishedAt) / 1000)}s`
      )
    } else {
      job.nextRunAtMs = normalNext
    }

    this.store.updateJob(job)
  }

  // -----------------------------------------------------------------------
  // Startup recovery
  // -----------------------------------------------------------------------

  /**
   * Run catch-up for jobs that missed their scheduled run (at most once each).
   * Called during start() after clearing stale markers.
   */
  private runMissedJobs(nowMs: number): void {
    const dueJobs = this.findDueJobs(nowMs)

    if (dueJobs.length === 0) return

    console.log(
      `[Scheduler] Found ${dueJobs.length} missed job(s) to catch up`
    )

    // Execute missed jobs asynchronously but don't block startup.
    // We run them as part of the first timer tick instead.
    // The timer will fire immediately (delay = 0) if there are due jobs.
  }

  /**
   * Recompute nextRunAtMs for all enabled jobs.
   * Used on startup to ensure consistency after potential clock changes.
   */
  private recomputeAllNextRuns(nowMs: number): void {
    const jobs = this.store.getEnabledJobs()

    for (const job of jobs) {
      if (job.status === 'paused' || job.status === 'disabled') continue
      if (job.runningAtMs != null) continue

      // Only recompute if nextRunAtMs is missing or already past
      const nextRun = job.nextRunAtMs
      const needsRecompute = nextRun == null || nextRun === 0

      if (needsRecompute) {
        try {
          const newNext = computeNextRun(job.schedule, job.anchorMs, nowMs)
          if (newNext !== undefined) {
            job.nextRunAtMs = newNext
            job.updatedAt = nowMs
            this.store.updateJob(job)
          } else {
            // Schedule produces no future run times -- disable to prevent infinite catch-up
            console.warn(
              `[Scheduler] Disabling job "${job.name}" (${job.id}): ` +
              `schedule produces no future run times. Fix the cron expression or schedule config.`
            )
            job.enabled = false
            job.status = 'disabled'
            job.nextRunAtMs = 0
            job.updatedAt = nowMs
            this.store.updateJob(job)
          }
        } catch (err) {
          console.error(
            `[Scheduler] Failed to recompute next run for job "${job.name}" (${job.id}):`,
            err
          )
          // Disable to prevent infinite catch-up on invalid schedule
          console.warn(
            `[Scheduler] Disabling job "${job.name}" (${job.id}) due to schedule computation error. ` +
            `Fix the cron expression or schedule config.`
          )
          job.enabled = false
          job.status = 'disabled'
          job.nextRunAtMs = 0
          job.updatedAt = nowMs
          this.store.updateJob(job)
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Maintenance
  // -----------------------------------------------------------------------

  /**
   * Clean up jobs that have been "running" for too long (process crash recovery).
   */
  private cleanupStuckJobs(nowMs: number): void {
    const jobs = this.store.getEnabledJobs()

    for (const job of jobs) {
      if (job.runningAtMs == null) continue

      const runningDuration = nowMs - job.runningAtMs
      if (runningDuration > STUCK_JOB_THRESHOLD_MS) {
        console.warn(
          `[Scheduler] Clearing stuck running marker for job "${job.name}" (${job.id}), ` +
          `running for ${Math.ceil(runningDuration / 60_000)} minutes`
        )
        job.runningAtMs = undefined
        job.status = 'idle'
        job.updatedAt = nowMs

        // Recompute next run
        try {
          const next = computeNextRun(job.schedule, job.anchorMs, nowMs)
          if (next !== undefined) {
            job.nextRunAtMs = next
          }
        } catch {
          // If schedule computation fails, leave nextRunAtMs as-is
        }

        this.store.updateJob(job)
      }
    }
  }

  /**
   * Maintenance-only recompute: fill in missing nextRunAtMs values
   * without advancing past-due jobs (which should be executed, not skipped).
   */
  private maintenanceRecompute(nowMs: number): void {
    const jobs = this.store.getEnabledJobs()
    let changed = false

    for (const job of jobs) {
      if (job.status === 'paused' || job.status === 'disabled') continue
      if (job.runningAtMs != null) continue

      // Only fill in MISSING nextRunAtMs
      if (job.nextRunAtMs == null || job.nextRunAtMs === 0) {
        try {
          const next = computeNextRun(job.schedule, job.anchorMs, nowMs)
          if (next !== undefined) {
            job.nextRunAtMs = next
            job.updatedAt = nowMs
            this.store.updateJob(job)
            changed = true
          }
        } catch {
          // Skip
        }
      }
    }

    // Periodic run log pruning (every tick is fine, the operation is cheap)
    if (changed) {
      this.store.pruneRunLog(1000)
    }
  }
}
