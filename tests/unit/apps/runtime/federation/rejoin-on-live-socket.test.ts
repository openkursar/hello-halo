/**
 * Unit tests for apps/runtime/federation -- confirmed-offline recovery on a LIVE
 * socket (the permanent-stuck deadlock).
 *
 * When a node is confirmed-offline but its WS session never dropped (heartbeats
 * keep arriving), the joiner's reconnect-reauth path — which would re-drive the
 * join — never fires, so the node deadlocks: heartbeats arrive, are dropped (T7),
 * and it never re-joins. The fix: on a heartbeat from a confirmed-offline node,
 * the host sends a `rejoin-request` control frame (rate-limited); the joiner
 * answers by re-sending its join-request, which re-admits it online and re-arms
 * the FSM — preserving T7 (a fresh handshake, not a silent revive).
 *
 * A fake clock + small thresholds drive the host FSM; an in-memory hub wires the
 * host and Bob coordinators so the rejoin-request → join-request round-trip runs
 * end-to-end.
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
import {
  InMemoryFederationHub,
  InMemoryFederationLink,
} from '../../../../../src/main/apps/runtime/federation/link'
import { LanMeshLink } from '../../../../../src/main/apps/runtime/federation/lan-mesh-provider'
import type {
  FederationMessage,
  JoinRequest,
} from '../../../../../src/main/apps/runtime/federation'

const OFFICE = 'office-1'
const HOST = 'node-host'
const BOB = 'node-bob'
const SUSPECT_MS = 100
const CONFIRMED_MS = 200

describe('confirmed-offline recovery on a live socket (Bug 1b)', () => {
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

  afterEach(() => dbManager.closeAll())

  function makeHost() {
    federationStore.upsertNode({
      nodeId: BOB,
      officeId: OFFICE,
      identity: 'identity-bob',
      displayName: 'Bob',
      joinedAt: clock,
      lastSeen: clock,
      status: 'online',
    })
    const hostLink = new InMemoryFederationLink(HOST, hub)
    const coordinator = createFederationCoordinator({
      context: { officeId: OFFICE, selfNodeId: HOST },
      link: hostLink,
      federationStore,
      teamStore,
      verifyCredential: (token) => (token === 'valid-token' ? { officeId: OFFICE } : null),
      now,
      presence: { suspectAfterMs: SUSPECT_MS, confirmedOfflineMs: CONFIRMED_MS },
    })
    coordinator.start()
    return coordinator
  }

  /** A Bob-side link that records frames the host sends to Bob. */
  function makeBobRecorder() {
    const received: FederationMessage[] = []
    const bobLink = new InMemoryFederationLink(BOB, hub)
    bobLink.onMessage((_from, msg) => received.push(msg))
    return { received }
  }

  function bobHeartbeat() {
    hub.deliver(BOB, HOST, { kind: 'heartbeat', officeId: OFFICE, fromNode: BOB, ts: clock })
  }

  function confirmBobOffline(coordinator: ReturnType<typeof makeHost>) {
    clock += CONFIRMED_MS + 1
    coordinator.sweepPresence()
    expect(federationStore.getNode(BOB)!.status).toBe('offline')
  }

  it('a heartbeat from a confirmed-offline node triggers a host rejoin-request', () => {
    const coordinator = makeHost()
    const bob = makeBobRecorder()
    confirmBobOffline(coordinator)

    // Bob is still connected (its heartbeat reaches the host). The host must nudge
    // it to re-handshake instead of silently dropping forever.
    clock += 10
    bobHeartbeat()

    const nudges = bob.received.filter((m) => m.kind === 'rejoin-request')
    expect(nudges).toHaveLength(1)
    expect(federationStore.getNode(BOB)!.status).toBe('offline')
  })

  it('rate-limits the rejoin-request: not one per heartbeat', () => {
    const coordinator = makeHost()
    const bob = makeBobRecorder()
    confirmBobOffline(coordinator)

    for (let i = 0; i < 5; i++) {
      clock += 10
      bobHeartbeat()
    }
    expect(bob.received.filter((m) => m.kind === 'rejoin-request')).toHaveLength(1)

    clock += Math.max(SUSPECT_MS, 5000) + 1
    bobHeartbeat()
    expect(bob.received.filter((m) => m.kind === 'rejoin-request')).toHaveLength(2)
  })

  it('end-to-end: rejoin-request drives a real re-join that re-admits the node online', () => {
    const hostCoordinator = makeHost()

    // Bob's joiner leg: like the production WsFederationClient-backed LanMeshLink,
    // every outbound frame is routed to the HOST (the `to` label is ignored — a
    // joiner has a single host peer). Inbound host→Bob frames are delivered to the
    // coordinator via deliver().
    const bobLink = new LanMeshLink((_to, frame) => hub.deliver(BOB, HOST, frame))
    const bobInbound = new InMemoryFederationLink(BOB, hub)
    bobInbound.onMessage((from, msg) => bobLink.deliver(from, msg))

    const bobCoordinator = createFederationCoordinator({
      context: { officeId: OFFICE, selfNodeId: BOB },
      link: bobLink,
      federationStore,
      teamStore,
      verifyCredential: () => null, // Bob is a joiner; it never admits anyone
      now,
      presence: { suspectAfterMs: SUSPECT_MS, confirmedOfflineMs: CONFIRMED_MS },
    })
    bobCoordinator.start()

    const joinReq: JoinRequest = {
      kind: 'join-request',
      officeId: OFFICE,
      fromNode: BOB,
      identityId: 'identity-bob',
      displayName: 'Bob',
      credentialToken: 'valid-token',
      bringMembers: [],
    }
    // Initial join: requestJoin remembers the request AND routes it to the host,
    // which admits Bob online (re-arming the FSM from the seeded row).
    bobCoordinator.requestJoin(joinReq)
    expect(federationStore.getNode(BOB)!.status).toBe('online')

    confirmBobOffline(hostCoordinator)

    // The socket is alive: a heartbeat arrives → host nudges with a rejoin-request
    // → Bob's coordinator re-sends its join-request → host re-admits Bob online.
    // The deadlock is broken without any socket reconnect.
    clock += 10
    bobHeartbeat()
    expect(federationStore.getNode(BOB)!.status).toBe('online')

    bobCoordinator.stop()
  })
})
