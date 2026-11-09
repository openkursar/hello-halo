/** Retained installed-member collaborations remain readable and saveable after migration. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { broadcastToAll, sendToRenderer } = vi.hoisted(() => ({
  broadcastToAll: vi.fn(),
  sendToRenderer: vi.fn(),
}))
vi.mock('../../../../src/main/http/websocket', () => ({ broadcastToAll }))
vi.mock('../../../../src/main/foundation/window.service', () => ({ sendToRenderer }))

import { randomUUID } from 'crypto'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import { TeamStore } from '../../../../src/main/apps/team/store'
import { MIGRATION_NAMESPACE, migrations } from '../../../../src/main/apps/team/migrations'
import { createTeamService } from '../../../../src/main/apps/team/service'
import type { TeamServiceDeps } from '../../../../src/main/apps/team/service'
import {
  SPACE_COORDINATOR_MEMBER_NAME,
  TEAM_EVENTS,
  spaceCoordinatorAppId,
  spaceCollabChatKey,
  buildTeamSessionKey,
} from '../../../../src/shared/apps/team-types'
import type { TeamEpoch, RosterBusyEntry } from '../../../../src/shared/apps/team-types'

const SPACE = 'space-a'
const CONVERSATION = 'conv-1'

function makeAppManager() {
  const apps = new Map<string, { id: string; spaceId: string | null; spec: { name: string }; userOverrides: Record<string, unknown> }>()
  let counter = 0
  return {
    apps,
    install: vi.fn(async (spaceId: string | null, spec: { name: string }) => {
      const id = `app-${++counter}`
      apps.set(id, { id, spaceId, spec: { ...spec }, userOverrides: {} })
      return id
    }),
    getApp: vi.fn((appId: string) => apps.get(appId) ?? null),
    updateOverrides: vi.fn((appId: string, overrides: Record<string, unknown>) => {
      Object.assign(apps.get(appId)!.userOverrides, overrides)
    }),
    uninstall: vi.fn(async () => {}),
    deleteApp: vi.fn(async (appId: string) => {
      apps.delete(appId)
    }),
  }
}

function makeRuntime(store: TeamStore) {
  const startEpoch = vi.fn(async (teamId: string, _trigger?: unknown, _instruction?: string): Promise<TeamEpoch> => ({
    id: randomUUID(),
    teamId,
    startedAt: Date.now(),
    endedAt: null,
    endReason: null,
    summary: null,
    lifecycle: 'run',
    chatKey: null,
  }))
  const ensureConversationEpoch = vi.fn((teamId: string, chatKey: string, title?: string): TeamEpoch => {
    const existing = store.getOpenConversationEpoch(teamId, chatKey)
    if (existing) return existing
    const epoch: TeamEpoch = {
      id: randomUUID(),
      teamId,
      startedAt: Date.now(),
      endedAt: null,
      endReason: null,
      summary: null,
      lifecycle: 'conversation',
      chatKey,
      title: title ?? null,
    }
    store.insertEpoch(epoch, 'event')
    return epoch
  })
  const sealConversationEpoch = vi.fn(async (_teamId: string, epochId: string, reason: Parameters<TeamStore['endEpoch']>[2] = 'completed') => {
    store.endEpoch(epochId, Date.now(), reason, null, null)
  })
  return {
    bus: { cancelSession: vi.fn(), continueSession: vi.fn() } as never,
    stopMemberTurn: vi.fn(async () => false),
    isMemberReachable: vi.fn(() => true),
    isMemberStopReachable: vi.fn(() => true),
    closeEpochResources: vi.fn(async (_teamId: string, _epochId: string) => {}),
    blackboard: { readBoard: vi.fn(() => ({ tasks: [], findings: [], roster: [] })) },
    checks: { viewForTeam: () => [], cancelById: vi.fn() } as never,
    startEpoch,
    ensureConversationEpoch,
    sealConversationEpoch,
    sealEpoch: vi.fn(async () => {}),
    getObservableStatus: vi.fn(() => 'idle'),
    getMemberStatus: vi.fn(() => 'working' as const),
    getMemberBusy: vi.fn((_appId: string, _teamId: string): RosterBusyEntry[] => []),
  teamFolders: {
    forMember: () => null,
    sharedDir: (teamId: string, epochId: string) => `/halo/team-work/${teamId}/${epochId}`,
    remove: vi.fn(async () => {}),
    prune: vi.fn(async () => {}),
  },
  }
}

function buildService(overrides?: Partial<TeamServiceDeps>) {
  const dbManager = createDatabaseManager(':memory:')
  const db = dbManager.getAppDatabase()
  dbManager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
  const store = new TeamStore(db)
  const appManager = makeAppManager()
  const runtime = makeRuntime(store)

  const deps: TeamServiceDeps = {
    store,
    appManager: appManager as never,
    getRuntime: () => runtime as never,
    spaces: {
      spaceExists: () => true,
      // Mirrors production: a member shares the owning space.
      createMemberSpace: ({ owningSpaceId }) => owningSpaceId,
      deleteMemberSpace: vi.fn(),
    },
    listArtifacts: vi.fn(async () => []),
    proposeMembersFromGoal: vi.fn(async () => []),
    ...overrides,
  }
  const service = createTeamService(deps)
  return { service, store, appManager, runtime, dbManager, deps }
}

const collabInput = () => ({
  owningSpaceId: SPACE,
  conversationId: CONVERSATION,
  name: 'Research crew',
  goal: 'Compare competitors',
  modelSelection: { modelSourceId: 'parent-source', modelId: 'parent-model' },
  members: [
    { memberName: 'researcher', role: 'Researcher', responsibility: 'Collect sources' },
    { memberName: 'writer', role: 'Writer', responsibility: 'Draft the brief' },
  ],
})

async function seedLegacyCollaboration(ctx: ReturnType<typeof buildService>) {
  const input = collabInput()
  const work = await ctx.service.ensureCollaboration({ owningSpaceId: SPACE, conversationId: CONVERSATION, title: input.name })
  ctx.store.updateTeamFields(work.team.id, { goal: input.goal })
  for (const proposed of input.members) {
    const appId = await ctx.appManager.install(SPACE, { name: proposed.memberName })
    ctx.appManager.updateOverrides(appId, input.modelSelection)
    ctx.store.addMember({ teamId: work.team.id, appId, memberName: proposed.memberName, role: proposed.role,
      duty: proposed.responsibility, isLead: false, aiProvisioned: true, addedAt: Date.now() })
  }
  return { team: ctx.store.getTeamById(work.team.id)!, epochId: work.epochId }
}

describe('temporary space collaborations', () => {
  let ctx: ReturnType<typeof buildService>

  beforeEach(() => {
    broadcastToAll.mockClear()
    sendToRenderer.mockClear()
    ctx = buildService()
  })

  afterEach(() => {
    ctx.dbManager.closeAll()
  })

  it('binds one empty collaboration to a source without requiring a goal or installing people', async () => {
    const { team, epochId } = await ctx.service.ensureCollaboration({ owningSpaceId: SPACE, conversationId: CONVERSATION, title: 'Review' })
    expect(team).toMatchObject({ ephemeral: true, goal: '', coordinatorConversationId: CONVERSATION, leadAppId: spaceCoordinatorAppId(CONVERSATION) })
    expect(ctx.store.listMembersByTeam(team.id)).toEqual([expect.objectContaining({ memberName: SPACE_COORDINATOR_MEMBER_NAME, isLead: true, aiProvisioned: false })])
    expect(ctx.store.getEpochById(epochId)).toMatchObject({ lifecycle: 'conversation', chatKey: spaceCollabChatKey(CONVERSATION) })
    expect(ctx.appManager.install).not.toHaveBeenCalled()
  })

  it('reads a private scope only for its local parent member and never saves it', async () => {
    const parent = await seedLegacyCollaboration(ctx)
    const member = ctx.store.listMembersByTeam(parent.team.id).find(item => item.aiProvisioned)!
    const key = buildTeamSessionKey(member.appId, parent.team.id, parent.epochId)
    const scope = await ctx.service.ensureCollaboration({ owningSpaceId: SPACE, conversationId: key, title: 'Private review' })
    expect(ctx.service.getCollabForConversation(key)).toMatchObject({ teamId: scope.team.id, epochId: scope.epochId })
    await expect(ctx.service.saveCollab(scope.team.id)).rejects.toThrow(/internal assistants/)
    ctx.store.removeMember(parent.team.id, member.appId)
    ctx.store.addMember({ ...member, origin: 'remote', ownerNodeId: 'remote-owner' })
    expect(ctx.service.getCollabForConversation(key)).toBeNull()
    ctx.store.removeMember(parent.team.id, member.appId)
    expect(ctx.service.getCollabForConversation(key)).toBeNull()
  })

  it('recursively removes private scopes including a removed parent member without deleting independent people', async () => {
    const parent = await seedLegacyCollaboration(ctx)
    const member = ctx.store.listMembersByTeam(parent.team.id).find(item => item.aiProvisioned)!
    const key = buildTeamSessionKey(member.appId, parent.team.id, parent.epochId)
    const child = await ctx.service.ensureCollaboration({ owningSpaceId: SPACE, conversationId: key, title: 'Private review' })
    const helper = await ctx.appManager.install(SPACE, { name: 'Independent helper' })
    ctx.store.addMember({ teamId: child.team.id, appId: helper, memberName: 'helper', role: '', isLead: false, aiProvisioned: false, addedAt: 1 })
    const nestedKey = buildTeamSessionKey(helper, child.team.id, child.epochId)
    const nested = await ctx.service.ensureCollaboration({ owningSpaceId: SPACE, conversationId: nestedKey, title: 'Nested review' })
    ctx.store.removeMember(parent.team.id, member.appId)
    await ctx.service.dissolveTeam(parent.team.id)
    expect(ctx.store.getTeamById(child.team.id)).toBeNull()
    expect(ctx.store.getTeamById(nested.team.id)).toBeNull()
    expect(ctx.appManager.getApp(helper)).not.toBeNull()
    expect(ctx.runtime.teamFolders.remove).toHaveBeenCalledWith(child.team.id, [child.epochId])
    expect(ctx.runtime.teamFolders.remove).toHaveBeenCalledWith(nested.team.id, [nested.epochId])
  })

  it('closes only the selected parent epoch private scopes and retries failed descendant cleanup', async () => {
    const parent = await seedLegacyCollaboration(ctx)
    const member = ctx.store.listMembersByTeam(parent.team.id).find(item => item.aiProvisioned)!
    const key = buildTeamSessionKey(member.appId, parent.team.id, parent.epochId)
    const child = await ctx.service.ensureCollaboration({ owningSpaceId: SPACE, conversationId: key, title: 'Private review' })
    const siblingEpoch = ctx.runtime.ensureConversationEpoch(parent.team.id, 'other-work')
    const siblingKey = buildTeamSessionKey(member.appId, parent.team.id, siblingEpoch.id)
    const sibling = await ctx.service.ensureCollaboration({ owningSpaceId: SPACE, conversationId: siblingKey, title: 'Other review' })
    ctx.store.endEpoch(parent.epochId, Date.now(), 'cleared', null)
    ctx.runtime.closeEpochResources.mockRejectedValueOnce(new Error('Session busy'))
    await expect(ctx.service.disposePrivateCollaborations(parent.team.id, parent.epochId)).rejects.toThrow(/retained/)
    expect(ctx.store.getTeamById(child.team.id)).not.toBeNull()
    await ctx.service.disposePrivateCollaborations(parent.team.id, parent.epochId)
    expect(ctx.store.getTeamById(child.team.id)).toBeNull()
    expect(ctx.store.getTeamById(sibling.team.id)).not.toBeNull()
    expect(ctx.store.getTeamById(parent.team.id)).not.toBeNull()
    await expect(ctx.service.ensureCollaboration({ owningSpaceId: SPACE, conversationId: key, title: 'Late scope' })).rejects.toThrow(/parent work is closed/)
  })

  it('coalesces concurrent source binding without replacing the existing work', async () => {
    const input = { owningSpaceId: SPACE, conversationId: CONVERSATION, title: 'Review' }
    const [first, second] = await Promise.all([ctx.service.ensureCollaboration(input), ctx.service.ensureCollaboration(input)])
    expect(second.team.id).toBe(first.team.id)
    expect(second.epochId).toBe(first.epochId)
    expect(ctx.store.listTeams()).toHaveLength(1)
  })

  it('the store refuses a second team bound to the same conversation', async () => {
    await seedLegacyCollaboration(ctx)
    const now = Date.now()
    expect(() =>
      ctx.store.insertTeam({
        id: randomUUID(),
        name: 'Second binding',
        owningSpaceId: SPACE,
        goal: 'g',
        leadAppId: null,
        memberSourcing: 'ai',
        collabMode: 'free',
        escalationRouting: 'user',
        status: 'idle',
        currentEpochId: null,
        createdAt: now,
        updatedAt: now,
        ephemeral: true,
        coordinatorConversationId: CONVERSATION,
      })
    ).toThrow(/UNIQUE constraint failed/)
  })

  it('creates an independent source conversation without replacing a saved collaboration', async () => {
    const { team } = await seedLegacyCollaboration(ctx)
    await ctx.service.saveCollab(team.id)
    const second = await ctx.service.ensureCollaboration({ owningSpaceId: SPACE, conversationId: 'another-chat', title: 'Another request' })
    expect(second.team.id).not.toBe(team.id)
    expect(ctx.service.getCollabForConversation(CONVERSATION)?.teamId).toBe(team.id)
    expect(ctx.store.getTeamById(team.id)?.coordinatorConversationId).toBe(CONVERSATION)
  })

  it('retains source collaboration while excluding it from global and space team directories', async () => {
    const { team } = await seedLegacyCollaboration(ctx)

    const memberships = ctx.store.listDirectoryMemberships().filter(m => m.teamId === team.id)
    expect(memberships.length).toBeGreaterThan(0)
    expect(memberships.every(m => m.ephemeral)).toBe(true)

    expect(ctx.service.listTeamItems(SPACE).some(t => t.id === team.id)).toBe(false)
    expect(ctx.service.listTeamItems().some(t => t.id === team.id)).toBe(false)
    expect(ctx.service.getCollabForConversation(CONVERSATION)?.teamId).toBe(team.id)
    const saved = await ctx.service.saveCollab(team.id)
    expect(ctx.service.listTeamItems(SPACE).map(t => t.id)).toEqual([saved.id])
    expect(ctx.service.listTeamItems().map(t => t.id)).toEqual([saved.id])
  })

  it('getCollabForConversation projects the live collaboration without the coordinator row', async () => {
    const { team } = await seedLegacyCollaboration(ctx)

    const collab = ctx.service.getCollabForConversation(CONVERSATION)
    expect(collab?.teamId).toBe(team.id)
    expect(collab?.active).toBe(true)
    expect(collab?.saved).toBe(false)
    expect(collab?.members.map(m => m.memberName).sort()).toEqual(['researcher', 'writer'])

    await ctx.service.archiveConversation(team.id, ctx.service.getCollabForConversation(CONVERSATION)!.epochId!)
    expect(ctx.service.getCollabForConversation(CONVERSATION)?.active).toBe(false)
  })

  it('saves only configuration into a separate ordinary team and preserves the running source', async () => {
    const { team, epochId } = await seedLegacyCollaboration(ctx)
    const workers = ctx.store.listMembersByTeam(team.id).filter(member => member.aiProvisioned)
    ctx.store.insertFinding({ id: 'finding', teamId: team.id, epochId, authorAppId: workers[0].appId, body: 'Current result', ref: null, createdAt: Date.now() })
    const saved = await ctx.service.saveCollab(team.id)
    expect(saved.id).not.toBe(team.id)
    expect(saved).toMatchObject({ name: team.name, goal: team.goal, ephemeral: false, coordinatorConversationId: null, currentEpochId: null })
    expect(ctx.service.getTeam(team.id)).toMatchObject({ ephemeral: true, leadAppId: team.leadAppId, savedTeamId: saved.id })
    expect(ctx.store.getEpochById(epochId)?.endedAt).toBeNull()
    expect(ctx.service.listConversations(saved.id)).toEqual([])
    expect(ctx.service.getTeamDetail(saved.id)?.findings).toEqual([])
    const members = ctx.store.listMembersByTeam(saved.id)
    expect(members.filter(member => !member.isLead).map(member => member.appId).sort()).toEqual(workers.map(member => member.appId).sort())
    expect(members.some(member => member.appId === team.leadAppId)).toBe(false)
    expect(ctx.appManager.getApp(saved.leadAppId!)?.userOverrides).toEqual({ modelSourceId: 'parent-source', modelId: 'parent-model' })
    ctx.store.updateMemberFields(team.id, workers[0].appId, { duty: 'A new temporary assignment' })
    expect(ctx.store.getMember(saved.id, workers[0].appId)?.duty).toBe(workers[0].duty)
    expect(ctx.service.getCollabForConversation(CONVERSATION)).toMatchObject({ teamId: team.id, saved: true, savedTeamId: saved.id, active: true })
    expect(ctx.runtime.startEpoch).not.toHaveBeenCalled()
    expect(ctx.service.listTeamItems(SPACE).filter(item => !item.ephemeral).map(item => item.id)).toEqual([saved.id])
  })

  it('coalesces concurrent saves and reuses the persisted link after restart', async () => {
    const { team } = await seedLegacyCollaboration(ctx)
    const first = ctx.service.saveCollab(team.id)
    expect(ctx.service.saveCollab(team.id)).toBe(first)
    const saved = await first
    const reopened = createTeamService(ctx.deps)
    expect((await reopened.saveCollab(team.id)).id).toBe(saved.id)
    expect(ctx.appManager.install).toHaveBeenCalledTimes(3)
    expect(ctx.store.listTeams()).toHaveLength(2)
  })

  it.each(['configuration', 'link'])('rolls back a failed %s without changing source work or members', async stage => {
    const { team, epochId } = await seedLegacyCollaboration(ctx)
    if (stage === 'configuration') ctx.appManager.updateOverrides.mockImplementationOnce(() => { throw new Error('save failed') })
    else vi.spyOn(ctx.store, 'attachSavedTeam').mockImplementationOnce(() => { throw new Error('save failed') })
    await expect(ctx.service.saveCollab(team.id)).rejects.toThrow('save failed')
    expect(ctx.store.listTeams()).toHaveLength(1)
    expect(ctx.store.listMembersByTeam(team.id)).toHaveLength(3)
    expect(ctx.appManager.apps.size).toBe(2)
    expect(ctx.store.getEpochById(epochId)?.endedAt).toBeNull()
    expect(ctx.service.getCollabForConversation(CONVERSATION)?.saved).toBe(false)
    await expect(ctx.service.saveCollab(team.id)).resolves.toMatchObject({ ephemeral: false })
  })

  it('rolls back the saved team if the source was deleted while installing its lead', async () => {
    const { team } = await seedLegacyCollaboration(ctx)
    const install = ctx.appManager.install.getMockImplementation()!
    ctx.appManager.install.mockImplementationOnce(async (spaceId, spec) => {
      await ctx.service.dissolveTeam(team.id)
      return install(spaceId, spec)
    })
    await expect(ctx.service.saveCollab(team.id)).rejects.toThrow(/collaboration changed/)
    expect(ctx.store.listTeams()).toHaveLength(0)
    expect(ctx.appManager.apps.size).toBe(0)
  })

  it('retains saved members when the temporary source is removed', async () => {
    const { team } = await seedLegacyCollaboration(ctx)
    const saved = await ctx.service.saveCollab(team.id)
    await ctx.service.dissolveTeam(team.id)
    expect(ctx.store.getTeamById(saved.id)?.leadAppId).toBe(saved.leadAppId)
    for (const member of ctx.store.listMembersByTeam(saved.id)) expect(ctx.appManager.getApp(member.appId)).not.toBeNull()
    await ctx.service.dissolveTeam(saved.id)
    expect(ctx.appManager.apps.size).toBe(0)
  })

  it('does not copy someone else’s remote membership into a new office without an invitation', async () => {
    const { team } = await seedLegacyCollaboration(ctx)
    ctx.store.addMember({ teamId: team.id, appId: 'remote-app', memberName: 'Remote', role: '', isLead: false, aiProvisioned: false, addedAt: Date.now(), origin: 'remote', ownerNodeId: 'another-node' })
    await expect(ctx.service.saveCollab(team.id)).rejects.toThrow(/invite/)
    expect(ctx.store.listTeams()).toHaveLength(1)
    expect(ctx.appManager.install).toHaveBeenCalledTimes(2)
  })

  it('copies the collaboration topology as configuration without copying its work', async () => {
    const { team } = await seedLegacyCollaboration(ctx)
    await ctx.service.updateTeam(team.id, { collabMode: 'structured' })
    const edges = ctx.store.listEdgesByTeam(team.id)
    const saved = await ctx.service.saveCollab(team.id)
    expect(ctx.store.listEdgesByTeam(saved.id)).toEqual(edges.map(edge => ({ ...edge, teamId: saved.id, fromAppId: saved.leadAppId })))
    expect(ctx.service.listConversations(saved.id)).toEqual([])
  })

  it('allows saving again after the previously saved team was deleted', async () => {
    const { team } = await seedLegacyCollaboration(ctx)
    const first = await ctx.service.saveCollab(team.id)
    broadcastToAll.mockClear()
    await ctx.service.dissolveTeam(first.id)
    expect(ctx.service.getCollabForConversation(CONVERSATION)?.saved).toBe(false)
    expect(broadcastToAll.mock.calls.some(([channel, event]) => channel === TEAM_EVENTS.updated && event.teamId === team.id && !event.team.savedTeamId)).toBe(true)
    const second = await ctx.service.saveCollab(team.id)
    expect(second.id).not.toBe(first.id)
    expect(second.name).toBe(team.name)
  })

  it('a saved configuration runs and opens tasks while its source remains a temporary single room', async () => {
    const { team, epochId } = await seedLegacyCollaboration(ctx)
    const saved = await ctx.service.saveCollab(team.id)
    await expect(ctx.service.openConversation(team.id, 'Side task')).rejects.toThrow(/temporary collaboration/)
    await expect(ctx.service.runTeam(team.id)).rejects.toThrow(/Save it as a team/)
    await ctx.service.openConversation(saved.id, 'Next request')
    await ctx.service.runTeam(saved.id)
    expect(ctx.service.listConversations(team.id).map(task => task.epochId)).toEqual([epochId])
    expect(ctx.service.getCollabForConversation(CONVERSATION)?.active).toBe(true)
  })

  it('normalizes an old saved team in place without starting or copying any work', async () => {
    const { team, epochId } = await seedLegacyCollaboration(ctx)
    ctx.store.clearEphemeral(team.id)
    const notify = vi.fn()
    ctx.deps.onRosterMutated = notify
    const service = createTeamService(ctx.deps)
    const detail = await service.openTeamDetail(team.id)
    expect(detail?.team.id).toBe(team.id)
    expect(detail?.team.leadAppId).not.toBe(team.leadAppId)
    expect(detail?.team.coordinatorConversationId).toBeNull()
    expect(detail?.legacyCoordinator).toBeUndefined()
    expect(ctx.store.getMember(team.id, team.leadAppId!)).toBeNull()
    expect(ctx.store.getEpochById(epochId)).not.toBeNull()
    expect(service.listConversations(team.id)).toMatchObject([{ kind: 'collab', readonly: true }])
    expect(ctx.runtime.startEpoch).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith(team.id)
    await service.openTeamDetail(team.id)
    expect(ctx.appManager.install).toHaveBeenCalledTimes(3)
  })

  it('defers legacy repair while the original conversation is busy, then repairs on retry', async () => {
    const { team } = await seedLegacyCollaboration(ctx)
    ctx.store.clearEphemeral(team.id)
    const isConversationBusy = vi.fn(() => true)
    const service = createTeamService({ ...ctx.deps, isConversationBusy })
    const before = ctx.store.getTeamById(team.id)
    const detail = await service.openTeamDetail(team.id)
    expect(detail?.legacyCoordinator).toMatchObject({ ownedHere: true, repairDeferred: true })
    expect(ctx.store.getTeamById(team.id)).toEqual(before)
    expect(service.getCollabForConversation(CONVERSATION)?.active).toBe(true)
    expect(ctx.appManager.install).toHaveBeenCalledTimes(2)
    isConversationBusy.mockReturnValue(false)
    expect((await service.openTeamDetail(team.id))?.legacyCoordinator).toBeUndefined()
  })

  it('defers legacy repair while a member is working in the original task', async () => {
    const { team, epochId } = await seedLegacyCollaboration(ctx)
    ctx.store.clearEphemeral(team.id)
    const member = ctx.store.listMembersByTeam(team.id).find(row => row.aiProvisioned)!
    ctx.runtime.getMemberBusy.mockImplementation(appId => appId === member.appId ? [{ epochId, kind: 'conversation', label: 'Research' }] : [])
    const detail = await ctx.service.openTeamDetail(team.id)
    expect(detail?.legacyCoordinator).toMatchObject({ repairDeferred: true })
    expect(ctx.store.getTeamById(team.id)?.leadAppId).toBe(team.leadAppId)
    expect(ctx.appManager.install).toHaveBeenCalledTimes(2)
  })

  it('rechecks live work after lead preparation and rolls back the unused lead', async () => {
    const { team } = await seedLegacyCollaboration(ctx)
    ctx.store.clearEphemeral(team.id)
    const isConversationBusy = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
    const service = createTeamService({ ...ctx.deps, isConversationBusy })
    const detail = await service.openTeamDetail(team.id)
    expect(detail?.legacyCoordinator).toMatchObject({ repairDeferred: true })
    expect(service.getCollabForConversation(CONVERSATION)?.active).toBe(true)
    expect(ctx.appManager.apps.size).toBe(2)
    expect(ctx.store.getTeamById(team.id)?.leadAppId).toBe(team.leadAppId)
  })

  it('keeps failed legacy repair readable and retries without duplicating the lead', async () => {
    const { team } = await seedLegacyCollaboration(ctx)
    ctx.store.clearEphemeral(team.id)
    vi.spyOn(ctx.store, 'setCoordinatorConversation').mockImplementationOnce(() => { throw new Error('repair failed') })
    const failed = await ctx.service.openTeamDetail(team.id)
    expect(failed?.legacyCoordinator).toMatchObject({ ownedHere: true, repairFailed: true })
    expect(failed?.team.leadAppId).toBe(team.leadAppId)
    expect(ctx.store.getMember(team.id, team.leadAppId!)).not.toBeNull()
    expect(ctx.appManager.apps.size).toBe(2)
    expect((await ctx.service.openTeamDetail(team.id))?.legacyCoordinator).toBeUndefined()
    expect(ctx.store.listMembersByTeam(team.id)).toHaveLength(3)
  })

  it('names the creator of a joined legacy team without repairing another computer', async () => {
    const { team } = await seedLegacyCollaboration(ctx)
    ctx.store.materializeJoinedOffice({ hostNodeId: 'creator-node', selfNodeId: 'viewer-node', snapshot: {
      team: { id: team.id, name: team.name, goal: team.goal, leadAppId: team.leadAppId, collabMode: 'free', hostNodeId: 'creator-node' },
      members: [{ appId: team.leadAppId!, memberName: 'coordinator', role: 'Coordinator', isLead: true, ownerNodeId: 'creator-node', memberIdentity: null, ownerDisplayName: 'Alice' }], edges: [],
    } })
    ctx.store.clearEphemeral(team.id)
    const detail = await ctx.service.openTeamDetail(team.id)
    expect(detail?.legacyCoordinator).toEqual({ ownedHere: false, ownerName: 'Alice' })
    expect(ctx.appManager.install).toHaveBeenCalledTimes(2)
    await expect(ctx.service.openConversation(team.id, 'New work')).rejects.toThrow(/creator/)
  })

  it('does not call the local creator another teammate when only authority moved elsewhere', async () => {
    const { team } = await seedLegacyCollaboration(ctx)
    ctx.store.materializeJoinedOffice({ hostNodeId: 'other-authority', selfNodeId: 'creator-node', snapshot: {
      team: { id: team.id, name: team.name, goal: team.goal, leadAppId: team.leadAppId, collabMode: 'free', hostNodeId: 'other-authority' },
      members: [{ appId: team.leadAppId!, memberName: 'coordinator', role: 'Coordinator', isLead: true, ownerNodeId: 'creator-node', memberIdentity: null }], edges: [],
    } })
    ctx.store.clearEphemeral(team.id)
    const detail = await ctx.service.openTeamDetail(team.id)
    expect(detail?.legacyCoordinator).toMatchObject({ ownedHere: true, repairFailed: true })
    expect(ctx.appManager.install).toHaveBeenCalledTimes(2)
  })

  it('dissolving an ephemeral collaboration cleans up its member apps', async () => {
    const { team } = await seedLegacyCollaboration(ctx)
    const memberApps = ctx.store
      .listMembersByTeam(team.id)
      .filter(m => m.aiProvisioned)
      .map(m => m.appId)

    await ctx.service.dissolveTeam(team.id)
    for (const appId of memberApps) {
      expect(ctx.appManager.apps.has(appId)).toBe(false)
    }
    expect(ctx.store.getTeamById(team.id)).toBeNull()
  })

  it('lists the coordinator\u2019s and members\u2019 published files where they really are', async () => {
    ctx.dbManager.closeAll()
    ctx = buildService({
      spaces: {
        spaceExists: () => true,
        createMemberSpace: ({ owningSpaceId }) => owningSpaceId,
        deleteMemberSpace: vi.fn(),
        resolveWorkDir: (spaceId) => (spaceId === SPACE ? '/work/project' : null),
      },
    })
    const { team, epochId } = await seedLegacyCollaboration(ctx)
    const researcher = ctx.store.listMembersByTeam(team.id).find(m => m.memberName === 'researcher')!
    const finding = (authorAppId: string, ref: string) =>
      ctx.store.insertFinding({ id: randomUUID(), teamId: team.id, epochId, authorAppId, body: null, ref, createdAt: Date.now() })
    finding(spaceCoordinatorAppId(CONVERSATION), 'plan.md')
    finding(researcher.appId, 'team:researcher/sources.md')

    const groups = await ctx.service.listArtifacts(team.id, epochId)
    const byMember = new Map(groups.map(g => [g.memberName, g.artifacts[0]]))

    // The coordinator has no app record; its file sits in the owning space's work dir.
    expect(byMember.get('lead')?.path).toBe('/work/project/plan.md')
    expect(byMember.get('researcher')?.path).toBe(`/halo/team-work/${team.id}/${epochId}/researcher/sources.md`)
    expect(byMember.get('researcher')?.relativePath).toBe('team:researcher/sources.md')

    ctx.store.clearEphemeral(team.id)
    await ctx.service.openTeamDetail(team.id)
    expect(await ctx.service.listArtifacts(team.id, epochId)).toEqual(groups)
    ctx.store.removeMember(team.id, researcher.appId)
    expect((await ctx.service.listArtifacts(team.id, epochId)).flatMap(group => group.artifacts.map(artifact => artifact.relativePath)))
      .toEqual(['plan.md', 'team:researcher/sources.md'])
  })
})
