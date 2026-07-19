/**
 * Flagship P2P-resilience regression at the manager tier: a 3-node office
 * loses its HOST/AUTHORITY and the two survivors self-heal end-to-end through
 * the REAL production path —
 *
 *   presence FSM confirms the authority offline (real silence, real clock)
 *   → the manager opens direct ELECTION LEGS to the survivors (peer dial)
 *   → the untouched election module runs over those legs (claim/confirm)
 *   → the front survivor wins, ANNOUNCES the new term, re-forms the star
 *   → the loser redials + re-enrolls with the new authority
 *   → a survivor→survivor wake round-trips over the re-formed transport.
 *
 * Both survivors are REAL FederationManagers with REAL coordinators and
 * authority modules. The only fake is the wire: a peer "dial" delivers into
 * the target's handleHostInbound (exactly how a dialed WS session lands on a
 * peer's server in production), and the host-side return path (hostSend)
 * delivers into the dialing peer's deliverInbound (the dialed client's
 * onFrame), attributed to the sender. The dead authority never exists — its
 * seeded ledger row starves into confirmed-offline like a crashed machine's.
 *
 * Pre-fix behaviour, for contrast: the election triggered but claims rode the
 * single upstream leg to the DEAD host, quorum never formed, and the office
 * paused forever (SCENARIOS.md C6 Option-B). This suite is that scenario
 * upgraded to self-healing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabaseManager } from '../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../src/main/platform/store/types'
import {
  initFederationStore,
  shutdownFederationStore,
} from '../../../../../src/main/apps/federation'
import { FederationStore } from '../../../../../src/main/apps/federation/store'
import { AuthorityStore } from '../../../../../src/main/apps/federation/authority-store'
import {
  MIGRATION_NAMESPACE as FED_NS,
  migrations as fedMigrations,
} from '../../../../../src/main/apps/federation/migrations'
import { TeamStore } from '../../../../../src/main/apps/team/store'
import {
  MIGRATION_NAMESPACE as TEAM_NS,
  migrations as teamMigrations,
} from '../../../../../src/main/apps/team/migrations'
import {
  createFederationManager,
  type FederationManager,
} from '../../../../../src/main/apps/runtime/federation/manager'
import type { FederationMessage, SerializedWakeRequest } from '../../../../../src/main/apps/runtime/federation/types'
import { DEFAULT_OFFICE_SCOPE } from '../../../../../src/main/apps/federation/types'

const OFFICE = 'office-survivor'
const NODE_A = 'node-a-dead-host' // the office creator; crashes before the test acts
const NODE_B = 'node-b-survivor' // earliest surviving joiner → expected winner
const NODE_C = 'node-c-survivor'
const MEMBER_B = 'app-owned-by-b'
const MEMBER_C = 'app-owned-by-c'
const TOKEN = 'valid-token'

/** Real-async poll (presence/election run on real clocks in this suite). */
async function waitFor(predicate: () => boolean, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 50))
  }
}

interface SurvivorNode {
  id: string
  dbm: DatabaseManager
  fed: FederationStore
  auth: AuthorityStore
  team: TeamStore
  manager: FederationManager
}

describe('survivor election over direct legs (3-node host loss self-heal)', () => {
  const nodes = new Map<string, SurvivorNode>()
  let sharedDbm: DatabaseManager

  /** clientId vocabulary of the fake wire: 'client-<nodeId>'. */
  const clientIdOf = (nodeId: string): string => `client-${nodeId}`
  const nodeOfClient = (clientId: string): string => clientId.replace(/^client-/, '')

  function buildNode(id: string, ownMember: string, peerOwners: Array<[string, string]>): SurvivorNode {
    const dbm = createDatabaseManager(':memory:')
    const db = dbm.getAppDatabase()
    dbm.runMigrations(db, FED_NS, fedMigrations)
    dbm.runMigrations(db, TEAM_NS, teamMigrations)
    const fed = new FederationStore(db)
    const auth = new AuthorityStore(db)
    const team = new TeamStore(db)
    const now = Date.now()

    // Node ledger every node holds after the roster projection landed:
    // self + the authority + PEER cards with the authoritative
    // join order and dialable addresses. The dead host's row is 'online' with
    // a fresh lastSeen — exactly the state at the instant it crashed.
    const rows: Array<[string, number]> = [
      [NODE_A, 1],
      [NODE_B, 2],
      [NODE_C, 3],
    ]
    for (const [nodeId, joinedAt] of rows) {
      fed.upsertNode({
        nodeId,
        officeId: OFFICE,
        identity: nodeId,
        displayName: nodeId,
        joinedAt,
        lastSeen: now,
        status: 'online',
        advertisedUrl: `mem://${nodeId}`,
      })
    }
    auth.patchAuthorityState(OFFICE, { term: 1, authorityNodeId: NODE_A, rosterEpoch: 1 }, now)

    // Shadow office as materialized from the dead host's roster: own member is
    // SELF-relative, peers carry absolute owner node ids.
    team.insertTeam({
      id: OFFICE,
      name: 'survivor office',
      owningSpaceId: 'space-1',
      goal: 'g',
      leadAppId: null,
      memberSourcing: 'manual',
      collabMode: 'free',
      escalationRouting: 'user',
      status: 'idle',
      currentEpochId: null,
      createdAt: now,
      updatedAt: now,
      hostNodeId: NODE_A,
    })
    team.addMember({
      teamId: OFFICE,
      appId: ownMember,
      memberName: ownMember,
      role: 'Writer',
      isLead: false,
      aiProvisioned: false,
      addedAt: now,
      ownerNodeId: 'SELF',
      origin: 'local',
    })
    for (const [appId, ownerNodeId] of peerOwners) {
      team.addMember({
        teamId: OFFICE,
        appId,
        memberName: appId,
        role: 'Writer',
        isLead: false,
        aiProvisioned: false,
        addedAt: now,
        ownerNodeId,
        origin: 'remote',
        memberIdentity: ownerNodeId,
      })
    }

    const manager = createFederationManager({
      // Host-role return path of the fake wire: a frame addressed to a learned
      // client session lands in that peer's dialed-client inbound, attributed
      // to the sender (production: the dialed client knows which node answered).
      hostSend: (clientId, frame) => {
        const peer = nodes.get(nodeOfClient(clientId))
        if (!peer) return false
        peer.manager.deliverInbound(OFFICE, frame as FederationMessage, id)
        return true
      },
      hostListOfficeClients: () => [],
      federationStore: fed,
      teamStore: team,
      authorityStore: auth,
      verifyCredential: (t) => (t === TOKEN ? { officeId: OFFICE, scope: DEFAULT_OFFICE_SCOPE } : null),
      getLocalNodeId: () => id,
      getLocalAdvertisedUrl: () => `mem://${id}`,
      // The fake wire's session identity: clientId encodes the proven node.
      getSessionIdentity: (clientId) => nodeOfClient(clientId),
      // Peer dial = production semantics: my outbound frames arrive on the
      // TARGET's WS server inbound, attributed to my proven identity.
      peerDialer: (_officeId, targetNodeId) => {
        const target = nodes.get(targetNodeId)
        if (!target) return null
        return {
          sender: (_to: string | null, frame: FederationMessage) =>
            target.manager.handleHostInbound({
              clientId: clientIdOf(id),
              officeId: OFFICE,
              frame,
            }),
        }
      },
      // Owner role: run the member this node owns when a wake lands here.
      runLocalTurn: async (req) => ({ finalMessage: `${id} ran ${req.appId}` }),
      getCurrentRunEpoch: () => null,
      getOwnerStatus: () => 'idle',
    })

    return { id, dbm, fed, auth, team, manager }
  }

  beforeEach(async () => {
    // The singleton feed store backs both managers' durable ctrl outboxes;
    // feeds are author-keyed, so two live nodes never collide in it.
    sharedDbm = createDatabaseManager(':memory:')
    initFederationStore({ db: sharedDbm })

    nodes.set(NODE_B, buildNode(NODE_B, MEMBER_B, [[MEMBER_C, NODE_C]]))
    nodes.set(NODE_C, buildNode(NODE_C, MEMBER_C, [[MEMBER_B, NODE_B]]))

    // Register both joined offices. The upstream URL points at a dead endpoint
    // (the crashed host); the join resolves failed fast, but the office stays
    // live with its join-request retained for roster re-entry — the same state
    // a survivor holds after its host vanished mid-session.
    for (const node of nodes.values()) {
      await node.manager.joinOffice({
        officeId: OFFICE,
        serverUrl: 'http://127.0.0.1:1',
        credentialToken: TOKEN,
        selfContext: { officeId: OFFICE, selfNodeId: node.id },
        bringMembers: [
          {
            appId: node.id === NODE_B ? MEMBER_B : MEMBER_C,
            memberName: node.id === NODE_B ? MEMBER_B : MEMBER_C,
            role: 'Writer',
            spaceId: `space-${node.id}`,
          },
        ],
      })
    }
  })

  afterEach(() => {
    for (const node of nodes.values()) {
      node.manager.stopAll()
      node.dbm.closeAll()
    }
    nodes.clear()
    shutdownFederationStore()
    sharedDbm.closeAll()
  })

  it(
    'confirms the dead authority, elects the front survivor over direct legs, re-forms the star, and round-trips a survivor→survivor wake',
    async () => {
      const b = nodes.get(NODE_B)!
      const c = nodes.get(NODE_C)!

      // Phase 1 — presence: the authority's silence crosses suspect (6s) then
      // confirmed-offline (13s) on both survivors' REAL FSMs. Peer rows are
      // presence-untracked, so the survivors never false-confirm each other
      // despite exchanging no direct heartbeats yet.
      await waitFor(() => b.fed.getNode(OFFICE, NODE_A)?.status === 'offline', 20_000)
      expect(b.fed.getNode(OFFICE, NODE_A)?.status).toBe('offline')
      expect(b.fed.getNode(OFFICE, NODE_C)?.status).toBe('online')

      // Phase 2 — election over the dial legs: B (earliest surviving joiner)
      // must win the next tenure with C's vote; C must converge on B.
      await waitFor(
        () => b.manager.getOfficeAuthority(OFFICE)?.isAuthoritySelf() === true,
        15_000
      )
      const bAuthority = b.manager.getOfficeAuthority(OFFICE)!
      expect(bAuthority.isAuthoritySelf()).toBe(true)
      expect(bAuthority.getTerm()).toBe(2)
      expect(bAuthority.isPaused()).toBe(false)

      await waitFor(() => c.auth.getAuthorityState(OFFICE)?.authorityNodeId === NODE_B, 10_000)
      expect(c.auth.getAuthorityState(OFFICE)).toMatchObject({ authorityNodeId: NODE_B, term: 2 })
      expect(c.manager.getOfficeAuthority(OFFICE)!.isAuthoritySelf()).toBe(false)

      // Phase 3 — star re-form: C re-enrolled with B (roster re-entry), so C's
      // shadow office now names B as its host/authority.
      await waitFor(() => c.team.getTeamById(OFFICE)?.hostNodeId === NODE_B, 10_000)
      expect(c.team.getTeamById(OFFICE)?.hostNodeId).toBe(NODE_B)

      // Phase 4 — the survivors can actually talk: C wakes B's member through
      // the re-formed transport and receives the turn's real completion.
      const outcome = await new Promise<{ kind: string; content?: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('wake round-trip timed out')), 20_000)
        c.manager.registerTurnComplete('corr-survivor-1', (o) => {
          clearTimeout(timer)
          resolve(o as never)
        })
        const sent = c.manager.sendWakeToMember({
          officeId: OFFICE,
          ownerNodeId: NODE_B,
          correlationId: 'corr-survivor-1',
          request: {
            appId: MEMBER_B,
            spaceId: 'space-b',
            message: 'still alive?',
            conversationId: `app-chat:${MEMBER_B}:team:${OFFICE}:epoch-s1`,
            teamContext: {
              teamId: OFFICE,
              epochId: 'epoch-s1',
              correlationId: 'corr-survivor-1',
              fromAppId: null,
              wait: true,
              kind: 'message',
            },
          } as unknown as SerializedWakeRequest,
        })
        expect(sent).toBe(true)
      })
      expect(outcome).toMatchObject({ kind: 'result', content: `${NODE_B} ran ${MEMBER_B}` })

      // Committed history intact: both survivors still hold the full member
      // roster (nothing was dropped to achieve the handover).
      expect(b.team.listMembersByTeam(OFFICE).map((m) => m.appId).sort()).toEqual(
        [MEMBER_B, MEMBER_C].sort()
      )
      expect(c.team.listMembersByTeam(OFFICE).map((m) => m.appId).sort()).toEqual(
        [MEMBER_B, MEMBER_C].sort()
      )

      // Phase 5 — SECOND failure: self-healing must not be a one-shot. The
      // elected authority is now the office's only presence source, so when C
      // crashes too, B's own FSM must confirm it offline (peers with a live
      // return session are presence-tracked on the authority) — this is what
      // keeps member unblock / reconcile / reachability working after a
      // handover instead of leaving C 'online' forever.
      c.manager.stopAll()
      nodes.delete(NODE_C)
      await waitFor(() => b.fed.getNode(OFFICE, NODE_C)?.status === 'offline', 25_000)
      expect(b.fed.getNode(OFFICE, NODE_C)?.status).toBe('offline')
      expect(b.manager.isMemberReachable(MEMBER_C, OFFICE)).toBe(false)
    },
    90_000
  )
})
