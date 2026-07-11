/**
 * Presence-FSM flap and clock-suspend handling, driven through the REAL presence
 * FSM over the fault-injection rig: heartbeat frames are starved/relieved over the
 * controllable transport and an injected monotonic clock advances, so the genuine
 * coordinator FSM (online → suspect → confirmed) decides — and its decision is what
 * reaches the authority's election driver.
 *
 * Covered invariants:
 *   flap tolerance   a 2–10s presence flap (jitter) must NOT confirm a node
 *            offline, must NOT trigger an election on the authority, and must NOT
 *            burn the election back-off/runaway budget. Only sustained
 *            (≥ confirmed) silence acts.
 *   suspend/resume   the FSM measures silence on the MONOTONIC clock; a host
 *            suspend/resume (wall jumps far past confirmed while monotonic is
 *            frozen) must be absorbed by the resume-grace guard and confirm
 *            NOBODY offline, avoiding a mass-false-offline on wake.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  buildCluster,
  SUSPECT_MS,
  CONFIRMED_MS,
  task,
  RIG_OFFICE,
  RIG_EPOCH,
  type FaultCluster,
} from './cluster'

describe('AC-11.4 / B2 — flap & suspend through the real presence FSM (D8 rig)', () => {
  let rig: FaultCluster
  afterEach(() => rig?.dispose())

  it('AC-11.4: a 2–10s flap reaches suspect at most, recovers on a heartbeat, no election, no offline', () => {
    rig = buildCluster({ ids: ['A', 'B', 'C'] })
    // Settle: one heartbeat round marks everyone freshly seen.
    rig.beat()

    // Authority A commits a write so we can later assert NO new authority emerged.
    rig.nodes.A.office.captureLocalWrite({
      teamId: RIG_OFFICE,
      epochId: RIG_EPOCH,
      op: 'post_task',
      payload: task('t1') as unknown as Record<string, unknown>,
      taskId: 't1',
    })
    expect(rig.committedWriteAuthorityCount()).toBe(1)

    // A "flap": silence crosses suspect but NOT confirmed (a 6–10s blip), then a
    // heartbeat arrives. B and C only ever see A as suspect, never offline.
    rig.advance(SUSPECT_MS + 1)
    rig.tick() // sweep: A → suspect on B and C (no heartbeats flowed this gap)
    expect(rig.nodes.B.fed.getNode(RIG_OFFICE, 'A')!.status).toBe('suspect')
    expect(rig.nodes.C.fed.getNode(RIG_OFFICE, 'A')!.status).toBe('suspect')

    // A heartbeat from A inside the window rolls suspect back to online — the flap
    // is fully absorbed.
    rig.advance(1)
    rig.beat()
    expect(rig.nodes.B.fed.getNode(RIG_OFFICE, 'A')!.status).toBe('online')
    expect(rig.nodes.C.fed.getNode(RIG_OFFICE, 'A')!.status).toBe('online')

    expect(rig.nodes.B.becameAuthority).not.toHaveBeenCalled()
    expect(rig.nodes.C.becameAuthority).not.toHaveBeenCalled()
    expect(rig.nodes.B.office.isAuthoritySelf()).toBe(false)
    expect(rig.nodes.C.office.isAuthoritySelf()).toBe(false)
    expect(rig.committedWriteAuthorityCount()).toBe(1)
    expect(rig.nodes.A.office.getTerm()).toBe(1)
  })

  it('AC-11.4: repeated flaps (suspect↔online) across several cycles never confirm offline or elect', () => {
    rig = buildCluster({ ids: ['A', 'B', 'C'] })
    rig.beat()

    for (let cycle = 0; cycle < 5; cycle++) {
      rig.advance(SUSPECT_MS + 1)
      rig.tick()
      expect(rig.nodes.B.fed.getNode(RIG_OFFICE, 'A')!.status).toBe('suspect')
      rig.advance(1)
      rig.beat()
      expect(rig.nodes.B.fed.getNode(RIG_OFFICE, 'A')!.status).toBe('online')
    }

    expect(rig.offlineSeenBy('B')).toEqual([])
    expect(rig.offlineSeenBy('C')).toEqual([])
    expect(rig.nodes.B.becameAuthority).not.toHaveBeenCalled()
    expect(rig.nodes.C.becameAuthority).not.toHaveBeenCalled()
    expect(rig.nodes.A.office.getTerm()).toBe(1)
  })

  it('B2: a host suspend/resume (wall jumps past confirmed, monotonic frozen) confirms NOBODY offline', () => {
    rig = buildCluster({ ids: ['A', 'B', 'C'] })
    rig.beat()

    // Establish a lastSweep baseline so the resume guard has a reference pair.
    rig.advance(1000)
    rig.tick()
    expect(rig.offlineSeenBy('B')).toEqual([])

    rig.advanceWallOnly(CONFIRMED_MS * 3)
    rig.tick()

    expect(rig.offlineSeenBy('A')).toEqual([])
    expect(rig.offlineSeenBy('B')).toEqual([])
    expect(rig.offlineSeenBy('C')).toEqual([])
    expect(rig.nodes.B.becameAuthority).not.toHaveBeenCalled()
    expect(rig.nodes.C.becameAuthority).not.toHaveBeenCalled()

    rig.advance(1000)
    rig.beat()
    rig.advance(1000)
    rig.tick()
    expect(rig.offlineSeenBy('B')).toEqual([])
  })

  it('contrast: SUSTAINED silence (≥ confirmed) on the real FSM DOES confirm the peer offline', () => {
    rig = buildCluster({ ids: ['A', 'B', 'C'] })
    rig.beat()

    // A genuinely dies: it stops beating AND stops sweeping/broadcasting. (Were A
    // left alive it would sweep too and project B/C offline from its own lonely
    // view — and whichever survivor swept A first would broadcast offline(A),
    // which the OTHER survivor absorbs as a host-authoritative projection
    // (applyRemoteOffline: unblock only, no store-row mutation) and then skip in
    // its own sweep. Killing A isolates the pure "A is silent" FSM transition on
    // each independent survivor.)
    rig.kill('A')

    // Delay presence broadcasts so each survivor's offline(A) projection queues
    // instead of delivering synchronously mid-sweep — without this, whichever
    // survivor sweeps first would make the other skip A via a host projection
    // instead of running its own FSM transition.
    rig.setDelay(50)

    rig.advance(CONFIRMED_MS + 1)
    rig.tick()

    // B and C each independently confirm A offline through the genuine FSM
    // (suspect→confirmed in one sweep is allowed as long as it passes through
    // suspect first).
    expect(rig.nodes.B.fed.getNode(RIG_OFFICE, 'A')!.status).toBe('offline')
    expect(rig.nodes.C.fed.getNode(RIG_OFFICE, 'A')!.status).toBe('offline')
  })
})
