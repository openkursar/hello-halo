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
 *   - collabMode switch clears / regenerates edges
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
  /** Kept whole (not just the name) so tests can assert what was provisioned. */
  spec: { name: string; system_prompt?: string }
}

function makeAppManager() {
  const apps = new Map<string, FakeApp>()
  let counter = 0

  const install = vi.fn(async (spaceId: string | null, spec: FakeApp['spec']) => {
    const id = `app-${++counter}`
    apps.set(id, { id, spaceId, spec: { ...spec } })
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
    checks: { viewForTeam: () => [], cancelById: vi.fn() } as never,
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
  const installedSpec = (appId: string) => appManager.apps.get(appId)?.spec ?? null

  return { service, store, appManager, runtime, dbManager, createdSpaces, deletedSpaces, installedSpec }
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

  describe('updateMember — duty and delegated capabilities', () => {
    it('writes a duty for a member of mine, trimmed', async () => {
      const team = await ctx.service.createTeam(manualInput())

      const updated = ctx.service.updateMember(team.id, 'existing-1', { duty: '  You do the coding.  ' })

      expect(updated.duty).toBe('You do the coding.')
      expect(ctx.store.listMembersByTeam(team.id).find(m => m.appId === 'existing-1')!.duty)
        .toBe('You do the coding.')
    })

    it('derives the one bit teammates need from the policy, and keeps the rest home', async () => {
      const team = await ctx.service.createTeam(manualInput())

      ctx.service.updateMember(team.id, 'existing-1', {
        delegatedPolicy: { allowedTools: ['Read'], allowChecks: false },
      })

      const member = ctx.store.listMembersByTeam(team.id).find(m => m.appId === 'existing-1')!
      expect(member.acceptsChecks).toBe(false)
      expect(member.delegatedPolicy).toEqual({ allowedTools: ['Read'], allowChecks: false })
    })

    it('refuses to rewrite a digital human someone else brought', async () => {
      const team = await ctx.service.createTeam(manualInput())
      ctx.store.addMember({
        teamId: team.id, appId: 'app-theirs', memberName: 'tester', role: '',
        isLead: false, aiProvisioned: false, addedAt: 9,
        ownerNodeId: 'node-b', origin: 'remote',
      })

      expect(() => ctx.service.updateMember(team.id, 'app-theirs', { duty: 'mine now' }))
        .toThrow(/only its owner/i)
    })
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

    it('keeps the proposed responsibility out of the member app’s own prompt', async () => {
      // The responsibility becomes the member's team duty, which the owner can
      // rewrite at any time. A second copy baked into the app's system prompt
      // could never be reached by that edit, leaving the member with two
      // conflicting job descriptions — so the prompt must not carry it.
      const team = await ctx.service.createTeam(
        manualInput({ memberSourcing: 'ai', members: [] }),
        [{ memberName: 'coder', role: 'engineer', responsibility: 'Ship the API and self-test it.' }]
      )

      const member = ctx.store.listMembersByTeam(team.id).find((m) => !m.isLead)!
      expect(member.duty).toBe('Ship the API and self-test it.')

      const spec = ctx.installedSpec(member.appId)!
      expect(spec.system_prompt).not.toContain('Ship the API and self-test it.')
      expect(spec.system_prompt).not.toContain(team.name)
      expect(spec.system_prompt).toContain('coder')
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

    it('deletes a space the team built, never the space the team was created in', async () => {
      const proposal: ProposedMember[] = [{ memberName: 'ai1', role: 'r', responsibility: 'x' }]
      const team = await ctx.service.createTeam(manualInput({ memberSourcing: 'ai', members: [] }), proposal)
      const leadAppId = team.leadAppId!
      const aiMember = ctx.store.listMembersByTeam(team.id).filter((m) => !m.isLead)[0]
      const aiSpaceId = ctx.appManager.getApp(aiMember.appId)!.spaceId

      await ctx.service.dissolveTeam(team.id)

      // Both apps are the team's own and go with it.
      expect(ctx.appManager.deleteApp).toHaveBeenCalledWith(leadAppId)
      expect(ctx.appManager.deleteApp).toHaveBeenCalledWith(aiMember.appId)
      // The space built for the AI member goes too.
      expect(ctx.deletedSpaces).toContain(aiSpaceId)
      // The lead was provisioned into the user's own space. Deleting that would
      // take its files and every other app living in it.
      expect(ctx.deletedSpaces).not.toContain(SPACE_A)
    })

    it('leaves the owning space alone when a demoted lead is removed', async () => {
      const team = await ctx.service.createTeam(manualInput())
      const oldLeadAppId = team.leadAppId!

      // Handing the lead over leaves the old one an ordinary member that still
      // counts as team-provisioned, so its delete button opens up — four clicks
      // from a fresh team to deleting the space the user works in.
      await ctx.service.updateTeam(team.id, { leadAppId: 'existing-1' })
      await ctx.service.removeMember(team.id, oldLeadAppId)

      expect(ctx.appManager.deleteApp).toHaveBeenCalledWith(oldLeadAppId)
      expect(ctx.deletedSpaces).not.toContain(SPACE_A)
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

    it('fires onRosterMutated on a lead change so joiners do not go stale (D-NEW-3)', async () => {
      const onRosterMutated = vi.fn()
      const local = buildService({ onRosterMutated })
      const team = await local.service.createTeam(
        manualInput({
          collabMode: 'structured',
          members: [{ appId: 'existing-1', role: 'Research' }, { appId: 'existing-2', role: 'Writer' }],
        })
      )
      onRosterMutated.mockClear()

      await local.service.updateTeam(team.id, { leadAppId: 'existing-2' })
      expect(onRosterMutated).toHaveBeenCalledWith(team.id)
      local.dbManager.closeAll()
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

    it('runTeam fires onRunStateChanged so a joiner status board goes live at run-start', async () => {
      const onRunStateChanged = vi.fn()
      const local = buildService({ onRunStateChanged })
      const team = await local.service.createTeam(manualInput())
      onRunStateChanged.mockClear()

      await local.service.runTeam(team.id)
      expect(onRunStateChanged).toHaveBeenCalledWith(team.id)
      local.dbManager.closeAll()
    })

    it('pauseTeam fires onRunStateChanged so a joiner status board rests at run-stop', async () => {
      const onRunStateChanged = vi.fn()
      const local = buildService({ onRunStateChanged })
      const team = await local.service.createTeam(manualInput())
      onRunStateChanged.mockClear()

      await local.service.pauseTeam(team.id)
      expect(onRunStateChanged).toHaveBeenCalledWith(team.id)
      local.dbManager.closeAll()
    })
  })

  describe('getTeamDetail — joined (shadow) office', () => {
    it('reads the replicated board for the active epoch and overlays member status', async () => {
      const NODE_HOST = 'node-host'
      const EPOCH = 'epoch-host-run'
      const LEAD = 'shadow-lead'
      const WORKER = 'shadow-worker'

      // A joiner materializes a RUNNING shadow office with a working member.
      ctx.store.materializeJoinedOffice({
        hostNodeId: NODE_HOST,
        selfNodeId: 'node-self',
        snapshot: {
          team: {
            id: 'shadow-office', name: 'Shadow', goal: 'g', leadAppId: LEAD,
            collabMode: 'structured', hostNodeId: NODE_HOST, epochId: EPOCH, status: 'running',
          },
          members: [
            { appId: LEAD, memberName: 'lead', role: 'Lead', isLead: true, ownerNodeId: NODE_HOST, memberIdentity: 'id-host', status: 'idle' },
            { appId: WORKER, memberName: 'worker', role: 'Analyst', isLead: false, ownerNodeId: NODE_HOST, memberIdentity: 'id-host', status: 'working', currentTaskTitle: 'Draft the brief' },
          ],
          edges: [],
        },
      })
      // Replication wrote a task into THIS store under the host's epoch id.
      ctx.store.insertTask({
        id: 'task-1', teamId: 'shadow-office', epochId: EPOCH, title: 'Draft the brief',
        assigneeAppId: WORKER, status: 'in_progress', resultRef: null, note: null,
        parentId: null, createdByAppId: LEAD, createdAt: Date.now(), updatedAt: Date.now(),
      })

      const detail = ctx.service.getTeamDetail('shadow-office')!
      expect(detail).toBeTruthy()
      expect(detail.team.status).toBe('running')
      expect(detail.tasks).toHaveLength(1)
      expect(detail.tasks[0].id).toBe('task-1')
      const worker = detail.roster.find((m) => m.appId === WORKER)!
      expect(worker.status).toBe('working')
      expect(worker.currentTaskTitle).toBe('Draft the brief')
      const lead = detail.roster.find((m) => m.appId === LEAD)!
      expect(lead.status).toBe('idle')
      // The runtime's readBoard is NOT consulted for a joined office (host-local
      // member status would read 'idle' there).
      expect(ctx.runtime.blackboard.readBoard).not.toHaveBeenCalledWith(
        'shadow-office', EPOCH, expect.anything()
      )
      // Materialization shadowed the host's run epoch as a local row so the
      // joiner's bus can route a 1:1 reply.
      const shadowEpoch = ctx.store.getEpochById(EPOCH)!
      expect(shadowEpoch).toBeTruthy()
      expect(shadowEpoch.teamId).toBe('shadow-office')
      expect(shadowEpoch.endedAt).toBeNull()
    })

    it('renders replicated activity even when the run-epoch pointer is not yet set (BUG 3)', () => {
      const NODE_HOST = 'node-host'
      const EPOCH = 'epoch-host-run'
      const WORKER = 'shadow-worker'

      // The roster arrived BEFORE the run epoch was stamped (epochId undefined), so
      // current_epoch_id stays null — but replication already landed a task/finding.
      ctx.store.materializeJoinedOffice({
        hostNodeId: NODE_HOST,
        selfNodeId: 'node-self',
        snapshot: {
          team: {
            id: 'shadow-office', name: 'Shadow', goal: 'g', leadAppId: 'shadow-lead',
            collabMode: 'structured', hostNodeId: NODE_HOST, status: 'running',
          },
          members: [
            { appId: WORKER, memberName: 'worker', role: 'Analyst', isLead: false, ownerNodeId: NODE_HOST, memberIdentity: 'id-host', status: 'idle' },
          ],
          edges: [],
        },
      })
      expect(ctx.store.getTeamById('shadow-office')?.currentEpochId).toBeNull()

      ctx.store.insertTask({
        id: 'task-1', teamId: 'shadow-office', epochId: EPOCH, title: 'Draft the brief',
        assigneeAppId: WORKER, status: 'in_progress', resultRef: null, note: null,
        parentId: null, createdByAppId: 'shadow-lead', createdAt: Date.now(), updatedAt: Date.now(),
      })

      // The feed binds to the replicated data's epoch, not the (unset) pointer.
      const detail = ctx.service.getTeamDetail('shadow-office')!
      expect(detail.tasks).toHaveLength(1)
      expect(detail.tasks[0].id).toBe('task-1')
    })
  })

  describe('decision ownership on a joined office', () => {
    const NODE_HOST = 'node-host'
    const SELF = 'node-self'
    const HOST_LEAD = 'shadow-lead'
    const OWN_MEMBER = 'my-analyst'

    /** A joined office blocked on a decision, with one member of ours in it. */
    function materializeBlockedOffice(store: typeof ctx.store = ctx.store) {
      store.materializeJoinedOffice({
        hostNodeId: NODE_HOST,
        selfNodeId: SELF,
        snapshot: {
          team: {
            id: 'shadow-office', name: 'Shadow', goal: 'g', leadAppId: HOST_LEAD,
            collabMode: 'structured', hostNodeId: NODE_HOST, epochId: 'epoch-host-run',
            status: 'waiting_user',
          },
          members: [
            {
              appId: HOST_LEAD, memberName: 'Lead', role: 'Lead', isLead: true,
              ownerNodeId: NODE_HOST, memberIdentity: 'id-host', ownerDisplayName: 'Alice',
              status: 'waiting_user',
            },
            {
              appId: OWN_MEMBER, memberName: 'Analyst', role: 'Analyst', isLead: false,
              ownerNodeId: SELF, memberIdentity: 'id-self', status: 'idle',
            },
          ],
          edges: [],
        },
      })
    }

    it('marks a teammate-owned member as someone else\u2019s, with the owner named', () => {
      materializeBlockedOffice()

      const roster = ctx.service.getTeamDetail('shadow-office')!.roster
      const lead = roster.find((m) => m.appId === HOST_LEAD)!
      expect(lead.status).toBe('waiting_user')
      expect(lead.sameMachine).toBe(false)
      expect(lead.owner).toBe('Alice')

      // Ours, so the same status IS addressed to this reader.
      const mine = roster.find((m) => m.appId === OWN_MEMBER)!
      expect(mine.sameMachine).toBe(true)
      expect(mine.owner).toBeNull()
    })

    it('does not flag the office as waiting on us when the decision is a teammate\u2019s', () => {
      materializeBlockedOffice()

      const item = ctx.service.listTeamItems().find((i) => i.id === 'shadow-office')!
      // The office really is blocked (the host says so) — but not on us.
      expect(item.status).toBe('waiting_user')
      expect(item.hasWaitingUser).toBe(false)
      expect(item.waitingCount).toBe(0)
    })

    it('flags the office when one of our own members raised the decision', () => {
      const withEscalation = buildService({
        getPendingEscalations: () => [
          { appId: OWN_MEMBER, entryId: 'entry-1', question: 'Ship it?', teamId: 'shadow-office' },
        ],
      })
      try {
        materializeBlockedOffice(withEscalation.store)

        const item = withEscalation.service.listTeamItems().find((i) => i.id === 'shadow-office')!
        expect(item.hasWaitingUser).toBe(true)
        expect(item.waitingCount).toBe(1)
      } finally {
        withEscalation.dbManager.closeAll()
      }
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
