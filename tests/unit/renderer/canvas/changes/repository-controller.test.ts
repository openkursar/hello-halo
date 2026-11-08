import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitRepository, GitRepositoryList } from '../../../../../src/shared/types/git'

const api = vi.hoisted(() => ({
  gitListRepositories: vi.fn(), gitOpenRepository: vi.fn(), gitForgetRepository: vi.fn(),
  gitGetStatus: vi.fn(), gitGetChanges: vi.fn(), codeReviewGetLatest: vi.fn(),
  gitStage: vi.fn(), gitCommit: vi.fn(), gitSync: vi.fn(),
}))
vi.mock('../../../../../src/renderer/api', () => ({ api }))
import { createGitChangesController, gitRevealReadiness, type GitChangesController } from '../../../../../src/renderer/components/canvas/viewers/changes/state/git-changes-store'
import { createViewMemory } from '../../../../../src/renderer/components/canvas/viewers/changes/state/view-memory'

const repo = (root: string): GitRepository => ({ root, name: root.split('/').pop()!, relativePath: root, branch: 'main', head: 'abc', unborn: false, upstream: null, ahead: 0, behind: 0 })
const first = repo('/space/a')
const second = repo('/space/deep/b')
const third = repo('/space/c')
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
  listed = { git: { available: true, version: '2.45' }, repositories: [first] }
  api.gitListRepositories.mockImplementation(async () => ok(listed))
  api.gitGetStatus.mockImplementation(async (_space, root) => ok({ repo: repo(root), staged: [], unstaged: [], conflicted: [], operation: null, truncated: false }))
  api.gitGetChanges.mockImplementation(async (_space, root, scope) => ok({ repoRoot: root, scope, beforeRevision: 'abc', files: [], truncated: false }))
  api.codeReviewGetLatest.mockResolvedValue(ok(null))
  api.gitOpenRepository.mockImplementation(async (_space, root) => {
    const opened = repo(root)
    listed = { ...listed, repositories: [...listed.repositories, opened], savedRepositories: [{ root, available: true }] }
    return ok(opened)
  })
  api.gitForgetRepository.mockImplementation(async (_space, root) => {
    listed = { ...listed, repositories: listed.repositories.filter((item) => item.root !== root), savedRepositories: [] }
    return ok(undefined)
  })
})
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.dispose())
})

describe('manual repositories in a mounted changes view', () => {
  it('defaults legacy saved rows to empty and selects the opened root after relisting', async () => {
    const { controller, memory } = create()
    await controller.load()
    expect(controller.store.getState().savedRepositories).toEqual([])
    expect(await controller.openRepository(second.root)).toBeNull()
    expect(api.gitOpenRepository).toHaveBeenCalledWith('space', second.root)
    expect(api.gitListRepositories).toHaveBeenCalledTimes(2)
    expect(memory.repoRoot).toBe(second.root)
    expect(controller.store.getState()).toMatchObject({ repoRoot: second.root, savedRepositories: [{ root: second.root, available: true }] })
  })

  it('keeps unavailable saved rows with zero available repositories and removes only their records', async () => {
    listed = { ...listed, repositories: [], savedRepositories: [{ root: second.root, available: false }] }
    const { controller } = create()
    await controller.load()
    expect(controller.store.getState()).toMatchObject({ phase: 'no-repo', savedRepositories: listed.savedRepositories })
    await controller.forgetRepository(second.root)
    expect(api.gitForgetRepository).toHaveBeenCalledWith('space', second.root)
    expect(controller.store.getState()).toMatchObject({ phase: 'no-repo', savedRepositories: [] })
  })

  it('reads remembered rows again after a viewer remount', async () => {
    const { controller } = create()
    await controller.openRepository(second.root)
    controller.dispose()
    const remounted = create().controller
    await remounted.load()
    expect(remounted.store.getState().savedRepositories).toEqual([{ root: second.root, available: true }])
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

  it('preserves selection when forgetting another root or one still discovered automatically', async () => {
    listed = { ...listed, repositories: [first, second], savedRepositories: [{ root: second.root, available: true }] }
    const { controller, memory } = create()
    await controller.load()
    await controller.forgetRepository(second.root)
    expect(memory.repoRoot).toBe(first.root)
    api.gitForgetRepository.mockImplementationOnce(async () => { listed = { ...listed, savedRepositories: [] }; return ok(undefined) })
    await controller.forgetRepository(first.root)
    expect(memory.repoRoot).toBe(first.root)
  })

  it('drops the selected removed root and its stale data, even if the replacement cannot load', async () => {
    listed = { ...listed, repositories: [first, second] }
    const { controller, memory } = create()
    await controller.load()
    api.gitGetStatus.mockResolvedValueOnce({ success: false, code: 'GIT_FAILED', error: 'read failed' })
    await controller.forgetRepository(first.root)
    expect(memory.repoRoot).toBe(second.root)
    expect(controller.store.getState()).toMatchObject({ repoRoot: second.root, list: null, status: null, repositories: [second] })
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
    opening.resolve(ok(second))
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
    status.resolve(ok({ repo: second }))
    await opening
    expect(controller.store.getState().repositories).toHaveLength(3)
    expect(controller.store.getState().repoRoot).toBe(third.root)
  })

  it('invalidates an older list request when opening or forgetting completes', async () => {
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

  it.each(['open', 'forget'] as const)('ignores %s results after disposal, without relisting or writing tab memory', async (operation) => {
    const { controller, memory } = create()
    await controller.load()
    const request = deferred<ReturnType<typeof ok<GitRepository | undefined>>>()
    api[operation === 'open' ? 'gitOpenRepository' : 'gitForgetRepository'].mockReturnValueOnce(request.promise)
    const pending = operation === 'open' ? controller.openRepository(second.root) : controller.forgetRepository(first.root)
    controller.dispose()
    const state = controller.store.getState()
    request.resolve(ok(operation === 'open' ? second : undefined))
    await pending
    expect(memory.repoRoot).toBe(first.root)
    expect(controller.store.getState()).toBe(state)
    expect(api.gitListRepositories).toHaveBeenCalledTimes(1)
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
    expect(await controller.forgetRepository(first.root)).toEqual({ code: 'GIT_BUSY' })
    await controller.selectRepository(second.root)
    expect(memory.repoRoot).toBe(first.root)
    expect(api.gitOpenRepository).not.toHaveBeenCalled()
    expect(api.gitForgetRepository).not.toHaveBeenCalled()
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
    request.resolve(ok(first))
    await pending
  })
})
