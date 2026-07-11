/**
 * Unit tests for apps/runtime/federation -- Coordinator (join + presence).
 *
 * Drives the host-side coordinator over a real in-memory FederationStore +
 * TeamStore and an InMemoryFederationHub simulating a small LAN of nodes. The
 * fake clock drives sendHeartbeat()/sweepPresence() deterministically — no real
 * timers.
 *
 * Proven behaviors:
 *   JOIN     — valid request persists office_nodes (online, joinedAt) + remote
 *              team_members (owner_node_id, origin=remote, member_identity),
 *              grants, broadcasts presence(online), fires onPresenceChange;
 *              rejoin preserves original joinedAt.
 *   REJECT   — invalid credential / office mismatch reject with no persistence.
 *   PRESENCE — timeout sweeps to offline with member identities; heartbeat
 *              before timeout keeps online; heartbeat after offline → online.
 *   DUPLICATE members in bringMembers don't crash the handshake.
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
import type {
  FederationMessage,
  JoinRequest,
  OfficeCredentialLike,
  PresenceSnapshot,
} from '../../../../../src/main/apps/runtime/federation'
import { DEFAULT_OFFICE_SCOPE } from '../../../../../src/main/apps/federation/types'

// ── Fixtures ──

const OFFICE = 'office-1'
const HOST = 'node-host'
const BOB = 'node-bob'
const CAROL = 'node-carol'
// Two-threshold debounce (D3): suspect at 6s, confirmed-offline at 13s. Tests
// drive sweepPresence() against the fake clock, so a silence that crosses
// confirmed must first pass through suspect (no online→offline direct jump).
const SUSPECT_MS = 6_000
const CONFIRMED_MS = 13_000

function makeJoinRequest(overrides?: Partial<JoinRequest>): JoinRequest {
  return {
    kind: 'join-request',
    officeId: OFFICE,
    fromNode: BOB,
    identityId: 'identity-bob',
    displayName: 'Bob',
    credentialToken: 'valid-token',
    bringMembers: [{ appId: 'app-bob-1', memberName: 'bob-writer', role: 'Writer' }],
    ...overrides,
  }
}

/** Captures frames a peer node receives off the hub. */
function recordingPeer(hub: InMemoryFederationHub, nodeId: string) {
  const link = new InMemoryFederationLink(nodeId, hub)
  const received: Array<{ from: string; msg: FederationMessage }> = []
  link.onMessage((from, msg) => received.push({ from, msg }))
  return { link, received }
}

describe('FederationCoordinator', () => {
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

  function makeHost(opts?: {
    verify?: (token: string) => OfficeCredentialLike | null
    onPresenceChange?: (snap: PresenceSnapshot) => void
  }) {
    const hostLink = new InMemoryFederationLink(HOST, hub)
    const coordinator = createFederationCoordinator({
      context: { officeId: OFFICE, selfNodeId: HOST },
      link: hostLink,
      federationStore,
      teamStore,
      verifyCredential:
        opts?.verify ??
        ((token) => (token === 'valid-token' ? { officeId: OFFICE, scope: DEFAULT_OFFICE_SCOPE } : null)),
      now,
      presence: { suspectAfterMs: SUSPECT_MS, confirmedOfflineMs: CONFIRMED_MS },
      onPresenceChange: opts?.onPresenceChange,
    })
    coordinator.start()
    return { coordinator, hostLink }
  }

  // ── JOIN (host admits) ──

  describe('join handshake', () => {
    it('admits a valid join-request: persists node + remote members, grants, broadcasts presence', () => {
      const onPresenceChange = vi.fn()
      makeHost({ onPresenceChange })
      const bob = recordingPeer(hub, BOB)

      bob.link.send(HOST, makeJoinRequest())

      const node = federationStore.getNode(OFFICE, BOB)!
      expect(node).toBeTruthy()
      expect(node.status).toBe('online')
      expect(node.identity).toBe('identity-bob')
      expect(node.displayName).toBe('Bob')
      expect(node.joinedAt).toBe(clock)
      expect(node.officeId).toBe(OFFICE)

      const members = teamStore.listMembersByTeam(OFFICE)
      expect(members).toHaveLength(1)
      expect(members[0]).toMatchObject({
        appId: 'app-bob-1',
        memberName: 'bob-writer',
        role: 'Writer',
        ownerNodeId: BOB,
        origin: 'remote',
        memberIdentity: 'identity-bob',
        isLead: false,
        aiProvisioned: false,
      })

      const grant = bob.received.find((r) => r.msg.kind === 'join-grant')
      expect(grant?.msg).toMatchObject({ kind: 'join-grant', officeId: OFFICE, assignedNodeId: BOB })

      const carol = recordingPeer(hub, CAROL) // joined after broadcast: no echo expected
      expect(carol.received).toHaveLength(0)
      expect(onPresenceChange).toHaveBeenCalledTimes(1)
      const snap = onPresenceChange.mock.calls[0][0] as PresenceSnapshot
      expect(snap.nodes.map((n) => n.nodeId)).toContain(BOB)
    })

    it('broadcasts presence(online) to an already-present peer', () => {
      makeHost()
      const carol = recordingPeer(hub, CAROL)
      const bob = recordingPeer(hub, BOB)

      bob.link.send(HOST, makeJoinRequest())

      const presence = carol.received.find((r) => r.msg.kind === 'presence-update')
      expect(presence?.msg).toMatchObject({
        kind: 'presence-update',
        nodeId: BOB,
        status: 'online',
        members: ['identity-bob'],
      })
    })

    it('preserves original joinedAt on rejoin', () => {
      makeHost()
      const bob = recordingPeer(hub, BOB)

      bob.link.send(HOST, makeJoinRequest())
      const firstJoinedAt = federationStore.getNode(OFFICE, BOB)!.joinedAt

      clock += 50_000
      bob.link.send(HOST, makeJoinRequest({ displayName: 'Bob Renamed' }))

      const node = federationStore.getNode(OFFICE, BOB)!
      expect(node.joinedAt).toBe(firstJoinedAt) // stable join order
      expect(node.lastSeen).toBe(clock) // refreshed
      expect(node.displayName).toBe('Bob Renamed') // refreshed
    })

    it('rejects an invalid credential with no persistence', () => {
      makeHost()
      const bob = recordingPeer(hub, BOB)

      bob.link.send(HOST, makeJoinRequest({ credentialToken: 'forged' }))

      const reject = bob.received.find((r) => r.msg.kind === 'join-reject')
      expect(reject?.msg).toMatchObject({ kind: 'join-reject', reason: 'CREDENTIAL_INVALID' })
      expect(federationStore.getNode(OFFICE, BOB)).toBeNull()
      expect(teamStore.listMembersByTeam(OFFICE)).toHaveLength(0)
    })

    it('rejects an office mismatch (credential office differs)', () => {
      makeHost({ verify: () => ({ officeId: 'other-office', scope: DEFAULT_OFFICE_SCOPE }) })
      const bob = recordingPeer(hub, BOB)

      bob.link.send(HOST, makeJoinRequest())

      const reject = bob.received.find((r) => r.msg.kind === 'join-reject')
      expect(reject?.msg).toMatchObject({ kind: 'join-reject', reason: 'OFFICE_MISMATCH' })
      expect(federationStore.getNode(OFFICE, BOB)).toBeNull()
    })

    it('rejects an office mismatch (request office differs from context)', () => {
      makeHost()
      const bob = recordingPeer(hub, BOB)

      bob.link.send(HOST, makeJoinRequest({ officeId: 'wrong-office' }))

      const reject = bob.received.find((r) => r.msg.kind === 'join-reject')
      expect(reject?.msg).toMatchObject({ kind: 'join-reject', reason: 'OFFICE_MISMATCH' })
      expect(federationStore.getNode(OFFICE, BOB)).toBeNull()
    })

    it('does not crash the handshake on duplicate bringMembers; a name clash is admitted renamed', () => {
      makeHost()
      const bob = recordingPeer(hub, BOB)

      bob.link.send(
        HOST,
        makeJoinRequest({
          bringMembers: [
            { appId: 'app-dup', memberName: 'same-name', role: 'A' },
            { appId: 'app-dup', memberName: 'other-name', role: 'B' }, // repeated appId → duplicate, skipped
            { appId: 'app-other', memberName: 'same-name', role: 'C' }, // name clash → renamed, admitted
          ],
        })
      )

      expect(federationStore.getNode(OFFICE, BOB)!.status).toBe('online')
      expect(bob.received.some((r) => r.msg.kind === 'join-grant')).toBe(true)
      // The repeated appId collapsed to one row; the name clash was admitted
      // under a disambiguated name (owner display name) instead of being dropped.
      const members = teamStore.listMembersByTeam(OFFICE)
      expect(members).toHaveLength(2)
      const byApp = new Map(members.map((m) => [m.appId, m]))
      expect(byApp.get('app-dup')!.memberName).toBe('same-name')
      expect(byApp.get('app-other')!.memberName).toBe('same-name·Bob')
    })
  })

  // ── PRESENCE ──

  describe('presence sweep + heartbeat (two-threshold debounce)', () => {
    function joinBob() {
      const bob = recordingPeer(hub, BOB)
      bob.link.send(HOST, makeJoinRequest())
      return bob
    }

    it('moves a node online→suspect→confirmed-offline as silence crosses each threshold', () => {
      const onPresenceChange = vi.fn()
      const { coordinator } = makeHost({ onPresenceChange })
      const carol = recordingPeer(hub, CAROL)
      joinBob()
      onPresenceChange.mockClear()
      carol.received.length = 0

      clock += SUSPECT_MS + 1
      coordinator.sweepPresence()
      expect(federationStore.getNode(OFFICE, BOB)!.status).toBe('suspect')
      expect(carol.received.some((r) => r.msg.kind === 'presence-update' && r.msg.status === 'suspect')).toBe(true)
      expect(carol.received.some((r) => r.msg.kind === 'presence-update' && r.msg.status === 'offline')).toBe(false)
      carol.received.length = 0

      clock += CONFIRMED_MS - SUSPECT_MS
      coordinator.sweepPresence()
      expect(federationStore.getNode(OFFICE, BOB)!.status).toBe('offline')
      const offline = carol.received.find(
        (r) => r.msg.kind === 'presence-update' && r.msg.status === 'offline'
      )
      expect(offline?.msg).toMatchObject({ nodeId: BOB, status: 'offline' })
      expect((offline?.msg as { members: string[] }).members).toEqual(['identity-bob'])
      expect(onPresenceChange).toHaveBeenCalled()
    })

    it('keeps a node online when a heartbeat arrives before the suspect threshold', () => {
      const { coordinator } = makeHost()
      joinBob()

      clock += SUSPECT_MS - 1
      hub.deliver(BOB, HOST, { kind: 'heartbeat', officeId: OFFICE, fromNode: BOB, ts: clock })

      // A sweep now sits within one suspect window of the refreshed lastSeen.
      clock += 2
      coordinator.sweepPresence()

      expect(federationStore.getNode(OFFICE, BOB)!.status).toBe('online')
    })

    it('recovers suspect→online on a heartbeat (jitter absorbed, no offline)', () => {
      const { coordinator } = makeHost()
      const carol = recordingPeer(hub, CAROL)
      joinBob()

      clock += SUSPECT_MS + 1
      coordinator.sweepPresence()
      expect(federationStore.getNode(OFFICE, BOB)!.status).toBe('suspect')
      carol.received.length = 0

      clock += 1
      hub.deliver(BOB, HOST, { kind: 'heartbeat', officeId: OFFICE, fromNode: BOB, ts: clock })
      expect(federationStore.getNode(OFFICE, BOB)!.status).toBe('online')
      const back = carol.received.find(
        (r) => r.msg.kind === 'presence-update' && r.msg.status === 'online'
      )
      expect(back?.msg).toMatchObject({ nodeId: BOB, status: 'online' })

      clock += SUSPECT_MS - 1
      coordinator.sweepPresence()
      expect(federationStore.getNode(OFFICE, BOB)!.status).toBe('online')
    })

    it('does NOT revive a confirmed-offline node on a bare heartbeat (requires rejoin, T7)', () => {
      const { coordinator } = makeHost()
      joinBob()

      clock += CONFIRMED_MS + 1
      coordinator.sweepPresence()
      expect(federationStore.getNode(OFFICE, BOB)!.status).toBe('offline')

      // A bare heartbeat after confirmed is dropped — no silent revival.
      clock += 1000
      hub.deliver(BOB, HOST, { kind: 'heartbeat', officeId: OFFICE, fromNode: BOB, ts: clock })
      expect(federationStore.getNode(OFFICE, BOB)!.status).toBe('offline')

      // A fresh join handshake re-admits the node as online (T5).
      const bob = recordingPeer(hub, BOB)
      bob.link.send(HOST, makeJoinRequest())
      expect(federationStore.getNode(OFFICE, BOB)!.status).toBe('online')
    })

    it('ignores heartbeats from an unknown node', () => {
      const { coordinator } = makeHost()
      hub.deliver('ghost', HOST, { kind: 'heartbeat', officeId: OFFICE, fromNode: 'ghost', ts: clock })
      expect(federationStore.getNode(OFFICE, 'ghost')).toBeNull()
      coordinator.sweepPresence() // must not throw
    })
  })

  // ── Snapshot ──

  describe('getPresence', () => {
    it('reflects current node statuses', () => {
      const { coordinator } = makeHost()
      const bob = recordingPeer(hub, BOB)
      bob.link.send(HOST, makeJoinRequest())
      const carol = recordingPeer(hub, CAROL)
      carol.link.send(
        HOST,
        makeJoinRequest({ fromNode: CAROL, identityId: 'identity-carol', bringMembers: [] })
      )

      let snap = coordinator.getPresence()
      expect(snap.officeId).toBe(OFFICE)
      expect(snap.nodes.map((n) => n.nodeId).sort()).toEqual([CAROL, BOB].sort())
      expect(snap.nodes.every((n) => n.status === 'online')).toBe(true)

      clock += CONFIRMED_MS + 1
      // Carol heartbeats; Bob goes stale past the confirmed threshold.
      hub.deliver(CAROL, HOST, { kind: 'heartbeat', officeId: OFFICE, fromNode: CAROL, ts: clock })
      coordinator.sweepPresence()

      snap = coordinator.getPresence()
      const byId = Object.fromEntries(snap.nodes.map((n) => [n.nodeId, n.status]))
      expect(byId[BOB]).toBe('offline')
      expect(byId[CAROL]).toBe('online')
    })
  })
})
