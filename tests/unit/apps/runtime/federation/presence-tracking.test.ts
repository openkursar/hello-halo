/**
 * Presence-tracking split (the highest-risk precondition of the resilience
 * plan): "I know this node's address" (a persisted office_nodes row) and "I
 * measure its silence" (a direct transport) are now two separate facts.
 *
 *  - An UNTRACKED row (a joiner's persisted PEER card) is never silence-swept:
 *    no matter how long no frames flow, the peer is not false-confirmed.
 *  - Untracked rows adopt the authority's presence-update projection INTO the
 *    ledger (the election candidate view reads row status), fire the member
 *    unblock exactly once per offline, and re-arm on a projected online.
 *  - Tracked rows keep the FSM behaviour byte-for-byte (silence → suspect →
 *    confirmed-offline).
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
import type { FederationCoordinator } from '../../../../../src/main/apps/runtime/federation/coordinator'
import type { FederationMessage, NodeId } from '../../../../../src/main/apps/runtime/federation/types'

const OFFICE = 'office-tracking'
const SELF = 'node-self'
const AUTHORITY = 'node-authority' // the tracked upstream
const PEER = 'node-peer' // persisted card, no transport
const PEER_MEMBER = 'app-peer-member'

const SUSPECT_MS = 6000
const CONFIRMED_MS = 13_000

describe('presence tracking split (address knowledge ≠ direct transport)', () => {
  let dbm: DatabaseManager
  let fed: FederationStore
  let team: TeamStore
  let coordinator: FederationCoordinator
  let deliver: (from: NodeId, msg: FederationMessage) => void
  let confirmedMembers: ReturnType<typeof vi.fn>
  let clock: number

  beforeEach(() => {
    dbm = createDatabaseManager(':memory:')
    const db = dbm.getAppDatabase()
    dbm.runMigrations(db, FED_NS, fedMigrations)
    dbm.runMigrations(db, TEAM_NS, teamMigrations)
    fed = new FederationStore(db)
    team = new TeamStore(db)
    clock = 1_000_000

    for (const [nodeId, joinedAt] of [
      [AUTHORITY, 1],
      [SELF, 2],
      [PEER, 3],
    ] as Array<[string, number]>) {
      fed.upsertNode({
        nodeId,
        officeId: OFFICE,
        identity: nodeId,
        displayName: nodeId,
        joinedAt,
        lastSeen: clock,
        status: 'online',
        advertisedUrl: `mem://${nodeId}`,
      })
    }
    const now = Date.now()
    team.insertTeam({
      id: OFFICE,
      name: 't',
      owningSpaceId: 's',
      goal: 'g',
      leadAppId: null,
      memberSourcing: 'manual',
      collabMode: 'free',
      escalationRouting: 'user',
      status: 'idle',
      currentEpochId: null,
      createdAt: now,
      updatedAt: now,
      hostNodeId: AUTHORITY,
    })
    team.addMember({
      teamId: OFFICE,
      appId: PEER_MEMBER,
      memberName: 'peer-member',
      role: 'Writer',
      isLead: false,
      aiProvisioned: false,
      addedAt: now,
      ownerNodeId: PEER,
      origin: 'remote',
      memberIdentity: PEER,
    })

    confirmedMembers = vi.fn()
    coordinator = createFederationCoordinator({
      context: { officeId: OFFICE, selfNodeId: SELF },
      link: {
        send: () => {},
        broadcast: () => {},
        onMessage: (handler) => {
          deliver = handler
        },
        close: () => {},
      },
      federationStore: fed,
      teamStore: team,
      verifyCredential: () => null,
      now: () => clock,
      monotonicNow: () => clock,
      presence: { suspectAfterMs: SUSPECT_MS, confirmedOfflineMs: CONFIRMED_MS },
      isPresenceTracked: (nodeId) => nodeId === AUTHORITY,
      listMembersForNode: (nodeId) =>
        team
          .listMembersByTeam(OFFICE)
          .filter((m) => m.ownerNodeId === nodeId)
          .map((m) => ({ appId: m.appId, memberIdentity: m.memberIdentity ?? null })),
      onMemberConfirmedOffline: confirmedMembers,
    })
    coordinator.start()
  })

  afterEach(() => {
    coordinator.stop()
    dbm.closeAll()
  })

  it('never silence-sweeps an untracked peer row; the tracked authority still confirms', () => {
    clock += CONFIRMED_MS + 1000
    coordinator.sweepPresence()

    // The tracked upstream starved into confirmed-offline…
    expect(fed.getNode(OFFICE, AUTHORITY)?.status).toBe('offline')
    // …while the peer card — equally silent, but with no transport to measure
    // — stays exactly as the authority last projected it.
    expect(fed.getNode(OFFICE, PEER)?.status).toBe('online')
  })

  it('adopts the authority projection into an untracked row, unblocks once, and re-arms on online', () => {
    deliver(AUTHORITY, {
      kind: 'presence-update',
      officeId: OFFICE,
      nodeId: PEER,
      status: 'offline',
      members: [PEER],
      since: clock,
    })
    // The ledger row (election candidate view) follows the projection, and the
    // member unblock fires for the peer-owned member.
    expect(fed.getNode(OFFICE, PEER)?.status).toBe('offline')
    expect(confirmedMembers).toHaveBeenCalledTimes(1)
    expect(confirmedMembers).toHaveBeenCalledWith(PEER_MEMBER)

    // A repeated offline projection does not double-fire.
    deliver(AUTHORITY, {
      kind: 'presence-update',
      officeId: OFFICE,
      nodeId: PEER,
      status: 'offline',
      members: [PEER],
      since: clock,
    })
    expect(confirmedMembers).toHaveBeenCalledTimes(1)

    // The authority's ONLINE projection is the rejoin signal for a
    // projection-owned row: status recovers and the latch re-arms…
    deliver(AUTHORITY, {
      kind: 'presence-update',
      officeId: OFFICE,
      nodeId: PEER,
      status: 'online',
      members: [PEER],
      since: clock,
    })
    expect(fed.getNode(OFFICE, PEER)?.status).toBe('online')

    // …so the NEXT offline projection unblocks again.
    deliver(AUTHORITY, {
      kind: 'presence-update',
      officeId: OFFICE,
      nodeId: PEER,
      status: 'offline',
      members: [PEER],
      since: clock,
    })
    expect(confirmedMembers).toHaveBeenCalledTimes(2)
  })

  it('a tracked row is FSM-owned: a remote projection does not overwrite its status', () => {
    deliver(AUTHORITY, {
      kind: 'presence-update',
      officeId: OFFICE,
      nodeId: AUTHORITY,
      status: 'offline',
      members: [],
      since: clock,
    })
    // Self-reported/projected status for a tracked node is observational only;
    // the local silence measurement owns the row.
    expect(fed.getNode(OFFICE, AUTHORITY)?.status).toBe('online')
  })
})
