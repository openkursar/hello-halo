import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createDatabaseManager } from '../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../src/main/platform/store/types'
import { TeamStore } from '../../../../../src/main/apps/team/store'
import { MIGRATION_NAMESPACE, migrations } from '../../../../../src/main/apps/team/migrations'
import { createParticipantService } from '../../../../../src/main/apps/team/participant-service'
import type { ParticipantExecution } from '../../../../../src/main/apps/team/participants'
import { beginTeamWorkspaceChange, prepareTeamWorkspaceChange } from '../../../../../src/main/apps/runtime/team/workspace-change'
import { buildTeamSessionKey, SELF_NODE_ID, spaceCoordinatorAppId } from '../../../../../src/shared/apps/team-types'
import { buildRunSenderKey } from '../../../../../src/shared/apps/im-keys'

let database: DatabaseManager
let store: TeamStore
const target = { spaceId: 'new', spacePath: '/spaces/new', workDir: '/projects/new', memoryDir: '/spaces/new/.halo/apps/person' }
const source = buildTeamSessionKey('person', 'standing', 'work')
const original: ParticipantExecution = {
  sourceAppId: 'person', engineId: 'halo', modelSelection: { modelSourceId: 'provider', modelId: 'model' },
  environment: { spaceId: 'old', spacePath: '/spaces/old', workDir: '/project/explicit', memoryDir: '/spaces/old/collaboration/helper' },
  permissions: { granted: ['Read'], denied: ['Bash'] }, prompt: 'Inspect.', requestId: 'request/helper',
  workspace: { cwd: '/project/explicit', checkout: '/project/explicit', gitRoot: '/project', gitCommonDirectory: '/project/.git', initialHead: 'original-head' },
  fileAccess: { cwd: '/project/explicit', workspaceRoots: ['/project/explicit'], memoryWritable: [], memoryReadable: [],
    attachedFiles: ['/project/explicit/file.txt'], closed: ['/spaces/old/collaboration/helper/private', '/spaces/old/project'],
    hookGuarded: [], memorySystemPaths: ['/spaces/old/collaboration/helper/state.json'] },
}
beforeEach(() => {
  database = createDatabaseManager(':memory:')
  database.runMigrations(database.getAppDatabase(), MIGRATION_NAMESPACE, migrations)
  store = new TeamStore(database.getAppDatabase())
  for (const [id, conversation] of [['standing', null], ['private', source]] as const) {
    store.insertTeam({ id, name: id, owningSpaceId: 'old', goal: '', leadAppId: conversation ? spaceCoordinatorAppId(conversation) : 'person',
      memberSourcing: 'manual', collabMode: 'free', escalationRouting: 'user', status: 'idle', currentEpochId: null,
      createdAt: 1, updatedAt: 1, ...(conversation ? { ephemeral: true, coordinatorConversationId: conversation } : {}) })
    store.insertEpoch({ id: id === 'standing' ? 'work' : 'private-work', teamId: id, startedAt: 1, endedAt: null, endReason: null, summary: null, lifecycle: 'conversation' })
  }
  store.addMember({ teamId: 'standing', appId: 'person', memberName: 'person', role: '', isLead: true, aiProvisioned: false, addedAt: 1 })
})
afterEach(() => database.closeAll())
function insert(appId = 'helper', overrides: Partial<ParticipantExecution> = {}, remote = false) {
  const participant = { teamId: 'private', epochId: 'private-work', appId, parentAppId: spaceCoordinatorAppId(source), memberName: appId,
    role: '', isLead: false as const, aiProvisioned: false, isTemporary: true as const, addedAt: 1,
    ownerNodeId: remote ? 'remote-node' : SELF_NODE_ID, origin: remote ? 'remote' as const : 'local' as const }
  const execution = { ...original, ...overrides }
  store.participants.insert(participant, remote ? undefined : execution)
  if (!remote) store.requests.track(buildTeamSessionKey(appId, participant.teamId, participant.epochId), execution.requestId!)
}
function fixture() {
  const runtime = { bus: { cancelSession: vi.fn() }, stopMemberTurn: vi.fn(async () => false) }
  const participants = createParticipantService({ store, getRuntime: () => runtime as never })
  return { participants, runtime, begin: (extra = {}) => beginTeamWorkspaceChange({ appId: 'person', sourceSpaceId: 'old',
    targetEnvironment: target, targetAppRoot: target.memoryDir, ...extra }, { store, participants }) }
}

describe('team workspace maintenance', () => {
  it('reroots canonical child directories when the workspace was registered through a parent symlink', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'halo-team-space-alias-')))
    const data = join(root, 'real')
    const alias = join(root, 'alias')
    const next = join(root, 'next')
    mkdirSync(join(data, 'space', 'module'), { recursive: true })
    mkdirSync(next)
    symlinkSync(data, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const sourceSpace = join(alias, 'space')
    const canonicalWorkDir = join(data, 'space', 'module')
    try {
      insert('helper', { environment: { ...original.environment, spacePath: sourceSpace, workDir: canonicalWorkDir },
        workspace: { cwd: canonicalWorkDir }, fileAccess: { ...original.fileAccess!, cwd: canonicalWorkDir, workspaceRoots: [canonicalWorkDir] } })
      const destination = { ...target, spacePath: next, workDir: join(next, 'work'), memoryDir: join(next, '.halo/apps/person') }
      const plan = prepareTeamWorkspaceChange({ appId: 'person', sourceSpaceId: 'old', sourceWorkDirs: [sourceSpace],
        targetEnvironment: destination, targetAppRoot: destination.memoryDir }, store)
      plan.commitEnvironment()
      const execution = store.participants.getExecution('private', 'private-work', 'helper')!
      expect(execution.environment.workDir).toBe(join(destination.workDir, 'module'))
      expect(execution.workspace?.cwd).toBe(join(destination.workDir, 'module'))
      expect(execution.fileAccess?.workspaceRoots).toEqual([join(destination.workDir, 'module')])
      expect(existsSync(canonicalWorkDir)).toBe(true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('fences and rehomes scheduled-run private scopes even without execution.sourceAppId', async () => {
    const runSource = buildRunSenderKey('person', 'run-id')
    store.setCoordinatorConversation('private', runSource)
    insert('helper', { sourceAppId: undefined })
    const f = fixture(); const lease = f.begin()
    expect(f.participants.isMaintaining('person', runSource)).toBe(true)
    expect(() => f.participants.beginRequest(runSource, 'late-run-request')).toThrow(/changing workspace/)
    expect(lease.actorIds).toContain('helper')
    const plan = await lease.drain()
    expect(plan.environments.map(row => row.appId)).toEqual(['helper'])
    expect(plan.environments[0].previousEnvironment).toEqual(original.environment)
    plan.commitEnvironment()
    expect(store.getTeamById('private')?.owningSpaceId).toBe('new')
    expect(store.participants.getExecution('private', 'private-work', 'helper')?.environment.spaceId).toBe('new')
    lease.release()
  })

  it('moves only local metadata and transcripts, preserving explicit project/worktree ownership and history', async () => {
    insert(); insert('remote', {}, true)
    store.participants.insert({ teamId: 'standing', epochId: 'work', appId: 'unrelated', parentAppId: 'peer', memberName: 'unrelated',
      role: '', isLead: false, aiProvisioned: false, isTemporary: true, addedAt: 1 },
    { ...original, sourceAppId: 'peer', environment: { ...original.environment, memoryDir: '/spaces/old/collaboration/unrelated' }, requestId: 'unrelated-request' })
    const f = fixture()
    const lease = f.begin()
    expect(f.participants.isMaintaining('person')).toBe(true)
    expect(f.participants.isMaintaining('helper')).toBe(true)
    expect(f.participants.isMaintaining('remote')).toBe(false)
    expect(f.participants.isMaintaining('unrelated')).toBe(false)
    expect(f.participants.adoptRequest({ teamId: 'private', epochId: 'private-work', callerAppId: 'helper' }, 'new-request')).toBe(false)
    const plan = await lease.drain()
    expect(plan.actorIds).toEqual(['person', 'helper'])
    expect(plan.relocations).toEqual([
      { sourcePath: '/spaces/old/collaboration/helper', targetPath: `${target.memoryDir}/collaboration/helper` },
      { sourcePath: '/spaces/old/.halo/apps/helper', targetPath: '/spaces/new/.halo/apps/helper' },
    ])
    expect(f.runtime.stopMemberTurn).toHaveBeenCalledWith({ teamId: 'private', epochId: 'private-work', appId: 'helper', expectedRequestId: 'request/helper' })
    expect(store.participants.getExecution('private', 'private-work', 'helper')?.environment.spaceId).toBe('old')
    plan.commitEnvironment()
    const next = store.participants.getExecution('private', 'private-work', 'helper')!
    expect(next.environment).toEqual({ ...target, workDir: '/project/explicit', memoryDir: `${target.memoryDir}/collaboration/helper` })
    expect(next.workspace).toEqual(original.workspace)
    expect(next.fileAccess?.closed).toEqual([`${target.memoryDir}/collaboration/helper/private`, '/spaces/old/project'])
    expect(next.fileAccess?.attachedFiles).toEqual(original.fileAccess?.attachedFiles)
    expect(next.permissions).toEqual(original.permissions)
    expect(store.getTeamById('private')?.owningSpaceId).toBe('new')
    expect(store.getTeamById('standing')?.owningSpaceId).toBe('old')
    expect(store.getEpochById('private-work')?.endedAt).toBeNull()
    expect(store.participants.getExecution('private', 'private-work', 'remote')).toBeNull()
    lease.release()
    expect(f.participants.isMaintaining('helper')).toBe(false)
    expect(f.participants.requestAllowed('request/helper')).toBe(false)
  })

  it('does not swallow a stop failure or produce a relocation plan before all stops settle', async () => {
    insert()
    const f = fixture()
    f.runtime.stopMemberTurn.mockRejectedValueOnce(new Error('flush failed'))
    const lease = f.begin()
    await expect(lease.drain()).rejects.toThrow(/could not be stopped/)
    expect(store.participants.getExecution('private', 'private-work', 'helper')?.environment).toEqual(original.environment)
    expect(f.participants.isMaintaining('helper')).toBe(true)
    lease.release()
  })

  it('restarts deleted working directories at the destination without moving project files or retaining a dangling lease', async () => {
    insert('helper', { environment: { ...original.environment, workDir: '/spaces/old/project' },
      fileAccess: { ...original.fileAccess!, cwd: '/spaces/old/project', workspaceRoots: ['/spaces/old/project'],
        attachedFiles: ['/spaces/old/project/file.txt', '/external/retained.txt'] } })
    const f = fixture(); const lease = f.begin({ deletingSpacePath: '/spaces/old' })
    const plan = await lease.drain()
    expect(plan.resetSessionActorIds).toEqual(['helper'])
    expect(plan.relocations.every(pair => pair.sourcePath !== '/spaces/old/project')).toBe(true)
    plan.commitEnvironment()
    const execution = store.participants.getExecution('private', 'private-work', 'helper')!
    expect(execution.environment.workDir).toBe(target.workDir)
    expect(execution.workspace).toBeUndefined()
    expect(execution.stopped).toBe(true)
    expect(execution.fileAccess?.workspaceRoots).toEqual([target.workDir])
    expect(execution.fileAccess?.attachedFiles).toEqual(['/external/retained.txt'])
    lease.release()
  })

  it('drops a worktree lease whose repository is being deleted without deleting an external checkout', () => {
    insert('helper', { workspace: { ...original.workspace!, gitRoot: '/spaces/old/repo', gitCommonDirectory: '/spaces/old/repo/.git' } })
    const plan = prepareTeamWorkspaceChange({ appId: 'person', sourceSpaceId: 'old', targetEnvironment: target,
      targetAppRoot: target.memoryDir, deletingSpacePath: '/spaces/old' }, store)
    expect(plan.resetSessionActorIds).toEqual(['helper'])
    plan.commitEnvironment()
    expect(store.participants.getExecution('private', 'private-work', 'helper')?.workspace).toBeUndefined()
    expect(store.participants.getExecution('private', 'private-work', 'helper')?.environment.workDir).toBe(target.workDir)
    expect(plan.relocations.some(pair => pair.sourcePath === original.workspace?.checkout)).toBe(false)
  })

  it('prepares startup repair using only persisted state without a participant service or runtime effects', () => {
    insert()
    const plan = prepareTeamWorkspaceChange({ appId: 'person', sourceSpaceId: 'old', targetEnvironment: target,
      targetAppRoot: target.memoryDir }, store)
    expect(plan.actorIds).toEqual(['person', 'helper'])
    expect(plan.resetSessionActorIds).toEqual([])
    expect(store.participants.getExecution('private', 'private-work', 'helper')?.environment.spaceId).toBe('old')
    expect(store.participants.getExecution('private', 'private-work', 'helper')?.stopped).toBeUndefined()
    plan.commitEnvironment()
    expect(store.participants.getExecution('private', 'private-work', 'helper')?.environment.spaceId).toBe('new')
  })

  it('moves an inherited Halo-data cwd with its parent without carrying an old-space dependency', () => {
    insert('helper', { environment: { ...original.environment, workDir: '/spaces/old' }, workspace: { cwd: '/spaces/old' },
      fileAccess: { ...original.fileAccess!, cwd: '/spaces/old', workspaceRoots: ['/spaces/old', '/external/project'],
        attachedFiles: ['/spaces/old/project.txt'] } })
    const plan = prepareTeamWorkspaceChange({ appId: 'person', sourceSpaceId: 'old', sourceWorkDirs: ['/spaces/old'],
      targetEnvironment: target, targetAppRoot: target.memoryDir }, store)
    plan.commitEnvironment()
    const execution = store.participants.getExecution('private', 'private-work', 'helper')!
    expect(execution.environment.workDir).toBe(target.workDir)
    expect(execution.workspace?.cwd).toBe(target.workDir)
    expect(execution.fileAccess?.cwd).toBe(target.workDir)
    expect(execution.fileAccess?.workspaceRoots).toEqual([target.workDir, '/external/project'])
    expect(execution.fileAccess?.attachedFiles).toEqual(['/spaces/old/project.txt'])
    expect(plan.resetSessionActorIds).toEqual([])
    expect(plan.relocations.some(pair => pair.sourcePath === '/spaces/old')).toBe(false)
  })

  it('reroots an internal non-worktree subdirectory relative to its pinned parent cwd', () => {
    insert('helper', { environment: { ...original.environment, workDir: '/spaces/old/artifacts/module' },
      workspace: { cwd: '/spaces/old/artifacts/module' } })
    const plan = prepareTeamWorkspaceChange({ appId: 'person', sourceSpaceId: 'old', sourceWorkDirs: ['/spaces/old/artifacts'],
      targetEnvironment: target, targetAppRoot: target.memoryDir }, store)
    expect(plan.environments[0].environment.workDir).toBe(`${target.workDir}/module`)
  })

  it('preserves external authored cwd even when it matches a parent pinned directory', () => {
    insert()
    const plan = prepareTeamWorkspaceChange({ appId: 'person', sourceSpaceId: 'old', sourceWorkDirs: ['/project/explicit'],
      targetEnvironment: target, targetAppRoot: target.memoryDir }, store)
    plan.commitEnvironment()
    expect(store.participants.getExecution('private', 'private-work', 'helper')?.environment.workDir).toBe('/project/explicit')
    expect(store.participants.getExecution('private', 'private-work', 'helper')?.workspace).toEqual(original.workspace)
  })

  it('remaps cwd only when it actually belongs to the moved metadata', async () => {
    insert('helper', { environment: { ...original.environment, workDir: '/spaces/old/collaboration/helper/scratch' },
      workspace: { cwd: '/spaces/old/collaboration/helper/scratch' } })
    const f = fixture(); const lease = f.begin({ deletingSpacePath: '/spaces/old' }); const plan = await lease.drain()
    plan.commitEnvironment()
    expect(store.participants.getExecution('private', 'private-work', 'helper')?.workspace?.cwd).toBe(`${target.memoryDir}/collaboration/helper/scratch`)
    lease.release()
  })

  it('refuses to treat an arbitrary project directory as participant metadata', async () => {
    insert('helper', { environment: { ...original.environment, memoryDir: '/projects/user-data' } })
    const f = fixture(); const lease = f.begin()
    await expect(lease.drain()).rejects.toThrow(/metadata location is not recognized/)
    lease.release()
  })

  it('keeps all execution changes atomic with the outer transaction', async () => {
    insert(); const f = fixture(); const lease = f.begin(); const plan = await lease.drain()
    expect(() => database.getAppDatabase().transaction(() => { plan.commitEnvironment(); throw new Error('injected') })()).toThrow('injected')
    expect(store.getTeamById('private')?.owningSpaceId).toBe('old')
    expect(store.participants.getExecution('private', 'private-work', 'helper')?.environment.spaceId).toBe('old')
    lease.release()
  })
})
