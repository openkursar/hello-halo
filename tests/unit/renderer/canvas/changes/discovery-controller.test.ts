import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitRepository } from '../../../../../src/shared/types/git'

const api = vi.hoisted(() => ({ gitListRepositories: vi.fn(), gitDiscoverRepository: vi.fn(), gitGetStatus: vi.fn(), gitGetChanges: vi.fn(), codeReviewGetLatest: vi.fn() }))
vi.mock('../../../../../src/renderer/api', () => ({ api }))
import { gitDiscovery } from '../../../../../src/renderer/services/git-discovery'
import { createGitChangesController, type GitChangesController } from '../../../../../src/renderer/components/canvas/viewers/changes/state/git-changes-store'
import { createViewMemory } from '../../../../../src/renderer/components/canvas/viewers/changes/state/view-memory'

const root = (path: string): GitRepository => ({ root: path, name: path, relativePath: path, branch: 'main', head: 'abc', unborn: false, upstream: null, ahead: 0, behind: 0 })
const first = root('/space')
const second = root('/space/deep/sdk')
const ok = <T>(data: T) => ({ success: true, data })
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
let controller: GitChangesController
beforeEach(() => {
  vi.resetAllMocks()
  gitDiscovery.forget()
  api.gitListRepositories.mockResolvedValue(ok({ git: { available: true, version: '2' }, repositories: [first] }))
  api.gitGetStatus.mockResolvedValue(ok({ repo: first, staged: [], unstaged: [], conflicted: [], operation: null, truncated: false }))
  api.gitGetChanges.mockResolvedValue(ok({ scope: { kind: 'uncommitted' }, beforeRevision: 'abc', files: [], truncated: false }))
  api.codeReviewGetLatest.mockResolvedValue(ok(null))
  controller = createGitChangesController('s', createViewMemory(), undefined)
})
afterEach(() => { controller.dispose(); gitDiscovery.forget() })

describe('incremental repository discovery', () => {
  it('shows a healthy repository while an unrelated probe is held, then appends without reloading', async () => {
    let finish!: (value: unknown) => void
    api.gitDiscoverRepository.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    gitDiscovery.noteFile('s', '/space/deep/sdk/file.ts')
    await controller.load()
    const before = controller.store.getState()
    expect(before.phase).toBe('ready')
    expect(before.repoRoot).toBe(first.root)
    finish(ok(second))
    await flush()
    const after = controller.store.getState()
    expect(after.repositories).toEqual([first, second])
    expect(after.repoRoot).toBe(first.root)
    expect(after.list).toBe(before.list)
    expect(after.status).toBe(before.status)
    expect(api.gitGetChanges).toHaveBeenCalledTimes(1)
    expect(api.gitListRepositories).toHaveBeenCalledTimes(1)
  })

  it('retains discoveries arriving during an older repository listing', async () => {
    let finish!: (value: unknown) => void
    api.gitListRepositories.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    api.gitDiscoverRepository.mockResolvedValue(ok(second))
    const loading = controller.load()
    gitDiscovery.noteFile('s', '/space/deep/sdk/file.ts')
    await flush()
    finish(ok({ git: { available: true, version: '2' }, repositories: [first] }))
    await loading
    expect(controller.store.getState().repositories).toEqual([first, second])
  })

  it('does not update disposed consumers or another space', async () => {
    api.gitDiscoverRepository.mockResolvedValue(ok(second))
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
