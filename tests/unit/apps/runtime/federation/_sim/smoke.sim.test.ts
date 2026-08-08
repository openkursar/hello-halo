/**
 * SimCluster bring-up smoke: two REAL FederationManagers (host + joiner) wired by
 * a deterministic in-process bus, each with its OWN feed store (Path B seam), so
 * both nodes' full manager+feed logic runs. No real sockets carry federation
 * traffic (the joined office's upstream leg is repointed onto the bus); no product
 * code is modified beyond the injected `feedStore` dep.
 *
 * Proves the assembly end-to-end: J joins H's office bringing a member; H (the
 * authority) sends a wake to that member; the wake rides H's ctrl feed to J,
 * J's scripted executor runs the "turn", and the turn-complete refluxes to H's
 * registered waiter. If this is green, the harness faithfully exercises the
 * uncovered assembly layer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createDatabaseManager } from '../../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../../src/main/platform/store/types'
import { FederationStore } from '../../../../../../src/main/apps/federation/store'
import { AuthorityStore } from '../../../../../../src/main/apps/federation/authority-store'
import { FeedStore } from '../../../../../../src/main/apps/federation/feed-store'
import {
  MIGRATION_NAMESPACE as FED_NS,
  migrations as fedMigrations,
} from '../../../../../../src/main/apps/federation/migrations'
import { TeamStore } from '../../../../../../src/main/apps/team/store'
import {
  MIGRATION_NAMESPACE as TEAM_NS,
  migrations as teamMigrations,
} from '../../../../../../src/main/apps/team/migrations'
import {
  createFederationManager,
  type FederationManager,
} from '../../../../../../src/main/apps/runtime/federation/manager'
import type {
  FederationMessage,
  SerializedWakeRequest,
  TurnCompletion,
} from '../../../../../../src/main/apps/runtime/federation/types'

const OFFICE = 'office-sim'
const H = 'node-host'
const J = 'node-joiner'
const MEMBER = 'app-j-analyst'
const TOKEN = 'valid'

/** Poll a predicate across real event-loop turns until true or exhausted. */
async function waitFor(pred: () => boolean, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (pred()) return
    await new Promise((r) => setImmediate(r))
  }
  throw new Error('waitFor timed out')
}

interface SimNode {
  id: string
  dbm: DatabaseManager
  fed: FederationStore
  auth: AuthorityStore
  feed: FeedStore
  team: TeamStore
  manager: FederationManager
  ranTurns: SerializedWakeRequest[]
}

/**
 * Minimal deterministic bus: routes (from → to) frames to a node's receive hook
 * synchronously. Drop / kill are modelled as a routable predicate.
 */
function makeBus() {
  const receivers = new Map<string, (from: string, officeId: string, frame: FederationMessage) => void>()
  const dead = new Set<string>()
  let dropPredicate: ((from: string, to: string, frame: FederationMessage) => boolean) | null = null

  return {
    register(id: string, recv: (from: string, officeId: string, frame: FederationMessage) => void) {
      receivers.set(id, recv)
    },
    /** Deliver from→to. Returns whether a route existed (transport-accepted), not ack. */
    route(from: string, to: string, officeId: string, frame: FederationMessage): boolean {
      if (dead.has(from) || dead.has(to)) return false
      if (dropPredicate?.(from, to, frame)) return true // accepted then lost in flight
      receivers.get(to)?.(from, officeId, frame)
      return true
    },
    reachable(from: string, to: string): boolean {
      return !dead.has(from) && !dead.has(to)
    },
    kill(id: string) {
      dead.add(id)
    },
    revive(id: string) {
      dead.delete(id)
    },
    setDrop(pred: ((from: string, to: string, frame: FederationMessage) => boolean) | null) {
      dropPredicate = pred
    },
  }
}

type Bus = ReturnType<typeof makeBus>

function buildNode(
  id: string,
  bus: Bus,
  opts: { runTurn?: (r: SerializedWakeRequest) => string | null } = {}
): SimNode {
  const dbm = createDatabaseManager(':memory:')
  const db = dbm.getAppDatabase()
  dbm.runMigrations(db, FED_NS, fedMigrations)
  dbm.runMigrations(db, TEAM_NS, teamMigrations)
  const fed = new FederationStore(db)
  const auth = new AuthorityStore(db)
  const feed = new FeedStore(db)
  const team = new TeamStore(db)
  const ranTurns: SerializedWakeRequest[] = []

  const manager = createFederationManager({
    hostSend: (clientId, frame) => bus.route(id, clientId, frame.officeId, frame),
    hostListOfficeClients: (officeId) => {
      const owners = new Set<string>()
      for (const m of team.listMembersByTeam(officeId)) {
        if (m.ownerNodeId && m.ownerNodeId !== id) owners.add(m.ownerNodeId)
      }
      return [...owners].filter((n) => bus.reachable(id, n))
    },
    federationStore: fed,
    teamStore: team,
    authorityStore: auth,
    feedStore: feed,
    verifyCredential: (tok) => (tok === TOKEN ? { officeId: OFFICE } : null),
    getLocalNodeId: () => id,
    getLocalAdvertisedUrl: () => `sim://${id}`,
    getLocalDisplayName: () => id,
    runLocalTurn: async (request) => {
      ranTurns.push(request)
      const finalMessage = opts.runTurn ? opts.runTurn(request) : `done:${request.appId}`
      return { finalMessage }
    },
    getOwnerStatus: () => 'idle',
    getCurrentRunEpoch: () => null,
    applyMemberWrite: () => {},
    reassignTask: () => {},
    ctrlGiveUpMs: 60_000,
  })

  bus.register(id, (from, officeId, frame) => {
    if (manager.listHostedOffices().includes(officeId)) {
      manager.handleHostInbound({ clientId: from, officeId, frame })
    } else if (manager.listJoinedOffices().includes(officeId)) {
      manager.deliverInbound(officeId, frame, from)
    }
  })

  return { id, dbm, fed, auth, feed, team, manager, ranTurns }
}

/**
 * Register a JOINED office on `joiner` without a live socket: seed the shadow
 * team row (hostNodeId), fire joinOffice against a dead endpoint (registers the
 * office synchronously), then repoint the upstream leg onto the bus and re-drive
 * the join to the host — all synchronous over the bus.
 */
function joinOverBus(joiner: SimNode, bus: Bus, hostId: string): void {
  const now = Date.now()
  joiner.team.insertTeam({
    id: OFFICE,
    name: 'sim office',
    owningSpaceId: 'space-j',
    goal: 'g',
    leadAppId: null,
    memberSourcing: 'manual',
    collabMode: 'structured',
    escalationRouting: 'user',
    status: 'idle',
    currentEpochId: null,
    createdAt: now,
    updatedAt: now,
    hostNodeId: hostId,
  })

  // Fire-and-forget: the office + join-request are registered synchronously in the
  // Promise executor; we drive the handshake ourselves over the bus.
  void joiner.manager.joinOffice({
    officeId: OFFICE,
    serverUrl: 'ws://127.0.0.1:9/ws',
    credentialToken: TOKEN,
    selfContext: { officeId: OFFICE, selfNodeId: joiner.id },
    bringMembers: [{ appId: MEMBER, memberName: 'analyst', role: 'Analyst', spaceId: 'space-j-1' }],
  })

  // The upstream leg always reaches the office authority (the host). Like the
  // real WsFederationClient, it ignores the envelope `to` for routing (that field
  // only addresses gateway rooms); a joiner's every frame rides the one leg to
  // its host, which relays onward.
  joiner.manager.repointLink(OFFICE, (_to, frame) =>
    bus.route(joiner.id, hostId, frame.officeId ?? OFFICE, frame)
  )
  joiner.manager.reenrollWithAuthority(OFFICE)
}

describe('SimCluster smoke — two managers, join + wake over a deterministic bus', () => {
  let bus: Bus
  let host: SimNode
  let joiner: SimNode

  beforeEach(() => {
    bus = makeBus()
    host = buildNode(H, bus)
    joiner = buildNode(J, bus)
    host.manager.hostOffice(OFFICE)
  })

  afterEach(() => {
    host.manager.stopAll()
    joiner.manager.stopAll()
    host.dbm.closeAll()
    joiner.dbm.closeAll()
  })

  it('host admits the joiner and persists its brought member', () => {
    joinOverBus(joiner, bus, H)

    const node = host.fed.getNode(OFFICE, J)
    expect(node?.status).toBe('online')
    const members = host.team.listMembersByTeam(OFFICE)
    expect(members.map((m) => m.appId)).toContain(MEMBER)
    expect(members.find((m) => m.appId === MEMBER)?.ownerNodeId).toBe(J)
  })

  it('delivers a wake to the joiner-owned member and refluxes turn-complete', async () => {
    joinOverBus(joiner, bus, H)

    let outcome: TurnCompletion | null = null
    host.manager.registerTurnComplete('corr-1', (o) => {
      outcome = o
    })
    const sent = host.manager.sendWakeToMember({
      officeId: OFFICE,
      ownerNodeId: J,
      request: { appId: MEMBER, spaceId: 'space-j-1', message: 'hi', conversationId: 'c1' } as unknown as SerializedWakeRequest,
      correlationId: 'corr-1',
    })
    expect(sent).toBe(true)

    // The wake rides H's ctrl feed to J, J's async runLocalTurn executes, and the
    // turn-complete refluxes to H's waiter — several event-loop turns.
    await waitFor(() => outcome !== null)

    expect(joiner.ranTurns.map((r) => r.appId)).toContain(MEMBER)
    expect(outcome).not.toBeNull()
    expect((outcome as unknown as TurnCompletion).kind).toBe('result')
  })
})
