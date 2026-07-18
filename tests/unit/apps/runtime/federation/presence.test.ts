/**
 * Unit tests for apps/runtime/federation -- Presence debounce FSM (D3).
 *
 * Proves the two-threshold reachability machine: online → suspect (HOLD) →
 * confirmed-offline, with asymmetric hysteresis (one heartbeat recovers from
 * suspect) and T7 (a bare heartbeat after confirmed does NOT revive — only a
 * rejoin does). The confirmed-offline → member-unblock seam is exercised through
 * the INJECTED onMemberConfirmedOffline hook (the bus is NOT involved here —
 * that hook is the seam bootstrap wires to bus.resolvePendingWaitsForMember).
 *
 * D3 invariants under test:
 *   O-P3-2  jitter rollback: silence into suspect then a heartbeat → online with
 *           ZERO side effects (onMemberConfirmedOffline never called).
 *   O-P3-1  suspect zero-action: no fan-out / no unblock while suspect.
 *   O-P3-3  confirmed acts once: offline + onMemberConfirmedOffline once per bound
 *           member; further ticks do not re-fire.
 *   No online→offline direct jump: always passes through suspect first.
 *   T7      confirmed requires rejoin; a bare heartbeat is dropped.
 *   recovery=1: a single heartbeat in suspect recovers.
 *
 * A fake clock + small thresholds drive sweepPresence()/handleHeartbeat
 * deterministically; the link is an in-memory hub.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createDatabaseManager } from '../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../src/main/platform/store/types'
import { FederationStore } from '../../../../../src/main/apps/federation/store'
import {
  MIGRATION_NAMESPACE as FED_NS,
  migrations as fedMigrations,
} from '../../../../../src/main/apps/federation/migrations'
import { TeamStore } from '../../../../../src/main/apps/team/store'
import {
  MIGRATION_NAMESPACE as TEAM_NS,
  migrations as teamMigrations,
} from '../../../../../src/main/apps/team/migrations'
import { createFederationCoordinator } from '../../../../../src/main/apps/runtime/federation/coordinator'
import type { NodeBoundMember } from '../../../../../src/main/apps/runtime/federation/coordinator'
import {
  InMemoryFederationHub,
  InMemoryFederationLink,
} from '../../../../../src/main/apps/runtime/federation/link'
import type {
  FederationMessage,
  JoinRequest,
  PresenceUpdate,
} from '../../../../../src/main/apps/runtime/federation'

// ── Fixtures ──

const OFFICE = 'office-1'
const HOST = 'node-host'
const BOB = 'node-bob'
const OBSERVER = 'node-observer'
// Small thresholds for the fake clock; ordering (suspect < confirmed) mirrors D3.
const SUSPECT_MS = 100
const CONFIRMED_MS = 200

/** A presence broadcast captured off the hub, in order. */
function recordingPeer(hub: InMemoryFederationHub, nodeId: string) {
  const link = new InMemoryFederationLink(nodeId, hub)
  const presence: PresenceUpdate[] = []
  link.onMessage((_from, msg) => {
    if (msg.kind === 'presence-update') presence.push(msg)
  })
  return { link, presence, statuses: () => presence.map((p) => p.status) }
}

describe('FederationCoordinator presence FSM (D3 two-threshold debounce)', () => {
  let dbManager: DatabaseManager
  let federationStore: FederationStore
  let teamStore: TeamStore
  let hub: InMemoryFederationHub
  let clock: number
  const now = () => clock

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, FED_NS, fedMigrations)
    dbManager.runMigrations(db, TEAM_NS, teamMigrations)
    federationStore = new FederationStore(db)
    teamStore = new TeamStore(db)
    hub = new InMemoryFederationHub()
    clock = 1_000_000
  })

  afterEach(() => {
    dbManager.closeAll()
  })

  /**
   * Build a host coordinator that already tracks BOB online with `memberCount`
   * bound members (owner_node_id = BOB). Returns the coordinator + spies.
   */
  function makeHostTrackingBob(memberCount = 1) {
    const onMemberConfirmedOffline = vi.fn<[string], void>()
    const memberAppIds: string[] = []
    for (let i = 0; i < memberCount; i++) {
      const appId = `app-bob-${i}`
      memberAppIds.push(appId)
      teamStore.addMember({
        teamId: OFFICE,
        appId,
        memberName: `bob-member-${i}`,
        role: 'Writer',
        isLead: false,
        aiProvisioned: false,
        addedAt: clock,
        ownerNodeId: BOB,
        origin: 'remote',
        memberIdentity: 'identity-bob',
      })
    }
    federationStore.upsertNode({
      nodeId: BOB,
      officeId: OFFICE,
      identity: 'identity-bob',
      displayName: 'Bob',
      joinedAt: clock,
      lastSeen: clock,
      status: 'online',
    })

    const listMembersForNode = vi.fn((nodeId: string): NodeBoundMember[] =>
      teamStore
        .listMembersByTeam(OFFICE)
        .filter((m) => m.ownerNodeId === nodeId)
        .map((m) => ({ appId: m.appId, memberIdentity: m.memberIdentity ?? null }))
    )

    const hostLink = new InMemoryFederationLink(HOST, hub)
    const coordinator = createFederationCoordinator({
      context: { officeId: OFFICE, selfNodeId: HOST },
      link: hostLink,
      federationStore,
      teamStore,
      verifyCredential: (token) => (token === 'valid-token' ? { officeId: OFFICE } : null),
      now,
      presence: { suspectAfterMs: SUSPECT_MS, confirmedOfflineMs: CONFIRMED_MS },
      onMemberConfirmedOffline,
      listMembersForNode,
    })
    coordinator.start()
    return { coordinator, onMemberConfirmedOffline, listMembersForNode, memberAppIds }
  }

  function bobHeartbeat() {
    hub.deliver(BOB, HOST, { kind: 'heartbeat', officeId: OFFICE, fromNode: BOB, ts: clock })
  }

  it('never sweeps this node\u2019s OWN row (self does not heartbeat to itself)', () => {
    const { coordinator, onMemberConfirmedOffline } = makeHostTrackingBob()
    // Self row, as ensureSelfNode records it (host at hosting, joiner at grant).
    federationStore.upsertNode({
      nodeId: HOST,
      officeId: OFFICE,
      identity: 'identity-host',
      displayName: 'Host',
      joinedAt: clock,
      lastSeen: clock,
      status: 'online',
    })
    const observer = recordingPeer(hub, OBSERVER)

    for (let i = 0; i < 10; i++) {
      clock += CONFIRMED_MS
      bobHeartbeat()
      coordinator.sweepPresence()
    }

    // The self row never degrades — a phantom self-offline poisons the
    // confirmedNodes guard (a later REAL offline of a peer is then ignored) and,
    // on a joiner, broadcasts a false projection up to the host.
    expect(federationStore.getNode(OFFICE, HOST)!.status).toBe('online')
    expect(onMemberConfirmedOffline).not.toHaveBeenCalled()
    expect(observer.statuses()).toEqual([])
  })

  it('O-P3-2: silence into suspect then a heartbeat → online; never fans out', () => {
    const { coordinator, onMemberConfirmedOffline } = makeHostTrackingBob()
    const observer = recordingPeer(hub, OBSERVER)

    clock += SUSPECT_MS + 1
    coordinator.sweepPresence()
    expect(federationStore.getNode(OFFICE, BOB)!.status).toBe('suspect')

    clock += 1
    bobHeartbeat()
    expect(federationStore.getNode(OFFICE, BOB)!.status).toBe('online')

    expect(onMemberConfirmedOffline).not.toHaveBeenCalled()
    expect(observer.statuses()).toEqual(['suspect', 'online'])
  })

  it('O-P3-1: while suspect, onMemberConfirmedOffline is never called', () => {
    const { coordinator, onMemberConfirmedOffline } = makeHostTrackingBob()

    clock += SUSPECT_MS + 1
    coordinator.sweepPresence()
    clock += 1
    coordinator.sweepPresence()
    clock += 1
    coordinator.sweepPresence()

    expect(federationStore.getNode(OFFICE, BOB)!.status).toBe('suspect')
    expect(onMemberConfirmedOffline).toHaveBeenCalledTimes(0)
  })

  it('O-P3-3: confirmed fans out once per bound member; further ticks do not re-fire', () => {
    const { coordinator, onMemberConfirmedOffline, memberAppIds } = makeHostTrackingBob(2)
    const observer = recordingPeer(hub, OBSERVER)

    clock += SUSPECT_MS + 1
    coordinator.sweepPresence()
    expect(federationStore.getNode(OFFICE, BOB)!.status).toBe('suspect')

    clock += CONFIRMED_MS - SUSPECT_MS
    coordinator.sweepPresence()
    expect(federationStore.getNode(OFFICE, BOB)!.status).toBe('offline')
    expect(onMemberConfirmedOffline).toHaveBeenCalledTimes(2)
    expect(onMemberConfirmedOffline.mock.calls.map((c) => c[0]).sort()).toEqual(
      [...memberAppIds].sort()
    )

    const offline = observer.presence.filter((p) => p.status === 'offline')
    expect(offline).toHaveLength(1)
    expect(offline[0].members).toEqual(['identity-bob'])

    clock += CONFIRMED_MS
    coordinator.sweepPresence()
    coordinator.sweepPresence()
    expect(onMemberConfirmedOffline).toHaveBeenCalledTimes(2)
    expect(observer.presence.filter((p) => p.status === 'offline')).toHaveLength(1)
  })

  it('never jumps online→offline directly: a long silence still passes through suspect', () => {
    const { coordinator } = makeHostTrackingBob()
    const observer = recordingPeer(hub, OBSERVER)

    // Single sweep after silence well past confirmed: must emit suspect BEFORE offline.
    clock += CONFIRMED_MS + 50
    coordinator.sweepPresence()

    expect(federationStore.getNode(OFFICE, BOB)!.status).toBe('offline')
    const seq = observer.statuses()
    const suspectIdx = seq.indexOf('suspect')
    const offlineIdx = seq.indexOf('offline')
    expect(suspectIdx).toBeGreaterThanOrEqual(0)
    expect(offlineIdx).toBeGreaterThan(suspectIdx)
  })

  it('recovery=1: a single heartbeat in suspect recovers to online', () => {
    const { coordinator } = makeHostTrackingBob()

    clock += SUSPECT_MS + 1
    coordinator.sweepPresence()
    expect(federationStore.getNode(OFFICE, BOB)!.status).toBe('suspect')

    clock += 1
    bobHeartbeat()
    expect(federationStore.getNode(OFFICE, BOB)!.status).toBe('online')
  })

  it('T7: a bare heartbeat after confirmed does NOT revive; a rejoin does', () => {
    const { coordinator, onMemberConfirmedOffline } = makeHostTrackingBob()

    clock += CONFIRMED_MS + 1
    coordinator.sweepPresence()
    expect(federationStore.getNode(OFFICE, BOB)!.status).toBe('offline')
    expect(onMemberConfirmedOffline).toHaveBeenCalledTimes(1)

    // Bare heartbeat: dropped, still offline.
    clock += 10
    bobHeartbeat()
    expect(federationStore.getNode(OFFICE, BOB)!.status).toBe('offline')

    // Rejoin handshake re-admits online and re-arms the FSM (a later confirmed
    // can fire again).
    clock += 10
    const join: JoinRequest = {
      kind: 'join-request',
      officeId: OFFICE,
      fromNode: BOB,
      identityId: 'identity-bob',
      displayName: 'Bob',
      credentialToken: 'valid-token',
      bringMembers: [],
    }
    hub.deliver(BOB, HOST, join as FederationMessage)
    expect(federationStore.getNode(OFFICE, BOB)!.status).toBe('online')

    // Re-armed: a fresh silence confirms again (fan-out fires a second time).
    clock += CONFIRMED_MS + 1
    coordinator.sweepPresence()
    expect(federationStore.getNode(OFFICE, BOB)!.status).toBe('offline')
    expect(onMemberConfirmedOffline).toHaveBeenCalledTimes(2)
  })

  it('a join-grant clears this node\u2019s confirmed-offline latch (joiner-side reset after a transport blip)', () => {
    const { coordinator } = makeHostTrackingBob()

    // A transport blip: BOB (the peer this node tracks — the HOST, from a
    // joiner's perspective) goes silent past the confirmed threshold.
    clock += CONFIRMED_MS + 1
    coordinator.sweepPresence()
    expect(federationStore.getNode(OFFICE, BOB)!.status).toBe('offline')

    // Latched: a bare heartbeat must NOT revive (no-silent-revive invariant).
    clock += 10
    bobHeartbeat()
    expect(federationStore.getNode(OFFICE, BOB)!.status).toBe('offline')

    // The connection recovered and OUR fresh join was granted: the grant is a
    // fresh handshake — verdicts reset, rows re-baseline online.
    hub.deliver(BOB, HOST, {
      kind: 'join-grant',
      officeId: OFFICE,
      assignedNodeId: HOST,
    } as FederationMessage)
    expect(federationStore.getNode(OFFICE, BOB)!.status).toBe('online')

    // Heartbeats now keep it online through subsequent sweeps (latch is gone).
    clock += CONFIRMED_MS - 1
    bobHeartbeat()
    coordinator.sweepPresence()
    expect(federationStore.getNode(OFFICE, BOB)!.status).toBe('online')
  })

  it('notifyResume re-baselines silence so a wake does not confirm healthy peers offline', () => {
    const { coordinator, onMemberConfirmedOffline } = makeHostTrackingBob()

    // Simulate a sleep: the clock jumps far past the confirmed threshold with no
    // heartbeats (a laptop lid closed). The very next sweep would mass-confirm.
    clock += CONFIRMED_MS * 5

    // The OS resume event fires FIRST (bootstrap wires powerMonitor → this).
    coordinator.notifyResume()

    // The post-resume sweep must NOT confirm BOB offline: the grace re-baselined
    // its silence to "now".
    coordinator.sweepPresence()
    expect(federationStore.getNode(OFFICE, BOB)!.status).toBe('online')
    expect(onMemberConfirmedOffline).not.toHaveBeenCalled()

    // A genuinely departed peer still confirms on a later normal silence.
    clock += CONFIRMED_MS + 1
    coordinator.sweepPresence()
    expect(federationStore.getNode(OFFICE, BOB)!.status).toBe('offline')
    expect(onMemberConfirmedOffline).toHaveBeenCalledTimes(1)
  })

  it('a JOINER that latched its host on a LIVE socket re-drives its own join (field deadlock: 3-node relay)', () => {
    const { coordinator } = makeHostTrackingBob()
    // This coordinator is a JOINER of BOB's office: it joined via requestJoin,
    // which remembers the join-request for exactly this recovery.
    const bobInbox: FederationMessage[] = []
    const bobLink = new InMemoryFederationLink(BOB, hub)
    bobLink.onMessage((_from, msg) => bobInbox.push(msg))
    const join: JoinRequest = {
      kind: 'join-request',
      officeId: OFFICE,
      fromNode: HOST,
      identityId: 'identity-host',
      credentialToken: 'valid-token',
      bringMembers: [],
    }
    coordinator.requestJoin(join)
    bobInbox.length = 0

    // The relay stalls ≥ confirmed threshold with the socket ALIVE: the joiner
    // latches its host offline. No socket drop → no reconnect-reauth rejoin.
    clock += CONFIRMED_MS + 1
    coordinator.sweepPresence()
    expect(federationStore.getNode(OFFICE, BOB)!.status).toBe('offline')

    // Host heartbeats resume on the live session. The joiner must NOT nudge the
    // HOST to "rejoin" (meaningless) — it must re-drive its OWN join-request.
    clock += 10
    bobHeartbeat()
    const resent = bobInbox.filter((m) => m.kind === 'join-request')
    expect(resent).toHaveLength(1)
    expect(resent[0]).toMatchObject({ fromNode: HOST, officeId: OFFICE })
    expect(bobInbox.some((m) => m.kind === 'rejoin-request')).toBe(false)

    // The host re-grants; the grant clears the latch and the office recovers.
    hub.deliver(BOB, HOST, {
      kind: 'join-grant',
      officeId: OFFICE,
      assignedNodeId: HOST,
    } as FederationMessage)
    expect(federationStore.getNode(OFFICE, BOB)!.status).toBe('online')
  })

  it('a heartbeat revives an UNLATCHED offline row (latch, not row status, enforces no-silent-revive)', () => {
    const { coordinator } = makeHostTrackingBob()

    clock += CONFIRMED_MS + 1
    coordinator.sweepPresence()
    expect(federationStore.getNode(OFFICE, BOB)!.status).toBe('offline')

    // Grant clears the latch; then simulate a row that is still offline (e.g.
    // recorded after the grant reset) receiving a live heartbeat.
    hub.deliver(BOB, HOST, {
      kind: 'join-grant',
      officeId: OFFICE,
      assignedNodeId: HOST,
    } as FederationMessage)
    federationStore.setNodeStatus(OFFICE, BOB, 'offline', clock)

    clock += 10
    bobHeartbeat()
    expect(federationStore.getNode(OFFICE, BOB)!.status).toBe('online')
  })
})
