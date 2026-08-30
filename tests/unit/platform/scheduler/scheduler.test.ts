/**
 * Unit tests for platform/scheduler
 *
 * Tests:
 * - Interval parsing (parseEveryString)
 * - Anchor-grid computation (computeNextRunEvery)
 * - Scheduler store CRUD and run log
 * - Timer backoff logic
 * - Concurrency guard (running jobs not re-triggered)
 * - Restart catch-up (at most one missed run per job)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import { parseEveryString, computeNextRunEvery, computeNextRun, computeNextRunCron } from '../../../../src/main/platform/scheduler/schedule'
import { SchedulerStore } from '../../../../src/main/platform/scheduler/store'
import { SchedulerTimer } from '../../../../src/main/platform/scheduler/timer'
import { initScheduler, resetSchedulerForTest } from '../../../../src/main/platform/scheduler/index'
import type { SchedulerJob, Schedule, RunOutcome } from '../../../../src/main/platform/scheduler/types'

// ============================================================================
// parseEveryString
// ============================================================================

describe('parseEveryString', () => {
  it('should parse seconds', () => {
    expect(parseEveryString('30s')).toBe(30_000)
  })

  it('should parse minutes', () => {
    expect(parseEveryString('5m')).toBe(300_000)
  })

  it('should parse hours', () => {
    expect(parseEveryString('2h')).toBe(7_200_000)
  })

  it('should parse days', () => {
    expect(parseEveryString('1d')).toBe(86_400_000)
  })

  it('should parse fractional values', () => {
    expect(parseEveryString('1.5h')).toBe(5_400_000)
  })

  it('should clamp to minimum interval (10s)', () => {
    expect(parseEveryString('1s')).toBe(10_000)
    expect(parseEveryString('5s')).toBe(10_000)
  })

  it('should be case-insensitive', () => {
    expect(parseEveryString('5M')).toBe(300_000)
  })

  it('should trim whitespace', () => {
    expect(parseEveryString(' 5m ')).toBe(300_000)
  })

  it('should throw on invalid format', () => {
    expect(() => parseEveryString('abc')).toThrow('Invalid interval string')
    expect(() => parseEveryString('')).toThrow('Invalid interval string')
    expect(() => parseEveryString('5x')).toThrow('Invalid interval string')
    expect(() => parseEveryString('5')).toThrow('Invalid interval string')
  })
})

// ============================================================================
// computeNextRunEvery
// ============================================================================

describe('computeNextRunEvery', () => {
  const INTERVAL = 60_000 // 1 minute
  const ANCHOR = 1_000_000 // arbitrary anchor

  it('should return anchor if now is before anchor', () => {
    const result = computeNextRunEvery(ANCHOR, INTERVAL, ANCHOR - 500)
    expect(result).toBe(ANCHOR)
  })

  it('should return anchor + interval if now equals anchor', () => {
    const result = computeNextRunEvery(ANCHOR, INTERVAL, ANCHOR)
    expect(result).toBe(ANCHOR + INTERVAL)
  })

  it('should return next grid point after now', () => {
    const result = computeNextRunEvery(ANCHOR, INTERVAL, ANCHOR + 30_000)
    expect(result).toBe(ANCHOR + INTERVAL)
  })

  it('should skip past periods after long offline', () => {
    // Offline for 10 periods
    const result = computeNextRunEvery(ANCHOR, INTERVAL, ANCHOR + 10.5 * INTERVAL)
    expect(result).toBe(ANCHOR + 11 * INTERVAL)
    // Only one future grid point, not 10
  })

  it('should advance one step when exactly on a grid point', () => {
    const result = computeNextRunEvery(ANCHOR, INTERVAL, ANCHOR + 5 * INTERVAL)
    expect(result).toBe(ANCHOR + 6 * INTERVAL)
  })

  it('should always return a value strictly greater than nowMs', () => {
    for (let i = 0; i < 100; i++) {
      const now = ANCHOR + Math.random() * 1_000_000
      const result = computeNextRunEvery(ANCHOR, INTERVAL, now)
      expect(result).toBeGreaterThan(now)
    }
  })
})

// ============================================================================
// computeNextRun (dispatch)
// ============================================================================

describe('computeNextRun', () => {
  const NOW = 1_700_000_000_000

  it('should dispatch to every handler', () => {
    const schedule: Schedule = { kind: 'every', every: '30m' }
    const result = computeNextRun(schedule, NOW, NOW)
    expect(result).toBeDefined()
    expect(result!).toBeGreaterThan(NOW)
  })

  it('should dispatch to once handler (future)', () => {
    const schedule: Schedule = { kind: 'once', once: NOW + 60_000 }
    const result = computeNextRun(schedule, NOW, NOW)
    expect(result).toBe(NOW + 60_000)
  })

  it('should return undefined for once in the past', () => {
    const schedule: Schedule = { kind: 'once', once: NOW - 60_000 }
    const result = computeNextRun(schedule, NOW, NOW)
    expect(result).toBeUndefined()
  })

  it('should dispatch to cron handler', () => {
    const schedule: Schedule = { kind: 'cron', cron: '0 9 * * *' }
    const result = computeNextRun(schedule, NOW, NOW)
    expect(result).toBeDefined()
    expect(result!).toBeGreaterThan(NOW)
  })

  it('should dispatch to cron handler with timezone', () => {
    const schedule: Schedule = { kind: 'cron', cron: '0 9 * * *', timezone: 'Asia/Shanghai' }
    const result = computeNextRun(schedule, NOW, NOW)
    expect(result).toBeDefined()
    expect(result!).toBeGreaterThan(NOW)
  })
})

// ============================================================================
// computeNextRunCron
// ============================================================================

describe('computeNextRunCron', () => {
  // Use a fixed "now" for deterministic tests:
  // 2023-11-14T12:30:00.000Z (Tuesday)
  const NOW = Date.UTC(2023, 10, 14, 12, 30, 0, 0)
  // Explicitly use UTC timezone for deterministic assertions regardless of system TZ
  const TZ = 'UTC'

  it('should compute next run for "every day at 9:00 UTC"', () => {
    // "0 9 * * *" = at 09:00 every day
    // now is 12:30 UTC, so next 09:00 is tomorrow
    const result = computeNextRunCron('0 9 * * *', TZ, NOW)
    expect(result).toBeDefined()
    expect(result!).toBeGreaterThan(NOW)

    const nextDate = new Date(result!)
    expect(nextDate.getUTCHours()).toBe(9)
    expect(nextDate.getUTCMinutes()).toBe(0)
    // Should be the next day
    expect(nextDate.getUTCDate()).toBe(15)
  })

  it('should compute next run for "every hour at :00"', () => {
    // "0 * * * *" = at minute 0 of every hour
    // now is 12:30, so next is 13:00
    const result = computeNextRunCron('0 * * * *', TZ, NOW)
    expect(result).toBeDefined()

    const nextDate = new Date(result!)
    expect(nextDate.getUTCHours()).toBe(13)
    expect(nextDate.getUTCMinutes()).toBe(0)
  })

  it('should compute next run for "every 6 hours"', () => {
    // "0 */6 * * *" = at minute 0 of every 6th hour (0, 6, 12, 18)
    // now is 12:30, next occurrence is 18:00
    const result = computeNextRunCron('0 */6 * * *', TZ, NOW)
    expect(result).toBeDefined()

    const nextDate = new Date(result!)
    expect(nextDate.getUTCHours()).toBe(18)
    expect(nextDate.getUTCMinutes()).toBe(0)
  })

  it('should compute next run for weekday-specific schedule', () => {
    // "30 14 * * 1-5" = at 14:30 on Mon-Fri
    // now is Tue 12:30 UTC, next is Tue 14:30 (same day, later time)
    const result = computeNextRunCron('30 14 * * 1-5', TZ, NOW)
    expect(result).toBeDefined()

    const nextDate = new Date(result!)
    expect(nextDate.getUTCHours()).toBe(14)
    expect(nextDate.getUTCMinutes()).toBe(30)
    // Should be the same day (Tuesday, day 14)
    expect(nextDate.getUTCDate()).toBe(14)
  })

  it('should compute next run for weekend schedule on a weekday', () => {
    // "0 10 * * 0,6" = at 10:00 on Sat/Sun
    // now is Tue, next is Sat Nov 18
    const result = computeNextRunCron('0 10 * * 0,6', TZ, NOW)
    expect(result).toBeDefined()

    const nextDate = new Date(result!)
    expect(nextDate.getUTCHours()).toBe(10)
    // Next Saturday is Nov 18
    expect(nextDate.getUTCDate()).toBe(18)
  })

  it('should compute next run for monthly schedule', () => {
    // "0 0 1 * *" = at midnight on the 1st of every month
    // now is Nov 14, next is Dec 1
    const result = computeNextRunCron('0 0 1 * *', TZ, NOW)
    expect(result).toBeDefined()

    const nextDate = new Date(result!)
    expect(nextDate.getUTCDate()).toBe(1)
    expect(nextDate.getUTCMonth()).toBe(11) // December (0-indexed)
  })

  it('should always return strictly after nowMs', () => {
    // Run 50 random samples to verify the "strictly after" invariant
    const patterns = [
      '0 9 * * *',
      '*/5 * * * *',
      '0 0 * * *',
      '30 */2 * * *',
      '0 0 1 * *',
    ]

    for (const pattern of patterns) {
      for (let i = 0; i < 10; i++) {
        // Random offset from NOW
        const randomNow = NOW + Math.floor(Math.random() * 86_400_000)
        const result = computeNextRunCron(pattern, TZ, randomNow)
        if (result !== undefined) {
          expect(result).toBeGreaterThan(randomNow)
        }
      }
    }
  })

  // --- Timezone support ---

  it('should respect timezone parameter', () => {
    // "0 9 * * *" in Asia/Shanghai (UTC+8)
    // Now is 12:30 UTC = 20:30 Shanghai time
    // Next 09:00 Shanghai = 01:00 UTC next day (Nov 15)
    const result = computeNextRunCron('0 9 * * *', 'Asia/Shanghai', NOW)
    expect(result).toBeDefined()

    const nextDate = new Date(result!)
    // 09:00 Shanghai = 01:00 UTC
    expect(nextDate.getUTCHours()).toBe(1)
    expect(nextDate.getUTCDate()).toBe(15)
  })

  it('should handle timezone with different day boundary', () => {
    // "0 22 * * *" in America/New_York (UTC-5)
    // Now is 12:30 UTC = 07:30 ET
    // Next 22:00 ET = 03:00 UTC next day
    const result = computeNextRunCron('0 22 * * *', 'America/New_York', NOW)
    expect(result).toBeDefined()
    expect(result!).toBeGreaterThan(NOW)
  })

  it('should use system timezone when timezone is undefined', () => {
    // When timezone is undefined, croner uses system timezone.
    // We just verify the result is valid (strictly after now), no UTC-hour assertions.
    const result = computeNextRunCron('0 9 * * *', undefined, NOW)
    expect(result).toBeDefined()
    expect(result!).toBeGreaterThan(NOW)
  })

  // --- Error handling ---

  it('should throw on invalid cron expression', () => {
    expect(() => computeNextRunCron('invalid', TZ, NOW)).toThrow('Invalid cron expression')
  })

  it('should throw on too-short cron expression', () => {
    expect(() => computeNextRunCron('* *', TZ, NOW)).toThrow('too short')
  })

  it('should throw on empty cron expression', () => {
    expect(() => computeNextRunCron('', TZ, NOW)).toThrow('too short')
  })

  it('should throw on out-of-range values', () => {
    // 25 is invalid for hours (0-23)
    expect(() => computeNextRunCron('0 25 * * *', TZ, NOW)).toThrow('Invalid cron expression')
  })

  // --- Edge cases ---

  it('should handle every-minute cron', () => {
    // "* * * * *" = every minute
    const result = computeNextRunCron('* * * * *', TZ, NOW)
    expect(result).toBeDefined()

    // Should be within 60 seconds
    expect(result! - NOW).toBeLessThanOrEqual(60_000)
    expect(result!).toBeGreaterThan(NOW)
  })

  it('should handle 6-part cron with seconds', () => {
    // "30 0 * * * *" = at second 30 of every minute
    const result = computeNextRunCron('30 0 * * * *', TZ, NOW)
    expect(result).toBeDefined()
    expect(result!).toBeGreaterThan(NOW)
  })

  it('should handle step patterns', () => {
    // "*/15 * * * *" = every 15 minutes
    const result = computeNextRunCron('*/15 * * * *', TZ, NOW)
    expect(result).toBeDefined()
    expect(result!).toBeGreaterThan(NOW)

    const nextDate = new Date(result!)
    // Minutes should be 0, 15, 30, or 45
    expect([0, 15, 30, 45]).toContain(nextDate.getUTCMinutes())
  })

  it('should handle range patterns', () => {
    // "0 9-17 * * *" = every hour from 9 to 17 (working hours)
    const result = computeNextRunCron('0 9-17 * * *', TZ, NOW)
    expect(result).toBeDefined()

    const nextDate = new Date(result!)
    const hour = nextDate.getUTCHours()
    expect(hour).toBeGreaterThanOrEqual(9)
    expect(hour).toBeLessThanOrEqual(17)
  })

  it('should handle list patterns', () => {
    // "0 9,12,18 * * *" = at 9:00, 12:00, and 18:00
    // now is 12:30 UTC, next is 18:00
    const result = computeNextRunCron('0 9,12,18 * * *', TZ, NOW)
    expect(result).toBeDefined()

    const nextDate = new Date(result!)
    expect(nextDate.getUTCHours()).toBe(18)
  })
})

// ============================================================================
// SchedulerStore
// ============================================================================

describe('SchedulerStore', () => {
  let manager: DatabaseManager
  let store: SchedulerStore

  beforeEach(() => {
    manager = createDatabaseManager(':memory:')
    store = new SchedulerStore(manager)
  })

  afterEach(() => {
    manager.closeAll()
  })

  function makeJob(overrides?: Partial<SchedulerJob>): SchedulerJob {
    const now = Date.now()
    return {
      id: 'job-' + Math.random().toString(36).slice(2),
      name: 'Test Job',
      schedule: { kind: 'every', every: '30m' },
      enabled: true,
      anchorMs: now,
      nextRunAtMs: now + 1_800_000,
      consecutiveErrors: 0,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      ...overrides
    }
  }

  describe('CRUD', () => {
    it('should insert and retrieve a job', () => {
      const job = makeJob({ name: 'Price Checker' })
      store.insertJob(job)

      const retrieved = store.getJob(job.id)
      expect(retrieved).not.toBeNull()
      expect(retrieved!.name).toBe('Price Checker')
      expect(retrieved!.schedule).toEqual({ kind: 'every', every: '30m' })
      expect(retrieved!.enabled).toBe(true)
    })

    it('should update a job', () => {
      const job = makeJob()
      store.insertJob(job)

      job.name = 'Updated Name'
      job.consecutiveErrors = 3
      job.status = 'disabled'
      store.updateJob(job)

      const retrieved = store.getJob(job.id)
      expect(retrieved!.name).toBe('Updated Name')
      expect(retrieved!.consecutiveErrors).toBe(3)
      expect(retrieved!.status).toBe('disabled')
    })

    it('should delete a job', () => {
      const job = makeJob()
      store.insertJob(job)
      expect(store.getJob(job.id)).not.toBeNull()

      const deleted = store.deleteJob(job.id)
      expect(deleted).toBe(true)
      expect(store.getJob(job.id)).toBeNull()
    })

    it('should return false when deleting non-existent job', () => {
      expect(store.deleteJob('nonexistent')).toBe(false)
    })

    it('should round-trip metadata through JSON', () => {
      const job = makeJob({
        metadata: { appId: 'jd-price', subscriptionId: 'sub-1', nested: { key: 'val' } }
      })
      store.insertJob(job)

      const retrieved = store.getJob(job.id)
      expect(retrieved!.metadata).toEqual({
        appId: 'jd-price',
        subscriptionId: 'sub-1',
        nested: { key: 'val' }
      })
    })
  })

  describe('listJobs', () => {
    it('should list all jobs ordered by nextRunAtMs', () => {
      const now = Date.now()
      store.insertJob(makeJob({ id: 'late', name: 'Late', nextRunAtMs: now + 3000 }))
      store.insertJob(makeJob({ id: 'early', name: 'Early', nextRunAtMs: now + 1000 }))
      store.insertJob(makeJob({ id: 'mid', name: 'Mid', nextRunAtMs: now + 2000 }))

      const jobs = store.listJobs()
      expect(jobs.map(j => j.id)).toEqual(['early', 'mid', 'late'])
    })

    it('should filter by status', () => {
      store.insertJob(makeJob({ id: 'idle1', status: 'idle' }))
      store.insertJob(makeJob({ id: 'paused1', status: 'paused' }))
      store.insertJob(makeJob({ id: 'idle2', status: 'idle' }))

      const idle = store.listJobs({ status: 'idle' })
      expect(idle).toHaveLength(2)
      expect(idle.every(j => j.status === 'idle')).toBe(true)
    })

    it('should filter by metadata', () => {
      store.insertJob(makeJob({ id: 'a1', metadata: { appId: 'app-a' } }))
      store.insertJob(makeJob({ id: 'b1', metadata: { appId: 'app-b' } }))
      store.insertJob(makeJob({ id: 'a2', metadata: { appId: 'app-a' } }))

      const appA = store.listJobs({ metadata: { appId: 'app-a' } })
      expect(appA).toHaveLength(2)
      expect(appA.every(j => j.metadata?.appId === 'app-a')).toBe(true)
    })
  })

  describe('getEnabledJobs', () => {
    it('should return only enabled jobs', () => {
      store.insertJob(makeJob({ id: 'enabled1', enabled: true }))
      store.insertJob(makeJob({ id: 'disabled1', enabled: false }))
      store.insertJob(makeJob({ id: 'enabled2', enabled: true }))

      const enabled = store.getEnabledJobs()
      expect(enabled).toHaveLength(2)
    })
  })

  describe('clearStaleRunningMarkers', () => {
    it('should clear all running markers', () => {
      store.insertJob(makeJob({ id: 'running1', status: 'running', runningAtMs: Date.now() - 10000 }))
      store.insertJob(makeJob({ id: 'running2', status: 'running', runningAtMs: Date.now() - 20000 }))
      store.insertJob(makeJob({ id: 'idle1' }))

      const cleared = store.clearStaleRunningMarkers()
      expect(cleared).toBe(2)

      const j1 = store.getJob('running1')
      expect(j1!.runningAtMs).toBeUndefined()
      expect(j1!.status).toBe('idle')
    })
  })

  describe('Run Log', () => {
    it('should insert and retrieve run log entries', () => {
      const job = makeJob()
      store.insertJob(job)

      const now = Date.now()
      store.insertRunLog({
        jobId: job.id,
        startedAt: now,
        finishedAt: now + 5000,
        durationMs: 5000,
        outcome: 'useful',
        metadata: { appId: 'test' }
      })

      const logs = store.getRunLog(job.id)
      expect(logs).toHaveLength(1)
      expect(logs[0].outcome).toBe('useful')
      expect(logs[0].durationMs).toBe(5000)
    })

    it('should return entries newest first', () => {
      const job = makeJob()
      store.insertJob(job)

      for (let i = 0; i < 5; i++) {
        store.insertRunLog({
          jobId: job.id,
          startedAt: 1000 + i,
          finishedAt: 2000 + i,
          durationMs: 1000,
          outcome: 'useful'
        })
      }

      const logs = store.getRunLog(job.id)
      expect(logs[0].startedAt).toBe(1004)
      expect(logs[4].startedAt).toBe(1000)
    })

    it('should respect limit parameter', () => {
      const job = makeJob()
      store.insertJob(job)

      for (let i = 0; i < 10; i++) {
        store.insertRunLog({
          jobId: job.id,
          startedAt: i,
          finishedAt: i + 1,
          durationMs: 1,
          outcome: 'useful'
        })
      }

      expect(store.getRunLog(job.id, 3)).toHaveLength(3)
    })
  })

  describe('getRunStats', () => {
    it('should aggregate run statistics', () => {
      const job = makeJob()
      store.insertJob(job)

      const outcomes: RunOutcome[] = ['useful', 'useful', 'noop', 'error', 'useful']
      outcomes.forEach((outcome, i) => {
        store.insertRunLog({
          jobId: job.id,
          startedAt: i * 1000,
          finishedAt: i * 1000 + 500,
          durationMs: 500,
          outcome,
          error: outcome === 'error' ? 'test error' : undefined
        })
      })

      const stats = store.getRunStats(job.id)
      expect(stats.totalRuns).toBe(5)
      expect(stats.useful).toBe(3)
      expect(stats.noop).toBe(1)
      expect(stats.error).toBe(1)
      expect(stats.avgDurationMs).toBe(500)
    })

    it('should filter by since timestamp', () => {
      const job = makeJob()
      store.insertJob(job)

      store.insertRunLog({ jobId: job.id, startedAt: 100, finishedAt: 200, durationMs: 100, outcome: 'useful' })
      store.insertRunLog({ jobId: job.id, startedAt: 500, finishedAt: 600, durationMs: 100, outcome: 'useful' })
      store.insertRunLog({ jobId: job.id, startedAt: 900, finishedAt: 1000, durationMs: 100, outcome: 'useful' })

      const stats = store.getRunStats(job.id, 400)
      expect(stats.totalRuns).toBe(2)
    })
  })

  describe('pruneRunLog', () => {
    it('should prune entries beyond the limit', () => {
      const job = makeJob()
      store.insertJob(job)

      for (let i = 0; i < 20; i++) {
        store.insertRunLog({
          jobId: job.id,
          startedAt: i * 1000,
          finishedAt: i * 1000 + 100,
          durationMs: 100,
          outcome: 'useful'
        })
      }

      const pruned = store.pruneRunLog(10)
      expect(pruned).toBe(10)

      const remaining = store.getRunLog(job.id, 100)
      expect(remaining).toHaveLength(10)
    })
  })
})

// ============================================================================
// SchedulerTimer (integration with store)
// ============================================================================

describe('SchedulerTimer', () => {
  let manager: DatabaseManager
  let store: SchedulerStore
  let timer: SchedulerTimer
  const timers: SchedulerTimer[] = []

  let currentTime: number
  const nowFn = () => currentTime

  beforeEach(() => {
    currentTime = 1_700_000_000_000
    manager = createDatabaseManager(':memory:')
    store = new SchedulerStore(manager)
    timer = new SchedulerTimer(store, nowFn)
    timers.push(timer)
    vi.useFakeTimers({ now: currentTime })
  })

  afterEach(() => {
    for (const t of timers) t.stop()
    timers.length = 0
    manager.closeAll()
    vi.useRealTimers()
  })

  function makeJob(overrides?: Partial<SchedulerJob>): SchedulerJob {
    return {
      id: 'job-' + Math.random().toString(36).slice(2),
      name: 'Test Job',
      schedule: { kind: 'every', every: '30m' },
      enabled: true,
      anchorMs: currentTime,
      nextRunAtMs: currentTime + 1_800_000,
      consecutiveErrors: 0,
      status: 'idle',
      createdAt: currentTime,
      updatedAt: currentTime,
      ...overrides
    }
  }

  it('should call handler when a job becomes due', async () => {
    const handler = vi.fn().mockResolvedValue('useful' as RunOutcome)
    timer.setHandler(handler)

    // Insert a job due NOW
    const job = makeJob({ nextRunAtMs: currentTime })
    store.insertJob(job)

    timer.start()

    // Advance timer to trigger the tick
    await vi.advanceTimersByTimeAsync(0)

    // Handler should have been called
    expect(handler).toHaveBeenCalledOnce()
    expect(handler.mock.calls[0][0].id).toBe(job.id)
  })

  it('should NOT call handler for a future job', async () => {
    const handler = vi.fn().mockResolvedValue('useful' as RunOutcome)
    timer.setHandler(handler)

    // Job is 30 minutes in the future
    const job = makeJob({ nextRunAtMs: currentTime + 1_800_000 })
    store.insertJob(job)

    timer.start()
    await vi.advanceTimersByTimeAsync(1000)

    expect(handler).not.toHaveBeenCalled()
  })

  it('should not re-trigger a running job', async () => {
    const handler = vi.fn().mockResolvedValue('useful' as RunOutcome)
    timer.setHandler(handler)

    // Insert an idle due job so armTimer() arms a timeout and the tick fires
    const idleJob = makeJob({ id: 'idle-due', nextRunAtMs: currentTime })
    store.insertJob(idleJob)

    timer.start()

    // After start(), insert a job that's due NOW but already running.
    // Inserted after start() so clearStaleRunningMarkers() doesn't touch it.
    const runningJob = makeJob({
      id: 'running-job',
      nextRunAtMs: currentTime,
      runningAtMs: currentTime - 1000,
      status: 'running'
    })
    store.insertJob(runningJob)

    await vi.advanceTimersByTimeAsync(0)

    // The idle job should be triggered, but the running job should NOT
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: 'idle-due' }))
  })

  it('should track consecutive errors in the store after handler error', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('test failure'))
    timer.setHandler(handler)

    const job = makeJob({ nextRunAtMs: currentTime })
    store.insertJob(job)

    timer.start()
    await vi.advanceTimersByTimeAsync(0)

    const updated = store.getJob(job.id)
    expect(updated!.consecutiveErrors).toBe(1)
    expect(updated!.status).toBe('idle') // not yet disabled (need 5 errors)
  })

  it('should clear stale running markers on start', () => {
    const job = makeJob({ status: 'running', runningAtMs: currentTime - 10_000 })
    store.insertJob(job)

    timer.start()

    const updated = store.getJob(job.id)
    expect(updated!.runningAtMs).toBeUndefined()
    expect(updated!.status).toBe('idle')
  })

  // Issue #340: a hung handler must not starve other jobs or the tick loop.
  describe('hung-handler isolation (issue #340)', () => {
    it('runs another job while one handler hangs', async () => {
      const release: Array<() => void> = []
      const hang = vi.fn().mockImplementation(() => new Promise<RunOutcome>(resolve => {
        release.push(() => resolve('useful'))
      }))
      const done = vi.fn().mockResolvedValue('useful' as RunOutcome)
      timer.setHandler(async (job) => (job.id === 'hang-job' ? hang() : done(job)))

      store.insertJob(makeJob({ id: 'hang-job', nextRunAtMs: currentTime }))
      store.insertJob(makeJob({ id: 'ok-job', nextRunAtMs: currentTime }))

      timer.start()
      await vi.advanceTimersByTimeAsync(0)

      // hang-job is stuck in the handler, but ok-job must still have completed.
      expect(hang).toHaveBeenCalledOnce()
      expect(done).toHaveBeenCalledOnce()
      const okJob = store.getJob('ok-job')
      expect(okJob!.runningAtMs).toBeUndefined()
      expect(okJob!.lastRunAtMs).toBe(currentTime)

      release[0]()
      await vi.advanceTimersByTimeAsync(0)
      const hangJob = store.getJob('hang-job')
      expect(hangJob!.runningAtMs).toBeUndefined()
    })

    it('keeps ticking while a handler hangs: the next scheduled run fires on time', async () => {
      const release: Array<() => void> = []
      const hang = vi.fn().mockImplementation(() => new Promise<RunOutcome>(resolve => {
        release.push(() => resolve('useful'))
      }))
      const done = vi.fn().mockResolvedValue('useful' as RunOutcome)
      timer.setHandler(async (job) => (job.id === 'hang-job' ? hang() : done(job)))

      store.insertJob(makeJob({ id: 'hang-job', nextRunAtMs: currentTime }))
      store.insertJob(makeJob({
        id: 'later-job',
        schedule: { kind: 'every', every: '30m' },
        anchorMs: currentTime,
        nextRunAtMs: currentTime + 60_000,
      }))

      timer.start()
      await vi.advanceTimersByTimeAsync(0)

      currentTime += 60_000
      await vi.advanceTimersByTimeAsync(60_000)

      // later-job fired on its own schedule despite the hang.
      expect(done).toHaveBeenCalledTimes(1)
      expect(done).toHaveBeenCalledWith(expect.objectContaining({ id: 'later-job' }))

      release[0]()
      await vi.advanceTimersByTimeAsync(0)
    })

    it('clears a stuck running marker while a handler is hung (self-heal not starved)', async () => {
      // A job whose handler hangs develops its OWN stale marker: it crossed
      // the 2h threshold mid-hang. The old loop could never clear it — the
      // hung tick held the running guard, so re-armed ticks returned early
      // and in-tick cleanup never ran again.
      const release: Array<() => void> = []
      const hang = vi.fn().mockImplementation(() => new Promise<RunOutcome>(resolve => {
        release.push(() => resolve('useful'))
      }))
      const done = vi.fn().mockResolvedValue('useful' as RunOutcome)
      timer.setHandler(async (job) => (job.id === 'hang-job' ? hang() : done(job)))

      store.insertJob(makeJob({ id: 'hang-job', nextRunAtMs: currentTime }))
      store.insertJob(makeJob({
        id: 'later-job',
        schedule: { kind: 'every', every: '30m' },
        anchorMs: currentTime,
        nextRunAtMs: currentTime + 60_000,
      }))

      timer.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(hang).toHaveBeenCalledOnce()
      expect(store.getJob('hang-job')!.runningAtMs).toBe(currentTime)

      // The marker crosses the threshold while the handler is still hung.
      currentTime += 2 * 60 * 60 * 1000 + 5_000
      await vi.advanceTimersByTimeAsync(60_000)
      await vi.advanceTimersByTimeAsync(60_000)

      const cleared = store.getJob('hang-job')
      expect(cleared!.runningAtMs).toBeUndefined()
      expect(cleared!.status).toBe('idle')
      // Recovery follows grid semantics (no catch-up storm): the job fires
      // again at its next scheduled point, and the re-arm makes the timer
      // actually wake for it.
      expect(cleared!.nextRunAtMs).toBeGreaterThan(currentTime)
      currentTime += 30 * 60_000
      await vi.advanceTimersByTimeAsync(30 * 60_000)
      expect(hang).toHaveBeenCalledTimes(2)

      release[0]()
      await vi.advanceTimersByTimeAsync(0)
    })
  })

  // Issue #340: the tick dispatches due jobs with bounded concurrency instead
  // of a serial for-await, so one slow job cannot block the rest.
  describe('bounded dispatch (issue #340)', () => {
    it('runs due jobs concurrently up to the cap and queues the rest', async () => {
      const capped = new SchedulerTimer(store, nowFn, { maxConcurrentRuns: 2 })
      timers.push(capped)

      const releases: Record<string, Array<() => void>> = {}
      const handler = vi.fn().mockImplementation((job: SchedulerJob) => {
        releases[job.id] = releases[job.id] || []
        return new Promise<RunOutcome>(resolve => {
          releases[job.id].push(() => resolve('useful'))
        })
      })
      capped.setHandler(handler)

      for (let i = 0; i < 3; i++) {
        store.insertJob(makeJob({ id: `job-${i}`, nextRunAtMs: currentTime }))
      }

      capped.start()
      await vi.advanceTimersByTimeAsync(0)

      // Two slots occupied, the third job waits.
      expect(handler).toHaveBeenCalledTimes(2)
      expect(store.getJob('job-2')!.runningAtMs).toBeUndefined()

      // Release one slot; the queued job starts.
      releases['job-0'][0]()
      await vi.advanceTimersByTimeAsync(0)
      expect(handler).toHaveBeenCalledTimes(3)

      // A due job discovered by a LATER tick respects slots freed earlier.
      store.insertJob(makeJob({ id: 'job-3', nextRunAtMs: currentTime }))
      releases['job-1'][0]()
      releases['job-2'][0]()
      await vi.advanceTimersByTimeAsync(0)
      currentTime += 60_000
      await vi.advanceTimersByTimeAsync(60_000)
      expect(handler).toHaveBeenCalledTimes(4)

      releases['job-3'][0]()
      await vi.advanceTimersByTimeAsync(0)
    })

    it('honors the concurrency cap injected through initScheduler deps', async () => {
      // The bootstrap call site must pass maxConcurrentRuns through
      // SchedulerDeps into the timer; an engine-default-only gate would be
      // vacuous. This pins the wiring by observing dispatch behavior with a
      // non-default cap (1) that only the injection path can produce.
      const service = await initScheduler({ db: manager, maxConcurrentRuns: 1 })
      const injectedTimer = timers.find(t => t !== timer)
      // initScheduler constructs its own timer; track it for afterEach cleanup.
      if (injectedTimer && !timers.includes(injectedTimer)) timers.push(injectedTimer)

      const releases: Array<() => void> = []
      service.onJobDue(() =>
        new Promise<RunOutcome>(resolve => {
          releases.push(() => resolve('useful'))
        })
      )

      for (let i = 0; i < 2; i++) {
        store.insertJob(makeJob({ id: `dep-job-${i}`, nextRunAtMs: currentTime }))
      }

      service.start()
      await vi.advanceTimersByTimeAsync(0)

      // Cap 1: the second job stays queued until the first settles.
      expect(releases).toHaveLength(1)
      releases[0]()
      await vi.advanceTimersByTimeAsync(0)
      expect(releases).toHaveLength(2)
      releases[1]()

      service.stop()
      // Reset the module singleton so other tests get a fresh instance.
      await resetSchedulerForTest()
    })
  })
})
