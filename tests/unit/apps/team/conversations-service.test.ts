/**
 * Service-level tests for the conversation surface + pending-escalation
 * aggregation:
 *   - listConversations projects open conversation epochs with resolved labels,
 *     kinds, readonly flags, and active/waiting state.
 *   - openConversation mints a native session; renameConversation relabels it.
 *   - getTeamDetail carries pendingEscalations; listTeamItems counts waiting.
 *
 * A REAL in-memory TeamStore backs the runtime mock so epoch lifecycle is
 * exercised end-to-end; the App Manager + emitters are mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { broadcastToAll, sendToRenderer } = vi.hoisted(() => ({
  broadcastToAll: vi.fn(),
  sendToRenderer: vi.fn(),
}))
vi.mock('../../../../src/main/http/websocket', () => ({ broadcastToAll }))
vi.mock('../../../../src/main/foundation/window.service', () => ({ sendToRenderer }))

import { randomUUID } from 'crypto'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import { TeamStore } from '../../../../src/main/apps/team/store'
import { MIGRATION_NAMESPACE, migrations } from '../../../../src/main/apps/team/migrations'
import { createTeamService } from '../../../../src/main/apps/team/service'
import type { TeamServiceDeps, PendingEscalationRecord } from '../../../../src/main/apps/team/service'
import type { Team, TeamMember, TeamEpoch, RosterBusyEntry } from '../../../../src/shared/apps/team-types'
import { nativeConversationChatKey, memberChatKey } from '../../../../src/shared/apps/im-keys'

const SPACE = 'space-a'
const TEAM_ID = 'team-1'
const LEAD_APP = 'lead-app'
const MEMBER_APP = 'member-app'

function seedTeam(store: TeamStore): void {
  const now = Date.now()
  const team: Team = {
    id: TEAM_ID, name: 'Team', owningSpaceId: SPACE, goal: 'g', leadAppId: LEAD_APP,
    memberSourcing: 'manual', collabMode: 'free', escalationRouting: 'user',
    status: 'idle', currentEpochId: null, createdAt: now, updatedAt: now,
  }
  store.insertTeam(team)
  const members: TeamMember[] = [
    { teamId: TEAM_ID, appId: LEAD_APP, memberName: 'Lead', role: 'Lead', isLead: true, aiProvisioned: false, addedAt: now },
    { teamId: TEAM_ID, appId: MEMBER_APP, memberName: 'Alice', role: 'R', isLead: false, aiProvisioned: false, addedAt: now },
  ]
  for (const m of members) store.addMember(m)
}

/** Minimal runtime mock backed by the real store for epoch lifecycle. */
function makeRuntime(store: TeamStore, busyByApp: Map<string, RosterBusyEntry[]>) {
  return {
    bus: {} as never,
    blackboard: { postTask: vi.fn(), updateTask: vi.fn(), postFinding: vi.fn(), readBoard: vi.fn(() => ({ tasks: [], findings: [], roster: [] })) } as never,
    getMemberStatus: () => 'idle' as const,
    getObservableStatus: (teamId: string) => store.getTeamById(teamId)?.status ?? 'idle',
    getMemberBusy: (appId: string) => busyByApp.get(appId) ?? [],
    startEpoch: vi.fn(),
    ensureConversationEpoch: (teamId: string, chatKey: string, title?: string): TeamEpoch => {
      const existing = store.getOpenConversationEpoch(teamId, chatKey)
      if (existing) return existing
      const epoch: TeamEpoch = {
        id: randomUUID(), teamId, startedAt: Date.now(), endedAt: null, endReason: null,
        summary: null, lifecycle: 'conversation', chatKey, title: title ?? null,
      }
      store.insertEpoch(epoch, 'event')
      return epoch
    },
    renameConversationEpoch: (teamId: string, epochId: string, title: string | null) => store.renameEpoch(epochId, title),
    noteEpochTurn: vi.fn(),
    sealEpoch: vi.fn(),
    sealConversationEpoch: vi.fn(async (teamId: string, epochId: string) => store.endEpoch(epochId, Date.now(), 'stopped', null)),
    requestSeal: vi.fn(),
    captureReport: vi.fn(),
    buildPromptContext: vi.fn(),
    resumeFromEscalation: vi.fn(),
    checks: { viewForTeam: () => [], cancelById: vi.fn() },
  }
}

describe('TeamService — conversations + pending escalations', () => {
  let dbManager: DatabaseManager
  let store: TeamStore
  let busyByApp: Map<string, RosterBusyEntry[]>
  let pending: PendingEscalationRecord[]

  function build() {
    const runtime = makeRuntime(store, busyByApp)
    const deps: TeamServiceDeps = {
      store,
      appManager: { getApp: (id: string) => ({ id, spaceId: SPACE, spec: { name: id } }) } as never,
      getRuntime: () => runtime as never,
      spaces: { spaceExists: () => true, createMemberSpace: () => 'ms' },
      listArtifacts: vi.fn(async () => []),
      proposeMembersFromGoal: vi.fn(async () => []),
      getPendingEscalations: () => pending,
      describeChatKey: () => 'WeCom Group',
    }
    return createTeamService(deps)
  }

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
    store = new TeamStore(db)
    seedTeam(store)
    busyByApp = new Map()
    pending = []
    broadcastToAll.mockClear()
    sendToRenderer.mockClear()
  })

  afterEach(() => { dbManager.closeAll() })

  it('new tasks addressed to the same member have independent contexts and titles', () => {
    const svc = build()
    const first = svc.openConversation(TEAM_ID, 'First request', MEMBER_APP)
    const second = svc.openConversation(TEAM_ID, 'Second request', MEMBER_APP)
    expect(first.epochId).not.toBe(second.epochId)
    expect(store.getEpochById(first.epochId)!.title).toBe('First request')
    expect(store.getEpochById(second.epochId)!.title).toBe('Second request')
  })

  it('conversation summaries do not materialize activity bodies or repeat member reads', () => {
    const svc = build()
    for (let index = 0; index < 200; index++) svc.openConversation(TEAM_ID, `Task ${index}`)
    const activities = vi.spyOn(store, 'listActivityByTeam')
    const members = vi.spyOn(store, 'listMembersByTeam')
    expect(svc.listConversations(TEAM_ID)).toHaveLength(200)
    expect(activities).not.toHaveBeenCalled()
    expect(members).toHaveBeenCalledTimes(1)
  })

  it('openConversation mints a native session, listConversations projects it', () => {
    const svc = build()
    const { epochId } = svc.openConversation(TEAM_ID, 'Weekly plan')
    const list = svc.listConversations(TEAM_ID)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ epochId, kind: 'native', label: 'Weekly plan', readonly: false })
  })

  it('projects member / IM conversations with the right kind, label and readonly', () => {
    const svc = build()
    // A member direct thread → labels as the member's name, writable.
    store.insertEpoch({
      id: 'c-mem', teamId: TEAM_ID, startedAt: 2, endedAt: null, endReason: null, summary: null,
      lifecycle: 'conversation', chatKey: memberChatKey(MEMBER_APP),
    })
    // An IM chat → read-only, labeled via describeChatKey.
    store.insertEpoch({
      id: 'c-im', teamId: TEAM_ID, startedAt: 1, endedAt: null, endReason: null, summary: null,
      lifecycle: 'conversation', chatKey: 'instance-1:group:g123',
    })
    const list = svc.listConversations(TEAM_ID)
    const mem = list.find(c => c.epochId === 'c-mem')!
    const im = list.find(c => c.epochId === 'c-im')!
    expect(mem).toMatchObject({ kind: 'member', memberAppId: MEMBER_APP, label: 'Alice', readonly: false })
    expect(im).toMatchObject({ kind: 'im', readonly: true, label: 'WeCom Group', channel: 'im' })
  })

  it('flags a conversation active when a member is busy on it', () => {
    const svc = build()
    const { epochId } = svc.openConversation(TEAM_ID)
    busyByApp.set(MEMBER_APP, [{ epochId, kind: 'conversation', label: '' }])
    expect(svc.listConversations(TEAM_ID).find(c => c.epochId === epochId)?.active).toBe(true)
  })

  it('projects a teammate decision as visible but not answerable on this machine', () => {
    const svc = build()
    const { epochId } = svc.openConversation(TEAM_ID, 'Review')
    store.updateMemberFields(TEAM_ID, MEMBER_APP, { awaitingDecision: true })
    store.insertActivity({
      id: 'decision-request:entry-1', teamId: TEAM_ID, epochId, kind: 'decision',
      actorAppId: MEMBER_APP, targetAppId: null, subject: 'Approve?', body: 'Approve the proposed change?',
      refId: 'entry-1', correlationId: null, status: 'escalation', createdAt: 100,
    })

    expect(svc.listConversations(TEAM_ID).find(item => item.epochId === epochId)).toMatchObject({
      waitingUser: true,
      waitingForMe: false,
      waitingMemberAppIds: [MEMBER_APP],
    })

    store.insertActivity({
      id: 'decision:entry-1', teamId: TEAM_ID, epochId, kind: 'decision',
      actorAppId: MEMBER_APP, targetAppId: null, subject: 'Approve?', body: 'Approved',
      refId: 'entry-1', correlationId: null, status: 'ok', createdAt: 200,
    })
    expect(svc.listConversations(TEAM_ID).find(item => item.epochId === epochId)).toMatchObject({
      waitingUser: false,
      waitingForMe: false,
    })
  })

  it('projects a remote decision on a joined office from roster state until its shared answer arrives', () => {
    const svc = build()
    store.materializeJoinedOffice({
      hostNodeId: 'host-1',
      selfNodeId: 'viewer-1',
      snapshot: {
        team: { id: TEAM_ID, name: 'Team', goal: 'g', leadAppId: LEAD_APP, collabMode: 'free' },
        members: [
          { appId: LEAD_APP, memberName: 'Lead', role: 'Lead', isLead: true, ownerNodeId: 'host-1', memberIdentity: null },
          { appId: MEMBER_APP, memberName: 'Alice', role: 'R', isLead: false, ownerNodeId: 'owner-2', memberIdentity: null, status: 'waiting_user' },
        ],
        edges: [],
      },
    })
    store.insertEpoch({
      id: 'remote-decision-task', teamId: TEAM_ID, startedAt: 100, endedAt: null, endReason: null,
      summary: null, lifecycle: 'conversation', chatKey: nativeConversationChatKey('remote-decision'),
    })
    store.insertActivity({
      id: 'decision-request:remote-entry', teamId: TEAM_ID, epochId: 'remote-decision-task', kind: 'decision',
      actorAppId: MEMBER_APP, targetAppId: null, subject: 'Approve?', body: 'Approve the remote change?',
      refId: 'remote-entry', correlationId: null, status: 'escalation', createdAt: 100,
    })

    expect(store.getMember(TEAM_ID, MEMBER_APP)?.awaitingDecision).toBe(false)
    expect(svc.listConversations(TEAM_ID).find(item => item.epochId === 'remote-decision-task')).toMatchObject({
      waitingUser: true,
      waitingForMe: false,
      waitingMemberAppIds: [MEMBER_APP],
    })

    store.insertActivity({
      id: 'decision:remote-entry', teamId: TEAM_ID, epochId: 'remote-decision-task', kind: 'decision',
      actorAppId: MEMBER_APP, targetAppId: null, subject: 'Approve?', body: 'Approved',
      refId: 'remote-entry', correlationId: null, status: 'ok', createdAt: 200,
    })
    expect(svc.listConversations(TEAM_ID).find(item => item.epochId === 'remote-decision-task')).toMatchObject({
      waitingUser: false,
      waitingForMe: false,
    })
  })

  it('merges a locally answerable decision with shared task state without duplicating its member', () => {
    const svc = build()
    const { epochId } = svc.openConversation(TEAM_ID, 'Local review')
    pending = [{
      appId: MEMBER_APP,
      entryId: 'entry-local',
      question: 'Proceed?',
      teamId: TEAM_ID,
      epochId,
    }]
    store.updateMemberFields(TEAM_ID, MEMBER_APP, { awaitingDecision: true })
    store.insertActivity({
      id: 'decision-request:entry-local', teamId: TEAM_ID, epochId, kind: 'decision',
      actorAppId: MEMBER_APP, targetAppId: null, subject: 'Proceed?', body: 'Proceed with the rollout?',
      refId: 'entry-local', correlationId: null, status: 'escalation', createdAt: 100,
    })

    expect(svc.listConversations(TEAM_ID).find(item => item.epochId === epochId)).toMatchObject({
      waitingUser: true,
      waitingForMe: true,
      waitingMemberAppIds: [MEMBER_APP],
    })
  })

  it('on a JOINED office, active is derived from the federated roster busy, not local sessions', () => {
    const svc = build()
    // Turn TEAM_ID into a joined (shadow) office whose lead is busy on a
    // conversation — the "busy" arrives via the host's roster snapshot, since a
    // joiner has no local sessions for host-run work. Without the joined branch
    // this conversation would read idle and never enter "busy now".
    store.materializeJoinedOffice({
      hostNodeId: 'host-1',
      selfNodeId: 'self-1',
      snapshot: {
        team: { id: TEAM_ID, name: 'T', goal: 'g', leadAppId: LEAD_APP, collabMode: 'free' },
        members: [
          {
            appId: LEAD_APP, memberName: 'Lead', role: 'Lead', isLead: true,
            ownerNodeId: 'host-1', memberIdentity: null,
            busy: [{ epochId: 'conv-joined', kind: 'conversation', label: 'topic' }],
          },
        ],
        edges: [],
      },
    })
    store.insertEpoch({
      id: 'conv-joined', teamId: TEAM_ID, startedAt: 1, endedAt: null, endReason: null, summary: null,
      lifecycle: 'conversation', chatKey: nativeConversationChatKey('u1'),
    })
    // The local runtime's getMemberBusy is empty (no local sessions), so the ONLY
    // way this is active is the federated roster busy — exactly the joiner case.
    busyByApp = new Map()
    const conv = svc.listConversations(TEAM_ID).find(c => c.epochId === 'conv-joined')
    expect(conv?.active).toBe(true)
  })

  it('renameConversation relabels the session', () => {
    const svc = build()
    const { epochId } = svc.openConversation(TEAM_ID, 'A')
    svc.renameConversation(TEAM_ID, epochId, 'B')
    expect(svc.listConversations(TEAM_ID).find(c => c.epochId === epochId)?.label).toBe('B')
  })

  it('archiveConversation retains a completed task in the list', async () => {
    const svc = build()
    const { epochId } = svc.openConversation(TEAM_ID)
    await svc.archiveConversation(TEAM_ID, epochId)
    expect(svc.listConversations(TEAM_ID)).toEqual([expect.objectContaining({ epochId, completed: true })])
  })

  it('getTeamDetail carries the team\u2019s pending escalations; other teams\u2019 are excluded', () => {
    const svc = build()
    pending = [
      { appId: MEMBER_APP, entryId: 'e1', question: 'Pick A or B?', teamId: TEAM_ID },
      { appId: 'someone-else', entryId: 'e2', question: 'unrelated', teamId: 'other-team' },
    ]
    const detail = svc.getTeamDetail(TEAM_ID)!
    expect(detail.pendingEscalations).toHaveLength(1)
    expect(detail.pendingEscalations![0]).toMatchObject({ appId: MEMBER_APP, memberName: 'Alice', question: 'Pick A or B?' })
  })

  it('listTeamItems counts waiting decisions independent of run status', () => {
    const svc = build()
    pending = [{ appId: MEMBER_APP, entryId: 'e1', question: 'q', teamId: TEAM_ID }]
    const item = svc.listTeamItems(SPACE).find(t => t.id === TEAM_ID)!
    expect(item.waitingCount).toBe(1)
    expect(item.hasWaitingUser).toBe(true)
  })
})
