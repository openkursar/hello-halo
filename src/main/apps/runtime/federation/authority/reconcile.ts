/**
 * Post-handover task reconciliation. After a handover the new authority
 * inherits the committed blackboard, but the volatile coordination state of the
 * OLD authority (pendingWaits / mailbox) is gone. Some tasks are still
 * `in_progress`. The new authority must NOT blindly reassign them: the owner
 * that was running a task may still be alive and busy, and reassigning it would
 * double-execute it.
 *
 * So before reassigning any `in_progress` task, reconcile against the owner's
 * live presence + busy:
 *   busy              → HOLD (still running it)
 *   suspect           → HOLD (jitter window; never act on a flap)
 *   idle              → REASSIGN (owner online but not running it → safe)
 *   confirmed-offline → REASSIGN (owner gone)
 *
 * This is an async, per-task process: its bound is the owner's confirmed
 * judgment (~12-15s for a dead owner), and it must NOT block the office's 5s
 * "writable after takeover" liveness — held tasks just stay `in_progress` until
 * their owner's presence resolves.
 */

import type { TeamStore, BlackboardTask } from '../../../team'

/** Owner reachability as projected from presence + the kernel busy signal. */
export type OwnerStatus = 'busy' | 'suspect' | 'idle' | 'confirmed-offline'

export type ReconcileDecision = 'hold' | 'reassign'

export function decideReassign(ownerStatus: OwnerStatus): ReconcileDecision {
  switch (ownerStatus) {
    case 'busy':
    case 'suspect':
      return 'hold'
    case 'idle':
    case 'confirmed-offline':
      return 'reassign'
  }
}

export interface ReconcilerDeps {
  officeId: string
  store: TeamStore
  /** Owner reachability for a member appId (presence FSM + kernel busy). */
  getOwnerStatus: (appId: string) => OwnerStatus
  /** Re-drive a task whose owner is gone (e.g. mark for the lead to reassign). */
  reassign: (task: BlackboardTask) => void
  /** Schedule a deferred re-check; defaults to setTimeout (unref'd). Injected for tests. */
  schedule?: (ms: number, fn: () => void) => () => void
  /** Re-check cadence for a held task while its owner stays busy/suspect. */
  recheckMs?: number
  now?: () => number
}

export interface Reconciler {
  /**
   * Reconcile every `in_progress` task of an epoch. Returns the immediate
   * decisions; HOLD tasks are re-checked on a timer until their owner resolves
   * to idle/offline (then reassigned) or the task leaves `in_progress`.
   */
  reconcileEpoch(teamId: string, epochId: string): Array<{ taskId: string; decision: ReconcileDecision }>
  /** Cancel all pending re-checks (e.g. on stop / epoch seal). */
  stop(): void
}

const DEFAULT_RECHECK_MS = 3000

export function createReconciler(deps: ReconcilerDeps): Reconciler {
  const { store, getOwnerStatus, reassign } = deps
  // Injected clock reserved for future TTL bookkeeping; bound (underscored as
  // intentionally-unused) so the seam stays stable without a `void` no-op.
  const _now = deps.now ?? (() => Date.now())
  const recheckMs = deps.recheckMs ?? DEFAULT_RECHECK_MS
  const schedule =
    deps.schedule ??
    ((ms, fn) => {
      const t = setTimeout(fn, ms)
      if (typeof t.unref === 'function') t.unref()
      return () => clearTimeout(t)
    })

  const pending = new Set<() => void>()

  function reconcileTask(teamId: string, epochId: string, taskId: string): void {
    const task = store.getTaskById(taskId)
    // Left in_progress? If the task moved on (done/rejected/reassigned), stop.
    if (!task || task.status !== 'in_progress' || task.epochId !== epochId) return
    const owner = task.assigneeAppId
    if (!owner) {
      // Unassigned in_progress is anomalous; treat as needing reassignment.
      reassign(task)
      return
    }
    const decision = decideReassign(getOwnerStatus(owner))
    if (decision === 'reassign') {
      reassign(task)
      return
    }
    // HOLD: owner busy/suspect → re-check later (bounded by the owner's confirmed
    // judgment, not a hard deadline). Never blocks office writability.
    const cancel = schedule(recheckMs, () => {
      pending.delete(cancel)
      reconcileTask(teamId, epochId, taskId)
    })
    pending.add(cancel)
  }

  return {
    reconcileEpoch(teamId, epochId) {
      const tasks = store
        .listTasksByEpoch(teamId, epochId)
        .filter((t) => t.status === 'in_progress')
      const decisions = tasks.map((t) => {
        const owner = t.assigneeAppId
        const decision: ReconcileDecision = owner
          ? decideReassign(getOwnerStatus(owner))
          : 'reassign'
        return { taskId: t.id, decision }
      })
      for (const t of tasks) {
        reconcileTask(teamId, epochId, t.id)
      }
      return decisions
    },
    stop() {
      for (const cancel of pending) cancel()
      pending.clear()
    },
  }
}
