/**
 * The review card's states from a review record and its progress, the "new
 * changes" count between two statuses, lining positions up across a diff, and
 * the data controller of a Git changes view against a stubbed git api.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitChangedFile, GitReviewRecord, GitWorkingTreeStatus } from '../../../../../src/shared/types/git'

const gitApi = vi.hoisted(() => ({
  gitListRepositories: vi.fn(),
  gitGetStatus: vi.fn(),
  gitGetChanges: vi.fn(),
  gitGetFileContents: vi.fn(),
  gitStage: vi.fn(),
  codeReviewGetLatest: vi.fn(),
}))
vi.mock('../../../../../src/renderer/api', () => ({ api: gitApi }))

const { reviewCardState, refusalText } = await import('../../../../../src/renderer/components/canvas/viewers/changes/review/review-state')
const { countChangedFiles } = await import('../../../../../src/renderer/components/canvas/viewers/changes/state/status-diff')
const { mapAcross } = await import('../../../../../src/renderer/components/canvas/viewers/changes/diff/diff-editor')
const { createGitChangesController } = await import('../../../../../src/renderer/components/canvas/viewers/changes/state/git-changes-store')
const { createViewMemory } = await import('../../../../../src/renderer/components/canvas/viewers/changes/state/view-memory')
const { EMPTY_REVIEW_PROGRESS } = await import('../../../../../src/renderer/utils/review-progress')

const t = (key: string, options?: Record<string, unknown>) =>
  key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name] ?? ''))

const record: GitReviewRecord = {
  repoRoot: '/w/repo', conversationId: 'conv', variant: 'quick', scope: { kind: 'uncommitted' },
  scopeLabel: 'Uncommitted changes', snapshot: 'tree1', fileCount: 4, startedAt: 1_000,
}

describe('review card state', () => {
  it('offers both reviews when there is no review, or its conversation is gone', () => {
    expect(reviewCardState(null, EMPTY_REVIEW_PROGRESS, 0)).toEqual({ kind: 'idle', deleted: false })
    expect(reviewCardState(record, { ...EMPTY_REVIEW_PROGRESS, status: 'missing' }, 0)).toEqual({ kind: 'idle', deleted: true })
  })

  it('follows a running review, from the record when the conversation has no start yet', () => {
    const todos = [{ content: 'Read the rules', status: 'completed' as const }]
    const state = reviewCardState(record, { ...EMPTY_REVIEW_PROGRESS, status: 'running', todos, activity: { key: 'Thinking...' } }, 0)
    expect(state).toEqual({ kind: 'running', variant: 'quick', startedAt: 1_000, todos, activity: { key: 'Thinking...' }, members: null })
  })

  it('shows the report with its timing, cost and staleness once done', () => {
    const progress = {
      ...EMPTY_REVIEW_PROGRESS,
      status: 'done' as const,
      startedAt: 2_000,
      endedAt: 104_000,
      tokens: 38_000,
      report: { messageId: 'm2', content: '## Verdict' },
      conversationTitle: 'Review · Uncommitted changes · 4 files',
    }
    expect(reviewCardState(record, progress, 3)).toEqual({
      kind: 'done', variant: 'quick', finishedAt: 104_000, tookMs: 102_000, tokens: 38_000,
      report: { messageId: 'm2', content: '## Verdict' }, conversationTitle: 'Review · Uncommitted changes · 4 files',
      basedOn: 1_000, changedSince: 3,
    })
  })

  it('treats a finished review without a report as failed, and keeps stops apart', () => {
    expect(reviewCardState(record, { ...EMPTY_REVIEW_PROGRESS, status: 'done' }, 0)).toEqual({ kind: 'failed', variant: 'quick', error: null })
    expect(reviewCardState(record, { ...EMPTY_REVIEW_PROGRESS, status: 'error', error: '529' }, 0)).toEqual({ kind: 'failed', variant: 'quick', error: '529' })
    expect(reviewCardState({ ...record, variant: 'team' }, { ...EMPTY_REVIEW_PROGRESS, status: 'stopped' }, 0)).toEqual({ kind: 'stopped', variant: 'team' })
    expect(reviewCardState(record, EMPTY_REVIEW_PROGRESS, 0)).toEqual({ kind: 'loading', variant: 'quick' })
  })

  it('says why a review did not start', () => {
    expect(refusalText('team-unavailable', 'x', t)).toBe('Team review isn\'t available right now')
    expect(refusalText('failed', 'disk full', t)).toBe('disk full')
    expect(refusalText('failed', '', t)).toBe('Something went wrong')
  })
})

function changed(path: string, extra: Partial<GitChangedFile> = {}): GitChangedFile {
  return { path, state: 'modified', additions: 1, deletions: 0, binary: false, ...extra }
}

describe('new changes count', () => {
  const before = { staged: [changed('a.ts')], unstaged: [changed('b.ts'), changed('c.ts')], conflicted: [] }

  it('counts each file that appeared, disappeared, moved between groups or changed its counts once', () => {
    expect(countChangedFiles(before, before)).toBe(0)
    const after = {
      staged: [],
      unstaged: [changed('a.ts'), changed('b.ts', { additions: 5 }), changed('d.ts', { state: 'untracked' })],
      conflicted: [],
    }
    // a.ts moved, b.ts grew, c.ts went away, d.ts appeared.
    expect(countChangedFiles(before, after)).toBe(4)
  })
})

describe('lining positions up across a diff', () => {
  // Side a: 10 chars, a chunk replaces a[3,5) with b[3,9); side b is 4 chars longer after it.
  const chunks = [{ fromA: 3, toA: 5, fromB: 3, toB: 9 }]

  it('maps positions before and after a chunk to the other side', () => {
    expect(mapAcross(2, chunks, true)).toBe(2)
    expect(mapAcross(7, chunks, true)).toBe(11)
    expect(mapAcross(11, chunks, false)).toBe(7)
  })
})

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
const repositories = { git: { available: true, version: '2.45.0' }, repositories: [status().repo] }

describe('git changes controller', () => {
  beforeEach(() => {
    for (const fn of Object.values(gitApi)) fn.mockReset()
    gitApi.gitListRepositories.mockImplementation(() => ok(repositories))
    gitApi.gitGetStatus.mockImplementation(() => ok(status()))
    gitApi.gitGetChanges.mockImplementation((_space: string, _root: string, scope: unknown) =>
      ok({ scope, beforeRevision: 'abc1234', files: [changed('src/a.ts')], truncated: false }))
    gitApi.codeReviewGetLatest.mockImplementation(() => ok(null))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('loads the first repository, its status, its list and its latest review', async () => {
    gitApi.codeReviewGetLatest.mockImplementation(() => ok(record))
    const memory = createViewMemory()
    const controller = createGitChangesController('space', memory, undefined)
    await controller.load({ relist: true })
    const state = controller.store.getState()
    expect(state.phase).toBe('ready')
    expect(state.repoRoot).toBe('/w/repo')
    expect(memory.repoRoot).toBe('/w/repo')
    expect(state.review).toEqual(record)
    expect(state.list?.files.map((f) => f.path)).toEqual(['src/a.ts'])
    expect(state.version).toBe(1)
    controller.dispose()
  })

  it('says when there is no git or no repository', async () => {
    gitApi.gitListRepositories.mockImplementationOnce(() => ok({ git: { available: false, reason: 'not-installed' }, repositories: [] }))
    const noGit = createGitChangesController('space', createViewMemory(), undefined)
    await noGit.load({ relist: true })
    expect(noGit.store.getState().phase).toBe('no-git')

    gitApi.gitListRepositories.mockImplementationOnce(() => ok({ git: { available: true, version: '2.45.0' }, repositories: [] }))
    const noRepo = createGitChangesController('space', createViewMemory(), undefined)
    await noRepo.load({ relist: true })
    expect(noRepo.store.getState().phase).toBe('no-repo')
  })

  it('compares since the last review only when there is one', async () => {
    const memory = { ...createViewMemory(), scope: { kind: 'since-review' as const } }
    const controller = createGitChangesController('space', memory, undefined)
    await controller.load({ relist: true })
    expect(memory.scope).toEqual({ kind: 'uncommitted' })

    gitApi.codeReviewGetLatest.mockImplementation(() => ok(record))
    await controller.setScope({ kind: 'since-review' })
    expect(gitApi.gitGetChanges).toHaveBeenLastCalledWith('space', '/w/repo', { kind: 'since-review', snapshot: 'tree1' })
  })

  it('looks for the repositories again when the chosen one is gone', async () => {
    const memory = { ...createViewMemory(), repoRoot: '/w/old' }
    gitApi.gitGetStatus.mockImplementationOnce(() => Promise.resolve({ success: false, error: 'gone', code: 'GIT_NOT_A_REPOSITORY' }))
    const controller = createGitChangesController('space', memory, undefined)
    await controller.load()
    expect(gitApi.gitListRepositories).toHaveBeenCalledTimes(2)
    expect(controller.store.getState().phase).toBe('ready')
    expect(memory.repoRoot).toBe('/w/repo')
  })

  it('turns file events in the repository into a "new changes" count, never a reload', async () => {
    vi.useFakeTimers()
    const controller = createGitChangesController('space', createViewMemory(), undefined)
    await controller.load({ relist: true })
    gitApi.gitGetStatus.mockImplementation(() => ok(status([changed('src/a.ts', { additions: 9 }), changed('src/new.ts', { state: 'untracked' })])))

    controller.noteFileChanges(['/w/repo/.git/index', '/w/other/x.ts'])
    await vi.advanceTimersByTimeAsync(1_500)
    expect(controller.store.getState().newChanges).toBe(0)

    controller.noteFileChanges(['/w/repo/src/a.ts'])
    await vi.advanceTimersByTimeAsync(1_500)
    expect(controller.store.getState().newChanges).toBe(2)
    expect(controller.store.getState().version).toBe(1)
    controller.dismissNewChanges()
    expect(controller.store.getState().newChanges).toBe(0)
    controller.dispose()
  })

  it('marks paths busy while staging, then reloads', async () => {
    let finish: () => void = () => {}
    gitApi.gitStage.mockImplementation(() => new Promise((resolve) => { finish = () => resolve({ success: true }) }))
    const controller = createGitChangesController('space', createViewMemory(), undefined)
    await controller.load({ relist: true })
    const staging = controller.stage(['src/a.ts'])
    expect(controller.store.getState().busyPaths.has('src/a.ts')).toBe(true)
    finish()
    expect(await staging).toBeNull()
    expect(controller.store.getState().busyPaths.size).toBe(0)
    await vi.waitFor(() => expect(controller.store.getState().version).toBe(2))
  })

  it('reads a file\'s contents once per load', async () => {
    gitApi.gitGetFileContents.mockImplementation(() => ok({ path: 'src/a.ts', before: 'a', after: 'b', binary: false, tooLarge: false, beforeBytes: 1, afterBytes: 1 }))
    const controller = createGitChangesController('space', createViewMemory(), undefined)
    await controller.load({ relist: true })
    const file = { key: 'src/a.ts', path: 'src/a.ts', absPath: '/w/repo/src/a.ts', state: 'modified' as const, additions: 1, deletions: 0, binary: false, generated: false }
    const [first, second] = await Promise.all([controller.contents(file), controller.contents(file)])
    expect(first).toBe(second)
    expect(first.size).toBe(2)
    expect(gitApi.gitGetFileContents).toHaveBeenCalledTimes(1)
    await controller.load()
    await controller.contents(file)
    expect(gitApi.gitGetFileContents).toHaveBeenCalledTimes(2)
  })
})
