import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { openMemberWorkspace, type MemberWorkspace } from '@hello-halo/agent-sdk/collaboration/workspaces'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import { TeamStore } from '../../../../src/main/apps/team/store'
import { migrations, MIGRATION_NAMESPACE } from '../../../../src/main/apps/team/migrations'
import { disposeJoinedOfficeWork } from '../../../../src/main/apps/runtime/team/office-disposal'
import { buildTeamSessionKey, spaceCoordinatorAppId } from '../../../../src/shared/apps/team-types'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const exec = promisify(execFile)

function storeFixture() {
  const db = createDatabaseManager(':memory:')
  db.runMigrations(db.getAppDatabase(), MIGRATION_NAMESPACE, migrations)
  cleanup.push(() => db.closeAll())
  const store = new TeamStore(db.getAppDatabase())
  store.insertTeam({ id: 'team', name: 'Team', owningSpaceId: 'space', goal: '', leadAppId: 'lead', memberSourcing: 'manual',
    collabMode: 'free', escalationRouting: 'user', status: 'idle', currentEpochId: null, hostNodeId: 'host', createdAt: 1, updatedAt: 1 })
  for (const epoch of ['first', 'second']) store.insertEpoch({ id: epoch, teamId: 'team', lifecycle: 'conversation', startedAt: 1, endedAt: null, endReason: null, summary: null })
  return store
}

it('releases a clean owned checkout on deletion and retains dirty or committed work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'halo-participant-disposal-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const repo = join(directory, 'repo'); await mkdir(repo)
  const git = (cwd: string, ...args: string[]) => exec('git', ['-C', cwd, ...args])
  await git(repo, 'init', '-q')
  await git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'Fixture baseline')
  const store = storeFixture()
  const source = buildTeamSessionKey('local-member', 'team', 'first')
  store.insertTeam({ ...store.getTeamById('team')!, id: 'private', name: 'Private', hostNodeId: undefined,
    ephemeral: true, coordinatorConversationId: source, leadAppId: spaceCoordinatorAppId(source) })
  store.insertEpoch({ id: 'private-work', teamId: 'private', lifecycle: 'conversation', startedAt: 1, endedAt: null, endReason: null, summary: null })
  const workspaces: MemberWorkspace[] = []
  cleanup.push(async () => {
    for (const workspace of workspaces) {
      try { await git(repo, 'worktree', 'remove', '--force', workspace.checkout!) } catch { /* A clean checkout was already released. */ }
    }
  })
  for (const kind of ['clean', 'dirty', 'committed']) {
    const id = randomUUID()
    const workspace = await openMemberWorkspace({ member: { id, isolation: 'worktree' }, parentCwd: repo,
      metadataDirectory: join(directory, 'metadata', id), signal: new AbortController().signal })
    workspaces.push(workspace)
    store.participants.insert({ teamId: 'private', epochId: 'private-work', appId: id, parentAppId: spaceCoordinatorAppId(source), memberName: kind,
      role: '', isLead: false, aiProvisioned: false, isTemporary: true, addedAt: 1 }, {
      engineId: 'halo', modelSelection: { modelSourceId: 'fixture', modelId: 'fixture' }, prompt: '',
      environment: { spaceId: 'space', spacePath: repo, workDir: workspace.cwd, memoryDir: directory }, permissions: { granted: [], denied: [] }, workspace,
    })
    if (kind !== 'clean') await writeFile(join(workspace.cwd, 'work.txt'), kind)
    if (kind === 'committed') {
      await git(workspace.cwd, 'add', 'work.txt')
      await git(workspace.cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Fixture work')
    }
  }
  await disposeJoinedOfficeWork(store, { bus: { cancelSession: vi.fn() }, closeEpochResources: vi.fn(async () => {}) } as never, 'team')
  expect(store.getTeamById('private')).toBeNull()
  await expect(access(workspaces[0].checkout!)).rejects.toThrow()
  await expect(access(workspaces[1].checkout!)).resolves.toBeUndefined()
  await expect(access(workspaces[2].checkout!)).resolves.toBeUndefined()
})

it('a remote dissolution preserves completed history after failed close and retries before purge', async () => {
  const store = storeFixture()
  store.endEpoch('first', 20, 'completed', 'Published result', 'output')
  store.updateWorkItem('first', { status: 'completed' })
  const history = store.listEpochsByTeam('team')
  store.participants.insert({ teamId: 'team', epochId: 'first', appId: 'temporary', parentAppId: 'lead', memberName: 'temporary',
    role: '', isLead: false, aiProvisioned: false, isTemporary: true, addedAt: 1 })
  const close = vi.fn(async (): Promise<void> => { throw new Error('Owner session still busy') })
  const runtime = { bus: { cancelSession: vi.fn() }, closeEpochResources: close } as never
  await expect(disposeJoinedOfficeWork(store, runtime, 'team')).rejects.toThrow(/retained/)
  expect(store.listEpochsByTeam('team')).toEqual(history)
  expect(store.getTeamById('team')).not.toBeNull()
  expect(store.participants.getById('temporary')).not.toBeNull()
  close.mockImplementation(async () => {})
  await disposeJoinedOfficeWork(store, runtime, 'team')
  expect(close).toHaveBeenCalledTimes(4)
  expect(store.getTeamById('team')).toBeNull()
  expect(store.participants.getById('temporary')).toBeNull()
})


it('recursively disposes private office scopes before purge, retaining descendants that fail to close', async () => {
  const store = storeFixture()
  const source = buildTeamSessionKey('removed-member', 'team', 'first')
  const nestedSource = buildTeamSessionKey('removed-helper', 'private', 'private-work')
  for (const [id, conversationId] of [['private', source], ['nested', nestedSource]]) {
    store.insertTeam({ ...store.getTeamById('team')!, id, name: id, hostNodeId: undefined, ephemeral: true,
      coordinatorConversationId: conversationId, leadAppId: spaceCoordinatorAppId(conversationId) })
    store.insertEpoch({ id: `${id}-work`, teamId: id, lifecycle: 'conversation', startedAt: 1, endedAt: null, endReason: null, summary: null })
  }
  const close = vi.fn(async (teamId: string) => { if (teamId === 'nested') throw new Error('Nested session busy') })
  const folders = vi.fn(async (_teamId: string) => {})
  const runtime = { bus: { cancelSession: vi.fn() }, closeEpochResources: close, teamFolders: { remove: folders } } as never
  await expect(disposeJoinedOfficeWork(store, runtime, 'team')).rejects.toThrow(/retained/)
  for (const id of ['team', 'private', 'nested']) expect(store.getTeamById(id)).not.toBeNull()
  close.mockImplementation(async () => {})
  await disposeJoinedOfficeWork(store, runtime, 'team')
  for (const id of ['team', 'private', 'nested']) expect(store.getTeamById(id)).toBeNull()
  expect(folders.mock.calls.map(([teamId]) => teamId)).toEqual(['nested', 'private', 'team'])
})

it('holds new epoch admission until every overlapping disposal releases its own token', () => {
  const store = storeFixture()
  const first = store.beginDisposal('team')
  const second = store.beginDisposal('team')
  const epoch = { ...store.getEpochById('first')!, id: 'new-work' }
  expect(() => store.insertEpoch(epoch)).toThrow(/being removed/)
  expect(() => store.upsertEpoch(epoch)).toThrow(/being removed/)
  store.upsertEpoch({ ...store.getEpochById('first')!, endedAt: 2, endReason: 'cleared' })
  expect(store.getEpochById('first')?.endReason).toBe('cleared')
  second(); second()
  expect(() => store.insertEpoch(epoch)).toThrow(/being removed/)
  first()
  store.insertEpoch(epoch)
  expect(store.getEpochById('new-work')).not.toBeNull()
})
