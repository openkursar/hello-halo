/**
 * Unit tests for temporary space collaborations (apps/team service).
 *
 * A collaboration is an ephemeral team coordinated by a space conversation:
 *   - createCollab: ephemeral team + coordinator member row (sentinel appId,
 *     lead) + AI members, bound to the conversation, one collaboration at a time
 *   - hidden surfaces: directory memberships carry the ephemeral flag,
 *     listTeamItems carries it for renderer filtering
 *   - saveCollab: clears the flag, keeps everything else running
 *   - runTeam: refuses an ephemeral team; provisions the real lead on a saved
 *     collaboration's first standalone run
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
import type { TeamEpoch } from '../../../../src/shared/apps/team-types'

const SPACE = 'space-a'
const CONVERSATION = 'conv-1'

function makeAppManager() {
  const apps = new Map<string, { id: string; spaceId: string | null; spec: { name: string } }>()
  let counter = 0
  return {
    apps,
    install: vi.fn(async (spaceId: string | null, spec: { name: string }) => {
      const id = `app-${++counter}`
      apps.set(id, { id, spaceId, spec: { ...spec } })
      return id
    }),
    getApp: vi.fn((appId: string) => apps.get(appId) ?? null),
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
    getMemberBusy: vi.fn(() => []),
  }
}

function buildService(overrides?: Partial<TeamServiceDeps>) {
  const dbManager = createDatabaseManager(':memory:')
  const db = dbManager.getAppDatabase()
  dbManager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
  const store = new TeamStore(db)
  const appManager = makeAppManager()
  const runtime = makeRuntime(store)

  const service = createTeamService({
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
  })
  return { service, store, appManager, runtime, dbManager }
}

const collabInput = () => ({
  owningSpaceId: SPACE,
  conversationId: CONVERSATION,
  name: 'Research crew',
  goal: 'Compare competitors',
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
    ctx.service.saveCollab(team.id)
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

  it('saveCollab keeps the team and the running collaboration untouched', async () => {
    const { team, epochId } = await ctx.service.createCollab(collabInput())

    const saved = ctx.service.saveCollab(team.id)
    expect(saved.ephemeral).toBe(false)
    // The live epoch is untouched — current work continues.
    expect(ctx.store.getEpochById(epochId)?.endedAt).toBeNull()
    // Members no longer read as ephemeral in the directory projection.
    expect(
      ctx.store.listDirectoryMemberships().filter(m => m.teamId === team.id).every(m => !m.ephemeral)
    ).toBe(true)
  })

  it('runTeam refuses an ephemeral collaboration outright', async () => {
    const { team } = await ctx.service.createCollab(collabInput())
    await expect(ctx.service.runTeam(team.id)).rejects.toThrow(/Save it as a team/)
  })

  it('a collaboration works in one conversation and cannot open a second', async () => {
    const { team, epochId } = await ctx.service.createCollab(collabInput())

    // The room is the conversation its space conversation coordinates — the
    // kind is what lets a surface find it without guessing.
    expect(ctx.service.listConversations(team.id)).toMatchObject([
      { epochId, kind: 'collab', label: team.name, readonly: false },
    ])

    expect(() => ctx.service.openConversation(team.id, 'Side task')).toThrow(/temporary collaboration/)
    expect(ctx.service.listConversations(team.id)).toHaveLength(1)
  })

  it('a completed collaboration keeps its room listed for review', async () => {
    const { team, epochId } = await ctx.service.createCollab(collabInput())
    await ctx.service.completeCollab(team.id, 'done')

    // The room's record survives the seal: history stays reachable from the
    // workbench instead of vanishing into an unrecoverable "unavailable" state.
    const rooms = ctx.service.listConversations(team.id)
    expect(rooms.find(c => c.epochId === epochId)).toMatchObject({ kind: 'collab' })
  })

  it('a saved collaboration opens tasks again, and its room still reads as the collaboration it was', async () => {
    const { team, epochId } = await ctx.service.createCollab(collabInput())
    ctx.service.saveCollab(team.id)

    const { epochId: taskId } = ctx.service.openConversation(team.id, 'Follow-up')
    const rooms = ctx.service.listConversations(team.id)
    expect(rooms).toHaveLength(2)
    // The room keeps its own identity: saving the team does not rewrite it into
    // a task, and the task the team opened beside it is an ordinary one.
    expect(rooms.find(c => c.epochId === epochId)?.kind).toBe('collab')
    expect(rooms.find(c => c.epochId === taskId)?.kind).toBe('native')
  })

  it('a saved collaboration provisions its real lead on the first standalone run', async () => {
    const { team } = await ctx.service.createCollab(collabInput())
    await ctx.service.completeCollab(team.id, 'done')
    ctx.service.saveCollab(team.id)

    await ctx.service.runTeam(team.id, { type: 'manual' }, 'Compare pricing this time')

    const after = ctx.service.getTeam(team.id)!
    expect(after.leadAppId).toBeTruthy()
    expect(after.leadAppId).not.toBe(spaceCoordinatorAppId(CONVERSATION))
    // The sentinel member row is gone; the provisioned lead took its place.
    const members = ctx.store.listMembersByTeam(team.id)
    expect(members.some(m => m.appId === spaceCoordinatorAppId(CONVERSATION))).toBe(false)
    expect(members.some(m => m.appId === after.leadAppId && m.isLead)).toBe(true)
    expect(ctx.runtime.startEpoch).toHaveBeenCalledWith(team.id, { type: 'manual' }, 'Compare pricing this time')
  })

  it('a live saved collaboration cannot be run standalone yet', async () => {
    const { team } = await ctx.service.createCollab(collabInput())
    ctx.service.saveCollab(team.id)
    await expect(ctx.service.runTeam(team.id)).rejects.toThrow(/still in progress/)
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
})
