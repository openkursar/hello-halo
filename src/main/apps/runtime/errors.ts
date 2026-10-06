/**
 * apps/runtime -- Error Types
 *
 * Domain-specific errors for the App execution engine.
 */

import type { AppStatus } from '../manager'

/**
 * Thrown when attempting to execute an App that is not in a runnable state.
 */
export class AppNotRunnableError extends Error {
  readonly name = 'AppNotRunnableError'
  readonly appId: string
  readonly status: AppStatus

  constructor(appId: string, status: AppStatus) {
    super(`App ${appId} is not runnable (status: ${status})`)
    this.appId = appId
    this.status = status
  }
}

/**
 * Thrown when a trigger is rejected due to a concurrency constraint.
 *
 * Two cases:
 * - Per-app limit (isPerApp=true): the same app is already running or queued.
 *   The caller should inform the user/AI the app is busy.
 * - Global limit (isPerApp=false): the global semaphore is saturated and
 *   the caller opted not to queue (reserved for future non-blocking paths).
 */
export class ConcurrencyLimitError extends Error {
  readonly name = 'ConcurrencyLimitError'
  readonly maxConcurrent: number
  /** True when the same app is already running or queued (per-app dedup). */
  readonly isPerApp: boolean
  readonly appId?: string

  constructor(maxConcurrent: number, appId?: string) {
    const msg = appId
      ? `App is already running or queued. Wait for it to complete before triggering again.`
      : `Concurrency limit reached (max: ${maxConcurrent} concurrent runs)`
    super(msg)
    this.maxConcurrent = maxConcurrent
    this.isPerApp = !!appId
    this.appId = appId
  }
}

/**
 * Thrown when an escalation entry is not found or has already been responded to.
 */
export class EscalationNotFoundError extends Error {
  readonly name = 'EscalationNotFoundError'
  readonly appId: string
  readonly entryId: string

  constructor(appId: string, entryId: string) {
    super(`Escalation not found: app=${appId}, entry=${entryId}`)
    this.appId = appId
    this.entryId = entryId
  }
}

/**
 * Thrown when an App execution fails due to an Agent/SDK error.
 */
export class RunExecutionError extends Error {
  readonly name = 'RunExecutionError'
  readonly appId: string
  readonly runId: string

  constructor(appId: string, runId: string, cause: string) {
    super(`Run execution failed: app=${appId}, run=${runId}: ${cause}`)
    this.appId = appId
    this.runId = runId
  }
}

/**
 * Thrown when asked for the process of a run whose transcript the retention
 * rule cleared. `code` lets a client say so in the user's language.
 */
export class RunProcessClearedError extends Error {
  readonly name = 'RunProcessClearedError'
  readonly code = 'RUN_PROCESS_CLEARED'
  readonly runId: string

  constructor(runId: string) {
    super('The detailed process of this execution was cleared under the retention rule')
    this.runId = runId
  }
}
