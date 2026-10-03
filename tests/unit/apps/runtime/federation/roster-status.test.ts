/**
 * Roster egress by version. While members work only their run state moves, so a
 * joiner receives just that (`member-status`); an unchanged re-projection is an
 * empty status naming the current version, so a joiner that missed a change
 * asks for the roster.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createDatabaseManager } from '../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../src/main/platform/store/types'
import { FederationStore } from '../../../../../src/main/apps/federation/store'
import { initFederationStore, shutdownFederationStore } from '../../../../../src/main/apps/federation'
import { TeamStore } from '../../../../../src/main/apps/team/store'
import { MIGRATION_NAMESPACE as TEAM_NS, migrations as teamMigrations } from '../../../../../src/main/apps/team/migrations'
import { createFederationManager, type FederationManager } from '../../../../../src/main/apps/runtime/federation/manager'
import { FEDERATION_PROTOCOL_VERSION } from '../../../../../src/main/apps/runtime/federation/protocol-m2'
import { DEFAULT_OFFICE_SCOPE } from '../../../../../src/main/apps/federation/types'
import type { FederationMessage, MemberStatusFrame, RosterFrame } from '../../../../../src/main/apps/runtime/federation/types'
import type { TeamMemberRuntimeStatus } from '../../../../../src/shared/apps/team-types'

const OFFICE = 'office-roster'
const HOST = 'node-host'
const NEW = 'node-a'
const OLD = 'node-b'
const TOKEN = 't'

describe('roster egress by version (host)', () => {
  let dbManager: DatabaseManager
  let manager: FederationManager
  let received: Map<string, FederationMessage[]>
  let status: Record<string, TeamMemberRuntimeStatus>

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    initFederationStore({ db: dbManager })
    dbManager.runMigrations(db, TEAM_NS, teamMigrations)
    const teamStore = new TeamStore(db)
    const now = Date.now()
    teamStore.insertTeam({
      id: OFFICE, name: 'o', owningSpaceId: 's', goal: 'g', leadAppId: null, memberSourcing: 'manual',
      collabMode: 'structured', escalationRouting: 'user', status: 'idle', currentEpochId: null, createdAt: now, updatedAt: now,
    })
    teamStore.addMember({ teamId: OFFICE, appId: 'host-member', memberName: 'h', role: 'r', isLead: false, aiProvisioned: false, addedAt: now })
    received = new Map([[`c-${NEW}`, []], [`c-${OLD}`, []]])
    status = {}
    manager = createFederationManager({
      hostSend: (clientId, frame) => {
        received.get(clientId)?.push(frame)
        return true
      },
      hostListOfficeClients: () => [`c-${NEW}`, `c-${OLD}`],
      federationStore: new FederationStore(db),
      teamStore,
      verifyCredential: (token) => (token === TOKEN ? { officeId: OFFICE, scope: DEFAULT_OFFICE_SCOPE } : null),
      getLocalNodeId: () => HOST,
      getSessionIdentity: (clientId) => clientId.slice(2),
      getMemberRuntimeStatus: (appId) => status[appId] ?? 'idle',
    })
    manager.hostOffice(OFFICE)
    for (const node of [NEW, OLD]) {
      manager.handleHostInbound({
        clientId: `c-${node}`,
        officeId: OFFICE,
        frame: { kind: 'join-request', officeId: OFFICE, fromNode: node, identityId: node, displayName: node, credentialToken: TOKEN, pv: FEDERATION_PROTOCOL_VERSION, bringMembers: [] } as FederationMessage,
      })
    }
    for (const list of received.values()) list.length = 0
  })

  afterEach(() => {
    manager.stopAll()
    shutdownFederationStore()
    dbManager.closeAll()
  })

  /** The throttled refresh a board write schedules during a run. */
  function refresh(): void {
    vi.useFakeTimers()
    try {
      manager.scheduleRosterRefresh(OFFICE)
      vi.advanceTimersByTime(1000)
    } finally {
      vi.useRealTimers()
    }
  }

  it('run-state change: every joiner gets only the changed member', () => {
    status['host-member'] = 'working'
    refresh()
    const toNew = received.get(`c-${NEW}`)!
    const toOld = received.get(`c-${OLD}`)!
    expect(toNew.map((f) => f.kind)).toEqual(['member-status'])
    const delta = toNew[0] as MemberStatusFrame
    expect(delta.members).toEqual([{ appId: 'host-member', status: 'working' }])
    expect(delta.version).toBe(delta.baseVersion + 1)
    expect(toOld).toEqual(toNew)
  })

  it('an unchanged re-projection is an empty status at the current version', () => {
    status['host-member'] = 'working'
    refresh()
    const version = (received.get(`c-${NEW}`)![0] as MemberStatusFrame).version
    refresh()
    const beat = received.get(`c-${NEW}`)![1] as MemberStatusFrame
    expect(beat.kind).toBe('member-status')
    expect(beat.members).toEqual([])
    expect(beat.baseVersion).toBe(version)
    expect(beat.version).toBe(version)
  })

  it('a roster-request is answered with the full roster at the current version', () => {
    status['host-member'] = 'working'
    refresh()
    received.get(`c-${NEW}`)!.length = 0
    manager.handleHostInbound({ clientId: `c-${NEW}`, officeId: OFFICE, frame: { kind: 'roster-request', officeId: OFFICE, fromNode: NEW } })
    const answer = received.get(`c-${NEW}`)!
    expect(answer.map((f) => f.kind)).toEqual(['roster'])
    expect((answer[0] as RosterFrame).version).toBeGreaterThan(0)
  })

  it('sustained run-state churn never resends the full roster', () => {
    vi.useFakeTimers()
    try {
      for (let i = 0; i < 20; i++) {
        status['host-member'] = i % 2 === 0 ? 'working' : 'idle'
        manager.scheduleRosterRefresh(OFFICE)
        vi.advanceTimersByTime(10_000)
      }
    } finally {
      vi.useRealTimers()
    }
    expect(received.get(`c-${NEW}`)!.filter((f) => f.kind === 'roster')).toHaveLength(0)
    expect(received.get(`c-${NEW}`)!.filter((f) => f.kind === 'member-status').length).toBeGreaterThan(0)
  })

  it('a membership change goes out as the full roster to everyone', () => {
    manager.broadcastRosterFor(OFFICE)
    expect(received.get(`c-${NEW}`)!.map((f) => f.kind)).toEqual(['roster'])
    expect(received.get(`c-${OLD}`)!.map((f) => f.kind)).toEqual(['roster'])
  })
})

describe('joined office applies run state by version', () => {
  it('applies a status on top of its snapshot and ignores one that does not line up', () => {
    const dbm = createDatabaseManager(':memory:')
    const db = dbm.getAppDatabase()
    dbm.runMigrations(db, TEAM_NS, teamMigrations)
    const store = new TeamStore(db)
    store.materializeJoinedOffice({
      hostNodeId: HOST, selfNodeId: NEW,
      snapshot: {
        team: { id: OFFICE, name: 'o', goal: 'g', leadAppId: null, collabMode: 'structured', hostNodeId: HOST, status: 'idle' },
        members: [{ appId: 'm1', memberName: 'm1', role: 'r', isLead: false, ownerNodeId: HOST, memberIdentity: null, ownerDisplayName: null, status: 'working' }],
        edges: [],
      },
    })
    expect(store.getJoinedMemberStatuses(OFFICE).get('m1')).toBe('working')
    store.applyJoinedMemberStatus(OFFICE, { status: 'running', members: [{ appId: 'm1', status: 'idle' }] })
    expect(store.getJoinedMemberStatuses(OFFICE).get('m1')).toBeUndefined()
    expect(store.getTeamById(OFFICE)?.status).toBe('running')
    dbm.closeAll()
  })
})

describe('joined office: member-status by version (manager)', () => {
  it('applies a status on its version, refuses one that does not line up', async () => {
    const dbm = createDatabaseManager(':memory:')
    const db = dbm.getAppDatabase()
    initFederationStore({ db: dbm })
    dbm.runMigrations(db, TEAM_NS, teamMigrations)
    const teamStore = new TeamStore(db)
    const joiner = createFederationManager({
      hostSend: () => false,
      hostListOfficeClients: () => [],
      federationStore: new FederationStore(db),
      teamStore,
      verifyCredential: () => null,
      getLocalNodeId: () => NEW,
    })
    await joiner.joinOffice({
      officeId: OFFICE, serverUrl: 'http://127.0.0.1:1', credentialToken: 't',
      selfContext: { officeId: OFFICE, selfNodeId: NEW }, bringMembers: [],
    })
    const roster: RosterFrame = {
      kind: 'roster', officeId: OFFICE, version: 3,
      snapshot: {
        team: { id: OFFICE, name: 'o', goal: 'g', leadAppId: null, collabMode: 'structured', hostNodeId: HOST, status: 'idle' },
        members: [{ appId: 'm1', memberName: 'm1', role: 'r', isLead: false, ownerNodeId: HOST, memberIdentity: null, ownerDisplayName: null }],
        edges: [],
      },
    }
    joiner.deliverInbound(OFFICE, roster, HOST)
    joiner.deliverInbound(OFFICE, { kind: 'member-status', officeId: OFFICE, baseVersion: 3, version: 4, members: [{ appId: 'm1', status: 'working' }] }, HOST)
    expect(teamStore.getJoinedMemberStatuses(OFFICE).get('m1')).toBe('working')
    // A status on a version this node never saw (one was lost) is not applied.
    joiner.deliverInbound(OFFICE, { kind: 'member-status', officeId: OFFICE, baseVersion: 9, version: 10, members: [{ appId: 'm1', status: 'idle' }] }, HOST)
    expect(teamStore.getJoinedMemberStatuses(OFFICE).get('m1')).toBe('working')
    joiner.stopAll()
    shutdownFederationStore()
    dbm.closeAll()
  })
})
