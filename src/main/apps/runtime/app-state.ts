/**
 * The one ladder from a persisted App status plus live execution facts to the
 * state the UI reads.
 *
 * Both the per-person query and the directory page derive it, and a second copy
 * is how they come to disagree. `error` must never be the ladder's default
 * either: that makes an unmapped status indistinguishable from a person the
 * runtime stopped.
 */

import type { AppStatus, AutomationAppState, BlockedReason } from '../../../shared/apps/app-types'

export interface RuntimeStatusInput {
  appStatus: AppStatus
  running: boolean
  queued: boolean
  pendingDecisions: number
}

export function deriveRuntimeStatus(input: RuntimeStatusInput): AutomationAppState['status'] {
  if (input.running) return 'running'
  if (input.queued) return 'queued'
  if (input.pendingDecisions > 0) return 'waiting_user'
  switch (input.appStatus) {
    case 'needs_login': return 'needs_login'
    case 'error': return 'error'
    // A removed person runs no more than a paused one; calling it an issue
    // would put it in front of the owner asking to be fixed.
    case 'paused': case 'uninstalled': return 'paused'
    default: return 'idle'
  }
}

/** Set only while the person cannot restart itself — resume is the way out of both. */
export function blockedReason(appStatus: AppStatus): BlockedReason | undefined {
  if (appStatus === 'error') return 'auto_disabled'
  if (appStatus === 'needs_login') return 'needs_login'
  return undefined
}

/** Must stay exactly what {@link blockedReason} recognises; for callers that query by status. */
export const BLOCKED_STATUSES: readonly AppStatus[] = ['error', 'needs_login']

/** Automatic triggers only fire in these statuses. */
export function automaticEnabled(appStatus: AppStatus): boolean {
  return appStatus === 'active' || appStatus === 'waiting_user'
}
