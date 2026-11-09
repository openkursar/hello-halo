import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitRepository, GitRepositoryEntry, GitRepositoryList } from '../../../../../src/shared/types/git'

const api = vi.hoisted(() => ({
  gitListRepositories: vi.fn(), gitDiscoverRepository: vi.fn(), gitOpenRepository: vi.fn(),
  gitGetStatus: vi.fn(), gitGetChanges: vi.fn(), codeReviewGetLatest: vi.fn(),
  gitStage: vi.fn(), gitCommit: vi.fn(), gitSync: vi.fn(),
}))
vi.mock('../../../../../src/renderer/api', () => ({ api }))
import { createGitChangesController, gitRevealReadiness, type GitChangesController } from '../../../../../src/renderer/components/canvas/viewers/changes/state/git-changes-store'
import { createViewMemory } from '../../../../../src/renderer/components/canvas/viewers/changes/state/view-memory'
import { gitDiscovery } from '../../../../../src/renderer/services/git-discovery'

const entry = (root: string): GitRepositoryEntry => ({ root, name: root.split('/').pop()!, relativePath: root, remembered: true })
const repo = (root: string): GitRepository => ({ root, name: root.split('/').pop()!, relativePath: root, branch: 'main', head: 'abc', unborn: false, upstream: null, ahead: 0, behind: 0 })
const first = entry('/space/a')
const second = entry('/space/deep/b')
const third = entry('/space/c')
const ok = <T>(data: T) => ({ success: true, data })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
let listed: GitRepositoryList
const controllers: GitChangesController[] = []
function create() {
  const memory = createViewMemory()
  const controller = createGitChangesController('space', memory, undefined)
  controllers.push(controller)
  return { controller, memory }
}
beforeEach(() => {
  vi.resetAllMocks()
  gitDiscovery.forget()
  listed = { git: { available: true, version: '2.45' }, repositories: [first] }
  api.gitListRepositories.mockImplementation(async () => ok(listed))
  api.gitGetStatus.mockImplementation(async (_space, root) => ok({ repo: repo(root), staged: [], unstaged: [], conflicted: [], operation: null, truncated: false }))
  api.gitGetChanges.mockImplementation(async (_space, root, scope) => ok({ repoRoot: root, scope, beforeRevision: 'abc', files: [], truncated: false }))
  api.codeReviewGetLatest.mockResolvedValue(ok(null))
  api.gitOpenRepository.mockImplementation(async (_space, root) => {
    listed = { ...listed, repositories: [...listed.repositories.filter((item) => item.root !== root), entry(root)] }
    return ok(repo(root))
  })
})
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.dispose())
  gitDiscovery.forget()
})

describe('manual repositories in a mounted changes view', () => {
  it('keeps path-only rows and selects the opened root after relisting', async () => {
    const { controller, memory } = create()
    await controller.load()
    expect(controller.store.getState().repositories).toEqual([first])
    expect(await controller.openRepository(second.root)).toBeNull()
    expect(api.gitOpenRepository).toHaveBeenCalledWith('space', second.root)
    expect(api.gitListRepositories.mock.calls).toEqual([
      ['space', { shallow: false }], ['space', { shallow: true }],
      ['space', { shallow: false }], ['space', { shallow: true }],
    ])
    expect(memory.repoRoot).toBe(second.root)
    expect(controller.store.getState()).toMatchObject({ repoRoot: second.root, repositories: [first, second] })
    expect(controller.store.getState().repositories.every((item) => !('branch' in item))).toBe(true)
  })

  it('remembers only a selected shallow path and skips record requests on ordinary reloads', async () => {
    listed = { ...listed, repositories: [first, { ...second, remembered: false }] }
    api.gitGetStatus.mockImplementation(async (_space, root, remember) => ok({ repo: repo(root), staged: [], unstaged: [], conflicted: [], operation: null, truncated: false, ...(remember ? { remembered: true } : {}) }))
    const { controller } = create()
    await controller.load()
    expect(api.gitGetStatus.mock.calls).toEqual([['space', first.root]])
    await controller.selectRepository(second.root)
    expect(api.gitGetStatus).toHaveBeenLastCalledWith('space', second.root, true)
    expect(controller.store.getState().repositories.find((item) => item.root === second.root)?.remembered).toBe(true)
    await controller.load()
    expect(api.gitGetStatus).toHaveBeenLastCalledWith('space', second.root)
    expect(controller.store.getState().repoRoot).toBe(second.root)
  })

  it('retains a failed selected path with no usable repositories and recovers on retry', async () => {
    listed = { ...listed, repositories: [second] }
    api.gitGetStatus.mockResolvedValueOnce({ success: false, code: 'GIT_NOT_A_REPOSITORY' })
    const { controller } = create()
    await controller.load()
    expect(controller.store.getState()).toMatchObject({ phase: 'error', repoRoot: second.root, repositories: [second] })
    expect(controller.store.getState().unavailableRoots).toEqual(new Set([second.root]))
    await controller.selectRepository(second.root)
    expect(controller.store.getState()).toMatchObject({ phase: 'ready', repoRoot: second.root, repositories: [second], unavailableRoots: new Set() })
  })

  it('clears old repository memory when the current working directory no longer has repositories', async () => {
    const { controller, memory } = create()
    await controller.load()
    memory.scope = { kind: 'commit', revision: 'old-commit' }
    memory.detail = { kind: 'file', items: ['old.ts'], index: 0 }
    memory.forced = ['old.ts']
    listed = { ...listed, repositories: [] }
    await controller.resetWorkingDirectory()
    expect(memory).toMatchObject({ repoRoot: undefined, detail: null, forced: [], scope: { kind: 'uncommitted' } })
    await controller.openRepository(second.root)
    expect(api.gitGetChanges).toHaveBeenLastCalledWith('space', second.root, { kind: 'uncommitted' })
  })

  it('invalidates old paths and results when the same space changes its working directory', async () => {
    const { controller, memory } = create()
    await controller.load()
    const status = deferred<ReturnType<typeof ok<unknown>>>()
    api.gitGetStatus.mockReturnValueOnce(status.promise)
    const stale = controller.load()
    listed = { ...listed, repositories: [second] }
    memory.scope = { kind: 'commit', revision: 'old-commit' }
    memory.detail = { kind: 'file', items: ['old.ts'], index: 0 }
    memory.forced = ['old.ts']
    await controller.resetWorkingDirectory()
    const state = controller.store.getState()
    status.resolve(ok({ repo: repo(first.root) }))
    await stale
    expect(controller.store.getState()).toBe(state)
    expect(state).toMatchObject({ phase: 'ready', repoRoot: second.root, repositories: [second] })
    expect(memory).toMatchObject({ repoRoot: second.root, detail: null, forced: [], scope: { kind: 'uncommitted' } })
  })

  it('ignores a manual opening that finishes after the working directory was replaced', async () => {
    const { controller, memory } = create()
    await controller.load()
    const opening = deferred<ReturnType<typeof ok<GitRepository>>>()
    api.gitOpenRepository.mockReturnValueOnce(opening.promise)
    const stale = controller.openRepository(second.root)
    listed = { ...listed, repositories: [third] }
    await controller.resetWorkingDirectory()
    const state = controller.store.getState()
    opening.resolve(ok(repo(second.root)))
    await stale
    expect(controller.store.getState()).toBe(state)
    expect(memory.repoRoot).toBe(third.root)
    expect(state.repositoryBusy).toBe(false)
  })

  it('reads remembered rows again after a viewer remount', async () => {
    const { controller } = create()
    await controller.openRepository(second.root)
    controller.dispose()
    const remounted = create().controller
    await remounted.load()
    expect(remounted.store.getState().repositories).toEqual([first, second])
    expect(remounted.store.getState().repositories.find((item) => item.root === second.root)?.remembered).toBe(true)
  })

  it('preserves detail, forced files and commit scope when the same tab remounts', async () => {
    const { controller, memory } = create()
    await controller.load()
    memory.detail = { kind: 'file', items: ['generated.ts'], index: 0, line: 12 }
    memory.forced = ['generated.ts']
    memory.scope = { kind: 'commit', revision: 'abc' }
    const remembered = { ...memory }
    controller.dispose()

    const remounted = createGitChangesController('space', memory, second.root)
    controllers.push(remounted)
    await remounted.load()
    expect(memory).toEqual(remembered)
    expect(memory.detail).toBe(remembered.detail)
    expect(memory.forced).toBe(remembered.forced)
    expect(remounted.store.getState().repoRoot).toBe(first.root)
  })

  it.each(['selection', 'remount'] as const)('clears repository-specific memory on a real root change through %s', async (kind) => {
    listed = { ...listed, repositories: [first, second] }
    const { controller, memory } = create()
    await controller.load()
    memory.detail = { kind: 'dir', items: ['src'], index: 0 }
    memory.forced = ['old.ts']
    memory.scope = { kind: 'commit', revision: 'abc' }
    if (kind === 'selection') {
      await controller.selectRepository(second.root)
    } else {
      controller.dispose()
      listed = { ...listed, repositories: [second] }
      const remounted = createGitChangesController('space', memory, undefined)
      controllers.push(remounted)
      await remounted.load()
    }
    expect(memory).toMatchObject({ repoRoot: second.root, detail: null, forced: [], scope: { kind: 'uncommitted' } })
  })

  it('keeps reveal readiness pending until the target list loads and rejects mixed roots', async () => {
    listed = { ...listed, repositories: [first, second] }
    const { controller } = create()
    await controller.load()
    const old = controller.store.getState()
    const target = deferred<ReturnType<typeof ok<unknown>>>()
    api.gitGetChanges.mockReturnValueOnce(target.promise)
    const switching = controller.selectRepository(second.root)
    expect(controller.store.getState()).toMatchObject({ repoRoot: second.root, status: null, list: null })
    expect(gitRevealReadiness(controller.store.getState())).toBe('pending')
    expect(await controller.stage(['target.ts'])).toEqual({ code: 'GIT_BUSY' })
    target.resolve(ok({ repoRoot: second.root, scope: { kind: 'uncommitted' }, beforeRevision: 'abc', files: [], truncated: false }))
    await switching
    const loaded = controller.store.getState()
    expect(gitRevealReadiness(loaded)).toBe('ready')
    expect(gitRevealReadiness({ ...loaded, list: null })).toBe('unavailable')
    expect(gitRevealReadiness({ ...loaded, status: old.status })).toBe('unavailable')
  })

  it('does not publish a superseded target list over the next repository', async () => {
    listed = { ...listed, repositories: [first, second, third] }
    const { controller } = create()
    await controller.load()
    const target = deferred<ReturnType<typeof ok<unknown>>>()
    api.gitGetChanges.mockReturnValueOnce(target.promise)
    const stale = controller.selectRepository(second.root)
    await controller.selectRepository(third.root)
    const current = controller.store.getState()
    target.resolve(ok({ scope: { kind: 'uncommitted' }, beforeRevision: 'old', files: [], truncated: false }))
    await stale
    expect(controller.store.getState()).toBe(current)
    expect(current.repoRoot).toBe(third.root)
    expect(gitRevealReadiness(current)).toBe('ready')
  })

  it.each(['gitGetStatus', 'gitGetChanges'] as const)('settles reveal readiness after target %s fails', async (method) => {
    listed = { ...listed, repositories: [first, second] }
    const { controller } = create()
    await controller.load()
    api[method].mockResolvedValueOnce({ success: false, code: 'GIT_FAILED', error: 'read failed' })
    await controller.selectRepository(second.root)
    expect(gitRevealReadiness(controller.store.getState())).toBe('unavailable')
  })

  it('keeps the default and discovered repositories while switching and refreshing', async () => {
    listed = { ...listed, repositories: [first, { ...second, remembered: false }] }
    const { controller, memory } = create()
    await controller.load()
    await controller.selectRepository(second.root)
    await controller.selectRepository(first.root)
    await controller.refresh({ relist: true })
    expect(memory.repoRoot).toBe(first.root)
    expect(controller.store.getState().repositories.map((item) => item.root)).toEqual([first.root, second.root])
    expect(controller.store.getState().phase).toBe('ready')
  })

  it('touches only the selected path and keeps a failed target selected until a successful retry', async () => {
    listed = { ...listed, repositories: [first, second, third] }
    const { controller, memory } = create()
    await controller.load()
    expect(api.gitGetStatus.mock.calls.map((call) => call[1])).toEqual([first.root])
    expect(api.gitGetChanges.mock.calls.map((call) => call[1])).toEqual([first.root])
    expect(api.codeReviewGetLatest.mock.calls.map((call) => call[1])).toEqual([first.root])
    api.gitGetStatus.mockResolvedValueOnce({ success: false, code: 'GIT_NOT_A_REPOSITORY', error: 'gone' })
    await controller.selectRepository(second.root)
    expect(memory.repoRoot).toBe(second.root)
    expect(controller.store.getState()).toMatchObject({ phase: 'error', repoRoot: second.root, repositories: [first, second, third], status: null, list: null })
    expect(controller.store.getState().unavailableRoots).toEqual(new Set([second.root]))
    expect(api.gitGetStatus.mock.calls.map((call) => call[1])).toEqual([first.root, second.root])
    await controller.selectRepository(second.root)
    expect(controller.store.getState()).toMatchObject({ phase: 'ready', repoRoot: second.root, unavailableRoots: new Set() })
    expect(api.gitListRepositories).toHaveBeenCalledTimes(2)
  })

  it('drops the displayed status and diff when reloading the same selected repository fails', async () => {
    const { controller, memory } = create()
    await controller.load()
    memory.detail = { kind: 'file', items: ['a.ts'], index: 0 }
    memory.forced = ['a.ts']
    memory.scope = { kind: 'commit', revision: 'abc' }
    api.gitGetStatus.mockResolvedValueOnce({ success: false, code: 'GIT_FAILED', error: 'unreadable' })
    await controller.load()
    expect(controller.store.getState()).toMatchObject({ phase: 'error', repoRoot: first.root, status: null, list: null })
    expect(memory).toMatchObject({ repoRoot: first.root, detail: { kind: 'file' }, forced: ['a.ts'], scope: { kind: 'commit', revision: 'abc' } })
    expect(gitRevealReadiness(controller.store.getState())).toBe('unavailable')
  })

  it('prunes unavailable markers when paths leave the current list and does not mark scope failures unavailable', async () => {
    listed = { ...listed, repositories: [first, second] }
    const { controller } = create()
    await controller.load()
    api.gitGetStatus.mockResolvedValueOnce({ success: false, code: 'GIT_FAILED' })
    await controller.selectRepository(second.root)
    await controller.selectRepository(first.root)
    expect(controller.store.getState().unavailableRoots).toEqual(new Set([second.root]))
    listed = { ...listed, repositories: [first] }
    await controller.refresh({ relist: true })
    expect(controller.store.getState().unavailableRoots).toEqual(new Set())
    api.gitGetChanges.mockResolvedValueOnce({ success: false, code: 'GIT_REVISION_NOT_FOUND' })
    await controller.setScope({ kind: 'revision', revision: 'gone', mergeBase: false })
    expect(controller.store.getState()).toMatchObject({ phase: 'ready', unavailableRoots: new Set(), list: null, listError: { code: 'GIT_REVISION_NOT_FOUND' } })
    expect(controller.store.getState().status?.repo.root).toBe(first.root)
  })

  it('keeps held opened-file discoveries without changing the selected repository', async () => {
    const { controller } = create()
    await controller.load()
    const discovery = deferred<ReturnType<typeof ok<unknown>>>()
    api.gitDiscoverRepository.mockReturnValueOnce(discovery.promise)
    gitDiscovery.noteFile('space', '/space/deep/b/file.ts')
    await Promise.resolve()
    discovery.resolve(ok({ repository: { root: second.root, name: second.name, relativePath: second.relativePath }, remembered: true }))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(controller.store.getState().repositories).toEqual([first, second])
    expect(controller.store.getState().repoRoot).toBe(first.root)
  })

  it('surfaces open failures without changing selection', async () => {
    const { controller, memory } = create()
    await controller.load()
    api.gitOpenRepository.mockResolvedValueOnce({ success: false, code: 'GIT_NOT_A_REPOSITORY' })
    expect(await controller.openRepository('/space/plain')).toEqual({ code: 'GIT_NOT_A_REPOSITORY', error: undefined })
    expect(memory.repoRoot).toBe(first.root)
    expect(controller.store.getState().repositoryBusy).toBe(false)
  })

  it('does not replace an intervening explicit selection when open finishes late', async () => {
    listed = { ...listed, repositories: [first, third] }
    const { controller, memory } = create()
    await controller.load()
    const opening = deferred<ReturnType<typeof ok<GitRepository>>>()
    api.gitOpenRepository.mockReturnValueOnce(opening.promise)
    const pending = controller.openRepository(second.root)
    await controller.selectRepository(third.root)
    listed = { ...listed, repositories: [first, second, third] }
    opening.resolve(ok(repo(second.root)))
    await pending
    expect(memory.repoRoot).toBe(third.root)
    expect(controller.store.getState().repositories).toEqual([first, second, third])
    expect(controller.store.getState().repoRoot).toBe(third.root)
  })

  it('does not lose a relisted root when another selection supersedes its status read', async () => {
    listed = { ...listed, repositories: [first, third] }
    const { controller } = create()
    await controller.load()
    const status = deferred<ReturnType<typeof ok<unknown>>>()
    api.gitGetStatus.mockReturnValueOnce(status.promise)
    const opening = controller.openRepository(second.root)
    await vi.waitFor(() => expect(controller.store.getState().repositories).toHaveLength(3))
    await controller.selectRepository(third.root)
    status.resolve(ok({ repo: repo(second.root) }))
    await opening
    expect(controller.store.getState().repositories).toHaveLength(3)
    expect(controller.store.getState().repoRoot).toBe(third.root)
  })

  it('invalidates an older list request when opening completes', async () => {
    const { controller } = create()
    await controller.load()
    const oldList = deferred<ReturnType<typeof ok<GitRepositoryList>>>()
    api.gitListRepositories.mockReturnValueOnce(oldList.promise)
    const stale = controller.load({ relist: true })
    await controller.openRepository(second.root)
    oldList.resolve(ok({ git: listed.git, repositories: [first] }))
    await stale
    expect(controller.store.getState().repoRoot).toBe(second.root)
    expect(controller.store.getState().repositories).toEqual([first, second])
  })

  it('ignores opening results after disposal, without relisting or writing tab memory', async () => {
    const { controller, memory } = create()
    await controller.load()
    const request = deferred<ReturnType<typeof ok<GitRepository>>>()
    api.gitOpenRepository.mockReturnValueOnce(request.promise)
    const pending = controller.openRepository(second.root)
    controller.dispose()
    const state = controller.store.getState()
    request.resolve(ok(repo(second.root)))
    await pending
    expect(memory.repoRoot).toBe(first.root)
    expect(controller.store.getState()).toBe(state)
    expect(api.gitListRepositories).toHaveBeenCalledTimes(2)
  })

  it('does not let a stale review read rewrite the current scope or start old-repository reads', async () => {
    const { controller, memory } = create()
    await controller.load()
    const review = deferred<ReturnType<typeof ok<null>>>()
    api.codeReviewGetLatest.mockReturnValueOnce(review.promise)
    const stale = controller.setScope({ kind: 'since-review' })
    await controller.setScope({ kind: 'staged' })
    const reads = api.gitGetChanges.mock.calls.length
    review.resolve(ok(null))
    await stale
    expect(memory.scope).toEqual({ kind: 'staged' })
    expect(api.gitGetChanges).toHaveBeenCalledTimes(reads)
  })

  it('does not rewrite the retained scope from a late review after the selected status failed', async () => {
    const { controller, memory } = create()
    await controller.load()
    const review = deferred<ReturnType<typeof ok<null>>>()
    api.codeReviewGetLatest.mockReturnValueOnce(review.promise)
    api.gitGetStatus.mockResolvedValueOnce({ success: false, code: 'GIT_NOT_A_REPOSITORY' })
    await controller.setScope({ kind: 'since-review' })
    const reads = api.gitGetChanges.mock.calls.length
    review.resolve(ok(null))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(memory.scope).toEqual({ kind: 'since-review' })
    expect(api.gitGetChanges).toHaveBeenCalledTimes(reads)
    expect(controller.store.getState()).toMatchObject({ phase: 'error', status: null, list: null })
  })

  it('clears a selected unavailable marker as soon as its retried status succeeds', async () => {
    const { controller } = create()
    await controller.load()
    api.gitGetStatus.mockResolvedValueOnce({ success: false, code: 'GIT_FAILED' })
    await controller.load()
    const list = deferred<ReturnType<typeof ok<unknown>>>()
    api.gitGetChanges.mockReturnValueOnce(list.promise)
    const retrying = controller.selectRepository(first.root)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(controller.store.getState().unavailableRoots).toEqual(new Set())
    expect(gitRevealReadiness(controller.store.getState())).toBe('pending')
    list.resolve(ok({ scope: { kind: 'uncommitted' }, beforeRevision: 'abc', files: [], truncated: false }))
    await retrying
    expect(gitRevealReadiness(controller.store.getState())).toBe('ready')
  })

  it('does not publish a list that arrives after disposal', async () => {
    const { controller, memory } = create()
    const request = deferred<ReturnType<typeof ok<GitRepositoryList>>>()
    api.gitListRepositories.mockReturnValueOnce(request.promise)
    const pending = controller.load()
    controller.dispose()
    const state = controller.store.getState()
    request.resolve(ok(listed))
    await pending
    expect(controller.store.getState()).toBe(state)
    expect(memory.repoRoot).toBeUndefined()
  })

  it.each(['stage', 'commit', 'sync'] as const)('refuses manual operations and selection while %s is in flight', async (operation) => {
    const { controller, memory } = create()
    await controller.load()
    const request = deferred<ReturnType<typeof ok<any>>>()
    api[{ stage: 'gitStage', commit: 'gitCommit', sync: 'gitSync' }[operation] as keyof typeof api].mockReturnValueOnce(request.promise)
    const pending = operation === 'stage' ? controller.stage(['a.ts']) : operation === 'commit' ? controller.commit({ message: 'test', amend: false, push: false }) : controller.sync()
    expect(await controller.openRepository(second.root)).toEqual({ code: 'GIT_BUSY' })
    await controller.selectRepository(second.root)
    expect(memory.repoRoot).toBe(first.root)
    expect(api.gitOpenRepository).not.toHaveBeenCalled()
    request.resolve(ok({ repo: first }))
    await pending
  })

  it('refuses Git writes while manual repository work is in flight', async () => {
    const { controller } = create()
    await controller.load()
    const request = deferred<ReturnType<typeof ok<GitRepository>>>()
    api.gitOpenRepository.mockReturnValueOnce(request.promise)
    const pending = controller.openRepository(second.root)
    expect(await controller.stage(['a.ts'])).toEqual({ code: 'GIT_BUSY' })
    expect(await controller.commit({ message: 'test', amend: false, push: false })).toEqual({ failure: { code: 'GIT_BUSY' } })
    expect(await controller.sync()).toEqual({ failure: { code: 'GIT_BUSY' } })
    request.resolve(ok(repo(first.root)))
    await pending
  })
})
