/**
 * AC-10 — roster fan-out at scale + backpressure isolation (deterministic bridge).
 *
 * One real host FederationManager with MANY joiners, each a bare coordinator over
 * its own faked-WS link (the manager.test.ts bridge, generalized to N clients).
 * Proves the fan-out path stays non-blocking and convergent under load:
 *   - many joiners all materialize the office on join (every joiner converges);
 *   - a high-frequency burst of broadcastRosterFor re-projects to EVERY joiner the
 *     same number of times (no dropped re-sync, no client starved) — the host
 *     iterates its office clients synchronously and returns, so a burst of N
 *     re-broadcasts yields N roster frames per joiner;
 *   - backpressure isolation: a wedged client whose hostSend returns false (its
 *     socket buffer is "full" / it is gone) does NOT stall delivery to the healthy
 *     joiners — they still receive every frame. The host neither throws nor blocks
 *     on the bad client.
 *
 * Fully synchronous + timer-free: the assertion is about delivery COUNTS and
 * convergence, not wall-clock latency, so it is deterministic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
import { createFederationManager } from '../../../../../src/main/apps/runtime/federation/manager'
import { createFederation } from '../../../../../src/main/apps/runtime/federation/index'
import { LanMeshLink } from '../../../../../src/main/apps/runtime/federation/lan-mesh-provider'
import { DEFAULT_OFFICE_SCOPE } from '../../../../../src/main/apps/federation/types'
import type { Team } from '../../../../../src/main/apps/team/types'
import type {
  FederationMessage,
  JoinRequest,
  OfficeCredentialLike,
  RosterFrame,
  RosterSnapshot,
} from '../../../../../src/main/apps/runtime/federation'

const OFFICE = 'office-scale'
const NODE_A = 'node-a-host'
const LEAD_APP = 'app-a-lead'
const VALID_TOKEN = 'valid-token'

function makeHostTeam(): Team {
  const now = Date.now()
  return {
    id: OFFICE,
    name: 'Scale Office',
    owningSpaceId: 'space-a',
    goal: 'Throughput',
    leadAppId: LEAD_APP,
    memberSourcing: 'manual',
    collabMode: 'free',
    escalationRouting: 'user',
    status: 'idle',
    currentEpochId: null,
    createdAt: now,
    updatedAt: now,
  }
}

interface Joiner {
  nodeId: string
  clientId: string
  link: LanMeshLink
  received: FederationMessage[]
  rosters: RosterSnapshot[]
}

describe('AC-10 — roster fan-out at scale + backpressure isolation', () => {
  let dbManager: DatabaseManager
  let federationStore: FederationStore
  let teamStore: TeamStore

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, FED_NS, fedMigrations)
    dbManager.runMigrations(db, TEAM_NS, teamMigrations)
    federationStore = new FederationStore(db)
    teamStore = new TeamStore(db)
  })

  afterEach(() => {
    dbManager.closeAll()
  })

  function seedHostTeam() {
    teamStore.insertTeam(makeHostTeam())
    teamStore.addMember({
      teamId: OFFICE, appId: LEAD_APP, memberName: 'lead', role: 'Lead',
      isLead: true, aiProvisioned: false, addedAt: Date.now(),
    })
    federationStore.upsertNode({
      nodeId: NODE_A, officeId: OFFICE, identity: 'identity-a', displayName: 'Host A',
      joinedAt: Date.now(), lastSeen: Date.now(), status: 'online',
    })
  }

  /**
   * Host A over a multi-client bridge. `deadClients` is a set of clientIds whose
   * hostSend returns false (wedged/gone socket) — the host must skip them without
   * stalling the rest. Every other client's frames are recorded on its joiner.
   */
  function wireHost(joiners: Map<string, Joiner>, deadClients: Set<string> = new Set()) {
    const verify = (token: string): OfficeCredentialLike | null =>
      token === VALID_TOKEN ? { officeId: OFFICE, scope: DEFAULT_OFFICE_SCOPE } : null

    const hostManager = createFederationManager({
      hostSend: (clientId, frame) => {
        if (deadClients.has(clientId)) return false // simulated backpressure / dead peer
        const j = [...joiners.values()].find((x) => x.clientId === clientId)
        if (!j) return false
        j.received.push(frame)
        j.link.deliver(NODE_A, frame)
        return true
      },
      hostListOfficeClients: () => [...joiners.values()].map((j) => j.clientId),
      federationStore,
      teamStore,
      verifyCredential: verify,
      getLocalNodeId: () => NODE_A,
    })
    hostManager.hostOffice(OFFICE)
    return hostManager
  }

  function makeJoiner(hostManager: () => ReturnType<typeof createFederationManager>, idx: number): Joiner {
    const nodeId = `node-b-${idx}`
    const clientId = `ws-client-${idx}`
    const received: FederationMessage[] = []
    const rosters: RosterSnapshot[] = []
    const link = new LanMeshLink((_to, frame) => {
      hostManager().handleHostInbound({ clientId, officeId: OFFICE, frame })
    })
    return { nodeId, clientId, link, received, rosters }
  }

  function joinFrom(j: Joiner) {
    const fed = createFederation({
      context: { officeId: OFFICE, selfNodeId: j.nodeId },
      link: j.link,
      federationStore,
      teamStore,
      verifyCredential: () => null,
      onRoster: (snap) => j.rosters.push(snap),
    })
    fed.coordinator.start()
    const request: JoinRequest = {
      kind: 'join-request',
      officeId: OFFICE,
      fromNode: j.nodeId,
      identityId: `identity-${j.nodeId}`,
      displayName: `Node ${j.nodeId}`,
      credentialToken: VALID_TOKEN,
      bringMembers: [{ appId: `app-${j.nodeId}`, memberName: `m-${j.nodeId}`, role: 'Analyst', spaceId: `space-${j.nodeId}` }],
    }
    fed.coordinator.requestJoin(request)
    return fed
  }

  it('many joiners all converge on join: each receives a roster snapshot', () => {
    seedHostTeam()
    const joiners = new Map<string, Joiner>()
    let hm!: ReturnType<typeof createFederationManager>
    hm = wireHost(joiners)

    const N = 20
    for (let i = 0; i < N; i++) {
      const j = makeJoiner(() => hm, i)
      joiners.set(j.clientId, j)
      joinFrom(j)
    }

    for (const j of joiners.values()) {
      expect(j.rosters.length).toBeGreaterThanOrEqual(1)
    }
    // The host persisted all N remote members (+ its own lead).
    expect(teamStore.listMembersByTeam(OFFICE).length).toBe(N + 1)
  })

  it('a high-frequency broadcast burst re-projects to EVERY joiner the same number of times', () => {
    seedHostTeam()
    const joiners = new Map<string, Joiner>()
    let hm!: ReturnType<typeof createFederationManager>
    hm = wireHost(joiners)

    const N = 10
    for (let i = 0; i < N; i++) {
      const j = makeJoiner(() => hm, i)
      joiners.set(j.clientId, j)
      joinFrom(j)
    }

    // Count roster frames already delivered by the joins, then burst.
    const baseline = [...joiners.values()].map((j) => j.received.filter((f) => f.kind === 'roster').length)

    const BURST = 50
    for (let b = 0; b < BURST; b++) hm.broadcastRosterFor(OFFICE)

    const joinerList = [...joiners.values()]
    joinerList.forEach((j, idx) => {
      const rosterCount = j.received.filter((f) => f.kind === 'roster').length
      // Each joiner received exactly BURST additional roster frames — no joiner was
      // starved and none received extra; the fan-out is even and complete.
      expect(rosterCount - baseline[idx]).toBe(BURST)
    })
  })

  it('backpressure isolation: a wedged client (hostSend → false) does not stall the healthy joiners', () => {
    seedHostTeam()
    const joiners = new Map<string, Joiner>()
    const dead = new Set<string>()
    let hm!: ReturnType<typeof createFederationManager>
    hm = wireHost(joiners, dead)

    const N = 6
    for (let i = 0; i < N; i++) {
      const j = makeJoiner(() => hm, i)
      joiners.set(j.clientId, j)
      joinFrom(j)
    }

    // Wedge one already-joined client: its socket is now "full"/gone.
    const victim = [...joiners.values()][0]
    dead.add(victim.clientId)

    const before = [...joiners.values()].map((j) => j.received.filter((f) => f.kind === 'roster').length)

    const BURST = 25
    expect(() => {
      for (let b = 0; b < BURST; b++) hm.broadcastRosterFor(OFFICE)
    }).not.toThrow()

    const joinerList = [...joiners.values()]
    joinerList.forEach((j, idx) => {
      const delivered = j.received.filter((f) => f.kind === 'roster').length - before[idx]
      if (j.clientId === victim.clientId) {
        // The wedged client received nothing further (its hostSend kept returning false).
        expect(delivered).toBe(0)
      } else {
        // Every healthy joiner still got the full burst — the dead peer did not
        // starve the fan-out.
        expect(delivered).toBe(BURST)
      }
    })
  })
})
