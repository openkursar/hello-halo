import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitRepository, GitRepositoryEntry, GitRepositoryList } from '../../../../../src/shared/types/git'

const api = vi.hoisted(() => ({ gitListRepositories: vi.fn(), gitDiscoverRepository: vi.fn(), gitGetStatus: vi.fn(), gitGetChanges: vi.fn(), codeReviewGetLatest: vi.fn() }))
vi.mock('../../../../../src/renderer/api', () => ({ api }))
import { gitDiscovery } from '../../../../../src/renderer/services/git-discovery'
import { i18nReady, setLanguage } from '../../../../../src/renderer/i18n'
import { useNotificationStore } from '../../../../../src/renderer/stores/notification.store'
import { createGitChangesController, type GitChangesController } from '../../../../../src/renderer/components/canvas/viewers/changes/state/git-changes-store'
import { createViewMemory } from '../../../../../src/renderer/components/canvas/viewers/changes/state/view-memory'

const entry = (root: string): GitRepositoryEntry => ({ root, name: root.split('/').pop()!, relativePath: root, remembered: true })
const first = entry('/space')
const second = entry('/space/deep/sdk')
const summary = (repository: GitRepositoryEntry): GitRepository => ({ root: repository.root, name: repository.name, relativePath: repository.relativePath, branch: 'main', head: 'abc', unborn: false, upstream: null, ahead: 0, behind: 0 })
const ok = <T>(data: T) => ({ success: true, data })
const list = (repositories: GitRepositoryEntry[]): GitRepositoryList => ({ git: { available: true, version: '2' }, repositories })
const found = (repository: GitRepositoryEntry) => ({ repository: { root: repository.root, name: repository.name, relativePath: repository.relativePath }, remembered: repository.remembered })
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
let controller: GitChangesController
beforeEach(async () => {
  await i18nReady
  await setLanguage('en')
  vi.resetAllMocks()
  gitDiscovery.forget()
  useNotificationStore.getState().clear()
  api.gitListRepositories.mockResolvedValue(ok(list([first])))
  api.gitGetStatus.mockImplementation(async (_space, root) => ok({ repo: summary(entry(root)), staged: [], unstaged: [], conflicted: [], operation: null, truncated: false }))
  api.gitGetChanges.mockResolvedValue(ok({ scope: { kind: 'uncommitted' }, beforeRevision: 'abc', files: [], truncated: false }))
  api.codeReviewGetLatest.mockResolvedValue(ok(null))
  controller = createGitChangesController('s', createViewMemory(), undefined)
})
afterEach(() => { controller.dispose(); gitDiscovery.forget() })

describe('incremental repository discovery', () => {
  it('shows a healthy repository while an unrelated probe is held, then appends without reloading', async () => {
    const discovery = deferred<ReturnType<typeof ok>>()
    api.gitDiscoverRepository.mockReturnValueOnce(discovery.promise)
    gitDiscovery.noteFile('s', '/space/deep/sdk/file.ts')
    await controller.load()
    const before = controller.store.getState()
    expect(before.phase).toBe('ready')
    expect(before.repoRoot).toBe(first.root)
    discovery.resolve(ok(found(second)))
    await flush()
    const after = controller.store.getState()
    expect(after.repositories).toEqual([first, second])
    expect(after.repoRoot).toBe(first.root)
    expect(after.list).toBe(before.list)
    expect(after.status).toBe(before.status)
    expect(api.gitGetChanges).toHaveBeenCalledTimes(1)
    expect(api.gitListRepositories.mock.calls).toEqual([['s', { shallow: false }], ['s', { shallow: true }]])
  })

  it('retains discoveries arriving during an older repository listing', async () => {
    const known = deferred<ReturnType<typeof ok<GitRepositoryList>>>()
    api.gitListRepositories.mockReturnValueOnce(known.promise)
    api.gitDiscoverRepository.mockResolvedValue(ok(found(second)))
    const loading = controller.load()
    gitDiscovery.noteFile('s', '/space/deep/sdk/file.ts')
    await flush()
    known.resolve(ok(list([first])))
    await loading
    expect(controller.store.getState().repositories).toEqual([first, second])
  })

  it('retains fresh remembered flags when older known and shallow listings finish later', async () => {
    const known = deferred<ReturnType<typeof ok<GitRepositoryList>>>()
    const shallow = deferred<ReturnType<typeof ok<GitRepositoryList>>>()
    api.gitListRepositories.mockReturnValueOnce(known.promise).mockReturnValueOnce(shallow.promise)
    api.gitDiscoverRepository.mockResolvedValue(ok(found(second)))
    const loading = controller.load()
    gitDiscovery.noteFile('s', '/space/deep/sdk/file.ts')
    await flush()
    known.resolve(ok(list([first, { ...second, remembered: false }])))
    await loading
    shallow.resolve(ok(list([first, { ...second, remembered: false }])))
    await flush()
    expect(controller.store.getState().repositories).toEqual([first, second])
  })

  it('loads only the known selected path while shallow discovery is held, and never reloads on completion', async () => {
    const shallow = deferred<ReturnType<typeof ok<GitRepositoryList>>>()
    api.gitListRepositories.mockImplementation((_space, options) => options.shallow ? shallow.promise : Promise.resolve(ok(list([second]))))
    await controller.load()
    const before = controller.store.getState()
    expect(before).toMatchObject({ phase: 'ready', repoRoot: second.root, repositories: [second] })
    expect(api.gitGetStatus).toHaveBeenCalledTimes(1)
    expect(api.gitGetStatus).toHaveBeenCalledWith('s', second.root)
    shallow.resolve(ok(list([first, second])))
    await flush()
    const after = controller.store.getState()
    expect(after.repositories).toEqual([second, first])
    expect(after.repoRoot).toBe(second.root)
    expect(after.status).toBe(before.status)
    expect(after.list).toBe(before.list)
    expect(after.version).toBe(before.version)
    expect(api.gitGetStatus).toHaveBeenCalledTimes(1)
    expect(api.gitGetChanges).toHaveBeenCalledTimes(1)
  })

  it('waits for a requested shallow target instead of replacing it with an unrelated known repository', async () => {
    const shallow = deferred<ReturnType<typeof ok<GitRepositoryList>>>()
    api.gitListRepositories.mockImplementation((_space, options) => options.shallow ? shallow.promise : Promise.resolve(ok(list([first]))))
    controller.dispose()
    const memory = createViewMemory()
    memory.repoRoot = second.root
    memory.scope = { kind: 'commit', revision: 'target-commit' }
    memory.detail = { kind: 'file', items: ['target.ts'], index: 0 }
    controller = createGitChangesController('s', memory, second.root)
    const loading = controller.load()
    await flush()
    expect(memory.repoRoot).toBe(second.root)
    expect(api.gitGetStatus).not.toHaveBeenCalled()
    shallow.resolve(ok(list([first, second])))
    await loading
    expect(controller.store.getState().repoRoot).toBe(second.root)
    expect(memory.scope).toEqual({ kind: 'commit', revision: 'target-commit' })
    expect(memory.detail).not.toBeNull()
  })

  it('waits for shallow discovery before selecting the first path when no root is known', async () => {
    const shallow = deferred<ReturnType<typeof ok<GitRepositoryList>>>()
    api.gitListRepositories.mockImplementation((_space, options) => options.shallow ? shallow.promise : Promise.resolve(ok(list([]))))
    const loading = controller.load()
    await flush()
    expect(controller.store.getState()).toMatchObject({ phase: 'loading', repoRoot: null, refreshing: true })
    expect(api.gitGetStatus).not.toHaveBeenCalled()
    shallow.resolve(ok(list([second, first])))
    await loading
    expect(controller.store.getState()).toMatchObject({ phase: 'ready', repoRoot: second.root })
    expect(api.gitGetStatus).toHaveBeenCalledTimes(1)
    expect(api.gitGetStatus).toHaveBeenCalledWith('s', second.root)
  })

  it('does not lose the supplemental list when a selection supersedes an earlier status load', async () => {
    const shallow = deferred<ReturnType<typeof ok<GitRepositoryList>>>()
    const status = deferred<ReturnType<typeof ok>>()
    api.gitListRepositories.mockImplementation((_space, options) => options.shallow ? shallow.promise : Promise.resolve(ok(list([first, second]))))
    api.gitGetStatus.mockReturnValueOnce(status.promise)
    const loading = controller.load()
    await flush()
    await controller.selectRepository(second.root)
    shallow.resolve(ok(list([first, second, entry('/space/third')])))
    await flush()
    const current = controller.store.getState()
    status.resolve(ok({ repo: summary(first) }))
    await loading
    expect(controller.store.getState()).toBe(current)
    expect(current.repositories).toHaveLength(3)
    expect(current.repoRoot).toBe(second.root)
  })

  it('retains a usable selected diff when supplemental discovery fails', async () => {
    api.gitListRepositories.mockImplementation((_space, options) => Promise.resolve(options.shallow
      ? { success: false, code: 'GIT_FAILED', error: 'discovery failed' } : ok(list([first]))))
    await controller.load()
    await flush()
    expect(controller.store.getState()).toMatchObject({ phase: 'ready', repoRoot: first.root, loadError: null })
    expect(api.gitGetStatus).toHaveBeenCalledTimes(1)
  })

  it('reports a failed empty-space scan as an error, not as no repositories', async () => {
    api.gitListRepositories.mockImplementation((_space, options) => Promise.resolve(options.shallow
      ? { success: false, code: 'GIT_FAILED', error: 'discovery failed' } : ok(list([]))))
    await controller.load()
    expect(controller.store.getState()).toMatchObject({ phase: 'error', loadError: { code: 'GIT_FAILED' } })
    expect(api.gitGetStatus).not.toHaveBeenCalled()
  })

  it('warns once per space about list record errors while paths and their diffs remain usable', async () => {
    api.gitListRepositories.mockResolvedValue(ok({ ...list([{ ...first, remembered: false }]), recordError: { code: 'GIT_FAILED', error: 'disk full' } }))
    const show = vi.spyOn(useNotificationStore.getState(), 'show')
    try {
      await controller.load()
      await controller.load({ relist: true })
      expect(controller.store.getState()).toMatchObject({ phase: 'ready', repositories: [{ ...first, remembered: false }] })
      expect(show).toHaveBeenCalledTimes(1)
      expect(show).toHaveBeenCalledWith(expect.objectContaining({ variant: 'warning', body: expect.stringContaining('could not be remembered') }))
    } finally {
      show.mockRestore()
    }
  })

  it('does not update disposed consumers or another space', async () => {
    api.gitDiscoverRepository.mockResolvedValue(ok(found(second)))
    await controller.load()
    gitDiscovery.noteFile('other', '/space/deep/sdk/file.ts')
    await flush()
    expect(controller.store.getState().repositories).toEqual([first])
    controller.dispose()
    gitDiscovery.noteFile('s', '/space/deep/sdk/file.ts')
    await flush()
    expect(controller.store.getState().repositories).toEqual([first])
  })
})
