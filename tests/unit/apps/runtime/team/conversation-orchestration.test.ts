/**
 * Orchestration tests for the conversation/outcome layer:
 *   - ensureConversationEpoch: creates a per-chat epoch, reuses the open one, and
 *     publishes an epoch mutation (replication capture).
 *   - getMemberBusy: reflects the open epochs a member is actively serving.
 *   - run outcome classification on seal (output / no_action / failed / escalation).
 *   - a pending escalation keeps a member waiting_user AFTER a run is sealed (P0-5).
 *
 * The bus is real; the session layer is a controllable mock.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { broadcastToAll, sendToRenderer } = vi.hoisted(() => ({
  broadcastToAll: vi.fn(),
  sendToRenderer: vi.fn(),
}))
vi.mock('../../../../../src/main/http/websocket', () => ({ broadcastToAll }))
vi.mock('../../../../../src/main/foundation/window.service', () => ({ sendToRenderer }))

import { createDatabaseManager } from '../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../src/main/platform/store/types'
import { TeamStore } from '../../../../../src/main/apps/team/store'
import { MIGRATION_NAMESPACE, migrations } from '../../../../../src/main/apps/team/migrations'
import { createMessageBus } from '../../../../../src/main/apps/runtime/team/message-bus'
import type { MessageBus } from '../../../../../src/main/apps/runtime/team/message-bus'
import { createOrchestration } from '../../../../../src/main/apps/runtime/team/orchestration'
import type { Orchestration, OrchestrationSessionDeps } from '../../../../../src/main/apps/runtime/team/orchestration'
import type { TeamEpoch } from '../../../../../src/shared/apps/team-types'
import { buildTeamSessionKey, nativeConversationChatKey, memberChatKey } from '../../../../../src/shared/apps/im-keys'
import type { Team, TeamMember } from '../../../../../src/main/apps/team/types'

const TEAM_ID = 'team-1'
const LEAD_APP = 'app-lead'
const RESEARCHER_APP = 'app-researcher'
const SPACE = 'space-a'

function seedTeam(store: TeamStore): void {
  const now = Date.now()
  const team: Team = {
    id: TEAM_ID, name: 'Team', owningSpaceId: SPACE, goal: 'g', leadAppId: LEAD_APP,
    memberSourcing: 'manual', collabMode: 'free', escalationRouting: 'user',
    status: 'idle', currentEpochId: null, createdAt: now, updatedAt: now,
  }
  store.insertTeam(team)
  const members: TeamMember[] = [
    { teamId: TEAM_ID, appId: LEAD_APP, memberName: 'lead', role: 'Lead', isLead: true, aiProvisioned: false, addedAt: now },
    { teamId: TEAM_ID, appId: RESEARCHER_APP, memberName: 'researcher', role: 'R', isLead: false, aiProvisioned: false, addedAt: now },
  ]
  for (const m of members) store.addMember(m)
}

function makeSession(active: Set<string>): OrchestrationSessionDeps {
  return {
    sendAppChatMessage: vi.fn(async () => ({ finalMessage: null })),
    isSessionActive: (key) => active.has(key),
    closeTeamSession: vi.fn(async () => {}),
    getMemberSpaceId: () => SPACE,
  }
}

describe('conversation + outcome orchestration', () => {
  let dbManager: DatabaseManager
  let store: TeamStore
  let bus: MessageBus
  let active: Set<string>
  const epochMutations: TeamEpoch[] = []
  const profilePublishes: { teamId: string; appId: string }[] = []

  function build(pending?: Set<string>): Orchestration {
    active = new Set<string>()
    const session = makeSession(active)
    let orch: Orchestration
    bus = createMessageBus({
      store,
      hooks: { wakeTarget: (p) => orch.wakeTarget(p), isBusy: (k) => orch.isBusy(k) },
    })
    orch = createOrchestration({
      store, bus, session,
      onEpochMutation: (e) => epochMutations.push(e),
      hasPendingEscalation: (appId) => pending?.has(appId) ?? false,
      onMemberProfileChanged: (teamId, appId) => profilePublishes.push({ teamId, appId }),
    })
    return orch
  }

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
    store = new TeamStore(db)
    seedTeam(store)
    epochMutations.length = 0
    profilePublishes.length = 0
    broadcastToAll.mockClear()
    sendToRenderer.mockClear()
  })

  afterEach(() => { dbManager.closeAll() })

  it('ensureConversationEpoch creates one per chat, reuses it, and publishes a mutation', () => {
    const orch = build()
    const key = nativeConversationChatKey('u1')
    const e1 = orch.ensureConversationEpoch(TEAM_ID, key, 'My session')
    expect(e1.lifecycle).toBe('conversation')
    expect(e1.title).toBe('My session')
    // Reuse: same chat → same epoch (never a second context).
    const e2 = orch.ensureConversationEpoch(TEAM_ID, key)
    expect(e2.id).toBe(e1.id)
    // It does NOT occupy the run pointer.
    expect(store.getCurrentEpochForTeam(TEAM_ID)).toBeNull()
    // Replication capture fired for the new epoch.
    expect(epochMutations.some((e) => e.id === e1.id)).toBe(true)
  })

  it('auto-names an untitled native conversation from the person\u2019s first message', () => {
    const orch = build()
    const convo = orch.ensureConversationEpoch(TEAM_ID, nativeConversationChatKey('u1'))
    expect(convo.title).toBeNull()
    // A bus-delivered turn must NOT name it — its input is a relayed envelope.
    orch.maybeAutoNameConversation(TEAM_ID, convo.id, false, '[Team message from Researcher] look at this')
    expect(store.getEpochById(convo.id)?.title).toBeNull()
    // The person's first message names it (whitespace collapsed).
    orch.maybeAutoNameConversation(TEAM_ID, convo.id, true, '  Who should we\n watch this week?  ')
    expect(store.getEpochById(convo.id)?.title).toBe('Who should we watch this week?')
    // A later message does NOT rename it (title set = only the first names).
    orch.maybeAutoNameConversation(TEAM_ID, convo.id, true, 'a follow-up')
    expect(store.getEpochById(convo.id)?.title).toBe('Who should we watch this week?')
  })

  it('names a conversation the person started with a NON-lead member', () => {
    const orch = build()
    const convo = orch.ensureConversationEpoch(TEAM_ID, nativeConversationChatKey('u2'))
    // The Conversation tab lets the user pick who to talk to, so keying naming on
    // the lead left these threads unnamed until a teammate envelope named them.
    orch.maybeAutoNameConversation(TEAM_ID, convo.id, true, 'Can you check the build?')
    expect(store.getEpochById(convo.id)?.title).toBe('Can you check the build?')
  })

  it('does not auto-name a member direct chat (it labels by member name)', () => {
    const orch = build()
    const convo = orch.ensureConversationEpoch(TEAM_ID, memberChatKey(RESEARCHER_APP))
    orch.maybeAutoNameConversation(TEAM_ID, convo.id, true, 'hello there')
    expect(store.getEpochById(convo.id)?.title).toBeNull()
  })

  it('stamps last activity monotonically as turns enter an epoch', () => {
    const orch = build()
    const convo = orch.ensureConversationEpoch(TEAM_ID, nativeConversationChatKey('u3'))
    const created = store.getEpochById(convo.id)!.lastActivityAt
    expect(created).toBe(convo.startedAt)

    const later = convo.startedAt + 60_000
    store.touchEpoch(convo.id, later)
    expect(store.getEpochById(convo.id)!.lastActivityAt).toBe(later)

    // A stamp from the past never pulls it backwards — including the one
    // noteEpochTurn writes with the current clock.
    store.touchEpoch(convo.id, convo.startedAt - 10_000)
    orch.noteEpochTurn(TEAM_ID, convo.id)
    expect(store.getEpochById(convo.id)!.lastActivityAt).toBe(later)
  })

  it('getMemberBusy lists the open epochs a member is actively serving, with labels', () => {
    const orch = build()
    const convo = orch.ensureConversationEpoch(TEAM_ID, memberChatKey(RESEARCHER_APP))
    // Not serving anything yet.
    expect(orch.getMemberBusy(RESEARCHER_APP, TEAM_ID)).toEqual([])
    // Mark the researcher's session for this conversation active.
    active.add(buildTeamSessionKey(RESEARCHER_APP, TEAM_ID, convo.id))
    const busy = orch.getMemberBusy(RESEARCHER_APP, TEAM_ID)
    expect(busy).toHaveLength(1)
    expect(busy[0].epochId).toBe(convo.id)
    expect(busy[0].kind).toBe('conversation')
    // A member direct-chat labels as the member's name (main-side resolved).
    expect(busy[0].label).toBe('researcher')
  })

  it('seals the conversation it was given, leaving an open run untouched', async () => {
    // Guards against sealing the team's current run instead of the
    // conversation the tool call was actually made from.
    const orch = build()
    const run = await orch.startEpoch(TEAM_ID)
    const convo = orch.ensureConversationEpoch(TEAM_ID, nativeConversationChatKey('u1'))

    await orch.sealConversationEpoch(TEAM_ID, convo.id, 'completed', 'chat done')

    expect(store.getEpochById(convo.id)?.endedAt).not.toBeNull()
    expect(store.getEpochById(convo.id)?.summary).toBe('chat done')
    // The run is still the team's live instance.
    expect(store.getEpochById(run.id)?.endedAt).toBeNull()
    const team = store.getTeamById(TEAM_ID)!
    expect(team.currentEpochId).toBe(run.id)
    expect(team.status).toBe('running')
  })

  it('ignores a second seal of an already-sealed conversation', async () => {
    const orch = build()
    const convo = orch.ensureConversationEpoch(TEAM_ID, nativeConversationChatKey('u1'))

    await orch.sealConversationEpoch(TEAM_ID, convo.id, 'completed', 'first')
    await orch.sealConversationEpoch(TEAM_ID, convo.id, 'stopped', 'second')

    expect(store.getEpochById(convo.id)?.endReason).toBe('completed')
    expect(store.getEpochById(convo.id)?.summary).toBe('first')
  })

  it('classifies a produced run as "output" on seal', async () => {
    const orch = build()
    const epoch = await orch.startEpoch(TEAM_ID)
    store.insertTask({
      id: 't1', teamId: TEAM_ID, epochId: epoch.id, title: 'brief', assigneeAppId: RESEARCHER_APP,
      status: 'done', resultRef: 'brief.md', note: null, parentId: null,
      createdByAppId: LEAD_APP, createdAt: Date.now(), updatedAt: Date.now(),
    })
    await orch.sealEpoch(TEAM_ID, 'completed')
    expect(store.getEpochById(epoch.id)?.outcome).toBe('output')
  })

  it('classifies a silent run as "no_action", and an errored run as "failed"', async () => {
    const orch = build()
    const e1 = await orch.startEpoch(TEAM_ID)
    await orch.sealEpoch(TEAM_ID, 'completed')
    expect(store.getEpochById(e1.id)?.outcome).toBe('no_action')

    const e2 = await orch.startEpoch(TEAM_ID)
    await orch.sealEpoch(TEAM_ID, 'error')
    expect(store.getEpochById(e2.id)?.outcome).toBe('failed')
  })

  it('a pending escalation keeps the member waiting_user AFTER the run is sealed (P0-5)', async () => {
    const pending = new Set<string>([RESEARCHER_APP])
    const orch = build(pending)
    const epoch = await orch.startEpoch(TEAM_ID)
    // With a persisted escalation, the seal classifies as 'escalation'…
    await orch.sealEpoch(TEAM_ID, 'completed')
    expect(store.getEpochById(epoch.id)?.outcome).toBe('escalation')
    // …and the member still reads waiting_user even though no epoch is open.
    expect(store.getCurrentEpochForTeam(TEAM_ID)).toBeNull()
    expect(orch.getMemberStatus(RESEARCHER_APP)).toBe('waiting_user')
  })

  it('reads "waiting on its owner" from the member row, so every machine shows it', async () => {
    const orch = build()
    await orch.startEpoch(TEAM_ID)

    // The owner's machine recorded the question; on any other machine this row
    // is the replicated copy. Either way the office must read it as blocked on
    // a person rather than as an idle member.
    store.updateMemberFields(TEAM_ID, RESEARCHER_APP, { awaitingDecision: true })

    expect(orch.getMemberStatus(RESEARCHER_APP)).toBe('waiting_user')
    // The run's opening wake is still in flight; let it land before the db closes.
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

  it('marks a member whose question is on the record, whatever path its turn took', () => {
    // The turn that asked may have been started by a teammate on another
    // machine, by an IM message, or by a person typing — none of those routes an
    // escalation, so the fact has to be derived rather than pushed.
    const pending = new Set<string>([RESEARCHER_APP])
    const orch = build(pending)

    orch.reconcileAwaitingDecision(RESEARCHER_APP)

    expect(store.getMember(TEAM_ID, RESEARCHER_APP)?.awaitingDecision).toBe(true)
    expect(profilePublishes).toContainEqual({ teamId: TEAM_ID, appId: RESEARCHER_APP })
  })

  it('publishes nothing when the answer has not changed', () => {
    const pending = new Set<string>([RESEARCHER_APP])
    const orch = build(pending)

    orch.reconcileAwaitingDecision(RESEARCHER_APP)
    profilePublishes.length = 0
    // Runs on every turn end — a second look at an unchanged fact must cost the
    // office nothing.
    orch.reconcileAwaitingDecision(RESEARCHER_APP)

    expect(profilePublishes).toEqual([])
  })

  it('clears the mark once the question leaves the record', () => {
    const pending = new Set<string>([RESEARCHER_APP])
    const orch = build(pending)
    orch.reconcileAwaitingDecision(RESEARCHER_APP)
    profilePublishes.length = 0

    pending.delete(RESEARCHER_APP)
    orch.reconcileAwaitingDecision(RESEARCHER_APP)

    expect(store.getMember(TEAM_ID, RESEARCHER_APP)?.awaitingDecision).toBe(false)
    expect(profilePublishes).toContainEqual({ teamId: TEAM_ID, appId: RESEARCHER_APP })
  })

  it('marks lead and non-lead alike — the escalation preference is not a second rule here', () => {
    // The preference shapes the prompt, it does not decide who answers. Reading
    // it here once gave the persisted mark and the live status opposite answers
    // for the same member: the office saw idle while its own screen said waiting.
    store.updateTeamFields(TEAM_ID, { escalationRouting: 'lead' })
    const pending = new Set<string>([RESEARCHER_APP, LEAD_APP])
    const orch = build(pending)

    orch.reconcileAwaitingDecision(RESEARCHER_APP)
    orch.reconcileAwaitingDecision(LEAD_APP)

    expect(store.getMember(TEAM_ID, RESEARCHER_APP)?.awaitingDecision).toBe(true)
    expect(store.getMember(TEAM_ID, LEAD_APP)?.awaitingDecision).toBe(true)
    // The persisted mark and the live projection must never disagree.
    expect(orch.getMemberStatus(RESEARCHER_APP)).toBe('waiting_user')
  })

  it('never writes the mark for a member another machine owns', () => {
    // That row is a replica of a fact only its owner can observe; writing it
    // here would fight the owner over it.
    const REMOTE_APP = 'app-remote'
    store.addMember({
      teamId: TEAM_ID, appId: REMOTE_APP, memberName: 'remote', role: 'R', isLead: false,
      aiProvisioned: false, addedAt: Date.now(), origin: 'remote', ownerNodeId: 'node-b',
    })
    const orch = build(new Set<string>([REMOTE_APP]))

    orch.reconcileAwaitingDecision(REMOTE_APP)

    expect(store.getMember(TEAM_ID, REMOTE_APP)?.awaitingDecision).toBe(false)
    expect(profilePublishes).toEqual([])
  })

  it('clears it when the person answers, and tells the office', async () => {
    const orch = build()
    const epoch = await orch.startEpoch(TEAM_ID)
    store.updateMemberFields(TEAM_ID, RESEARCHER_APP, { awaitingDecision: true })
    profilePublishes.length = 0

    orch.resumeFromEscalation({ teamId: TEAM_ID, epochId: epoch.id, appId: RESEARCHER_APP, response: 'yes' })

    expect(store.getMember(TEAM_ID, RESEARCHER_APP)?.awaitingDecision).toBe(false)
    expect(profilePublishes).toContainEqual({ teamId: TEAM_ID, appId: RESEARCHER_APP })
    // The answer wakes the member; let that turn settle before the db closes.
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

})
