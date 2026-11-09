import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { buildTeamSessionKey } from '../../../../src/shared/apps/im-keys'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import { migrations as teamMigrations } from '../../../../src/main/apps/team/migrations'
import { migrations as managerMigrations } from '../../../../src/main/apps/manager/migrations'
import { TeamStore } from '../../../../src/main/apps/team/store'
import { AppManagerStore } from '../../../../src/main/apps/manager/store'
import { createAppManagerService } from '../../../../src/main/apps/manager/service'
import { createTeamService } from '../../../../src/main/apps/team/service'
import { createMessageBus } from '@hello-halo/agent-sdk/collaboration'
import { createWorkMembership } from '../../../../src/main/apps/runtime/team/membership'
import type { ParticipantSource } from '../../../../src/main/apps/team/participant-service'

vi.mock('../../../../src/main/http/websocket', () => ({ broadcastToAll: vi.fn() }))
vi.mock('../../../../src/main/foundation/window.service', () => ({ sendToRenderer: vi.fn() }))

let f: ReturnType<typeof fixture>
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'halo-save-collaboration-'))
  const database = createDatabaseManager(join(directory, 'state.db')), db = database.getAppDatabase()
  database.runMigrations(db, 'app_manager', managerMigrations)
  database.runMigrations(db, 'app_team', teamMigrations)
  const store = new TeamStore(db)
  const appManager = createAppManagerService({ store: new AppManagerStore(db), getSpacePath: () => directory,
    getAppDataPath: id => join(directory, 'apps', id), getGlobalAppDir: () => join(directory, 'global') })
  const runtime = {
    bus: createMessageBus({ store: createWorkMembership(store), hooks: { isBusy: () => false, wakeTarget: async () => {} } }),
    getObservableStatus: () => 'idle', getMemberStatus: () => 'idle', getMemberBusy: () => [],
    checks: { viewForTeam: () => [], cancelById: vi.fn() },
    sealEpoch: vi.fn(async () => {}), stopMemberTurn: vi.fn(async () => true),
    teamFolders: { remove: vi.fn(async () => {}) },
    ensureConversationEpoch(teamId: string, chatKey: string) {
      const old = store.getOpenConversationEpoch(teamId, chatKey)
      if (old) return old
      const epoch = { id: randomUUID(), teamId, chatKey, lifecycle: 'conversation' as const,
        startedAt: Date.now(), endedAt: null, endReason: null, summary: null }
      store.insertEpoch(epoch); return epoch
    },
  }
  const deps = { store, appManager, getRuntime: () => runtime as never,
    spaces: { spaceExists: () => true, createMemberSpace: ({ owningSpaceId }: { owningSpaceId: string }) => owningSpaceId },
    listArtifacts: async () => [], proposeMembersFromGoal: async () => [] }
  const service = createTeamService(deps)
  const source: ParticipantSource = { modelSelection: { modelSourceId: 'source', modelId: 'model' }, engineId: 'halo',
    environment: { spaceId: 'space', spacePath: directory, workDir: directory, memoryDir: join(directory, 'private') },
    permissions: { granted: ['ai-browser'], denied: ['email'] } }
  return { directory, database, db, store, appManager, runtime, deps, service, source }
}
beforeEach(() => { f = fixture() })
afterEach(() => { vi.restoreAllMocks(); f.database.closeAll(); rmSync(f.directory, { recursive: true, force: true }) })
async function sourceWork() {
  const work = await f.service.ensureCollaboration({ owningSpaceId: 'space', conversationId: 'original-chat', title: 'Research' })
  f.service.participants.beginRequest('original-chat', 'original-request')
  const caller = { teamId: work.team.id, epochId: work.epochId, callerAppId: work.team.leadAppId! }
  const first = await f.service.participants.spawn(caller, { name: 'Reviewer', prompt: 'PRIVATE ASSIGNMENT: inspect original.md, not a saved persona.' }, f.source)
  const second = await f.service.participants.spawn(caller, { name: 'Tester', prompt: 'PRIVATE ASSIGNMENT: run initial tests.' }, f.source)
  return { ...work, caller, members: [first, second] }
}

describe('saving scoped collaboration configuration', () => {
  it('exposes a member-private scope to its local owner but never saves it as an explicit team', async () => {
    const parent = await sourceWork()
    const conversationId = buildTeamSessionKey(parent.members[0].appId, parent.team.id, parent.epochId)
    const work = await f.service.ensureCollaboration({ owningSpaceId: 'space', conversationId, title: 'Internal inspection' })
    expect(f.service.getCollaborationScope(conversationId)?.team.id).toBe(work.team.id)
    expect(f.service.getCollabForConversation(conversationId)?.teamId).toBe(work.team.id)
    await expect(f.service.saveCollab(work.team.id)).rejects.toThrow('internal assistants')
    expect(f.appManager.listApps()).toEqual([])
  })
  it('creates new installed identities, preserves source work and copies no history, memory or current assignment', async () => {
    const work = await sourceWork()
    const original = f.store.participants.getExecution(work.team.id, work.epochId, work.members[0].appId)!
    writeFileSync(join(original.environment.memoryDir, 'private-memory.txt'), 'PRIVATE MEMORY')
    f.store.insertFinding({ id: 'original-finding', teamId: work.team.id, epochId: work.epochId, authorAppId: work.members[0].appId, body: 'PRIVATE RESULT', ref: null, createdAt: 1 })
    const saved = await f.service.saveCollab(work.team.id)
    const members = f.store.listMembersByTeam(saved.id)
    expect(members).toHaveLength(3)
    expect(members.every(member => !work.members.some(original => original.appId === member.appId))).toBe(true)
    for (const member of members.filter(member => !member.isLead)) {
      const app = f.appManager.getApp(member.appId)!
      expect(app.userOverrides).toMatchObject({ engineId: 'halo', modelSourceId: 'source', modelId: 'model', memory: { enabled: false }, spaceMemoryAccess: false })
      expect(app.permissions).toEqual({ granted: ['ai-browser'], denied: ['email'] })
      if (app.spec.type !== 'automation') throw new Error('Expected an installed digital human')
      expect(app.spec.system_prompt).not.toContain('PRIVATE ASSIGNMENT')
      expect(readdirSync(join(f.appManager.getAppWorkDir(member.appId), 'memory'))).toEqual([])
    }
    expect(f.appManager.getApp(saved.leadAppId!)?.userOverrides).toMatchObject({ engineId: 'halo', modelSourceId: 'source', modelId: 'model' })
    expect(f.store.listEpochsByTeam(saved.id)).toEqual([])
    expect(f.store.listFindingsByTeam(saved.id)).toEqual([])
    expect(f.store.participants.list(work.team.id, work.epochId)).toHaveLength(2)
    expect(readFileSync(join(original.environment.memoryDir, 'private-memory.txt'), 'utf8')).toBe('PRIVATE MEMORY')
    expect(f.store.getTeamById(work.team.id)).toMatchObject({ ephemeral: true, coordinatorConversationId: 'original-chat', savedTeamId: saved.id })
    expect(f.store.getEpochById(work.epochId)?.endedAt).toBeNull()
  })

  it('reads only the coordinator-bound work, coalesces concurrent saves and reuses the link after service reconstruction', async () => {
    const work = await sourceWork()
    f.store.insertEpoch({ id: 'unrelated', teamId: work.team.id, startedAt: 2, endedAt: null, endReason: null, summary: null, lifecycle: 'conversation', chatKey: 'other' })
    f.store.participants.insert({ ...work.members[0], appId: 'foreign-work-member', epochId: 'unrelated' }, {
      ...f.store.participants.getExecution(work.team.id, work.epochId, work.members[0].appId)!, prompt: 'Wrong scope',
    })
    f.store.updateTeamCurrentEpoch(work.team.id, 'unrelated')
    const first = f.service.saveCollab(work.team.id)
    expect(f.service.saveCollab(work.team.id)).toBe(first)
    const saved = await first
    expect(f.store.listMembersByTeam(saved.id)).toHaveLength(3)
    const restored = createTeamService(f.deps)
    expect((await restored.saveCollab(work.team.id)).id).toBe(saved.id)
    expect(f.appManager.listApps()).toHaveLength(3)
  })

  it.each(['profile', 'link'])('rolls back new installations on %s failure and permits a clean retry', async stage => {
    const work = await sourceWork()
    if (stage === 'profile') vi.spyOn(f.appManager, 'updateOverrides').mockImplementationOnce(() => { throw new Error('save failed') })
    else vi.spyOn(f.store, 'attachSavedTeam').mockImplementationOnce(() => { throw new Error('save failed') })
    await expect(f.service.saveCollab(work.team.id)).rejects.toThrow('save failed')
    expect(f.appManager.listApps()).toEqual([])
    expect(f.store.listTeams()).toHaveLength(1)
    expect(f.store.participants.list(work.team.id, work.epochId)).toHaveLength(2)
    expect(f.store.getEpochById(work.epochId)?.endedAt).toBeNull()
    await expect(f.service.saveCollab(work.team.id)).resolves.toMatchObject({ ephemeral: false })
    expect(f.appManager.listApps()).toHaveLength(3)
  })

  it('does not resurrect a same-name uninstalled person or reuse their private data', async () => {
    const work = await sourceWork()
    const oldId = await f.appManager.install('space', { spec_version: '1', name: `Research · ${work.members[0].memberName}`,
      version: '1', author: 'Fixture', description: 'Fixture', type: 'automation', system_prompt: 'Old persona' }, {})
    await f.appManager.uninstall(oldId)
    const saved = await f.service.saveCollab(work.team.id)
    expect(f.store.listMembersByTeam(saved.id).some(member => member.appId === oldId)).toBe(false)
    expect(f.appManager.getApp(oldId)?.status).toBe('uninstalled')
  })

  it('preserves current source denials instead of granting permissions revoked since creation', async () => {
    const parent = await f.appManager.install('space', { spec_version: '1', name: 'Source', version: '1', author: 'Fixture', description: 'Fixture', type: 'automation', system_prompt: 'Source' }, {})
    f.appManager.grantPermission(parent, 'ai-browser')
    f.source.sourceAppId = parent
    const work = await sourceWork()
    f.appManager.revokePermission(parent, 'ai-browser')
    const saved = await f.service.saveCollab(work.team.id)
    for (const member of f.store.listMembersByTeam(saved.id).filter(member => !member.isLead)) {
      expect(f.appManager.getApp(member.appId)?.permissions).toEqual({ granted: [], denied: ['email', 'ai-browser'] })
    }
  })
})
