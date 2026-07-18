/**
 * Fault-injection tests for the reliable control-plane feed (ctrl-feed.ts).
 *
 * Two nodes — an AUTHORITY and an OWNER — each with its own real FeedStore,
 * exchange ctrl entries (wake / turn-complete) through an in-memory bus that can
 * drop frames. Proves the assembled unit:
 *   - delivers a wake / turn-complete exactly once (happy path),
 *   - self-heals a dropped frame via the retransmit backstop (MB-2),
 *   - applies a duplicate at most once — no double execution (H9),
 *   - ignores an entry addressed to a different node (directed dispatch),
 *   - exposes a delivery watermark for the three-state receipt (pending→delivered),
 *   - continues after an author "restart" with no seq reset and no re-execution.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabaseManager } from '../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../src/main/platform/store/types'
import { FeedStore } from '../../../../../src/main/apps/federation/feed-store'
import {
  MIGRATION_NAMESPACE,
  migrations,
} from '../../../../../src/main/apps/federation/migrations'
import { createCtrlFeed, type CtrlFeed } from '../../../../../src/main/apps/runtime/federation/ctrl-feed'
import { feedIdKey, type FeedSyncFrame } from '../../../../../src/main/apps/runtime/federation/log/types'
import type { SerializedWakeRequest } from '../../../../../src/main/apps/runtime/federation/types'
import type { TurnCompletion } from '../../../../../src/main/apps/runtime/team/message-bus'

const OFFICE = 'office-1'
const AUTH = 'node-authority'
const OWNER = 'node-owner'
const GIVE_UP_MS = 60_000
const AUTH_CTRL_KEY = feedIdKey({ officeId: OFFICE, author: AUTH, kind: 'ctrl' })

function makeRequest(appId = 'app-x'): SerializedWakeRequest {
  return {
    appId,
    spaceId: 'space-1',
    message: 'do the thing',
    conversationId: 'conv-1',
    teamContext: { teamId: OFFICE, epochId: 'epoch-1', correlationId: 'c', fromAppId: null, wait: false },
  } as unknown as SerializedWakeRequest
}

interface Harness {
  authFeed: CtrlFeed
  ownerFeed: CtrlFeed
  authStore: FeedStore
  wakesAtOwner: Array<{ correlationId: string; from: string; appId: string }>
  completionsAtAuth: Array<{ correlationId: string; outcome: TurnCompletion }>
  undeliverablesAtAuth: Array<{ correlationId: string; target: string; reason: string }>
  /** Drop the next frame delivered to `to` matching pred. */
  dropOnce: (to: string, pred: (f: FeedSyncFrame) => boolean) => void
  /** Advance the authority's injected clock (drives the give-up backstop). */
  advanceAuthClock: (ms: number) => void
  rebuildAuth: () => void
  closeAll: () => void
}

function makeHarness(): Harness {
  const authDb = createDatabaseManager(':memory:')
  const ownerDb = createDatabaseManager(':memory:')
  authDb.runMigrations(authDb.getAppDatabase(), MIGRATION_NAMESPACE, migrations)
  ownerDb.runMigrations(ownerDb.getAppDatabase(), MIGRATION_NAMESPACE, migrations)
  const authStore = new FeedStore(authDb.getAppDatabase())
  const ownerStore = new FeedStore(ownerDb.getAppDatabase())

  const wakesAtOwner: Harness['wakesAtOwner'] = []
  const completionsAtAuth: Harness['completionsAtAuth'] = []
  const undeliverablesAtAuth: Harness['undeliverablesAtAuth'] = []
  let drop: { to: string; pred: (f: FeedSyncFrame) => boolean } | null = null
  let authClock = 1_000_000

  function deliver(to: string, from: string, frame: FeedSyncFrame): void {
    if (drop && drop.to === to && drop.pred(frame)) {
      drop = null
      return
    }
    const wire = JSON.parse(JSON.stringify(frame)) as FeedSyncFrame
    if (to === AUTH) authFeed.handleFrame(from, wire)
    else ownerFeed.handleFrame(from, wire)
  }

  function buildAuth(): CtrlFeed {
    return createCtrlFeed({
      officeId: OFFICE,
      selfNodeId: AUTH,
      feedStore: authStore,
      sendToPeer: (peer, frame) => deliver(peer, AUTH, frame),
      // The authority never receives a wake; it receives turn-completes.
      onWake: () => {},
      onTurnComplete: (m) => completionsAtAuth.push({ correlationId: m.correlationId, outcome: m.outcome }),
      onUndeliverable: (m) =>
        undeliverablesAtAuth.push({ correlationId: m.correlationId, target: m.target, reason: m.reason }),
      retransmitIntervalMs: 0,
      giveUpMs: GIVE_UP_MS,
      now: () => authClock,
    })
  }

  let authFeed: CtrlFeed = buildAuth()
  const ownerFeed: CtrlFeed = createCtrlFeed({
    officeId: OFFICE,
    selfNodeId: OWNER,
    feedStore: ownerStore,
    sendToPeer: (peer, frame) => deliver(peer, OWNER, frame),
    onWake: (m) =>
      wakesAtOwner.push({ correlationId: m.correlationId, from: m.from, appId: m.request.appId }),
    onTurnComplete: () => {},
    retransmitIntervalMs: 0,
  })

  return {
    get authFeed() {
      return authFeed
    },
    ownerFeed,
    authStore,
    wakesAtOwner,
    completionsAtAuth,
    undeliverablesAtAuth,
    dropOnce: (to, pred) => {
      drop = { to, pred }
    },
    advanceAuthClock: (ms) => {
      authClock += ms
    },
    rebuildAuth: () => {
      authFeed = buildAuth()
    },
    closeAll: () => {
      authDb.closeAll()
      ownerDb.closeAll()
    },
  }
}

describe('ctrl-feed — reliable control-plane delivery', () => {
  let h: Harness

  beforeEach(() => {
    h = makeHarness()
    // Both sides subscribe to each other's ctrl feed (as the manager does on join).
    h.ownerFeed.subscribePeer(AUTH)
    h.authFeed.subscribePeer(OWNER)
  })

  afterEach(() => h.closeAll())

  it('delivers a wake to the addressed owner exactly once (happy path)', () => {
    h.authFeed.publishWake(OWNER, 'corr-1', makeRequest('app-a'))
    expect(h.wakesAtOwner).toHaveLength(1)
    expect(h.wakesAtOwner[0]).toMatchObject({ correlationId: 'corr-1', from: AUTH, appId: 'app-a' })
  })

  it('refluxes turn-complete to the authority exactly once', () => {
    h.ownerFeed.publishTurnComplete(AUTH, 'corr-1', { kind: 'result', content: 'done' })
    expect(h.completionsAtAuth).toHaveLength(1)
    expect(h.completionsAtAuth[0].outcome).toEqual({ kind: 'result', content: 'done' })
  })

  it('MB-2: a dropped turn-complete self-heals on the retransmit backstop (no loss)', () => {
    // Drop the first feed-entries frame carrying the completion to the authority.
    h.dropOnce(AUTH, (f) => f.kind === 'feed-entries')
    h.ownerFeed.publishTurnComplete(AUTH, 'corr-9', { kind: 'result', content: 'late' })
    expect(h.completionsAtAuth).toHaveLength(0) // lost in flight

    // The backstop resends from the peer's (un-advanced) ack watermark.
    h.ownerFeed.retransmitTick()
    expect(h.completionsAtAuth).toHaveLength(1)
    expect(h.completionsAtAuth[0].correlationId).toBe('corr-9')
  })

  it('MB-2: a dropped wake self-heals on the retransmit backstop', () => {
    h.dropOnce(OWNER, (f) => f.kind === 'feed-entries')
    h.authFeed.publishWake(OWNER, 'corr-w', makeRequest())
    expect(h.wakesAtOwner).toHaveLength(0)

    h.authFeed.retransmitTick()
    expect(h.wakesAtOwner).toHaveLength(1)
    expect(h.wakesAtOwner[0].correlationId).toBe('corr-w')
  })

  it('H9: a duplicated wake is applied at most once (no double execution)', () => {
    h.authFeed.publishWake(OWNER, 'corr-dup', makeRequest())
    expect(h.wakesAtOwner).toHaveLength(1)
    // A redundant retransmit (e.g. ack lost, or gateway double-path) re-sends the
    // same entry; the consumer's seq + fid dedup must not re-apply it.
    h.authFeed.retransmitTick()
    h.authFeed.retransmitTick()
    expect(h.wakesAtOwner).toHaveLength(1)
  })

  it('directed dispatch: an entry addressed to another node is consumed but not acted on', () => {
    // Authority wakes some OTHER node; the owner consumes the entry (cursor advances)
    // but does not run it.
    h.authFeed.publishWake('node-somebody-else', 'corr-other', makeRequest())
    expect(h.wakesAtOwner).toHaveLength(0)
    // The owner still acked it, so a real wake to the owner right after applies in order.
    h.authFeed.publishWake(OWNER, 'corr-mine', makeRequest('app-mine'))
    expect(h.wakesAtOwner).toHaveLength(1)
    expect(h.wakesAtOwner[0]).toMatchObject({ correlationId: 'corr-mine', appId: 'app-mine' })
  })

  it('three-state: the delivery watermark advances only once the peer acks', () => {
    const { seq } = h.authFeed.publishWake(OWNER, 'corr-d', makeRequest())
    // The owner applied + acked synchronously through the bus → delivered.
    expect(h.authFeed.deliveredUpTo(OWNER)).toBeGreaterThanOrEqual(seq)

    // A wake whose delivery frame is dropped stays pending until a retransmit acks.
    h.dropOnce(OWNER, (f) => f.kind === 'feed-entries')
    const pendingWake = h.authFeed.publishWake(OWNER, 'corr-p', makeRequest())
    expect(h.authFeed.deliveredUpTo(OWNER)).toBeLessThan(pendingWake.seq)
    h.authFeed.retransmitTick()
    expect(h.authFeed.deliveredUpTo(OWNER)).toBeGreaterThanOrEqual(pendingWake.seq)
  })

  it('restart: a rebuilt author continues seq without reset and does not re-run old wakes', () => {
    h.authFeed.publishWake(OWNER, 'corr-1', makeRequest())
    expect(h.wakesAtOwner).toHaveLength(1)

    // Author process "restarts": a fresh ctrl feed over the SAME store. Its
    // in-memory subscriber set is empty until peers reconnect — so the owner
    // re-subscribes (exactly what the manager does on reconnect), declaring its
    // persisted watermark so only the un-applied tail is replayed.
    h.rebuildAuth()
    h.ownerFeed.subscribePeer(AUTH)

    // A new wake gets the NEXT seq (persisted floor, no reset), and the owner —
    // whose cursor persisted at corr-1 — applies only corr-2, never re-running corr-1.
    h.authFeed.publishWake(OWNER, 'corr-2', makeRequest('app-2'))
    h.authFeed.retransmitTick()
    const ids = h.wakesAtOwner.map((w) => w.correlationId)
    expect(ids).toEqual(['corr-1', 'corr-2']) // exactly once each, in order
  })

  it('patience: an un-acked wake stays PENDING before the give-up deadline (no offline fast-fail)', () => {
    // The wake never reaches the owner (delivery frame dropped) — e.g. a WAN
    // tunnel outage. It must stay pending in the outbox (the retransmit backstop
    // will deliver it on recovery), not be failed by a presence transition.
    h.dropOnce(OWNER, (f) => f.kind === 'feed-entries')
    const { seq } = h.authFeed.publishWake(OWNER, 'corr-flap', makeRequest())
    expect(h.authFeed.deliveredUpTo(OWNER)).toBeLessThan(seq)

    // Well within the give-up window: still pending, never undeliverable.
    h.advanceAuthClock(GIVE_UP_MS - 1)
    h.authFeed.retransmitTick() // also redelivers → the owner finally acks
    expect(h.undeliverablesAtAuth).toHaveLength(0)
    expect(h.wakesAtOwner.map((w) => w.correlationId)).toContain('corr-flap')
  })

  it('give-up: a DELIVERED wake is never reported undeliverable after the deadline', () => {
    // Delivered + acked synchronously through the bus.
    const { seq } = h.authFeed.publishWake(OWNER, 'corr-ok', makeRequest())
    expect(h.authFeed.deliveredUpTo(OWNER)).toBeGreaterThanOrEqual(seq)

    // Past the give-up deadline the sweep retires it silently (its completion is
    // awaited separately) — it must NOT be re-reported as undelivered.
    h.advanceAuthClock(GIVE_UP_MS + 1)
    h.authFeed.retransmitTick()
    expect(h.undeliverablesAtAuth).toHaveLength(0)
  })

  it('give-up backstop: an un-acked wake becomes undeliverable after the deadline on the tick', () => {
    // A wake to a node that never subscribes/acks stays undelivered even across
    // retransmits — the only exit is the give-up backstop.
    const GHOST = 'node-ghost'
    h.authFeed.publishWake(GHOST, 'corr-stuck', makeRequest())

    // Before the deadline: the sweep on the tick leaves it pending.
    h.advanceAuthClock(GIVE_UP_MS - 1)
    h.authFeed.retransmitTick()
    expect(h.undeliverablesAtAuth).toHaveLength(0)

    // Past the deadline: the next tick sweeps it to undeliverable('timeout').
    h.advanceAuthClock(2)
    h.authFeed.retransmitTick()
    expect(h.undeliverablesAtAuth).toEqual([
      { correlationId: 'corr-stuck', target: GHOST, reason: 'timeout' },
    ])
  })

  it('retention: the tick prunes the outbox prefix every subscriber has acked, without seq reset', () => {
    // Three delivered + acked wakes → the owner's cursor covers all of them.
    h.authFeed.publishWake(OWNER, 'corr-1', makeRequest())
    h.authFeed.publishWake(OWNER, 'corr-2', makeRequest())
    const { seq: seq3 } = h.authFeed.publishWake(OWNER, 'corr-3', makeRequest())
    expect(h.authFeed.deliveredUpTo(OWNER)).toBeGreaterThanOrEqual(seq3)

    // The tick prunes below the min subscriber watermark (= the owner's ack).
    h.authFeed.retransmitTick()
    expect(h.authStore.listAfter(OFFICE, AUTH_CTRL_KEY, 0, 100)).toHaveLength(0)

    // Seq allocation is anchored to the retention floor, so the next wake continues
    // from seq3+1 (no reuse of seq 1) and is delivered exactly once.
    const { seq: seq4 } = h.authFeed.publishWake(OWNER, 'corr-4', makeRequest('app-4'))
    expect(seq4).toBe(seq3 + 1)
    expect(h.wakesAtOwner.map((w) => w.correlationId)).toEqual(['corr-1', 'corr-2', 'corr-3', 'corr-4'])
  })
})
