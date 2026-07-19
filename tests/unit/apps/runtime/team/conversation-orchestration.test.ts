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

  it('auto-names an untitled native conversation from the lead\u2019s first message', () => {
    const orch = build()
    const convo = orch.ensureConversationEpoch(TEAM_ID, nativeConversationChatKey('u1'))
    expect(convo.title).toBeNull()
    // A member's turn must NOT name it (only the lead / front desk does).
    orch.maybeAutoNameConversation(TEAM_ID, convo.id, RESEARCHER_APP, 'irrelevant member turn')
    expect(store.getEpochById(convo.id)?.title).toBeNull()
    // The lead's first user message names it (whitespace collapsed).
    orch.maybeAutoNameConversation(TEAM_ID, convo.id, LEAD_APP, '  Who should we\n watch this week?  ')
    expect(store.getEpochById(convo.id)?.title).toBe('Who should we watch this week?')
    // A later message does NOT rename it (title set = only the first names).
    orch.maybeAutoNameConversation(TEAM_ID, convo.id, LEAD_APP, 'a follow-up')
    expect(store.getEpochById(convo.id)?.title).toBe('Who should we watch this week?')
  })

  it('does not auto-name a member direct chat (it labels by member name)', () => {
    const orch = build()
    const convo = orch.ensureConversationEpoch(TEAM_ID, memberChatKey(RESEARCHER_APP))
    orch.maybeAutoNameConversation(TEAM_ID, convo.id, LEAD_APP, 'hello there')
    expect(store.getEpochById(convo.id)?.title).toBeNull()
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
})
