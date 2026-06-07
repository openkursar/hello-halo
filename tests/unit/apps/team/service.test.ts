/**
 * Unit tests for apps/team service (lifecycle + orchestration)
 *
 * Covers the service layer over a REAL in-memory TeamStore, with the App
 * Manager, the team runtime, and the space/artifact helpers mocked:
 *   - createTeam manual: attaches existing apps, provisions a lead, default
 *     structured edges (lead→member sync)
 *   - createTeam AI: caps the confirmed proposal at AI_MEMBER_HARD_LIMIT,
 *     installs member apps with aiProvisioned=true in independent spaces
 *   - dissolve orphan cleanup: AI members + provisioned lead removed, manual
 *     members kept (and apps referenced by another team kept)
 *   - collabMode switch clears / regenerates edges (§F9)
 *   - run/pause delegate to runtime.startEpoch / sealEpoch
 *   - every mutation emits team:updated on both transports
 *
 * The event emitters are mocked so emissions can be asserted without Electron.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { broadcastToAll, sendToRenderer } = vi.hoisted(() => ({
  broadcastToAll: vi.fn(),
  sendToRenderer: vi.fn(),
}))
vi.mock('../../../../src/main/http/websocket', () => ({ broadcastToAll }))
vi.mock('../../../../src/main/foundation/window.service', () => ({ sendToRenderer }))

import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import { TeamStore } from '../../../../src/main/apps/team/store'
import { MIGRATION_NAMESPACE, migrations } from '../../../../src/main/apps/team/migrations'
import { createTeamService, parseProposedMembers } from '../../../../src/main/apps/team/service'
import type { TeamServiceDeps } from '../../../../src/main/apps/team/service'
import { AI_MEMBER_HARD_LIMIT } from '../../../../src/shared/apps/team-types'
import type {
  CreateTeamInput,
  ProposedMember,
  TeamEpoch,
} from '../../../../src/shared/apps/team-types'

const SPACE_A = 'space-a'

// ============================================
// Mock App Manager
// ============================================

interface FakeApp {
  id: string
  spaceId: string | null
  spec: { name: string }
}

function makeAppManager() {
  const apps = new Map<string, FakeApp>()
  let counter = 0

  const install = vi.fn(async (spaceId: string | null, spec: { name: string }) => {
    const id = `app-${++counter}`
    apps.set(id, { id, spaceId, spec: { name: spec.name } })
    return id
  })
  const getApp = vi.fn((appId: string) => apps.get(appId) ?? null)
  const uninstall = vi.fn(async () => {})
  const deleteApp = vi.fn(async (appId: string) => {
    apps.delete(appId)
  })

  // Pre-seed a couple of "existing" apps for manual membership.
  apps.set('existing-1', { id: 'existing-1', spaceId: SPACE_A, spec: { name: 'Researcher' } })
  apps.set('existing-2', { id: 'existing-2', spaceId: SPACE_A, spec: { name: 'Tester' } })

  return { apps, install, getApp, uninstall, deleteApp }
}

// ============================================
// Mock Runtime
// ============================================

function makeRuntime() {
  let epochCounter = 0
  const startEpoch = vi.fn(async (teamId: string): Promise<TeamEpoch> => {
    return {
      id: `epoch-${++epochCounter}`,
      teamId,
      startedAt: Date.now(),
      endedAt: null,
      endReason: null,
      summary: null,
    lifecycle: 'run',
    chatKey: null,
    }
  })
  const sealEpoch = vi.fn(async () => {})
  const blackboard = {
    postTask: vi.fn(),
    updateTask: vi.fn(),
    postFinding: vi.fn(),
    readBoard: vi.fn(() => ({ tasks: [], findings: [], roster: [] })),
  }
  return {
    bus: {} as never,
    blackboard: blackboard as never,
    startEpoch,
    sealEpoch,
    captureReport: vi.fn(),
    buildPromptContext: vi.fn(),
  }
}

// ============================================
// Service factory under test
// ============================================

function buildService(overrides?: Partial<TeamServiceDeps>) {
  const dbManager = createDatabaseManager(':memory:')
  const db = dbManager.getAppDatabase()
  dbManager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
  const store = new TeamStore(db)

  const appManager = makeAppManager()
  const runtime = makeRuntime()
  const createdSpaces: string[] = []
  const deletedSpaces: string[] = []
  let spaceCounter = 0

  const deps: TeamServiceDeps = {
    store,
    appManager: appManager as never,
    getRuntime: () => runtime as never,
    spaces: {
      spaceExists: () => true,
      createMemberSpace: () => {
        const id = `member-space-${++spaceCounter}`
        createdSpaces.push(id)
        return id
      },
      deleteMemberSpace: (spaceId) => {
        deletedSpaces.push(spaceId)
      },
    },
    listArtifacts: vi.fn(async () => []),
    proposeMembersFromGoal: vi.fn(async () => []),
    ...overrides,
  }

  const service = createTeamService(deps)
  return { service, store, appManager, runtime, dbManager, createdSpaces, deletedSpaces }
}

function manualInput(overrides?: Partial<CreateTeamInput>): CreateTeamInput {
  return {
    name: 'Research Team',
    goal: 'Build a competitor brief',
    owningSpaceId: SPACE_A,
    memberSourcing: 'manual',
    collabMode: 'structured',
    escalationRouting: 'user',
    members: [{ appId: 'existing-1', role: 'Research' }],
    ...overrides,
  }
}

// ============================================
// Tests
// ============================================

describe('TeamService', () => {
  let ctx: ReturnType<typeof buildService>

  beforeEach(() => {
    broadcastToAll.mockClear()
    sendToRenderer.mockClear()
    ctx = buildService()
  })

  afterEach(() => {
    ctx.dbManager.closeAll()
  })

  describe('createTeam — manual', () => {
    it('attaches existing apps, provisions a lead, and emits team:updated', async () => {
      const team = await ctx.service.createTeam(manualInput())

      expect(team.leadAppId).toBeTruthy()
      const members = ctx.store.listMembersByTeam(team.id)
      // The lead is a real member row (isLead:true) alongside the worker, so the
      // runtime can resolve it as a team participant.
      const workers = members.filter((m) => !m.isLead)
      const lead = members.find((m) => m.isLead)
      expect(workers).toHaveLength(1)
      expect(workers[0].appId).toBe('existing-1')
      expect(workers[0].aiProvisioned).toBe(false)
      expect(lead?.appId).toBe(team.leadAppId)

      // Lead install happened (the only install for a manual team).
      expect(ctx.appManager.install).toHaveBeenCalledTimes(1)

      // Default structured edge: lead → member, sync=true.
      const edges = ctx.store.listEdgesByTeam(team.id)
      expect(edges).toHaveLength(1)
      expect(edges[0].fromAppId).toBe(team.leadAppId)
      expect(edges[0].toAppId).toBe('existing-1')
      expect(edges[0].sync).toBe(true)

      // team:updated emitted on both transports.
      expect(broadcastToAll).toHaveBeenCalledWith('team:updated', expect.objectContaining({ teamId: team.id }))
      expect(sendToRenderer).toHaveBeenCalledWith('team:updated', expect.objectContaining({ teamId: team.id }))
    })

    it('respects an explicit leadAppId without provisioning a new lead', async () => {
      const team = await ctx.service.createTeam(manualInput({ leadAppId: 'existing-2' }))
      expect(team.leadAppId).toBe('existing-2')
      // No lead install — only existing apps referenced.
      expect(ctx.appManager.install).not.toHaveBeenCalled()
    })

    it('free mode generates no edges', async () => {
      const team = await ctx.service.createTeam(manualInput({ collabMode: 'free' }))
      expect(ctx.store.listEdgesByTeam(team.id)).toHaveLength(0)
    })
  })

  describe('createTeam — AI', () => {
    function proposal(n: number): ProposedMember[] {
      return Array.from({ length: n }, (_, i) => ({
        memberName: `m${i}`,
        role: `role-${i}`,
        responsibility: `does ${i}`,
      }))
    }

    it('installs AI members (aiProvisioned) in independent spaces and caps at the hard limit', async () => {
      const team = await ctx.service.createTeam(
        manualInput({ memberSourcing: 'ai', members: [] }),
        proposal(AI_MEMBER_HARD_LIMIT + 3) // over the cap
      )

      const members = ctx.store.listMembersByTeam(team.id)
      const workers = members.filter((m) => !m.isLead)
      expect(workers).toHaveLength(AI_MEMBER_HARD_LIMIT)
      expect(workers.every((m) => m.aiProvisioned)).toBe(true)

      // One independent space + one install per AI member, plus one lead install.
      expect(ctx.createdSpaces).toHaveLength(AI_MEMBER_HARD_LIMIT)
      expect(ctx.appManager.install).toHaveBeenCalledTimes(AI_MEMBER_HARD_LIMIT + 1)
    })

    it('assigns unique member names when the proposal collides', async () => {
      const dup: ProposedMember[] = [
        { memberName: 'dev', role: 'a', responsibility: 'x' },
        { memberName: 'dev', role: 'b', responsibility: 'y' },
      ]
      const team = await ctx.service.createTeam(manualInput({ memberSourcing: 'ai', members: [] }), dup)
      const names = ctx.store.listMembersByTeam(team.id).filter((m) => !m.isLead).map((m) => m.memberName)
      expect(new Set(names).size).toBe(2)
    })
  })

  describe('dissolveTeam — orphan cleanup', () => {
    it('deletes AI members + the provisioned lead, keeps manual members', async () => {
      // Manual member (existing-1) + AI member + provisioned lead.
      const team = await ctx.service.createTeam(
        manualInput({
          memberSourcing: 'manual',
          members: [{ appId: 'existing-1', role: 'Research' }],
        })
      )
      const leadAppId = team.leadAppId!

      // A second manual member (referenced app) must also survive dissolve.
      await ctx.service.addMember(team.id, { appId: 'existing-2' })

      await ctx.service.dissolveTeam(team.id)

      // Team gone.
      expect(ctx.store.getTeamById(team.id)).toBeNull()
      // Lead app deleted (provisioned, unreferenced).
      expect(ctx.appManager.deleteApp).toHaveBeenCalledWith(leadAppId)
      // Manual member apps NOT deleted.
      expect(ctx.appManager.deleteApp).not.toHaveBeenCalledWith('existing-1')
      expect(ctx.appManager.deleteApp).not.toHaveBeenCalledWith('existing-2')

      // removed event emitted.
      expect(broadcastToAll).toHaveBeenCalledWith('team:updated', expect.objectContaining({ teamId: team.id, removed: true }))
    })

    it('deletes AI member apps + their spaces on dissolve', async () => {
      const proposal: ProposedMember[] = [{ memberName: 'ai1', role: 'r', responsibility: 'x' }]
      const team = await ctx.service.createTeam(manualInput({ memberSourcing: 'ai', members: [] }), proposal)
      const aiMember = ctx.store.listMembersByTeam(team.id).filter((m) => !m.isLead)[0]

      ctx.appManager.deleteApp.mockClear()
      await ctx.service.dissolveTeam(team.id)

      expect(ctx.appManager.deleteApp).toHaveBeenCalledWith(aiMember.appId)
      expect(ctx.deletedSpaces.length).toBeGreaterThanOrEqual(1)
    })

    it('keeps an AI app that is still referenced by another team', async () => {
      const proposal: ProposedMember[] = [{ memberName: 'ai1', role: 'r', responsibility: 'x' }]
      const teamA = await ctx.service.createTeam(manualInput({ name: 'A', memberSourcing: 'ai', members: [] }), proposal)
      const aiMember = ctx.store.listMembersByTeam(teamA.id).filter((m) => !m.isLead)[0]

      // Reference the same AI app from a second team (manual reference).
      const teamB = await ctx.service.createTeam(manualInput({ name: 'B', memberSourcing: 'manual', members: [] }))
      await ctx.service.addMember(teamB.id, { appId: aiMember.appId })

      ctx.appManager.deleteApp.mockClear()
      await ctx.service.dissolveTeam(teamA.id)

      // Still referenced by team B → not deleted.
      expect(ctx.appManager.deleteApp).not.toHaveBeenCalledWith(aiMember.appId)
    })
  })

  describe('updateTeam — collabMode switch (§F9)', () => {
    it('structured → free clears edges', async () => {
      const team = await ctx.service.createTeam(manualInput({ collabMode: 'structured' }))
      expect(ctx.store.listEdgesByTeam(team.id).length).toBeGreaterThan(0)

      await ctx.service.updateTeam(team.id, { collabMode: 'free' })
      expect(ctx.store.listEdgesByTeam(team.id)).toHaveLength(0)
    })

    it('free → structured regenerates default lead→member edges', async () => {
      const team = await ctx.service.createTeam(manualInput({ collabMode: 'free' }))
      expect(ctx.store.listEdgesByTeam(team.id)).toHaveLength(0)

      await ctx.service.updateTeam(team.id, { collabMode: 'structured' })
      const edges = ctx.store.listEdgesByTeam(team.id)
      expect(edges).toHaveLength(1)
      expect(edges[0].fromAppId).toBe(team.leadAppId)
      expect(edges[0].sync).toBe(true)
    })
  })

  describe('run / pause', () => {
    it('runTeam delegates to runtime.startEpoch', async () => {
      const team = await ctx.service.createTeam(manualInput())
      await ctx.service.runTeam(team.id)
      // Defaults to a manual run trigger when none is given.
      expect(ctx.runtime.startEpoch).toHaveBeenCalledWith(team.id, { type: 'manual' })
    })

    it('pauseTeam seals the epoch with reason "stopped"', async () => {
      const team = await ctx.service.createTeam(manualInput())
      await ctx.service.pauseTeam(team.id)
      expect(ctx.runtime.sealEpoch).toHaveBeenCalledWith(team.id, 'stopped')
    })
  })

  describe('setEdges + listTeamItems', () => {
    it('setEdges replaces topology and normalizes teamId', async () => {
      const team = await ctx.service.createTeam(manualInput({ collabMode: 'free' }))
      ctx.service.setEdges(team.id, [
        { teamId: 'WRONG', fromAppId: team.leadAppId!, toAppId: 'existing-1', sync: false },
      ])
      const edges = ctx.store.listEdgesByTeam(team.id)
      expect(edges).toHaveLength(1)
      expect(edges[0].teamId).toBe(team.id)
    })

    it('listTeamItems projects member count + status', async () => {
      const team = await ctx.service.createTeam(manualInput())
      const items = ctx.service.listTeamItems(SPACE_A)
      const item = items.find((i) => i.id === team.id)
      expect(item).toBeTruthy()
      expect(item!.memberCount).toBe(1)
      expect(item!.status).toBe('idle')
    })
  })

  describe('proposeMembers', () => {
    it('caps the proposer output at the hard limit', async () => {
      const big: ProposedMember[] = Array.from({ length: AI_MEMBER_HARD_LIMIT + 4 }, (_, i) => ({
        memberName: `m${i}`,
        role: `r${i}`,
        responsibility: `x${i}`,
      }))
      const local = buildService({ proposeMembersFromGoal: vi.fn(async () => big) })
      const out = await local.service.proposeMembers('some goal', SPACE_A)
      expect(out).toHaveLength(AI_MEMBER_HARD_LIMIT)
      local.dbManager.closeAll()
    })
  })
})

// ============================================
// parseProposedMembers (defensive JSON parsing)
// ============================================

describe('parseProposedMembers', () => {
  it('extracts a JSON array embedded in prose', () => {
    const raw = 'Sure! Here you go:\n[{"memberName":"dev","role":"Engineer","responsibility":"build"}] done'
    const out = parseProposedMembers(raw)
    expect(out).toEqual([{ memberName: 'dev', role: 'Engineer', responsibility: 'build' }])
  })

  it('returns [] on malformed input', () => {
    expect(parseProposedMembers('not json')).toEqual([])
    expect(parseProposedMembers('{"memberName":"x"}')).toEqual([])
  })

  it('drops items missing required fields and caps at the hard limit', () => {
    const items = Array.from({ length: AI_MEMBER_HARD_LIMIT + 2 }, (_, i) => ({
      memberName: `m${i}`,
      role: 'r',
      responsibility: 'x',
    }))
    items.push({ memberName: '', role: 'r', responsibility: 'x' } as never)
    const out = parseProposedMembers(JSON.stringify(items))
    expect(out.length).toBe(AI_MEMBER_HARD_LIMIT)
  })
})
