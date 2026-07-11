/**
 * reconcile — post-handover task reconciliation.
 *
 * Owner busy/suspect → HOLD (no reassign); idle/confirmed-offline → REASSIGN.
 * Held tasks re-check on a (faked) timer until the owner resolves.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  decideReassign,
  createReconciler,
  type OwnerStatus,
} from '../../../../../../src/main/apps/runtime/federation/authority/reconcile'
import type { BlackboardTask, TeamStore } from '../../../../../../src/main/apps/team'

function task(id: string, assignee: string | null, status: BlackboardTask['status'] = 'in_progress'): BlackboardTask {
  return {
    id,
    teamId: 'T',
    epochId: 'E',
    title: id,
    assigneeAppId: assignee,
    status,
    resultRef: null,
    note: null,
    parentId: null,
    createdByAppId: 'lead',
    createdAt: 0,
    updatedAt: 0,
  }
}

/** A minimal TeamStore stub exposing only what the reconciler reads. */
function storeWith(tasks: BlackboardTask[]): TeamStore {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  return {
    listTasksByEpoch: () => [...byId.values()],
    getTaskById: (id: string) => byId.get(id) ?? null,
  } as unknown as TeamStore
}

function makeScheduler() {
  let pending: Array<{ id: number; fn: () => void }> = []
  let nextId = 1
  return {
    schedule: (_ms: number, fn: () => void) => {
      const id = nextId++
      pending.push({ id, fn })
      return () => {
        pending = pending.filter((p) => p.id !== id)
      }
    },
    runAll() {
      // Run currently-queued callbacks (a re-check may enqueue more).
      const batch = pending
      pending = []
      for (const p of batch) p.fn()
    },
    count: () => pending.length,
  }
}

describe('decideReassign (pure M-10 decision)', () => {
  it('holds on busy/suspect, reassigns on idle/offline', () => {
    expect(decideReassign('busy')).toBe('hold')
    expect(decideReassign('suspect')).toBe('hold')
    expect(decideReassign('idle')).toBe('reassign')
    expect(decideReassign('confirmed-offline')).toBe('reassign')
  })
})

describe('createReconciler', () => {
  it('O-M10-1: busy owner → zero reassign (HOLD), re-checks later', () => {
    const reassign = vi.fn()
    const sched = makeScheduler()
    const r = createReconciler({
      officeId: 'O',
      store: storeWith([task('t1', 'owner-1')]),
      getOwnerStatus: () => 'busy',
      reassign,
      schedule: sched.schedule,
    })
    const decisions = r.reconcileEpoch('T', 'E')
    expect(decisions).toEqual([{ taskId: 't1', decision: 'hold' }])
    expect(reassign).not.toHaveBeenCalled()
    // A re-check is scheduled while the owner stays busy.
    expect(sched.count()).toBe(1)
  })

  it('O-M10-2: confirmed-offline / idle owner → reassign', () => {
    const reassign = vi.fn()
    const sched = makeScheduler()
    const r = createReconciler({
      officeId: 'O',
      store: storeWith([task('t1', 'owner-1'), task('t2', 'owner-2')]),
      getOwnerStatus: (appId) => (appId === 'owner-1' ? 'confirmed-offline' : 'idle'),
      reassign,
      schedule: sched.schedule,
    })
    const decisions = r.reconcileEpoch('T', 'E')
    expect(decisions).toEqual([
      { taskId: 't1', decision: 'reassign' },
      { taskId: 't2', decision: 'reassign' },
    ])
    expect(reassign).toHaveBeenCalledTimes(2)
  })

  it('held task is reassigned once its owner becomes offline on a later re-check', () => {
    const reassign = vi.fn()
    const sched = makeScheduler()
    let status: OwnerStatus = 'busy'
    const r = createReconciler({
      officeId: 'O',
      store: storeWith([task('t1', 'owner-1')]),
      getOwnerStatus: () => status,
      reassign,
      schedule: sched.schedule,
    })
    r.reconcileEpoch('T', 'E')
    expect(reassign).not.toHaveBeenCalled()
    status = 'confirmed-offline'
    sched.runAll() // the re-check fires
    expect(reassign).toHaveBeenCalledTimes(1)
  })

  it('does not reassign a task that left in_progress', () => {
    const reassign = vi.fn()
    const sched = makeScheduler()
    const t = task('t1', 'owner-1', 'done')
    const r = createReconciler({
      officeId: 'O',
      store: storeWith([t]),
      getOwnerStatus: () => 'confirmed-offline',
      reassign,
      schedule: sched.schedule,
    })
    const decisions = r.reconcileEpoch('T', 'E')
    expect(decisions).toEqual([]) // only in_progress tasks are reconciled
    expect(reassign).not.toHaveBeenCalled()
  })
})
