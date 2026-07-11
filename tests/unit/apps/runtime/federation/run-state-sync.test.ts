/**
 * Unit tests for apps/runtime/federation -- live run-state propagation.
 *
 * The signature-demo gap: when the HOST runs the team, only the structural roster
 * + the blackboard DATA replicated to a JOINER; the live RUN STATE (team running
 * status + per-member working/idle churn) never crossed the wire, so the joiner's
 * status board stayed "Ready / no recent activity". These tests pin the three
 * additive propagation pieces:
 *
 *   1. SNAPSHOT — buildRosterSnapshot stamps team.status + each member's live
 *      runtime status (+ the in-progress task title) from the injected seam.
 *   2. JOINER — materializeJoinedOffice persists team.status and exposes the
 *      transient per-member runtime-status overlay for the status board.
 *   3. EGRESS — run start/stop re-projects the roster immediately; a board write
 *      schedules a throttled (coalesced) re-projection so a busy run never floods.
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
import { createFederationManager } from '../../../../../src/main/apps/runtime/federation/manager'
import { LanMeshLink } from '../../../../../src/main/apps/runtime/federation/lan-mesh-provider'
import { SELF_NODE_ID } from '../../../../../src/shared/apps/team-types'
import type { Team } from '../../../../../src/main/apps/team/types'
import type { TeamMemberRuntimeStatus } from '../../../../../src/shared/apps/team-types'
import type {
  FederationMessage,
  JoinRequest,
  OfficeCredentialLike,
  RosterFrame,
  RosterSnapshot,
} from '../../../../../src/main/apps/runtime/federation'
import type { BlackboardWriteRecord } from '../../../../../src/main/apps/runtime/team'

const OFFICE = 'office-1'
const NODE_A = 'node-a-host'
const NODE_B = 'node-b-joiner'
const B_CLIENT_ID = 'ws-client-b'
const VALID_TOKEN = 'valid-token'
const LEAD_APP = 'app-a-lead'
const HOST_MEMBER = 'app-a-analyst'
const B_MEMBER = 'app-b-1'
const EPOCH = 'epoch-live-1'

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

describe('federation live run-state propagation', () => {
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

  /** Host manager + a joiner bridge; captures every frame B receives. */
  function wireTwoNodes(opts?: {
    getMemberRuntimeStatus?: (appId: string) => TeamMemberRuntimeStatus
    getCurrentRunEpoch?: (officeId: string) => { teamId: string; epochId: string } | null
  }) {
    const verify = (token: string): OfficeCredentialLike | null =>
      token === VALID_TOKEN ? { officeId: OFFICE } : null
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
      getMemberRuntimeStatus: opts?.getMemberRuntimeStatus,
      getCurrentRunEpoch: opts?.getCurrentRunEpoch,
    })

    hostManager.hostOffice(OFFICE)
    return { hostManager, bReceived }
  }

  function joinRequestFromB(): JoinRequest {
    return {
      kind: 'join-request', officeId: OFFICE, fromNode: NODE_B, identityId: 'identity-b',
      displayName: 'Node B', credentialToken: VALID_TOKEN,
      bringMembers: [{ appId: B_MEMBER, memberName: 'b-analyst', role: 'Analyst' }],
    }
  }

  function lastRoster(bReceived: FederationMessage[]): RosterSnapshot {
    const frames = bReceived.filter((f): f is RosterFrame => f.kind === 'roster')
    expect(frames.length).toBeGreaterThan(0)
    return frames[frames.length - 1].snapshot
  }

  // ── 1. Snapshot carries run-state ──────────────────────────────────────────

  it('snapshot reflects working member: status=working + currentTaskTitle present', () => {
    seedHostTeam({ status: 'running', currentEpochId: EPOCH })
    teamStore.insertTask({
      id: 't1', teamId: OFFICE, epochId: EPOCH, title: 'Draft the brief',
      assigneeAppId: HOST_MEMBER, status: 'in_progress', resultRef: null, note: null,
      parentId: null, createdByAppId: LEAD_APP, createdAt: Date.now(), updatedAt: Date.now(),
    })

    const status: Record<string, TeamMemberRuntimeStatus> = { [HOST_MEMBER]: 'working' }
    const { hostManager, bReceived } = wireTwoNodes({
      getMemberRuntimeStatus: (appId) => status[appId] ?? 'idle',
      getCurrentRunEpoch: () => ({ teamId: OFFICE, epochId: EPOCH }),
    })
    hostManager.handleHostInbound({ clientId: B_CLIENT_ID, officeId: OFFICE, frame: joinRequestFromB() })

    const snap = lastRoster(bReceived)
    expect(snap.team.status).toBe('running')
    const byApp = new Map(snap.members.map((m) => [m.appId, m]))
    expect(byApp.get(HOST_MEMBER)!.status).toBe('working')
    expect(byApp.get(HOST_MEMBER)!.currentTaskTitle).toBe('Draft the brief')
    // An idle member carries no task title.
    expect(byApp.get(LEAD_APP)!.status).toBe('idle')
    expect(byApp.get(LEAD_APP)!.currentTaskTitle).toBeUndefined()
  })

  // ── 2. Joiner persists run-state + overlays member status ───────────────────

  it('materializeJoinedOffice persists team.status and exposes the member-status overlay', () => {
    const snapshot: RosterSnapshot = {
      team: {
        id: OFFICE, name: 'Research Office', goal: 'g', leadAppId: LEAD_APP,
        collabMode: 'structured', hostNodeId: NODE_A, epochId: EPOCH, status: 'running',
      },
      members: [
        { appId: LEAD_APP, memberName: 'lead', role: 'Lead', isLead: true, ownerNodeId: NODE_A, memberIdentity: 'identity-a', ownerDisplayName: 'Host A', status: 'idle' },
        { appId: HOST_MEMBER, memberName: 'a-analyst', role: 'Analyst', isLead: false, ownerNodeId: NODE_A, memberIdentity: 'identity-a', ownerDisplayName: 'Host A', status: 'working', currentTaskTitle: 'Draft the brief' },
        { appId: B_MEMBER, memberName: 'b-analyst', role: 'Analyst', isLead: false, ownerNodeId: NODE_B, memberIdentity: 'identity-b', ownerDisplayName: 'Node B', status: 'idle' },
      ],
      edges: [],
    }

    teamStore.materializeJoinedOffice({ hostNodeId: NODE_A, selfNodeId: NODE_B, snapshot })

    // The shadow office is RUNNING (the run banner goes live), not stuck idle.
    expect(teamStore.getTeamById(OFFICE)!.status).toBe('running')
    expect(teamStore.getTeamById(OFFICE)!.currentEpochId).toBe(EPOCH)

    // The transient overlay exposes the working member so the topology animates.
    const statuses = teamStore.getJoinedMemberStatuses(OFFICE)
    expect(statuses.get(HOST_MEMBER)).toBe('working')
    expect(statuses.has(LEAD_APP)).toBe(false) // idle members are not stored
    expect(teamStore.getJoinedMemberTaskTitle(OFFICE, HOST_MEMBER)).toBe('Draft the brief')
  })

  it('overlay is replaced wholesale per snapshot (member goes back to idle)', () => {
    const running: RosterSnapshot = {
      team: { id: OFFICE, name: 'O', goal: 'g', leadAppId: LEAD_APP, collabMode: 'free', hostNodeId: NODE_A, epochId: EPOCH, status: 'running' },
      members: [{ appId: HOST_MEMBER, memberName: 'a', role: 'r', isLead: false, ownerNodeId: NODE_A, memberIdentity: 'id-a', ownerDisplayName: 'A', status: 'working', currentTaskTitle: 'task' }],
      edges: [],
    }
    teamStore.materializeJoinedOffice({ hostNodeId: NODE_A, selfNodeId: NODE_B, snapshot: running })
    expect(teamStore.getJoinedMemberStatuses(OFFICE).get(HOST_MEMBER)).toBe('working')

    const rested: RosterSnapshot = {
      team: { ...running.team, status: 'idle', epochId: undefined },
      members: [{ ...running.members[0], status: 'idle', currentTaskTitle: undefined }],
      edges: [],
    }
    teamStore.materializeJoinedOffice({ hostNodeId: NODE_A, selfNodeId: NODE_B, snapshot: rested })
    expect(teamStore.getJoinedMemberStatuses(OFFICE).has(HOST_MEMBER)).toBe(false)
    expect(teamStore.getTeamById(OFFICE)!.status).toBe('idle')
  })

  // ── 3. Throttled egress ────────────────────────────────────────────────────

  it('scheduleRosterRefresh coalesces a burst into one re-projection (throttle)', () => {
    vi.useFakeTimers()
    try {
      seedHostTeam({ status: 'running', currentEpochId: EPOCH })
      const { hostManager, bReceived } = wireTwoNodes({
        getCurrentRunEpoch: () => ({ teamId: OFFICE, epochId: EPOCH }),
      })
      // Admit B so the host has a joiner to project to.
      hostManager.handleHostInbound({ clientId: B_CLIENT_ID, officeId: OFFICE, frame: joinRequestFromB() })
      const baseline = bReceived.filter((f) => f.kind === 'roster').length

      // A burst of member-status churn (simulated as repeated schedule calls).
      for (let i = 0; i < 25; i++) hostManager.scheduleRosterRefresh(OFFICE)

      // Nothing extra fired synchronously (coalesced behind the timer).
      expect(bReceived.filter((f) => f.kind === 'roster').length).toBe(baseline)

      // After the coalesce window, exactly ONE additional roster went out.
      vi.advanceTimersByTime(1000)
      expect(bReceived.filter((f) => f.kind === 'roster').length).toBe(baseline + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a board write schedules the throttled roster refresh (routeAuthorityWrite)', () => {
    vi.useFakeTimers()
    try {
      seedHostTeam({ status: 'running', currentEpochId: EPOCH })
      const { hostManager, bReceived } = wireTwoNodes({
        getCurrentRunEpoch: () => ({ teamId: OFFICE, epochId: EPOCH }),
      })
      hostManager.handleHostInbound({ clientId: B_CLIENT_ID, officeId: OFFICE, frame: joinRequestFromB() })
      const baseline = bReceived.filter((f) => f.kind === 'roster').length

      const write: BlackboardWriteRecord = {
        teamId: OFFICE, epochId: EPOCH, op: 'update_task',
        payload: { taskId: 't1', status: 'in_progress', updatedAt: Date.now() }, taskId: 't1',
      }
      hostManager.routeAuthorityWrite(write)
      hostManager.routeAuthorityWrite(write)
      vi.advanceTimersByTime(1000)
      expect(bReceived.filter((f) => f.kind === 'roster').length).toBe(baseline + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('scheduleRosterRefresh is a no-op for an office not hosted here', () => {
    // No hostOffice → manager hosts nothing; a refresh must not throw or emit.
    const { hostManager, bReceived } = (() => {
      const received: FederationMessage[] = []
      const mgr = createFederationManager({
        hostSend: () => false,
        hostListOfficeClients: () => [],
        federationStore,
        teamStore,
        verifyCredential: () => null,
        getLocalNodeId: () => NODE_A,
      })
      return { hostManager: mgr, bReceived: received }
    })()

    expect(() => hostManager.scheduleRosterRefresh('not-hosted')).not.toThrow()
    expect(bReceived).toHaveLength(0)
  })
})
