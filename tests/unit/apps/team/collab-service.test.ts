/**
 * Unit tests for temporary space collaborations (apps/team service).
 *
 * A collaboration is an ephemeral team coordinated by a space conversation:
 *   - createCollab: ephemeral team + coordinator member row (sentinel appId,
 *     lead) + AI members, bound to the conversation, one collaboration at a time
 *   - hidden surfaces: directory memberships carry the ephemeral flag,
 *     listTeamItems carries it for renderer filtering
 *   - saveCollab: snapshots configuration into a separate single-lead team
 *   - runTeam: refuses an ephemeral team; provisions the real lead on a saved
 *     collaboration before independent work
 *   - completeCollab: seals the collaboration's conversation epoch
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
import { TeamStore } from '../../../../src/main/apps/team/store'
import { MIGRATION_NAMESPACE, migrations } from '../../../../src/main/apps/team/migrations'
import { createTeamService } from '../../../../src/main/apps/team/service'
import type { TeamServiceDeps } from '../../../../src/main/apps/team/service'
import {
  SPACE_COORDINATOR_MEMBER_NAME,
  TEAM_EVENTS,
  spaceCoordinatorAppId,
  spaceCollabChatKey,
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
  const sealConversationEpoch = vi.fn(async (_teamId: string, epochId: string) => {
    store.endEpoch(epochId, Date.now(), 'completed', null, null)
  })
  return {
    bus: {} as never,
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

  it('createCollab assembles an ephemeral team with the space conversation as coordinator', async () => {
    const { team, epochId } = await ctx.service.createCollab(collabInput())

    expect(team.ephemeral).toBe(true)
    expect(team.coordinatorConversationId).toBe(CONVERSATION)
    expect(team.leadAppId).toBe(spaceCoordinatorAppId(CONVERSATION))
    expect(team.collabMode).toBe('free')

    const members = ctx.store.listMembersByTeam(team.id)
    const coordinator = members.find(m => m.appId === spaceCoordinatorAppId(CONVERSATION))
    expect(coordinator?.memberName).toBe(SPACE_COORDINATOR_MEMBER_NAME)
    expect(coordinator?.isLead).toBe(true)
    // Never cleaned up as an orphan app — there is no app behind it.
    expect(coordinator?.aiProvisioned).toBe(false)
    expect(members.filter(m => m.appId !== coordinator!.appId)).toHaveLength(2)

    // Members share the owning space (CC-style shared working directory).
    for (const m of members.filter(x => x.aiProvisioned)) {
      expect(ctx.appManager.apps.get(m.appId)?.spaceId).toBe(SPACE)
    }

    const epoch = ctx.store.getEpochById(epochId)
    expect(epoch?.lifecycle).toBe('conversation')
    expect(epoch?.chatKey).toBe(spaceCollabChatKey(CONVERSATION))
  })

  it('pins every member before dispatch and keeps the captured selection across creation awaits', async () => {
    const input = collabInput()
    const originalInstall = ctx.appManager.install.getMockImplementation()!
    ctx.appManager.install.mockImplementation(async (spaceId, spec) => {
      input.modelSelection.modelSourceId = 'other-source'
      input.modelSelection.modelId = 'other-model'
      return originalInstall(spaceId, spec)
    })
    const { team } = await ctx.service.createCollab(input)
    for (const member of ctx.store.listMembersByTeam(team.id).filter(m => m.aiProvisioned)) {
      expect(ctx.appManager.getApp(member.appId)?.userOverrides).toEqual({
        modelSourceId: 'parent-source', modelId: 'parent-model',
      })
    }
    expect(ctx.appManager.updateOverrides).toHaveBeenCalledTimes(2)
    expect(ctx.appManager.updateOverrides.mock.invocationCallOrder.at(-1))
      .toBeLessThan(ctx.runtime.ensureConversationEpoch.mock.invocationCallOrder[0])
    await ctx.service.saveCollab(team.id)
    expect(ctx.appManager.getApp('app-1')?.userOverrides.modelId).toBe('parent-model')
  })

  it('refuses a missing coordinator model before installing members', async () => {
    const input = collabInput()
    input.modelSelection.modelId = ''
    await expect(ctx.service.createCollab(input)).rejects.toThrow(/coordinator source and model/)
    expect(ctx.appManager.install).not.toHaveBeenCalled()
    expect(ctx.store.listTeams()).toEqual([])
  })

  it('rolls back all provisioned members when persisting the model fails', async () => {
    ctx.appManager.updateOverrides.mockImplementationOnce(() => {}).mockImplementationOnce(() => {
      throw new Error('model write failed')
    })
    await expect(ctx.service.createCollab(collabInput())).rejects.toThrow('model write failed')
    expect(ctx.appManager.apps.size).toBe(0)
    expect(ctx.store.listTeams()).toEqual([])
    expect(ctx.runtime.ensureConversationEpoch).not.toHaveBeenCalled()
  })

  it('refuses a second collaboration while one is live, replaces a finished ephemeral one', async () => {
    const first = await ctx.service.createCollab(collabInput())
    await expect(ctx.service.createCollab(collabInput())).rejects.toThrow(/active collaboration/)

    await ctx.service.completeCollab(first.team.id, 'done')
    const second = await ctx.service.createCollab(collabInput())
    expect(second.team.id).not.toBe(first.team.id)
    // The finished ephemeral team dissolved with its members.
    expect(ctx.store.getTeamById(first.team.id)).toBeNull()
  })

  it('serializes concurrent createCollab calls for one conversation', async () => {
    // Without per-conversation serialization the second call would interleave
    // into the first's member-provisioning awaits and dissolve it mid-assembly.
    const p1 = ctx.service.createCollab(collabInput())
    const p2 = ctx.service.createCollab(collabInput())

    await expect(p2).rejects.toThrow(/active collaboration/)
    const first = await p1
    // The first collaboration survived intact: coordinator + two AI members.
    expect(ctx.store.getTeamById(first.team.id)).not.toBeNull()
    expect(ctx.store.listMembersByTeam(first.team.id)).toHaveLength(3)
    expect(ctx.service.getCollabForConversation(CONVERSATION)?.teamId).toBe(first.team.id)
  })

  it('the store refuses a second team bound to the same conversation', async () => {
    await ctx.service.createCollab(collabInput())
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

  it('replacing a finished SAVED collaboration unbinds it and announces the update', async () => {
    const { team } = await ctx.service.createCollab(collabInput())
    await ctx.service.saveCollab(team.id)
    await ctx.service.completeCollab(team.id, 'done')

    broadcastToAll.mockClear()
    const second = await ctx.service.createCollab(collabInput())
    expect(second.team.id).not.toBe(team.id)

    // The old saved team is unbound AND the renderer heard about it — without
    // the event, its in-chat panel keeps showing the stale team.
    expect(ctx.store.getTeamById(team.id)?.coordinatorConversationId).toBeNull()
    const unbindEvent = broadcastToAll.mock.calls.find(
      ([channel, event]) =>
        channel === TEAM_EVENTS.updated &&
        (event as { teamId?: string }).teamId === team.id
    )
    expect(unbindEvent).toBeTruthy()
    expect((unbindEvent![1] as { team?: { coordinatorConversationId: string | null } }).team?.coordinatorConversationId).toBeNull()
  })

  it('marks memberships ephemeral for the people directory, and list items for the Teams page', async () => {
    const { team } = await ctx.service.createCollab(collabInput())

    const memberships = ctx.store.listDirectoryMemberships().filter(m => m.teamId === team.id)
    expect(memberships.length).toBeGreaterThan(0)
    expect(memberships.every(m => m.ephemeral)).toBe(true)

    const item = ctx.service.listTeamItems(SPACE).find(t => t.id === team.id)
    expect(item?.ephemeral).toBe(true)
  })

  it('getCollabForConversation projects the live collaboration without the coordinator row', async () => {
    const { team } = await ctx.service.createCollab(collabInput())

    const collab = ctx.service.getCollabForConversation(CONVERSATION)
    expect(collab?.teamId).toBe(team.id)
    expect(collab?.active).toBe(true)
    expect(collab?.saved).toBe(false)
    expect(collab?.members.map(m => m.memberName).sort()).toEqual(['researcher', 'writer'])

    await ctx.service.completeCollab(team.id, 'done')
    expect(ctx.service.getCollabForConversation(CONVERSATION)?.active).toBe(false)
  })

  it('saves only configuration into a separate ordinary team and preserves the running source', async () => {
    const { team, epochId } = await ctx.service.createCollab(collabInput())
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
    const { team } = await ctx.service.createCollab(collabInput())
    const first = ctx.service.saveCollab(team.id)
    expect(ctx.service.saveCollab(team.id)).toBe(first)
    const saved = await first
    const reopened = createTeamService(ctx.deps)
    expect((await reopened.saveCollab(team.id)).id).toBe(saved.id)
    expect(ctx.appManager.install).toHaveBeenCalledTimes(3)
    expect(ctx.store.listTeams()).toHaveLength(2)
  })

  it.each(['configuration', 'link'])('rolls back a failed %s without changing source work or members', async stage => {
    const { team, epochId } = await ctx.service.createCollab(collabInput())
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
    const { team } = await ctx.service.createCollab(collabInput())
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
    const { team } = await ctx.service.createCollab(collabInput())
    const saved = await ctx.service.saveCollab(team.id)
    await ctx.service.dissolveTeam(team.id)
    expect(ctx.store.getTeamById(saved.id)?.leadAppId).toBe(saved.leadAppId)
    for (const member of ctx.store.listMembersByTeam(saved.id)) expect(ctx.appManager.getApp(member.appId)).not.toBeNull()
    await ctx.service.dissolveTeam(saved.id)
    expect(ctx.appManager.apps.size).toBe(0)
  })

  it('does not copy someone else’s remote membership into a new office without an invitation', async () => {
    const { team } = await ctx.service.createCollab(collabInput())
    ctx.store.addMember({ teamId: team.id, appId: 'remote-app', memberName: 'Remote', role: '', isLead: false, aiProvisioned: false, addedAt: Date.now(), origin: 'remote', ownerNodeId: 'another-node' })
    await expect(ctx.service.saveCollab(team.id)).rejects.toThrow(/invite/)
    expect(ctx.store.listTeams()).toHaveLength(1)
    expect(ctx.appManager.install).toHaveBeenCalledTimes(2)
  })

  it('copies the collaboration topology as configuration without copying its work', async () => {
    const { team } = await ctx.service.createCollab(collabInput())
    await ctx.service.updateTeam(team.id, { collabMode: 'structured' })
    const edges = ctx.store.listEdgesByTeam(team.id)
    const saved = await ctx.service.saveCollab(team.id)
    expect(ctx.store.listEdgesByTeam(saved.id)).toEqual(edges.map(edge => ({ ...edge, teamId: saved.id, fromAppId: saved.leadAppId })))
    expect(ctx.service.listConversations(saved.id)).toEqual([])
  })

  it('allows saving again after the previously saved team was deleted', async () => {
    const { team } = await ctx.service.createCollab(collabInput())
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
    const { team, epochId } = await ctx.service.createCollab(collabInput())
    const saved = await ctx.service.saveCollab(team.id)
    await expect(ctx.service.openConversation(team.id, 'Side task')).rejects.toThrow(/temporary collaboration/)
    await expect(ctx.service.runTeam(team.id)).rejects.toThrow(/Save it as a team/)
    await ctx.service.openConversation(saved.id, 'Next request')
    await ctx.service.runTeam(saved.id)
    expect(ctx.service.listConversations(team.id).map(task => task.epochId)).toEqual([epochId])
    expect(ctx.service.getCollabForConversation(CONVERSATION)?.active).toBe(true)
  })

  it('normalizes an old saved team in place without starting or copying any work', async () => {
    const { team, epochId } = await ctx.service.createCollab(collabInput())
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
    const { team } = await ctx.service.createCollab(collabInput())
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
    const { team, epochId } = await ctx.service.createCollab(collabInput())
    ctx.store.clearEphemeral(team.id)
    const member = ctx.store.listMembersByTeam(team.id).find(row => row.aiProvisioned)!
    ctx.runtime.getMemberBusy.mockImplementation(appId => appId === member.appId ? [{ epochId, kind: 'conversation', label: 'Research' }] : [])
    const detail = await ctx.service.openTeamDetail(team.id)
    expect(detail?.legacyCoordinator).toMatchObject({ repairDeferred: true })
    expect(ctx.store.getTeamById(team.id)?.leadAppId).toBe(team.leadAppId)
    expect(ctx.appManager.install).toHaveBeenCalledTimes(2)
  })

  it('rechecks live work after lead preparation and rolls back the unused lead', async () => {
    const { team } = await ctx.service.createCollab(collabInput())
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
    const { team } = await ctx.service.createCollab(collabInput())
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
    const { team } = await ctx.service.createCollab(collabInput())
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
    const { team } = await ctx.service.createCollab(collabInput())
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
    const { team } = await ctx.service.createCollab(collabInput())
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
    const { team, epochId } = await ctx.service.createCollab(collabInput())
    const researcher = ctx.store.listMembersByTeam(team.id).find(m => m.memberName === 'researcher')!
    const finding = (authorAppId: string, ref: string) =>
      ctx.store.insertFinding({ id: randomUUID(), teamId: team.id, epochId, authorAppId, body: null, ref, createdAt: Date.now() })
    finding(spaceCoordinatorAppId(CONVERSATION), 'plan.md')
    finding(researcher.appId, 'team:researcher/sources.md')

    const groups = await ctx.service.listArtifacts(team.id, epochId)
    const byMember = new Map(groups.map(g => [g.memberName, g.artifacts[0]]))

    // The coordinator has no app record; its file sits in the owning space's work dir.
    expect(byMember.get('coordinator')?.path).toBe('/work/project/plan.md')
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
