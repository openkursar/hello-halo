# Scheduler Module -- Design Decisions

> Module: `src/main/platform/scheduler/`
> Date: 2026-02-21
> Status: Implementation reference

---

## 1. Module Purpose

A general-purpose, persistent job scheduler for the Halo Electron main process.
It knows nothing about AI, LLM, or Apps -- it manages timed jobs with callbacks.

Consuming layers register jobs via `addJob()` (tagging each with a `kind`,
default `'app'`) and register a per-kind callback via `onJobDue(kind, handler)`.
The timer routes each due job to the handler matching its `kind`, so multiple
domains (e.g. `apps/runtime` for `'app'`, the team runtime for `'team'`) consume
the same scheduler without depending on one another. A due job whose kind has no
registered handler is recorded as an error (never silently dropped).

---

## 2. Key Design Decisions

### 2.1 `every + anchor` Semantics

The core scheduling algorithm uses an anchor timestamp plus a fixed interval.
`computeNextRun(anchorMs, everyMs, nowMs)` always jumps to the next future
grid-aligned time point, never returning a past time.

**Edge cases handled:**

- **anchor in the future**: Return `anchorMs` directly (job has not started yet).
- **Clock rollback**: `Math.ceil` ensures we always land on the next future
  grid point. If the clock jumps backward, the next tick will simply re-evaluate
  and find the correct next future slot.
- **Very short intervals**: Minimum interval is clamped to 10 seconds to prevent
  CPU thrashing. The timer loop itself wakes at most every 15 seconds, so sub-15s
  precision is not guaranteed.
- **Offline period**: Only one catch-up run, never all missed periods. If
  `computeNextRun` returns a time that is already past but has never been run,
  we fire once on the next timer tick.

### 2.2 Timer Loop: Recursive `setTimeout` with Clamped Delay

Using recursive `setTimeout` (not `setInterval`) for several reasons:

1. Prevents drift accumulation -- each tick schedules the next based on real time.
2. Timer can be re-armed at any moment (after addJob, after job completion).
3. Maximum delay clamped to 60 seconds, ensuring timely recovery from clock
   jumps and preventing Node.js 32-bit timer overflow.

The tick interval is dynamic: `min(timeUntilNextDueJob, 60_000)`.

### 2.3 Exponential Backoff

On execution error, the next run is delayed by an exponential backoff schedule:

```
1st error  ->  30 seconds
2nd error  ->   1 minute
3rd error  ->   5 minutes
4th error  ->  15 minutes
5th+ error ->  60 minutes
```

The backoff delay is applied as `max(normalNextRun, errorTime + backoffDelay)`,
so it only delays, never advances, the next run.

**Auto-disable**: After `MAX_CONSECUTIVE_ERRORS` (5) consecutive errors, the
job's `status` is set to `'disabled'` and `enabled` to `false`. This prevents
runaway error loops.

**Reset on resume**: When `resumeJob()` is called, `consecutiveErrors` is reset
to 0 and `status` goes back to `'idle'`. The user's explicit action is a signal
to try again fresh.

### 2.4 Concurrency Control

Each job has an implicit concurrency limit of 1 -- a job that is already
`running` will not be re-triggered on the next tick. The timer loop skips jobs
with a non-null `runningAtMs` value.

**Stuck job detection**: If `runningAtMs` is older than 2 hours (configurable),
the marker is cleared on the next tick, treating it as a crash/timeout. The job
is then eligible to run again.

**Global concurrency**: The architecture doc mentions `maxConcurrentDaemonRuns`.
This is the responsibility of `apps/runtime` (the consumer), not the scheduler.
The scheduler fires `onJobDue` for every due job; the consumer can throttle
via a semaphore before calling the handler.

Decision rationale: The scheduler is a generic engine. Global concurrency across
heterogeneous jobs is a policy decision that belongs in the consuming layer.

### 2.5 Restart Recovery

On `start()`:

1. Clear all stale `runningAtMs` markers (jobs interrupted by crash).
2. Identify jobs where `nextRunAtMs` is in the past and the job has never run
   or was last run before `nextRunAtMs`. Fire these as "missed" catch-up runs
   -- but at most once per job.
3. Recompute `nextRunAtMs` for all enabled jobs.
4. Arm the timer.

This guarantees at most one catch-up run per job, never a backlog storm.

### 2.6 SQLite Persistence Strategy

Using `better-sqlite3` synchronous API through `DatabaseManager`. The scheduler
owns two tables in the app-level database (`~/.halo/halo.db`):

- `scheduler_jobs`: Job definitions and runtime state
- `scheduler_run_log`: Execution history

**Write frequency**: Writes happen on:
- Job CRUD operations (rare, user-initiated)
- Timer tick: update `runningAtMs` before execution, update state after
- This is at most a few writes per minute, well within SQLite's capacity

No batching needed -- individual writes are fast (< 1ms with WAL mode).

### 2.7 `once` Schedule Kind

In addition to `every` and `cron`, we support `once` for one-shot jobs.
After successful execution, the job is disabled. On error, the job is also
disabled (with error state preserved) to keep one-shot semantics predictable.

### 2.8 `cron` Schedule Kind

Standard cron expression scheduling via the `croner` library (zero dependencies).

```typescript
{ kind: 'cron', cron: '0 9 * * *', timezone?: 'Asia/Shanghai' }
```

**Supported formats:**
- Standard 5-part: `minute hour dom month dow` (e.g. `0 9 * * *`)
- Extended 6-part: `second minute hour dom month dow` (e.g. `30 0 9 * * *`)

**Timezone behavior:**
- When `timezone` is provided, cron is evaluated in that IANA timezone.
- When `timezone` is omitted, cron is evaluated in the system's local timezone.
- The returned `nextRunAtMs` is always an absolute epoch timestamp (UTC).

**Consistency with `every` semantics:**
- Always returns the next future occurrence strictly after `nowMs`.
- After offline periods, only the next future match is returned (no catch-up storm).
- Invalid cron expressions throw at `addJob()` time, failing fast.

**Why `croner`:**
- Zero dependencies, lightweight (~30KB).
- Full TypeScript support.
- Built-in IANA timezone support (no need for `moment-timezone` or similar).
- We only use the pattern parser + `nextRun()` method -- croner's built-in
  timer/scheduling features are unused (we have our own timer engine).

### 2.9 Process Exit Handling

The `stop()` method clears the timer. Jobs that are mid-execution when the
process exits will have stale `runningAtMs` markers, which are cleaned up on
the next `start()` (see 2.5).

No attempt is made to gracefully await running jobs -- that is the consumer's
responsibility during its own shutdown sequence.

---

## 3. File Structure

```
src/main/platform/scheduler/
  index.ts      -- initScheduler(), shutdownScheduler(), SchedulerService impl
  types.ts      -- All public types (SchedulerJob, RunOutcome, etc.)
  schedule.ts   -- computeNextRun(), computeNextRunCron(), parseEveryString()
  store.ts      -- SQLite CRUD (migrations, read/write jobs, run log)
  timer.ts      -- Timer loop, backoff logic, tick handler
```

## 4. Public API (contract with apps/runtime)

```typescript
export function initScheduler(deps: { db: DatabaseManager }): Promise<SchedulerService>
export function shutdownScheduler(): Promise<void>

interface SchedulerService {
  addJob(job): string
  removeJob(jobId): void
  updateJob(jobId, updates): void
  pauseJob(jobId): void
  resumeJob(jobId): void
  getJob(jobId): SchedulerJob | null
  listJobs(filter?): SchedulerJob[]
  onJobDue(kind, handler): void   // kind-routed; jobs default to kind 'app'
  start(): void
  stop(): void
  getRunLog(jobId, limit?): RunLogEntry[]
  getRunStats(jobId, since?): RunStats
}
```

## 5. Dependencies

- `platform/store` (DatabaseManager) -- the only internal dependency
- `crypto` (Node.js built-in, for UUID generation)
- `croner` (cron expression parsing, zero-dependency library)
