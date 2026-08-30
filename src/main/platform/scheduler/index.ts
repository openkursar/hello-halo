/**
 * platform/scheduler -- Public API
 *
 * Persistent job scheduling engine for the Halo platform layer.
 * This is a general-purpose engine: it does not know about AI, LLM, or Apps.
 *
 * Usage in bootstrap/extended.ts:
 *
 *   import { initScheduler, shutdownScheduler } from '../platform/scheduler'
 *
 *   const scheduler = await initScheduler({ db })
 *   scheduler.onJobDue(async (job) => {
 *     // ... execute the job
 *     return 'useful'
 *   })
 *   scheduler.start()
 *
 *   // On shutdown:
 *   scheduler.stop()
 */

import { randomUUID } from 'crypto'
import type { DatabaseManager } from '../store/types'
import { SchedulerStore } from './store'
import { SchedulerTimer } from './timer'
import { computeNextRun } from './schedule'
import type {
  SchedulerService,
  SchedulerJob,
  SchedulerJobCreate,
  SchedulerJobUpdate,
  JobDueHandler,
  JobFilter,
  RunLogEntry,
  RunStats
} from './types'

// Re-export types for consumers
export type {
  SchedulerService,
  SchedulerJob,
  SchedulerJobCreate,
  SchedulerJobUpdate,
  JobDueHandler,
  JobFilter,
  RunLogEntry,
  RunStats,
  Schedule,
  ScheduleEvery,
  ScheduleCron,
  ScheduleOnce,
  ScheduleKind,
  JobStatus,
  RunOutcome
} from './types'

// Re-export for testing
export { computeNextRun, computeNextRunEvery, computeNextRunCron, parseEveryString } from './schedule'

// ---------------------------------------------------------------------------
// Module State
// ---------------------------------------------------------------------------

let serviceInstance: SchedulerService | null = null

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export interface SchedulerDeps {
  db: DatabaseManager
  /**
   * Cap on concurrently executing jobs (dispatch-layer limit). The runtime
   * execution layer enforces its own Semaphore on top of this. Required from
   * real bootstrap call sites so the cap is an explicit product decision,
   * not an engine default silently in effect.
   */
  maxConcurrentRuns?: number
}

/**
 * Initialize the scheduler module.
 *
 * Creates the persistence layer, timer engine, and returns the
 * SchedulerService interface. Must be called after `initStore()`.
 *
 * @param deps - Dependencies: `db` (DatabaseManager) and the explicit
 *   dispatch concurrency cap `maxConcurrentRuns`.
 * @returns The SchedulerService instance.
 */
export async function initScheduler(deps: SchedulerDeps): Promise<SchedulerService> {
  if (serviceInstance) {
    return serviceInstance
  }

  const start = performance.now()

  const store = new SchedulerStore(deps.db)
  const timer = new SchedulerTimer(store, undefined, {
    maxConcurrentRuns: deps.maxConcurrentRuns
  })

  const service: SchedulerService = {
    // -- Job CRUD --

    addJob(input: SchedulerJobCreate): string {
      const now = Date.now()
      const id = input.id || randomUUID()
      const anchorMs = now

      // Compute the first run time
      let nextRunAtMs: number
      try {
        const next = computeNextRun(input.schedule, anchorMs, now)
        if (next === undefined) {
          throw new Error(
            `Schedule produces no future run times. ` +
            `Verify the cron expression or schedule configuration.`
          )
        }
        nextRunAtMs = next
      } catch (err) {
        throw new Error(
          `Failed to compute initial run time for job "${input.name}": ${err instanceof Error ? err.message : String(err)}`
        )
      }

      const job: SchedulerJob = {
        id,
        name: input.name,
        schedule: input.schedule,
        enabled: input.enabled,
        metadata: input.metadata,
        anchorMs,
        nextRunAtMs,
        consecutiveErrors: 0,
        status: 'idle',
        createdAt: now,
        updatedAt: now
      }

      store.insertJob(job)
      timer.rearm()

      console.log(
        `[Scheduler] Job added: "${job.name}" (${job.id}), ` +
        `schedule: ${job.schedule.kind}, next run: ${new Date(nextRunAtMs).toISOString()}`
      )

      return id
    },

    removeJob(jobId: string): void {
      const job = store.getJob(jobId)
      if (!job) return

      store.deleteJob(jobId)
      timer.rearm()

      console.log(`[Scheduler] Job removed: "${job.name}" (${jobId})`)
    },

    updateJob(jobId: string, updates: SchedulerJobUpdate): void {
      const job = store.getJob(jobId)
      if (!job) {
        throw new Error(`Scheduler job not found: ${jobId}`)
      }

      const now = Date.now()
      let scheduleChanged = false

      if (updates.name !== undefined) {
        job.name = updates.name
      }

      if (updates.schedule !== undefined) {
        job.schedule = updates.schedule
        scheduleChanged = true
      }

      if (updates.enabled !== undefined) {
        job.enabled = updates.enabled
        if (updates.enabled && (job.status === 'paused' || job.status === 'disabled')) {
          job.status = 'idle'
          job.consecutiveErrors = 0
          scheduleChanged = true
        }
      }

      if (updates.metadata !== undefined) {
        job.metadata = updates.metadata
      }

      // Recompute next run if schedule changed
      if (scheduleChanged && job.enabled) {
        try {
          const next = computeNextRun(job.schedule, job.anchorMs, now)
          if (next !== undefined) {
            job.nextRunAtMs = next
          }
        } catch {
          // Keep existing nextRunAtMs
        }
      }

      job.updatedAt = now
      store.updateJob(job)
      timer.rearm()

      console.log(`[Scheduler] Job updated: "${job.name}" (${jobId})`)
    },

    pauseJob(jobId: string): void {
      const job = store.getJob(jobId)
      if (!job) {
        throw new Error(`Scheduler job not found: ${jobId}`)
      }

      if (job.status === 'running') {
        console.warn(`[Scheduler] Cannot pause running job "${job.name}" (${jobId})`)
        return
      }

      job.status = 'paused'
      job.updatedAt = Date.now()
      store.updateJob(job)
      timer.rearm()

      console.log(`[Scheduler] Job paused: "${job.name}" (${jobId})`)
    },

    resumeJob(jobId: string): void {
      const job = store.getJob(jobId)
      if (!job) {
        throw new Error(`Scheduler job not found: ${jobId}`)
      }

      if (job.status !== 'paused' && job.status !== 'disabled') {
        return // Already active
      }

      const now = Date.now()
      job.status = 'idle'
      job.enabled = true
      job.consecutiveErrors = 0

      // Recompute next run from now
      try {
        const next = computeNextRun(job.schedule, job.anchorMs, now)
        if (next !== undefined) {
          job.nextRunAtMs = next
        }
      } catch {
        // Keep existing
      }

      job.updatedAt = now
      store.updateJob(job)
      timer.rearm()

      console.log(
        `[Scheduler] Job resumed: "${job.name}" (${jobId}), ` +
        `next run: ${new Date(job.nextRunAtMs).toISOString()}`
      )
    },

    getJob(jobId: string): SchedulerJob | null {
      return store.getJob(jobId)
    },

    listJobs(filter?: JobFilter): SchedulerJob[] {
      return store.listJobs(filter)
    },

    // -- Execution --

    onJobDue(handler: JobDueHandler): void {
      timer.setHandler(handler)
    },

    start(): void {
      timer.start()
    },

    stop(): void {
      timer.stop()
    },

    // -- Observability --

    getRunLog(jobId: string, limit?: number): RunLogEntry[] {
      return store.getRunLog(jobId, limit)
    },

    getRunStats(jobId: string, since?: number): RunStats {
      return store.getRunStats(jobId, since)
    }
  }

  serviceInstance = service

  const duration = performance.now() - start
  const jobCount = store.getEnabledJobs().length
  console.log(
    `[Scheduler] Initialized in ${duration.toFixed(1)}ms ` +
    `(${jobCount} existing job(s))`
  )

  return service
}

/**
 * Shutdown the scheduler module.
 *
 * Stops the timer loop and clears the singleton reference.
 * Does not cancel in-flight job executions.
 */
export async function shutdownScheduler(): Promise<void> {
  if (serviceInstance) {
    serviceInstance.stop()
    serviceInstance = null
    console.log('[Scheduler] Shutdown complete')
  }
}

/**
 * Test-only singleton reset. Call after an initScheduler-based test so the
 * module-level serviceInstance does not leak into other tests.
 */
export async function resetSchedulerForTest(): Promise<void> {
  if (serviceInstance) {
    serviceInstance.stop()
    serviceInstance = null
  }
}
