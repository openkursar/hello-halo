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
import type { Team, TeamMember, TeamEpoch, RosterBusyEntry, EpochEndReason } from '../../../../src/shared/apps/team-types'
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
    ensureConversationEpoch: (teamId: string, chatKey: string, title?: string, createdBy?: string, entryAppId?: string): TeamEpoch => {
      const existing = store.getOpenConversationEpoch(teamId, chatKey)
      if (existing) return existing
      const epoch: TeamEpoch = {
        id: randomUUID(), teamId, startedAt: Date.now(), endedAt: null, endReason: null,
        summary: null, lifecycle: 'conversation', chatKey, title: title ?? null,
      }
      store.insertEpoch(epoch, 'event')
      if (createdBy || entryAppId) store.updateWorkItem(epoch.id, { ...(createdBy ? { createdBy } : {}), ...(entryAppId ? { entryAppId } : {}) })
      return epoch
    },
    renameConversationEpoch: (teamId: string, epochId: string, title: string | null) => store.renameEpoch(epochId, title),
    noteEpochTurn: vi.fn(),
    sealEpoch: vi.fn(),
    sealConversationEpoch: vi.fn(async (teamId: string, epochId: string, reason: EpochEndReason = 'stopped') => store.endEpoch(epochId, Date.now(), reason, null)),
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
    return createTeamService(buildDeps())
  }

  function buildDeps(): TeamServiceDeps {
    const runtime = makeRuntime(store, busyByApp)
    return {
      store,
      appManager: { getApp: (id: string) => ({ id, spaceId: SPACE, spec: { name: id } }), listApps: ({ spaceId }: { spaceId: string }) => spaceId === SPACE ? [{ id: LEAD_APP }, { id: MEMBER_APP }] : [] } as never,
      getRuntime: () => runtime as never,
      spaces: { spaceExists: () => true, createMemberSpace: () => 'ms' },
      listArtifacts: vi.fn(async () => []),
      proposeMembersFromGoal: vi.fn(async () => []),
      getPendingEscalations: () => pending,
      describeChatKey: () => 'WeCom Group',
    }
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

  it('pages native homepage tasks without reading whole-team histories', async () => {
    const svc = build()
    const first = await svc.openConversation(TEAM_ID, 'First', MEMBER_APP)
    const second = await svc.openConversation(TEAM_ID, 'Second', MEMBER_APP)
    const fullRead = vi.spyOn(store, 'listEpochsByTeam')
    const stats = vi.spyOn(store, 'getConversationStats')
    const page = svc.listNativeTasks({ spaceId: SPACE, limit: 1 })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({ teamId: TEAM_ID, teamName: 'Team', spaceId: SPACE, kind: 'native' })
    expect(page.nextCursor).toBeTruthy()
    const next = svc.listNativeTasks({ spaceId: SPACE, limit: 1, cursor: page.nextCursor! })
    expect(new Set([...page.items, ...next.items].map(item => item.epochId))).toEqual(new Set([first.epochId, second.epochId]))
    expect(next.nextCursor).toBeNull()
    expect(fullRead).not.toHaveBeenCalled()
    expect(stats.mock.calls.every(call => call[2]?.length === 1 && call[3] === false)).toBe(true)
    expect(svc.listNativeTasks({ spaceId: 'other' }).items).toEqual([])
    expect(() => svc.listNativeTasks({ spaceId: 'other', cursor: page.nextCursor! })).toThrow('cursor')
    expect(() => svc.listNativeTasks({ spaceId: SPACE, limit: 0 })).toThrow('limit')
  })

  it('resolves old pins within space scope without a continuation cursor', async () => {
    const svc = build()
    const old = await svc.openConversation(TEAM_ID, 'Pinned', MEMBER_APP)
    for (let i = 0; i < 31; i++) {
      const recent = await svc.openConversation(TEAM_ID, `Recent ${i}`, MEMBER_APP)
      store.touchEpoch(recent.epochId, Date.now() + 1000 + i)
    }
    expect(svc.listNativeTasks({ spaceId: SPACE }).items.map(item => item.epochId)).not.toContain(old.epochId)
    const epochIds = [old.epochId, 'missing', old.epochId]
    const page = svc.listNativeTasks({ spaceId: SPACE, epochIds, limit: 100 })
    expect(page.items.map(item => item.epochId)).toEqual([old.epochId])
    expect(page.nextCursor).toBeNull()
    expect(svc.listNativeTasks({ spaceId: 'other', epochIds }).items).toEqual([])
    expect(svc.listNativeTasks({ spaceId: SPACE, epochIds: [] })).toEqual({ items: [], nextCursor: null })
    const allIds = store.listEpochsByTeam(TEAM_ID).map(epoch => epoch.id)
    expect(svc.listNativeTasks({ spaceId: SPACE, epochIds: allIds, limit: 1 }).items).toHaveLength(1)
    expect(svc.listNativeTasks({ spaceId: SPACE, epochIds: allIds, limit: 1 }).nextCursor).toBeNull()
  })

  it.each([null, 'task', {}, [1], [''], ['   '], Array(101).fill('task')])(
    'rejects invalid exact IDs %j', epochIds => {
      const svc = build()
      const query = vi.spyOn(store, 'listNativeTaskEpochs')
      expect(() => svc.listNativeTasks({ spaceId: SPACE, epochIds: epochIds as never })).toThrow('epochIds')
      expect(query).not.toHaveBeenCalled()
    },
  )

  it('rejects exact IDs combined with even an empty cursor', () => {
    expect(() => build().listNativeTasks({ spaceId: SPACE, epochIds: [], cursor: '' })).toThrow('cursor')
  })

  it('opens independent native conversations without assigning blackboard tasks', async () => {
    const svc = build()
    const insertTask = vi.spyOn(store, 'insertTask')
    const first = await svc.openConversation(TEAM_ID, 'First request', MEMBER_APP)
    const second = await svc.openConversation(TEAM_ID, 'Second request', MEMBER_APP)
    const firstEpoch = store.getEpochById(first.epochId)!
    const secondEpoch = store.getEpochById(second.epochId)!

    expect(first.epochId).not.toBe(second.epochId)
    expect(firstEpoch).toMatchObject({ teamId: TEAM_ID, lifecycle: 'conversation', title: 'First request', endedAt: null,
      workItem: { id: first.epochId, status: 'open', entryAppId: MEMBER_APP } })
    expect(secondEpoch).toMatchObject({ teamId: TEAM_ID, lifecycle: 'conversation', title: 'Second request', endedAt: null,
      workItem: { id: second.epochId, status: 'open', entryAppId: MEMBER_APP } })
    expect(firstEpoch.chatKey).toMatch(/^native:/)
    expect(secondEpoch.chatKey).toMatch(/^native:/)
    expect(firstEpoch.chatKey).not.toBe(secondEpoch.chatKey)
    expect(store.listTasksByTeam(TEAM_ID)).toEqual([])
    expect(insertTask).not.toHaveBeenCalled()
  })

  it('conversation summaries do not materialize activity bodies or repeat member reads', async () => {
    const svc = build()
    for (let index = 0; index < 200; index++) await svc.openConversation(TEAM_ID, `Task ${index}`)
    const activities = vi.spyOn(store, 'listActivityByTeam')
    const members = vi.spyOn(store, 'listMembersByTeam')
    expect(svc.listConversations(TEAM_ID)).toHaveLength(200)
    expect(activities).not.toHaveBeenCalled()
    expect(members).toHaveBeenCalledTimes(1)
  })

  it('openConversation mints a native session, listConversations projects it', async () => {
    const svc = build()
    const { epochId } = await svc.openConversation(TEAM_ID, 'Weekly plan')
    const list = svc.listConversations(TEAM_ID)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ epochId, kind: 'native', label: 'Weekly plan', readonly: false })
  })

  it('projects member / IM conversations with the right kind, label and readonly', async () => {
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

  it('flags a conversation active when a member is busy on it', async () => {
    const svc = build()
    const { epochId } = await svc.openConversation(TEAM_ID)
    busyByApp.set(MEMBER_APP, [{ epochId, kind: 'conversation', label: '' }])
    expect(svc.listConversations(TEAM_ID).find(c => c.epochId === epochId)?.active).toBe(true)
  })

  it('counts work handed out by message as subtasks while the board is empty', async () => {
    const svc = build()
    const { epochId } = await svc.openConversation(TEAM_ID, 'Brief')
    const message = (id: string, actorAppId: string, targetAppId: string, createdAt: number) => store.insertActivity({
      id, teamId: TEAM_ID, epochId, kind: 'message', actorAppId, targetAppId, subject: 'Draft', body: null,
      refId: null, correlationId: null, status: 'sent', createdAt,
    })
    const subtasks = () => svc.listConversations(TEAM_ID).find(c => c.epochId === epochId)?.subtasks
    message('ask', LEAD_APP, MEMBER_APP, 100)
    expect(subtasks()).toEqual({ done: 0, open: 1 })
    message('answer', MEMBER_APP, LEAD_APP, 200)
    expect(subtasks()).toEqual({ done: 1, open: 0 })
    busyByApp.set(MEMBER_APP, [{ epochId, kind: 'conversation', label: '' }])
    expect(subtasks()).toEqual({ done: 0, open: 1 })
  })

  it('names a failure still holding up any unfinished task, not only the current one', async () => {
    const svc = build()
    const { epochId: stuck } = await svc.openConversation(TEAM_ID, 'Stuck')
    await svc.openConversation(TEAM_ID, 'Current')
    const act = (id: string, patch: Record<string, unknown>) => store.insertActivity({
      id, teamId: TEAM_ID, epochId: stuck, kind: 'message', actorAppId: LEAD_APP, targetAppId: MEMBER_APP, subject: 'Draft', body: null,
      refId: null, correlationId: null, status: 'sent', createdAt: 100, ...patch,
    })
    const failure = () => svc.listConversations(TEAM_ID).find(c => c.epochId === stuck)?.failure
    act('lost', { kind: 'reply', actorAppId: MEMBER_APP, targetAppId: LEAD_APP, status: 'undelivered', createdAt: 100 })
    act('lead-later', { createdAt: 200 })
    expect(failure()).toEqual({ appId: MEMBER_APP, activityId: 'lost', senderAppId: LEAD_APP })
    act('member-back', { actorAppId: MEMBER_APP, targetAppId: LEAD_APP, createdAt: 300 })
    expect(failure()).toBeUndefined()
  })

  it('leaves a failure in a cleared IM chat in its history, not on the list as a stop', () => {
    const svc = build()
    for (const [id, endReason] of [['im-cleared', 'cleared'], ['im-stopped', 'stopped']] as const) {
      store.insertEpoch({
        id, teamId: TEAM_ID, startedAt: 1, endedAt: 5, endReason, summary: null,
        lifecycle: 'conversation', chatKey: `instance-1:group:${id}`,
      })
      store.insertActivity({
        id: `${id}-lost`, teamId: TEAM_ID, epochId: id, kind: 'reply', actorAppId: MEMBER_APP, targetAppId: LEAD_APP, subject: 'Draft', body: null,
        refId: null, correlationId: null, status: 'undelivered', createdAt: 100,
      })
    }
    const list = svc.listConversations(TEAM_ID)
    expect(list.find(c => c.epochId === 'im-cleared')?.failure).toBeUndefined()
    expect(list.find(c => c.epochId === 'im-stopped')?.failure).toMatchObject({ appId: MEMBER_APP, activityId: 'im-stopped-lost' })
  })

  it('names who took part in a task in roster order, only on the team task list', async () => {
    const svc = build()
    const { epochId } = await svc.openConversation(TEAM_ID, 'Brief')
    const { epochId: quiet } = await svc.openConversation(TEAM_ID, 'Quiet')
    const participants = (id: string) => svc.listConversations(TEAM_ID).find(c => c.epochId === id)?.participantAppIds
    store.insertActivity({
      id: 'ask', teamId: TEAM_ID, epochId, kind: 'message', actorAppId: 'outsider-app', targetAppId: MEMBER_APP, subject: 'Draft', body: null,
      refId: null, correlationId: null, status: 'sent', createdAt: 100,
    })
    expect(participants(epochId)).toEqual([MEMBER_APP])
    busyByApp.set(LEAD_APP, [{ epochId, kind: 'conversation', label: '' }])
    expect(participants(epochId)).toEqual(store.listMembersByTeam(TEAM_ID).map(member => member.appId))
    expect(participants(quiet)).toBeUndefined()
    expect(svc.listNativeTasks({ spaceId: SPACE }).items.every(item => !('participantAppIds' in item))).toBe(true)
  })

  it('counts whoever answered the user directly as taking part, though it left no team activity', async () => {
    const answeredIn = new Map<string, string[]>()
    const listAnsweredMembers = vi.fn((_teamId: string, appIds: readonly string[], epochIds: readonly string[]) =>
      new Map([...answeredIn].filter(([epochId]) => epochIds.includes(epochId)).map(([epochId, ids]) => [epochId, ids.filter(id => appIds.includes(id))])))
    const svc = createTeamService({ ...buildDeps(), listAnsweredMembers })
    const { epochId: direct } = await svc.openConversation(TEAM_ID, 'Direct', MEMBER_APP)
    const { epochId: lead } = await svc.openConversation(TEAM_ID, 'Lead')
    const { epochId: quiet } = await svc.openConversation(TEAM_ID, 'Quiet')
    answeredIn.set(direct, [MEMBER_APP])
    answeredIn.set(lead, [LEAD_APP])
    const participants = (id: string) => svc.listConversations(TEAM_ID).find(c => c.epochId === id)?.participantAppIds
    expect(participants(direct)).toEqual([MEMBER_APP])
    expect(participants(lead)).toEqual([LEAD_APP])
    expect(participants(quiet)).toBeUndefined()
    listAnsweredMembers.mockClear()
    svc.listNativeTasks({ spaceId: SPACE })
    expect(listAnsweredMembers).not.toHaveBeenCalled()
  })

  it('projects a teammate decision as visible but not answerable on this machine', async () => {
    const svc = build()
    const { epochId } = await svc.openConversation(TEAM_ID, 'Review')
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

  it('projects a remote decision on a joined office from roster state until its shared answer arrives', async () => {
    const svc = build()
    store.materializeJoinedOffice({
      hostNodeId: 'host-1',
      selfNodeId: 'viewer-1',
      snapshot: {
        team: { id: TEAM_ID, name: 'Team', goal: 'g', leadAppId: LEAD_APP, collabMode: 'free', hostNodeId: 'host-1' },
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

  it('merges a locally answerable decision with shared task state without duplicating its member', async () => {
    const svc = build()
    const { epochId } = await svc.openConversation(TEAM_ID, 'Local review')
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

  it('on a JOINED office, active is derived from the federated roster busy, not local sessions', async () => {
    const svc = build()
    // Turn TEAM_ID into a joined (shadow) office whose lead is busy on a
    // conversation — the "busy" arrives via the host's roster snapshot, since a
    // joiner has no local sessions for host-run work. Without the joined branch
    // this conversation would read idle and never enter "busy now".
    store.materializeJoinedOffice({
      hostNodeId: 'host-1',
      selfNodeId: 'self-1',
      snapshot: {
        team: { id: TEAM_ID, name: 'T', goal: 'g', leadAppId: LEAD_APP, collabMode: 'free', hostNodeId: 'host-1' },
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
    // The task panel reads the same busy, or it calls a task finished that the list shows running.
    const lead = svc.getEpochBoard(TEAM_ID, 'conv-joined')?.roster?.find(m => m.appId === LEAD_APP)
    expect(lead?.busy).toEqual([{ epochId: 'conv-joined', kind: 'conversation', label: 'topic' }])
  })

  it('renameConversation relabels the session', async () => {
    const svc = build()
    const { epochId } = await svc.openConversation(TEAM_ID, 'A')
    svc.renameConversation(TEAM_ID, epochId, 'B')
    expect(svc.listConversations(TEAM_ID).find(c => c.epochId === epochId)?.label).toBe('B')
  })

  it('archiveConversation retains a completed task in the list', async () => {
    const svc = build()
    const { epochId } = await svc.openConversation(TEAM_ID)
    await svc.archiveConversation(TEAM_ID, epochId)
    expect(svc.listConversations(TEAM_ID)).toEqual([expect.objectContaining({ epochId, completed: true })])
  })

  it('archiving unfinished work records it as ended by the viewer, apart from finished work', async () => {
    const svc = createTeamService({ ...buildDeps(), getViewerIdentity: () => 'me' })
    const { epochId } = await svc.openConversation(TEAM_ID)
    await svc.archiveConversation(TEAM_ID, epochId)
    expect(store.getEpochById(epochId)).toMatchObject({ endReason: 'ended', workItem: { status: 'completed', endedBy: 'me' } })
    const task = svc.listConversations(TEAM_ID).find(c => c.epochId === epochId)
    expect(task).toMatchObject({ completed: true, endedManually: true, endedByMe: true })
    expect(task?.endedBy).toBeUndefined()
    store.updateWorkItem(epochId, { status: 'open' })
    expect(store.getEpochById(epochId)?.workItem?.endedBy).toBeNull()
  })

  it('archiving work that already finished keeps it finished', async () => {
    const svc = createTeamService({ ...buildDeps(), getViewerIdentity: () => 'me' })
    store.insertEpoch({
      id: 'conv-done', teamId: TEAM_ID, startedAt: 1, endedAt: 5, endReason: 'completed', summary: 'Shipped',
      lifecycle: 'conversation', chatKey: nativeConversationChatKey('done'),
    })
    await svc.archiveConversation(TEAM_ID, 'conv-done')
    expect(store.getEpochById('conv-done')).toMatchObject({ endReason: 'completed', workItem: { endedBy: null } })
    expect(svc.listConversations(TEAM_ID).find(c => c.epochId === 'conv-done')?.endedManually).toBeUndefined()
  })

  it('archiving open work whose subtasks are all done records it as finished, not ended by hand', async () => {
    const svc = createTeamService({ ...buildDeps(), getViewerIdentity: () => 'me' })
    const { epochId } = await svc.openConversation(TEAM_ID)
    store.insertTask({
      id: 'task-done', teamId: TEAM_ID, epochId, title: 'Draft the brief',
      assigneeAppId: LEAD_APP, status: 'done', resultRef: null, note: null,
      parentId: null, createdByAppId: LEAD_APP, createdAt: 1, updatedAt: 1,
    })
    await svc.archiveConversation(TEAM_ID, epochId)
    expect(store.getEpochById(epochId)).toMatchObject({ endReason: 'completed', workItem: { status: 'completed', endedBy: null } })
    expect(svc.listConversations(TEAM_ID).find(c => c.epochId === epochId)?.endedManually).toBeUndefined()
  })

  it('archiving work that stopped or failed judges it by its subtasks, as the list does', async () => {
    const svc = createTeamService({ ...buildDeps(), getViewerIdentity: () => 'me' })
    const sealed = (id: string, endReason: EpochEndReason, status: 'done' | 'in_progress') => {
      store.insertEpoch({
        id, teamId: TEAM_ID, startedAt: 1, endedAt: 5, endReason, summary: null,
        lifecycle: 'conversation', chatKey: nativeConversationChatKey(id),
      })
      store.insertTask({
        id: `${id}-task`, teamId: TEAM_ID, epochId: id, title: 'Draft the brief',
        assigneeAppId: LEAD_APP, status, resultRef: null, note: null,
        parentId: null, createdByAppId: LEAD_APP, createdAt: 1, updatedAt: 1,
      })
    }
    for (const reason of ['stopped', 'error', 'timeout'] as const) {
      sealed(`done-${reason}`, reason, 'done')
      await svc.archiveConversation(TEAM_ID, `done-${reason}`)
      expect(store.getEpochById(`done-${reason}`)).toMatchObject({ endReason: 'completed', workItem: { status: 'completed', endedBy: null } })
    }
    sealed('open-stopped', 'stopped', 'in_progress')
    await svc.archiveConversation(TEAM_ID, 'open-stopped')
    expect(store.getEpochById('open-stopped')).toMatchObject({ endReason: 'ended', workItem: { endedBy: 'me' } })
  })

  it('archiving work handed out by message settles it the way the list does', async () => {
    const svc = createTeamService({ ...buildDeps(), getViewerIdentity: () => 'me' })
    const message = (epochId: string, id: string, actorAppId: string, targetAppId: string, createdAt: number) => store.insertActivity({
      id, teamId: TEAM_ID, epochId, kind: 'message', actorAppId, targetAppId, subject: 'Draft', body: null,
      refId: null, correlationId: null, status: 'sent', createdAt,
    })
    const { epochId: answered } = await svc.openConversation(TEAM_ID, 'Answered')
    message(answered, 'ask-1', LEAD_APP, MEMBER_APP, 100)
    message(answered, 'answer-1', MEMBER_APP, LEAD_APP, 200)
    const { epochId: waiting } = await svc.openConversation(TEAM_ID, 'Waiting')
    message(waiting, 'ask-2', LEAD_APP, MEMBER_APP, 100)
    await svc.archiveConversation(TEAM_ID, answered)
    await svc.archiveConversation(TEAM_ID, waiting)
    expect(store.getEpochById(answered)?.endReason).toBe('completed')
    expect(store.getEpochById(waiting)).toMatchObject({ endReason: 'ended', workItem: { endedBy: 'me' } })
  })

  it('on a joined office, names the host owner who ended a task and refuses to end one locally', async () => {
    const svc = createTeamService({ ...buildDeps(), getViewerIdentity: () => 'me' })
    store.materializeJoinedOffice({
      hostNodeId: 'host-1',
      selfNodeId: 'viewer-1',
      snapshot: {
        team: { id: TEAM_ID, name: 'Team', goal: 'g', leadAppId: LEAD_APP, collabMode: 'free', hostNodeId: 'host-1' },
        members: [
          { appId: LEAD_APP, memberName: 'Lead', role: 'Lead', isLead: true, ownerNodeId: 'host-1', memberIdentity: 'host-person', ownerDisplayName: 'Zhang' },
        ],
        edges: [],
      },
    })
    store.upsertEpoch({
      id: 'conv-ended', teamId: TEAM_ID, startedAt: 1, endedAt: 5, endReason: 'ended', summary: null,
      lifecycle: 'conversation', chatKey: nativeConversationChatKey('ended'),
      workItem: { id: 'conv-ended', teamId: TEAM_ID, title: null, status: 'completed', createdBy: 'me', endedBy: 'host-person', createdAt: 1, updatedAt: 5 },
    })
    expect(svc.listConversations(TEAM_ID).find(c => c.epochId === 'conv-ended')).toMatchObject({ endedManually: true, endedBy: 'Zhang' })
    expect(svc.listConversations(TEAM_ID).find(c => c.epochId === 'conv-ended')?.endedByMe).toBeUndefined()
    store.insertEpoch({
      id: 'conv-open', teamId: TEAM_ID, startedAt: 1, endedAt: null, endReason: null, summary: null,
      lifecycle: 'conversation', chatKey: nativeConversationChatKey('open'),
    })
    await expect(svc.archiveConversation(TEAM_ID, 'conv-open')).rejects.toThrow('host')
    expect(store.getEpochById('conv-open')?.endedAt).toBeNull()
  })

  it('tells when a conversation was ended as done, but not when it was stopped', () => {
    const svc = build()
    store.insertEpoch({
      id: 'conv-done', teamId: TEAM_ID, startedAt: 1, endedAt: 5, endReason: 'completed', summary: 'Shipped',
      lifecycle: 'conversation', chatKey: nativeConversationChatKey('done'),
    })
    store.insertEpoch({
      id: 'conv-stopped', teamId: TEAM_ID, startedAt: 1, endedAt: 6, endReason: 'stopped', summary: null,
      lifecycle: 'conversation', chatKey: nativeConversationChatKey('stopped'),
    })
    const list = svc.listConversations(TEAM_ID)
    expect(list.find(c => c.epochId === 'conv-done')).toMatchObject({ finishedAt: 5 })
    expect(list.find(c => c.epochId === 'conv-stopped')?.finishedAt).toBeUndefined()
  })

  it('getTeamDetail carries the team\u2019s pending escalations; other teams\u2019 are excluded', async () => {
    const svc = build()
    pending = [
      { appId: MEMBER_APP, entryId: 'e1', question: 'Pick A or B?', teamId: TEAM_ID },
      { appId: 'someone-else', entryId: 'e2', question: 'unrelated', teamId: 'other-team' },
    ]
    const detail = svc.getTeamDetail(TEAM_ID)!
    expect(detail.pendingEscalations).toHaveLength(1)
    expect(detail.pendingEscalations![0]).toMatchObject({ appId: MEMBER_APP, memberName: 'Alice', question: 'Pick A or B?' })
  })

  it('listTeamItems counts waiting decisions independent of run status', async () => {
    const svc = build()
    pending = [{ appId: MEMBER_APP, entryId: 'e1', question: 'q', teamId: TEAM_ID }]
    const item = svc.listTeamItems(SPACE).find(t => t.id === TEAM_ID)!
    expect(item.waitingCount).toBe(1)
    expect(item.hasWaitingUser).toBe(true)
  })
})
