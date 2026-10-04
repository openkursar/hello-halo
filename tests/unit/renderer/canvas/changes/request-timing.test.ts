/**
 * When the changes view asks the main process for work: file contents a few
 * at a time, newest first, dropped once nobody wants them; the "changed since
 * the review" count when the card first appears, when it appears again after
 * files changed, on Refresh and after a discard; no status check while the
 * window is hidden; and the layout re-rendering only at width steps.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitChangedFile, GitWorkingTreeStatus } from '../../../../../src/shared/types/git'

const gitApi = vi.hoisted(() => ({
  gitListRepositories: vi.fn(),
  gitGetStatus: vi.fn(),
  gitGetChanges: vi.fn(),
  gitGetFileContents: vi.fn(),
  gitStage: vi.fn(),
  gitUnstage: vi.fn(),
  gitDiscard: vi.fn(),
  gitCommit: vi.fn(),
  codeReviewGetLatest: vi.fn(),
}))
vi.mock('../../../../../src/renderer/api', () => ({ api: gitApi }))

const { RequestQueue, isAbortError } = await import('../../../../../src/renderer/components/canvas/viewers/changes/state/request-queue')
const { ChangedSinceCounter } = await import('../../../../../src/renderer/components/canvas/viewers/changes/review/changed-since')
const { createGitChangesController } = await import('../../../../../src/renderer/components/canvas/viewers/changes/state/git-changes-store')
const { createViewMemory } = await import('../../../../../src/renderer/components/canvas/viewers/changes/state/view-memory')
const { layoutStep } = await import('../../../../../src/renderer/components/canvas/viewers/changes/shared/use-container-width')
const { deepestRootOf } = await import('../../../../../src/renderer/components/canvas/viewers/changes/model/paths')

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

describe('request queue', () => {
  it('runs at most its limit at once, the newest waiting request first', async () => {
    const queue = new RequestQueue(2)
    const started: string[] = []
    const gates = new Map<string, ReturnType<typeof deferred<void>>>()
    const task = (name: string) => () => {
      started.push(name)
      const gate = deferred()
      gates.set(name, gate)
      return gate.promise.then(() => name)
    }
    const results = ['a', 'b', 'c', 'd'].map((name) => queue.run(task(name)))
    expect(started).toEqual(['a', 'b'])
    expect(queue.pending).toBe(2)
    gates.get('a')!.resolve()
    await results[0]
    await Promise.resolve()
    expect(started).toEqual(['a', 'b', 'd'])
    gates.get('b')!.resolve()
    gates.get('d')!.resolve()
    await Promise.all([results[1], results[3]])
    await Promise.resolve()
    expect(started).toEqual(['a', 'b', 'd', 'c'])
    gates.get('c')!.resolve()
    expect(await Promise.all(results)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('drops a waiting request whose signal aborts, without running it', async () => {
    const queue = new RequestQueue(1)
    const first = deferred()
    const ran = vi.fn(() => Promise.resolve('late'))
    void queue.run(() => first.promise)
    const reading = new AbortController()
    const waiting = queue.run(ran, reading.signal)
    reading.abort()
    await expect(waiting).rejects.toSatisfy(isAbortError)
    first.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(ran).not.toHaveBeenCalled()
    expect(queue.pending).toBe(0)
  })

  it('refuses a request that is already cancelled', async () => {
    const reading = new AbortController()
    reading.abort()
    await expect(new RequestQueue(4).run(() => Promise.resolve(1), reading.signal)).rejects.toSatisfy(isAbortError)
  })
})

describe('changed-since counter', () => {
  it('counts once for a snapshot, a recount and the file changes seen; asking again reuses it', async () => {
    const counter = new ChangedSinceCounter()
    const count = vi.fn(() => Promise.resolve(4))
    expect(counter.lastFor('s1')).toBeNull()
    expect(await counter.countFor('s1', 0, 0, count)).toBe(4)
    // The card shown again with nothing changed meanwhile, or re-rendered by a focus load.
    expect(await counter.countFor('s1', 0, 0, count)).toBe(4)
    expect(count).toHaveBeenCalledTimes(1)
    expect(counter.lastFor('s1')).toBe(4)
    expect(counter.lastFor('s2')).toBeNull()
  })

  it('counts again after a Refresh or discard, after files changed, and for a new review', async () => {
    const counter = new ChangedSinceCounter()
    const count = vi.fn(() => Promise.resolve(1))
    await counter.countFor('s1', 0, 0, count)
    await counter.countFor('s1', 1, 0, count)
    await counter.countFor('s1', 1, 3, count)
    await counter.countFor('s2', 1, 3, count)
    expect(count).toHaveBeenCalledTimes(4)
  })

  it('shares a count still running with a card that appears meanwhile', async () => {
    const counter = new ChangedSinceCounter()
    const running = deferred<number>()
    const count = vi.fn(() => running.promise)
    const first = counter.countFor('s1', 0, 0, count)
    const second = counter.countFor('s1', 0, 0, count)
    running.resolve(2)
    expect([await first, await second]).toEqual([2, 2])
    expect(count).toHaveBeenCalledTimes(1)
  })

  it('keeps the newer count when an older one finishes after it', async () => {
    const counter = new ChangedSinceCounter()
    const older = deferred<number>()
    const olderCount = counter.countFor('s1', 0, 0, () => older.promise)
    await counter.countFor('s1', 1, 0, () => Promise.resolve(5))
    older.resolve(9)
    expect(await olderCount).toBe(9)
    expect(counter.lastFor('s1')).toBe(5)
  })
})

function changed(path: string, extra: Partial<GitChangedFile> = {}): GitChangedFile {
  return { path, state: 'modified', additions: 1, deletions: 0, binary: false, ...extra }
}

function status(files: GitChangedFile[] = [changed('src/a.ts')]): GitWorkingTreeStatus {
  return {
    repo: { root: '/w/repo', name: 'repo', relativePath: '', branch: 'main', head: 'abc1234', unborn: false, upstream: null, ahead: 0, behind: 0 },
    staged: [],
    unstaged: files,
    conflicted: [],
    operation: null,
    truncated: false,
  }
}

const ok = <T,>(data: T) => Promise.resolve({ success: true, data })
const file = { key: 'src/a.ts', path: 'src/a.ts', absPath: '/w/repo/src/a.ts', state: 'modified' as const, additions: 1, deletions: 0, binary: false, generated: false }

describe('git changes controller timing', () => {
  beforeEach(() => {
    for (const fn of Object.values(gitApi)) fn.mockReset()
    gitApi.gitListRepositories.mockImplementation(() => ok({ git: { available: true, version: '2.45.0' }, repositories: [status().repo] }))
    gitApi.gitGetStatus.mockImplementation(() => ok(status()))
    gitApi.gitGetChanges.mockImplementation((_s: string, _r: string, scope: unknown) => ok({ scope, beforeRevision: 'abc', files: [changed('src/a.ts')], truncated: false }))
    gitApi.codeReviewGetLatest.mockImplementation(() => ok(null))
    for (const op of [gitApi.gitStage, gitApi.gitUnstage, gitApi.gitDiscard]) op.mockImplementation(() => ok(undefined))
    gitApi.gitCommit.mockImplementation(() => ok({ commit: 'def5678', pushed: false }))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('asks to recount the changes since the review only on Refresh and after a discard', async () => {
    vi.useFakeTimers()
    const controller = createGitChangesController('space', createViewMemory(), undefined)
    const recount = () => controller.store.getState().recount
    await controller.load({ relist: true })
    expect(recount()).toBe(0)

    await vi.advanceTimersByTimeAsync(3_000)
    controller.refreshIfStale()
    await controller.stage(['src/a.ts'])
    await controller.unstage(['src/a.ts'])
    await controller.commit({ message: 'x', amend: false, push: false })
    controller.noteFileChanges(['/w/repo/src/a.ts'])
    await vi.advanceTimersByTimeAsync(1_500)
    expect(recount()).toBe(0)

    await controller.refresh({ relist: true })
    expect(recount()).toBe(1)
    await controller.discard(['src/a.ts'])
    expect(recount()).toBe(2)

    gitApi.gitDiscard.mockImplementationOnce(() => Promise.resolve({ success: false, error: 'locked', code: 'GIT_LOCKED' }))
    await controller.discard(['src/a.ts'])
    expect(recount()).toBe(2)
    controller.dispose()
  })

  it('counts file changes in the repository for the review card without running git', async () => {
    vi.useFakeTimers()
    const controller = createGitChangesController('space', createViewMemory(), undefined)
    await controller.load({ relist: true })
    const statusReads = gitApi.gitGetStatus.mock.calls.length
    expect(controller.treeVersion()).toBe(0)

    controller.noteFileChanges(['/w/repo/src/a.ts'])
    controller.noteFileChanges(['/w/other/x.ts'])
    controller.noteFileChanges(['/w/repo/.git/index'])
    expect(controller.treeVersion()).toBe(1)
    controller.noteFileChanges(null)
    expect(controller.treeVersion()).toBe(2)
    expect(gitApi.gitGetStatus).toHaveBeenCalledTimes(statusReads)
    controller.dispose()
  })

  it('waits with the new-changes check while the window is hidden, and checks once it is shown', async () => {
    vi.useFakeTimers()
    const page = { visibilityState: 'hidden' as DocumentVisibilityState }
    Object.defineProperty(globalThis, 'document', { value: page, configurable: true })
    try {
      const controller = createGitChangesController('space', createViewMemory(), undefined)
      await controller.load({ relist: true })
      const statusReads = () => gitApi.gitGetStatus.mock.calls.length
      const afterLoad = statusReads()

      controller.noteFileChanges(['/w/repo/src/a.ts'])
      await vi.advanceTimersByTimeAsync(1_500)
      expect(statusReads()).toBe(afterLoad)

      // Shown again right away: no reload is due, so the skipped check runs.
      page.visibilityState = 'visible'
      controller.refreshIfStale()
      await vi.advanceTimersByTimeAsync(1_500)
      expect(statusReads()).toBe(afterLoad + 1)

      // Shown again later: the reload answers it, with no check on top.
      page.visibilityState = 'hidden'
      controller.noteFileChanges(['/w/repo/src/a.ts'])
      await vi.advanceTimersByTimeAsync(3_000)
      page.visibilityState = 'visible'
      controller.refreshIfStale()
      await vi.advanceTimersByTimeAsync(1_500)
      expect(statusReads()).toBe(afterLoad + 2)
      controller.dispose()
    } finally {
      Reflect.deleteProperty(globalThis, 'document')
    }
  })

  it('reads file contents three at a time and drops reads nobody waits for', async () => {
    const gates: Array<ReturnType<typeof deferred<unknown>>> = []
    gitApi.gitGetFileContents.mockImplementation(() => {
      const gate = deferred<unknown>()
      gates.push(gate)
      return gate.promise
    })
    const controller = createGitChangesController('space', createViewMemory(), undefined)
    await controller.load({ relist: true })
    const many = ['a', 'b', 'c', 'd', 'e'].map((name) => ({ ...file, key: name, path: `src/${name}.ts` }))
    const cancelled = new AbortController()
    const reads = many.map((f, i) => controller.contents(f, i === 3 ? cancelled.signal : undefined))
    expect(gitApi.gitGetFileContents).toHaveBeenCalledTimes(3)
    cancelled.abort()
    await expect(reads[3]).rejects.toSatisfy(isAbortError)
    const contents = { path: 'x', before: 'a', after: 'b', binary: false, tooLarge: false }
    gates[0].resolve({ success: true, data: contents })
    await reads[0]
    await vi.waitFor(() => expect(gitApi.gitGetFileContents).toHaveBeenCalledTimes(4))
    expect(gitApi.gitGetFileContents.mock.calls[3][2]).toMatchObject({ path: 'src/e.ts' })
    for (const gate of gates.slice(1)) gate.resolve({ success: true, data: contents })
    await Promise.all([reads[1], reads[2], reads[4]])
    controller.dispose()
  })

  it('asks once more, a moment later, when the main process was too busy to read', async () => {
    vi.useFakeTimers()
    gitApi.gitGetFileContents
      .mockImplementationOnce(() => Promise.resolve({ success: false, error: 'busy', code: 'GIT_BUSY' }))
      .mockImplementationOnce(() => ok({ path: 'src/a.ts', before: 'a', after: 'b', binary: false, tooLarge: false }))
    const controller = createGitChangesController('space', createViewMemory(), undefined)
    await controller.load({ relist: true })
    const reading = controller.contents(file)
    await vi.advanceTimersByTimeAsync(1_000)
    expect((await reading).after).toBe('b')
    expect(gitApi.gitGetFileContents).toHaveBeenCalledTimes(2)
    controller.dispose()
  })
})

describe('layout steps', () => {
  it('stay the same within a step and change across one', () => {
    expect(layoutStep(1000, true)).toBe(layoutStep(1100, true))
    expect(layoutStep(1000, true)).not.toBe(layoutStep(1200, true))
    expect(layoutStep(700, true)).not.toBe(layoutStep(760, true))
    expect(layoutStep(500, false)).not.toBe(layoutStep(600, false))
  })

  it('move with the docked file list', () => {
    expect(layoutStep(920, true)).not.toBe(layoutStep(920, false))
  })
})

describe('owning repository', () => {
  it('is the deepest root holding the path', () => {
    const roots = ['/w/space', '/w/space/halo-local', '/w/other']
    expect(deepestRootOf(roots, '/w/space/halo-local/src/x.ts')).toBe('/w/space/halo-local')
    expect(deepestRootOf(roots, '/w/space/src/x.ts')).toBe('/w/space')
    expect(deepestRootOf(roots, '/elsewhere/x.ts')).toBeNull()
    expect(deepestRootOf(roots, '/w/space')).toBeNull()
  })
})
