/**
 * Unit tests for apps/runtime/federation -- distributed roster sync (DR).
 *
 * Proves the two halves of the join-roster handshake the host previously
 * dropped:
 *   1. HOST emit — when B joins A, A fires onRosterChanged(officeId) AND
 *      broadcasts a `roster` frame carrying every member with ABSOLUTE owner
 *      node ids (A's own members → A's node id, B's member → B's node id) plus
 *      the structured-mode lead→B edge.
 *   2. JOINER materialize — driving B's coordinator with that roster frame makes
 *      B's local store hold the office as a shadow team (host_node_id = A) with
 *      B's own member remapped to SELF/local and A's members remote; re-applying
 *      the same roster is idempotent (no duplicate members, no constraint error).
 *
 * Plus a migration v6 guard (v1..v6 clean; existing teams read hostNodeId null).
 *
 * Real in-memory stores + the two-node faked-WS bridge from manager.test.ts.
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
import { SELF_NODE_ID, buildTeamSessionKey } from '../../../../../src/shared/apps/team-types'
import type { Team } from '../../../../../src/main/apps/team/types'
import type {
  FederationMessage,
  JoinRequest,
  OfficeCredentialLike,
  RosterFrame,
  RosterSnapshot,
} from '../../../../../src/main/apps/runtime/federation'

const OFFICE = 'office-1'
const NODE_A = 'node-a-host'
const NODE_B = 'node-b-joiner'
const B_CLIENT_ID = 'ws-client-b'
const VALID_TOKEN = 'valid-token'

const LEAD_APP = 'app-a-lead'
const HOST_MEMBER = 'app-a-analyst'
const B_MEMBER = 'app-b-1'

function makeHostTeam(overrides?: Partial<Team>): Team {
  const now = Date.now()
  return {
    id: OFFICE,
    name: 'Research Office',
    owningSpaceId: 'space-a',
    goal: 'Weekly brief',
    leadAppId: LEAD_APP,
    memberSourcing: 'manual',
    collabMode: 'structured',
    escalationRouting: 'user',
    status: 'idle',
    currentEpochId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe('federation roster sync (DR)', () => {
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

  /** Seed the host's own team row + lead + a locally-owned member (stored SELF). */
  function seedHostTeam() {
    teamStore.insertTeam(makeHostTeam())
    teamStore.addMember({
      teamId: OFFICE,
      appId: LEAD_APP,
      memberName: 'lead',
      role: 'Lead',
      isLead: true,
      aiProvisioned: false,
      addedAt: Date.now(),
    })
    teamStore.addMember({
      teamId: OFFICE,
      appId: HOST_MEMBER,
      memberName: 'a-analyst',
      role: 'Analyst',
      isLead: false,
      aiProvisioned: false,
      addedAt: Date.now(),
    })
    // The host advertises a display name for its own node (so ownerDisplayName resolves).
    federationStore.upsertNode({
      nodeId: NODE_A,
      officeId: OFFICE,
      identity: 'identity-a',
      displayName: 'Host A',
      joinedAt: Date.now(),
      lastSeen: Date.now(),
      status: 'online',
    })
  }

  /**
   * Wire host A's manager + a joiner B bridge (faked WS hop). Captures every
   * frame B receives and the officeIds A's onRosterChanged fired for.
   */
  function wireTwoNodes(opts?: { verify?: (token: string) => OfficeCredentialLike | null }) {
    const verify =
      opts?.verify ?? ((token: string) => (token === VALID_TOKEN ? { officeId: OFFICE } : null))

    const bReceived: FederationMessage[] = []
    const rosterChangedFor: string[] = []

    const bLink = new LanMeshLink((_to, frame) => {
      hostManager.handleHostInbound({ clientId: B_CLIENT_ID, officeId: OFFICE, frame })
    })

    const hostManager = createFederationManager({
      hostSend: (clientId, frame) => {
        if (clientId !== B_CLIENT_ID) return false
        bReceived.push(frame)
        bLink.deliver(NODE_A, frame)
        return true
      },
      hostListOfficeClients: () => [B_CLIENT_ID],
      federationStore,
      teamStore,
      verifyCredential: verify,
      getLocalNodeId: () => NODE_A,
      onRosterChanged: (officeId) => rosterChangedFor.push(officeId),
    })

    hostManager.hostOffice(OFFICE)
    return { hostManager, bLink, bReceived, rosterChangedFor }
  }

  /** Build B's joiner coordinator over bLink and request a join. */
  function joinFromB(bLink: LanMeshLink, onRoster?: (snap: RosterSnapshot) => void) {
    const fed = createFederation({
      context: { officeId: OFFICE, selfNodeId: NODE_B },
      link: bLink,
      federationStore,
      teamStore,
      verifyCredential: () => null,
      onRoster,
    })
    fed.coordinator.start()
    const request: JoinRequest = {
      kind: 'join-request',
      officeId: OFFICE,
      fromNode: NODE_B,
      identityId: 'identity-b',
      displayName: 'Node B',
      credentialToken: VALID_TOKEN,
      bringMembers: [{ appId: B_MEMBER, memberName: 'b-analyst', role: 'Analyst', spaceId: 'space-b-1' }],
    }
    fed.coordinator.requestJoin(request)
    return fed
  }

  // ── 1. HOST emits on join ──────────────────────────────────────────────────

  it('host fires onRosterChanged and broadcasts a roster with ABSOLUTE owner ids', () => {
    seedHostTeam()
    const { bLink, bReceived, rosterChangedFor } = wireTwoNodes()
    joinFromB(bLink)

    expect(rosterChangedFor).toContain(OFFICE)

    const roster = bReceived.find((f): f is RosterFrame => f.kind === 'roster')
    expect(roster).toBeTruthy()
    const snap = roster!.snapshot
    expect(snap.team.hostNodeId).toBe(NODE_A)

    const byApp = new Map(snap.members.map((m) => [m.appId, m]))
    // A's own members (stored SELF locally) → A's absolute node id on the wire.
    expect(byApp.get(LEAD_APP)!.ownerNodeId).toBe(NODE_A)
    expect(byApp.get(HOST_MEMBER)!.ownerNodeId).toBe(NODE_A)
    // B's member → B's node id (already absolute).
    expect(byApp.get(B_MEMBER)!.ownerNodeId).toBe(NODE_B)
    expect(byApp.get(B_MEMBER)!.memberIdentity).toBe('identity-b')
    // The host resolved its own node's display name onto its members.
    expect(byApp.get(LEAD_APP)!.ownerDisplayName).toBe('Host A')
    // The joiner's display name reached the wire (join-request → member row →
    // roster), so every node can render the owner badge from its own store.
    expect(byApp.get(B_MEMBER)!.ownerDisplayName).toBe('Node B')
    expect(teamStore.listMembersByTeam(OFFICE).find((m) => m.appId === B_MEMBER)?.ownerDisplayName).toBe('Node B')
  })

  it('structured mode: roster edges link lead→B-member (same shape as the recommended topology)', () => {
    seedHostTeam()
    const { bLink, bReceived } = wireTwoNodes()
    joinFromB(bLink)

    const roster = bReceived.find((f): f is RosterFrame => f.kind === 'roster')!
    const edgeSet = new Set(roster.snapshot.edges.map((e) => `${e.fromAppId}→${e.toAppId}`))
    expect(edgeSet.has(`${LEAD_APP}→${B_MEMBER}`)).toBe(true)
    // No reverse edge: replies ride the wake/turn-complete correlation, and a
    // lead↔member cycle would scramble the topology auto-layout.
    expect(edgeSet.has(`${B_MEMBER}→${LEAD_APP}`)).toBe(false)
    // The synthesized edge is sync (same as the recommended default) on the host.
    const stored = teamStore.listEdgesByTeam(OFFICE).find(
      (e) => e.fromAppId === LEAD_APP && e.toAppId === B_MEMBER
    )
    expect(stored?.sync).toBe(true)
  })

  it('same-name brought member is admitted under a disambiguated name (never silently dropped)', () => {
    seedHostTeam()
    const { bLink, bReceived } = wireTwoNodes()

    // B brings a member whose name collides with the host's own 'a-analyst'.
    const fed = createFederation({
      context: { officeId: OFFICE, selfNodeId: NODE_B },
      link: bLink,
      federationStore,
      teamStore,
      verifyCredential: () => null,
    })
    fed.coordinator.start()
    fed.coordinator.requestJoin({
      kind: 'join-request',
      officeId: OFFICE,
      fromNode: NODE_B,
      identityId: 'identity-b',
      displayName: 'Node B',
      credentialToken: VALID_TOKEN,
      bringMembers: [{ appId: B_MEMBER, memberName: 'a-analyst', role: 'Analyst' }],
    })

    const roster = bReceived.filter((f): f is RosterFrame => f.kind === 'roster').at(-1)!
    const brought = roster.snapshot.members.find((m) => m.appId === B_MEMBER)
    expect(brought).toBeTruthy()
    expect(brought!.memberName).toBe('a-analyst·Node B')
    const host = roster.snapshot.members.find((m) => m.appId === HOST_MEMBER)
    expect(host!.memberName).toBe('a-analyst')
    const edgeSet = new Set(roster.snapshot.edges.map((e) => `${e.fromAppId}→${e.toAppId}`))
    expect(edgeSet.has(`${LEAD_APP}→${B_MEMBER}`)).toBe(true)
    fed.coordinator.stop()
  })

  it('rejoin keeps the name assigned on first join (no re-disambiguation churn)', () => {
    seedHostTeam()
    const { bLink, bReceived } = wireTwoNodes()

    const request: JoinRequest = {
      kind: 'join-request',
      officeId: OFFICE,
      fromNode: NODE_B,
      identityId: 'identity-b',
      displayName: 'Node B',
      credentialToken: VALID_TOKEN,
      bringMembers: [{ appId: B_MEMBER, memberName: 'a-analyst', role: 'Analyst' }],
    }
    const fed = createFederation({
      context: { officeId: OFFICE, selfNodeId: NODE_B },
      link: bLink,
      federationStore,
      teamStore,
      verifyCredential: () => null,
    })
    fed.coordinator.start()
    fed.coordinator.requestJoin(request)
    fed.coordinator.requestJoin(request) // rejoin (e.g. reconnect re-handshake)

    const roster = bReceived.filter((f): f is RosterFrame => f.kind === 'roster').at(-1)!
    const brought = roster.snapshot.members.filter((m) => m.appId === B_MEMBER)
    expect(brought).toHaveLength(1)
    expect(brought[0].memberName).toBe('a-analyst·Node B')
    fed.coordinator.stop()
  })

  it('free mode: no edges synthesized', () => {
    teamStore.insertTeam(makeHostTeam({ collabMode: 'free' }))
    teamStore.addMember({
      teamId: OFFICE,
      appId: LEAD_APP,
      memberName: 'lead',
      role: 'Lead',
      isLead: true,
      aiProvisioned: false,
      addedAt: Date.now(),
    })
    const { bLink, bReceived } = wireTwoNodes()
    joinFromB(bLink)

    const roster = bReceived.find((f): f is RosterFrame => f.kind === 'roster')!
    expect(roster.snapshot.edges).toHaveLength(0)
  })

  // ── 2. JOINER materializes (the relay-enabling assertion) ───────────────────

  it('joiner materializes the shadow office: own member SELF/local, host members remote', () => {
    seedHostTeam()
    const { bLink } = wireTwoNodes()

    // B materializes whatever roster the host projects (the production wiring).
    joinFromB(bLink, (snap) =>
      teamStore.materializeJoinedOffice({ hostNodeId: snap.team.hostNodeId, selfNodeId: NODE_B, snapshot: snap })
    )

    const team = teamStore.getTeamById(OFFICE)!
    expect(team).toBeTruthy()
    expect(team.hostNodeId).toBe(NODE_A)

    const byApp = new Map(teamStore.listMembersByTeam(OFFICE).map((m) => [m.appId, m]))
    // B's own member is stored SELF-relative so RelayCapture sees it as owned-by-SELF.
    expect(byApp.get(B_MEMBER)!.ownerNodeId).toBe(SELF_NODE_ID)
    expect(byApp.get(B_MEMBER)!.origin).toBe('local')
    expect(byApp.get(LEAD_APP)!.ownerNodeId).toBe(NODE_A)
    expect(byApp.get(LEAD_APP)!.origin).toBe('remote')
    expect(byApp.get(HOST_MEMBER)!.ownerNodeId).toBe(NODE_A)
    expect(byApp.get(HOST_MEMBER)!.origin).toBe('remote')
    // The owner badge survives materialization: the joiner labels host-owned
    // members from its own member rows (it keeps no office_nodes rows for peers),
    // while its own member carries no badge.
    expect(byApp.get(LEAD_APP)!.ownerDisplayName).toBe('Host A')
    expect(byApp.get(B_MEMBER)!.ownerDisplayName).toBeNull()
  })

  it('materialize is idempotent: re-applying the same roster keeps one member set', () => {
    const snapshot: RosterSnapshot = {
      team: { id: OFFICE, name: 'Research Office', goal: 'g', leadAppId: LEAD_APP, collabMode: 'structured', hostNodeId: NODE_A },
      members: [
        { appId: LEAD_APP, memberName: 'lead', role: 'Lead', isLead: true, ownerNodeId: NODE_A, memberIdentity: 'identity-a', ownerDisplayName: 'Host A' },
        { appId: B_MEMBER, memberName: 'b-analyst', role: 'Analyst', isLead: false, ownerNodeId: NODE_B, memberIdentity: 'identity-b', ownerDisplayName: 'Node B' },
      ],
      edges: [
        { fromAppId: LEAD_APP, toAppId: B_MEMBER },
        { fromAppId: B_MEMBER, toAppId: LEAD_APP },
      ],
    }

    const apply = () =>
      teamStore.materializeJoinedOffice({ hostNodeId: NODE_A, selfNodeId: NODE_B, snapshot })

    expect(apply).not.toThrow()
    expect(apply).not.toThrow() // re-apply must not violate any unique index

    expect(teamStore.listMembersByTeam(OFFICE)).toHaveLength(2)
    expect(teamStore.listEdgesByTeam(OFFICE)).toHaveLength(2)
    expect(teamStore.getMemberByName(OFFICE, 'b-analyst')!.ownerNodeId).toBe(SELF_NODE_ID)
  })

  it('persists the host run epoch so the joiner can bind the live run from its store (B-2 / D-NEW-2)', () => {
    const base: RosterSnapshot = {
      team: { id: OFFICE, name: 'Research Office', goal: 'g', leadAppId: LEAD_APP, collabMode: 'structured', hostNodeId: NODE_A, epochId: 'epoch-live-1' },
      members: [
        { appId: LEAD_APP, memberName: 'lead', role: 'Lead', isLead: true, ownerNodeId: NODE_A, memberIdentity: 'identity-a', ownerDisplayName: 'Host A' },
        { appId: B_MEMBER, memberName: 'b-analyst', role: 'Analyst', isLead: false, ownerNodeId: NODE_B, memberIdentity: 'identity-b', ownerDisplayName: 'Node B' },
      ],
      edges: [],
    }

    // Initial join (INSERT path): the open epoch is recorded on the shadow office.
    teamStore.materializeJoinedOffice({ hostNodeId: NODE_A, selfNodeId: NODE_B, snapshot: base })
    expect(teamStore.getTeamById(OFFICE)!.currentEpochId).toBe('epoch-live-1')

    // A later roster with no open run (UPDATE path): the epoch clears, so the
    // joiner does not pin a stale run after the host's run ends.
    teamStore.materializeJoinedOffice({
      hostNodeId: NODE_A,
      selfNodeId: NODE_B,
      snapshot: { ...base, team: { ...base.team, epochId: undefined } },
    })
    expect(teamStore.getTeamById(OFFICE)!.currentEpochId).toBeNull()
  })

  it('run-epoch id is IDENTICAL on host and joiner, so both bind the same run session key', () => {
    // The host opens a run; the host-authoritative epoch id is what rides the
    // roster snapshot. The joiner must shadow that SAME id (current_epoch_id AND a
    // team_epochs row), so a member woken under the host run-epoch streams + reads
    // under one conversationId on both nodes. A divergent (shadow) epoch id would
    // make a joiner view its own member under the wrong session key and see
    // nothing — the SYMPTOM-2 failure this invariant guards.
    const HOST_EPOCH = 'epoch-run-shared'

    // HOST side: a real epoch row + the team pointing at it (what the snapshot reads).
    teamStore.insertTeam(makeHostTeam({ currentEpochId: HOST_EPOCH }))
    teamStore.insertEpoch({
      id: HOST_EPOCH, teamId: OFFICE, startedAt: Date.now(),
      endedAt: null, endReason: null, summary: null, lifecycle: 'run',
    })
    const hostCurrentEpoch = teamStore.getTeamById(OFFICE)!.currentEpochId!

    // JOINER side (separate store): materialize the host roster carrying that epoch.
    const joinerDbm = createDatabaseManager(':memory:')
    try {
      const jdb = joinerDbm.getAppDatabase()
      joinerDbm.runMigrations(jdb, FED_NS, fedMigrations)
      joinerDbm.runMigrations(jdb, TEAM_NS, teamMigrations)
      const joinerStore = new TeamStore(jdb)

      joinerStore.materializeJoinedOffice({
        hostNodeId: NODE_A,
        selfNodeId: NODE_B,
        snapshot: {
          team: { id: OFFICE, name: 'Research Office', goal: 'g', leadAppId: LEAD_APP, collabMode: 'structured', hostNodeId: NODE_A, epochId: hostCurrentEpoch },
          members: [
            { appId: LEAD_APP, memberName: 'lead', role: 'Lead', isLead: true, ownerNodeId: NODE_A, memberIdentity: 'identity-a', ownerDisplayName: 'Host A' },
            { appId: B_MEMBER, memberName: 'b-analyst', role: 'Analyst', isLead: false, ownerNodeId: NODE_B, memberIdentity: 'identity-b', ownerDisplayName: 'Node B' },
          ],
          edges: [],
        },
      })

      const joinerCurrentEpoch = joinerStore.getTeamById(OFFICE)!.currentEpochId
      // 1. The bound run-epoch id is byte-identical across nodes.
      expect(joinerCurrentEpoch).toBe(hostCurrentEpoch)
      // 2. The joiner has a matching team_epochs row (so its bus does not treat the
      //    epoch as sealed and drop the woken member's reply / reactivateEpoch works).
      expect(joinerStore.getEpochById(hostCurrentEpoch)).not.toBeNull()
      // 3. The conversationId both nodes derive for B's member is the SAME — this is
      //    the key the member streams under and the joiner's chat view reads under.
      expect(buildTeamSessionKey(B_MEMBER, OFFICE, joinerCurrentEpoch!)).toBe(
        buildTeamSessionKey(B_MEMBER, OFFICE, hostCurrentEpoch)
      )
    } finally {
      joinerDbm.closeAll()
    }
  })

  it('end-to-end: B joins A over the bridge → B has the office with host_node_id = A', () => {
    seedHostTeam()
    const rosterChangedOnB: string[] = []
    const { bLink } = wireTwoNodes()

    // Mirror the manager's joiner wiring: materialize + fire a UI refresh.
    joinFromB(bLink, (snap) => {
      teamStore.materializeJoinedOffice({ hostNodeId: snap.team.hostNodeId, selfNodeId: NODE_B, snapshot: snap })
      rosterChangedOnB.push(OFFICE)
    })

    expect(rosterChangedOnB).toContain(OFFICE)
    const team = teamStore.getTeamById(OFFICE)!
    expect(team.hostNodeId).toBe(NODE_A)
    expect(teamStore.listMembersByTeam(OFFICE)).toHaveLength(3) // lead + host member + B
  })

  // ── 3. Migration v6 ─────────────────────────────────────────────────────────

  it('migration v1..v6 applies clean; existing teams read hostNodeId null', () => {
    const m2 = createDatabaseManager(':memory:')
    const db = m2.getAppDatabase()
    expect(() => m2.runMigrations(db, TEAM_NS, teamMigrations)).not.toThrow()
    const version = (
      db.prepare('SELECT version FROM _migrations WHERE namespace = ?').get(TEAM_NS) as { version: number }
    ).version
    // v6 introduced host_node_id; later migrations may exist — assert at-least, not exact.
    expect(version).toBeGreaterThanOrEqual(6)

    const store = new TeamStore(db)
    store.insertTeam(makeHostTeam({ leadAppId: null }))
    expect(store.getTeamById(OFFICE)!.hostNodeId).toBeNull()
    m2.closeAll()
  })

  it('migration v6 applies cleanly on a db already at v5', () => {
    const m2 = createDatabaseManager(':memory:')
    const db = m2.getAppDatabase()
    m2.runMigrations(db, TEAM_NS, teamMigrations.filter((m) => m.version <= 5))
    expect(
      (db.prepare('SELECT version FROM _migrations WHERE namespace = ?').get(TEAM_NS) as { version: number }).version
    ).toBe(5)
    expect(() => m2.runMigrations(db, TEAM_NS, teamMigrations)).not.toThrow()
    expect(
      (db.prepare('SELECT version FROM _migrations WHERE namespace = ?').get(TEAM_NS) as { version: number }).version
    ).toBeGreaterThanOrEqual(6)
    m2.closeAll()
  })
})
