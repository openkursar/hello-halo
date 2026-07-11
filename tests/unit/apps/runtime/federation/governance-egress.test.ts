/**
 * Governance egress + roster re-sync + run-epoch propagation (D-1 / G-1 / G-3 / B-2).
 *
 * The HOST is a real FederationManager; a joiner B is driven as a bare coordinator
 * over the deterministic faked-WS bridge from roster-sync.test.ts (host hostSend →
 * B's link; B's link send → host handleHostInbound). No real sockets, no timers —
 * the bridge delivers every host broadcast into B's coordinator synchronously.
 *
 * Proven on the wire (host emits the exact frame, B receives it):
 *   - D-1 roster re-sync: after a membership mutation the host re-projects the FULL
 *     roster (broadcastRosterFor) → B receives a fresh `roster` snapshot, not only
 *     on join. The snapshot carries ABSOLUTE owner ids the joiner remaps.
 *   - G-1 member-removed: projectMemberRemoved broadcasts a `member-removed` frame
 *     (technical appId, term-stamped) → B's M2 sink sees it.
 *   - G-3 office-dissolved: projectOfficeDissolved broadcasts an `office-dissolved`
 *     frame BEFORE local teardown → B's M2 sink sees it while the link is live.
 *   - B-2 run-epoch on the wire: when a run epoch is open the roster snapshot's
 *     team.epochId carries it, so a joiner can derive the live session key. When no
 *     run is open the field is absent.
 *
 * The end-to-end joiner-MANAGER teardown half (handleJoinerM2Frame →
 * onMemberRemovedRemote/onOfficeDissolvedRemote → shadow-store teardown) needs a
 * full joiner manager and is proven over a real socket in governance-egress-ws.test.ts;
 * this deterministic bridge is the primary gate for the host-side egress contract.
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
import type { M2Frame } from '../../../../../src/main/apps/runtime/federation/protocol-m2'
import { DEFAULT_OFFICE_SCOPE } from '../../../../../src/main/apps/federation/types'

const OFFICE = 'office-gov'
const EPOCH = 'epoch-live-1'
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
    name: 'Governance Office',
    owningSpaceId: 'space-a',
    goal: 'Ship it',
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

describe('governance egress + roster re-sync + run-epoch (D-1/G-1/G-3/B-2)', () => {
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

  /** Seed the host's own team + lead + a locally-owned member (stored SELF). */
  function seedHostTeam(overrides?: Partial<Team>) {
    teamStore.insertTeam(makeHostTeam(overrides))
    teamStore.addMember({
      teamId: OFFICE, appId: LEAD_APP, memberName: 'lead', role: 'Lead',
      isLead: true, aiProvisioned: false, addedAt: Date.now(),
    })
    teamStore.addMember({
      teamId: OFFICE, appId: HOST_MEMBER, memberName: 'a-analyst', role: 'Analyst',
      isLead: false, aiProvisioned: false, addedAt: Date.now(),
    })
    federationStore.upsertNode({
      nodeId: NODE_A, officeId: OFFICE, identity: 'identity-a', displayName: 'Host A',
      joinedAt: Date.now(), lastSeen: Date.now(), status: 'online',
    })
  }

  /**
   * Host A's real manager + a faked-WS bridge to a bare joiner B. `runEpoch`
   * controls what the host's getCurrentRunEpoch reports (B-2). Captures every frame
   * B receives.
   */
  function wireTwoNodes(opts?: {
    verify?: (token: string) => OfficeCredentialLike | null
    runEpoch?: { teamId: string; epochId: string } | null
  }) {
    const verify =
      opts?.verify ??
      ((token: string) => (token === VALID_TOKEN ? { officeId: OFFICE, scope: DEFAULT_OFFICE_SCOPE } : null))

    const bReceived: FederationMessage[] = []
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
      getCurrentRunEpoch: () => (opts && 'runEpoch' in opts ? opts.runEpoch ?? null : null),
    })

    hostManager.hostOffice(OFFICE)
    return { hostManager, bLink, bReceived }
  }

  /** Build B's joiner coordinator over bLink. `onM2` sinks governance/M2 frames. */
  function joinFromB(
    bLink: LanMeshLink,
    hooks: {
      onRoster?: (snap: RosterSnapshot) => void
      onM2?: (from: string, frame: M2Frame) => void
    } = {}
  ) {
    const fed = createFederation({
      context: { officeId: OFFICE, selfNodeId: NODE_B },
      link: bLink,
      federationStore,
      teamStore,
      verifyCredential: () => null,
      onRoster: hooks.onRoster,
      onM2Frame: hooks.onM2,
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

  it('D-1: a post-join mutation re-projects the full roster to B', () => {
    seedHostTeam()
    const rosters: RosterSnapshot[] = []
    const { hostManager, bLink } = wireTwoNodes()
    joinFromB(bLink, { onRoster: (snap) => rosters.push(snap) })

    // The join already delivered one roster.
    expect(rosters).toHaveLength(1)

    teamStore.addMember({
      teamId: OFFICE, appId: 'app-a-writer', memberName: 'a-writer', role: 'Writer',
      isLead: false, aiProvisioned: false, addedAt: Date.now(),
    })
    hostManager.broadcastRosterFor(OFFICE)

    expect(rosters).toHaveLength(2)
    const latest = rosters[rosters.length - 1]
    const appIds = new Set(latest.members.map((m) => m.appId))
    expect(appIds.has('app-a-writer')).toBe(true)
    // Owner ids are absolute on the wire (host members → A's node id).
    expect(latest.members.find((m) => m.appId === LEAD_APP)!.ownerNodeId).toBe(NODE_A)
  })

  it('D-1: broadcastRosterFor on an office not hosted here is a silent no-op', () => {
    const { hostManager } = wireTwoNodes()
    expect(() => hostManager.broadcastRosterFor('not-hosted-office')).not.toThrow()
  })

  it('G-1: projectMemberRemoved broadcasts a term-stamped member-removed frame', () => {
    seedHostTeam()
    const m2: M2Frame[] = []
    const { hostManager, bLink } = wireTwoNodes()
    joinFromB(bLink, { onM2: (_from, f) => m2.push(f) })

    hostManager.projectMemberRemoved(OFFICE, HOST_MEMBER)

    const removed = m2.find((f) => f.kind === 'member-removed')
    expect(removed).toBeTruthy()
    expect(removed).toMatchObject({
      kind: 'member-removed',
      officeId: OFFICE,
      fromNode: NODE_A,
      appId: HOST_MEMBER,
    })
    // Term-stamped (host M2 off in this wiring → term 0), and carries an fid.
    expect((removed as { term: number }).term).toBe(0)
    expect((removed as { fid: string }).fid).toBeTruthy()
  })

  it('G-1: projectMemberRemoved on an unhosted office is a silent no-op', () => {
    const { hostManager } = wireTwoNodes()
    expect(() => hostManager.projectMemberRemoved('not-hosted', 'x')).not.toThrow()
  })

  it('G-3: projectOfficeDissolved broadcasts office-dissolved BEFORE local teardown', () => {
    seedHostTeam()
    const m2: M2Frame[] = []
    const { hostManager, bLink } = wireTwoNodes()
    joinFromB(bLink, { onM2: (_from, f) => m2.push(f) })

    expect(hostManager.listHostedOffices()).toEqual([OFFICE])
    hostManager.projectOfficeDissolved(OFFICE)

    const dissolved = m2.find((f) => f.kind === 'office-dissolved')
    expect(dissolved).toBeTruthy()
    expect(dissolved).toMatchObject({ kind: 'office-dissolved', officeId: OFFICE, fromNode: NODE_A })
    // Broadcast happens while the office is STILL hosted (frame rode the live link);
    // projectOfficeDissolved itself does not tear the host down — the caller does.
    expect(hostManager.listHostedOffices()).toEqual([OFFICE])
  })

  it('G-3: projectOfficeDissolved on an unhosted office is a silent no-op', () => {
    const { hostManager } = wireTwoNodes()
    expect(() => hostManager.projectOfficeDissolved('not-hosted')).not.toThrow()
  })

  it('B-2: an open run epoch rides the roster snapshot so the joiner can derive the live session key', () => {
    seedHostTeam()
    const rosters: RosterSnapshot[] = []
    const { bLink } = wireTwoNodes({ runEpoch: { teamId: OFFICE, epochId: EPOCH } })
    joinFromB(bLink, { onRoster: (snap) => rosters.push(snap) })

    expect(rosters).toHaveLength(1)
    expect(rosters[0].team.epochId).toBe(EPOCH)
  })

  it('B-2: no open run → the roster snapshot omits epochId (absent, not empty)', () => {
    seedHostTeam()
    const rosters: RosterSnapshot[] = []
    const { bLink } = wireTwoNodes({ runEpoch: null })
    joinFromB(bLink, { onRoster: (snap) => rosters.push(snap) })

    expect(rosters).toHaveLength(1)
    expect(rosters[0].team.epochId).toBeUndefined()
  })

  it('B-2: the epoch also rides a post-join re-broadcast (live run started after join)', () => {
    seedHostTeam()
    const rosters: RosterSnapshot[] = []
    const { hostManager, bLink } = wireTwoNodes({ runEpoch: { teamId: OFFICE, epochId: EPOCH } })
    joinFromB(bLink, { onRoster: (snap) => rosters.push(snap) })
    hostManager.broadcastRosterFor(OFFICE)

    expect(rosters.length).toBeGreaterThanOrEqual(2)
    expect(rosters[rosters.length - 1].team.epochId).toBe(EPOCH)
  })

  it('D-1: a roster frame is what B receives (kind+host id), not a diff', () => {
    seedHostTeam()
    const { hostManager, bLink, bReceived } = wireTwoNodes()
    joinFromB(bLink)
    bReceived.length = 0

    hostManager.broadcastRosterFor(OFFICE)
    const roster = bReceived.find((f): f is RosterFrame => f.kind === 'roster')
    expect(roster).toBeTruthy()
    expect(roster!.snapshot.team.hostNodeId).toBe(NODE_A)
  })
})
