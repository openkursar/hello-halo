import { describe, it, expect } from 'vitest'
import {
  projectReplicaApplied,
  REPLICA_ROW_EVENTS_MAX,
} from '../../../../../src/main/apps/runtime/federation/replica-events'
import type { BlackboardTask } from '../../../../../src/shared/apps/team-types'

const OFFICE = 'o1'

function task(id: string, status: BlackboardTask['status'] = 'pending'): BlackboardTask {
  return {
    id, teamId: OFFICE, epochId: 'e1', title: id, assigneeAppId: null, status,
    resultRef: null, note: null, parentId: null, createdByAppId: 'a', createdAt: 0, updatedAt: 0,
  }
}

function act(id: string) {
  return { id, teamId: OFFICE, epochId: 'e1', kind: 'message', actorAppId: 'a', targetAppId: null, subject: id, body: null, refId: null, correlationId: null, status: null, createdAt: 0 }
}

describe('projectReplicaApplied', () => {
  it('turns replicated rows into board deltas, not a refresh', () => {
    const tasks = new Map([['t1', task('t1', 'done')]])
    const out = projectReplicaApplied(
      OFFICE,
      {
        snapshot: false,
        entries: [
          { op: 'update_task', taskId: 't1', payload: { status: 'done' } },
          { op: 'post_activity', payload: act('a1') },
          { op: 'post_finding', payload: { id: 'f1', teamId: OFFICE, epochId: 'e1', authorAppId: 'a', body: 'b', ref: null, createdAt: 0 } },
        ],
      },
      (id) => tasks.get(id) ?? null
    )
    expect(out.refresh).toBe(false)
    expect(out.boardEvents.map((e) => e.kind)).toEqual(['task', 'activity', 'finding'])
    // The merged replica row travels, not the partial update payload.
    expect(out.boardEvents[0].task?.status).toBe('done')
    expect(out.boardEvents[0].task?.title).toBe('t1')
  })

  it('an epoch change or a snapshot refreshes, and reports the epoch', () => {
    const epoch = projectReplicaApplied(OFFICE, { snapshot: false, entries: [{ op: 'epoch_upsert', taskId: 'e9', payload: { id: 'e9' } }] }, () => null)
    expect(epoch.refresh).toBe(true)
    expect(epoch.changed).toEqual(['board', 'epochs', 'conversations'])
    expect(epoch.epochIds).toEqual(['e9'])
    const snap = projectReplicaApplied(OFFICE, { snapshot: true, entries: [] }, () => null)
    expect(snap.refresh).toBe(true)
    expect(snap.changed).toBeNull()
    expect(snap.boardEvents).toEqual([])
  })

  it('a large catch-up page is one refresh instead of one event per row', () => {
    const entries = Array.from({ length: REPLICA_ROW_EVENTS_MAX + 1 }, (_, i) => ({ op: 'post_activity' as const, payload: act(`a${i}`) }))
    const out = projectReplicaApplied(OFFICE, { snapshot: false, entries }, () => null)
    expect(out.refresh).toBe(true)
    expect(out.changed).toEqual(['board', 'conversations'])
    expect(out.boardEvents).toEqual([])
  })

  it('a task update whose row the replica does not hold emits nothing', () => {
    const out = projectReplicaApplied(OFFICE, { snapshot: false, entries: [{ op: 'update_task', taskId: 'gone', payload: {} }] }, () => null)
    expect(out.boardEvents).toEqual([])
    expect(out.refresh).toBe(false)
  })
})
