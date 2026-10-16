import { describe, it, expect, vi } from 'vitest'
import {
  EMPTY_VIEW,
  GraphLoader,
  mergePage,
  NO_PAGES,
  settleLoad,
  type GraphLoadMode,
  type GraphPages,
  type GraphView,
} from '../../../src/renderer/components/canvas/viewers/changes/graph/graph-pages'
import { GIT_LIMITS, type GitCommitGraph, type GitGraphCommit } from '../../../src/shared/types/git'

const c = (oid: string): GitGraphCommit => ({ oid, shortOid: oid, parents: [], author: 'Ada', date: '2026-01-01T00:00:00Z', subject: oid, refs: [] })
const page = (oids: string[], more: boolean): GitCommitGraph => ({ commits: oids.map(c), more })
const oids = (pages: GraphPages) => pages.commits.map((commit) => commit.oid)
/** Six commits read as two pages of three, more to come. */
const loaded = (): GraphPages => ({ commits: ['a5', 'a4', 'a3', 'a2', 'a1', 'a0'].map(c), read: 6, more: true })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('commit graph pages', () => {
  it('makes a new query\'s first page the whole list', () => {
    const next = mergePage(loaded(), 'reset', page(['b2', 'b1'], false))
    expect(next).toEqual({ commits: [c('b2'), c('b1')], read: 2, more: false })
  })

  it('appends the next page, keeping a commit that repeats across pages once', () => {
    const first = mergePage(NO_PAGES, 'reset', page(['a5', 'a4', 'a3'], true))
    // A commit arrived between the pages: the second page starts with one already shown.
    const next = mergePage(first, 'append', page(['a3', 'a2', 'a1'], true))
    expect(oids(next)).toEqual(['a5', 'a4', 'a3', 'a2', 'a1'])
    // The skip counts what git returned, repeats included.
    expect(next.read).toBe(6)
    expect(next.more).toBe(true)
    const last = mergePage(next, 'append', page(['a1'], false))
    expect(last.commits).toBe(next.commits)
    expect(last).toMatchObject({ read: 7, more: false })
  })

  it('puts new commits on top when shown again, without losing the rows they push down', () => {
    // Two new commits push a4 and a3 past the fresh first page; the deeper rows go on from a5.
    const next = mergePage(loaded(), 'refresh', page(['n2', 'n1', 'a5'], true))
    expect(oids(next)).toEqual(['n2', 'n1', 'a5', 'a4', 'a3', 'a2', 'a1', 'a0'])
    expect(next).toMatchObject({ read: 8, more: true })
  })

  it('starts over from the fresh first page when a loaded row above where it ends was rewritten', () => {
    // a5 was amended into b5: where the deeper rows sit now is unknown, so they load again on scroll.
    expect(mergePage(loaded(), 'refresh', page(['b5', 'a4', 'a3'], true))).toEqual({ commits: [c('b5'), c('a4'), c('a3')], read: 3, more: true })
  })

  it('starts over from the fresh first page when loaded rows above where it ends were pushed below it', () => {
    // A commit on the side line moved that whole line to the top; main's rows now come after it.
    const before: GraphPages = { commits: ['m3', 'm2', 'm1', 's3', 's2', 's1', 'b'].map(c), read: 7, more: false }
    expect(mergePage(before, 'refresh', page(['s4', 's3', 's2'], true))).toEqual({ commits: [c('s4'), c('s3'), c('s2')], read: 3, more: true })
  })

  it('keeps a commit once when the fresh first page moved it up', () => {
    const next = mergePage(loaded(), 'refresh', page(['a2', 'a5', 'a4'], true))
    expect(oids(next)).toEqual(['a2', 'a5', 'a4', 'a3', 'a1', 'a0'])
  })

  it('starts over from the fresh first page when it no longer meets the loaded rows', () => {
    expect(mergePage(loaded(), 'refresh', page(['n3', 'n2', 'n1'], true))).toEqual({ commits: [c('n3'), c('n2'), c('n1')], read: 3, more: true })
    // A first page with nothing after it is the whole history.
    expect(mergePage(loaded(), 'refresh', page(['n1', 'a5'], false))).toEqual({ commits: [c('n1'), c('a5')], read: 2, more: false })
  })
})

describe('commit graph pages read from topo order at the real page size', () => {
  const PAGE = GIT_LIMITS.maxGraphCommits
  /** One page of `git log --topo-order` as the main process reads it. */
  const logPage = (history: readonly string[], skip: number): GitCommitGraph => {
    const commits = history.slice(skip, skip + PAGE).map(c)
    return { commits, more: commits.length === PAGE }
  }
  const readToEnd = (pages: GraphPages, history: readonly string[]): GraphPages => {
    let next = pages
    for (let i = 0; i < 100 && next.more; i++) next = mergePage(next, 'append', logPage(history, next.read))
    return next
  }
  /** A branch line, newest commit first. */
  const line = (name: string, length: number) => Array.from({ length }, (_, i) => `${name}${length - i}`)

  // Topo order shows one branch line at a time, the newest tip's first. A commit
  // on the other line moves that whole line, longer than a page, to the top.
  const LINE = PAGE + 20
  const before = [...line('main', LINE), ...line('side', LINE), 'base']
  const after = ['side-new', ...line('side', LINE), ...line('main', LINE), 'base']

  it('keeps the rows read so far when new commits land on the newest line', () => {
    const loaded = readToEnd(mergePage(NO_PAGES, 'reset', logPage(before, 0)), before)
    const withNew = ['main-new2', 'main-new1', ...before]
    const shownAgain = mergePage(loaded, 'refresh', logPage(withNew, 0))
    expect(oids(shownAgain)).toEqual(withNew)
    expect(shownAgain).toMatchObject({ read: withNew.length, more: false })
  })

  it('reads every commit again when a branch line moved to the top', () => {
    const loaded = readToEnd(mergePage(NO_PAGES, 'reset', logPage(before, 0)), before)
    expect(oids(loaded)).toEqual(before)
    const shownAgain = mergePage(loaded, 'refresh', logPage(after, 0))
    expect(oids(shownAgain)).toEqual(after.slice(0, PAGE))
    expect(shownAgain).toMatchObject({ read: PAGE, more: true })
    expect(oids(readToEnd(shownAgain, after))).toEqual(after)
  })

  it('reads every commit again after that move, however deep the list was read', () => {
    const deep = line('deep', 400)
    const longBefore = [...before, ...deep]
    const longAfter = [...after, ...deep]
    let loaded = mergePage(NO_PAGES, 'reset', logPage(longBefore, 0))
    for (let i = 1; i < 3; i++) loaded = mergePage(loaded, 'append', logPage(longBefore, loaded.read))
    expect(loaded).toMatchObject({ read: 3 * PAGE, more: true })
    const shownAgain = mergePage(loaded, 'refresh', logPage(longAfter, 0))
    expect(oids(readToEnd(shownAgain, longAfter))).toEqual(longAfter)
  })
})

describe('what a settled load leaves on screen', () => {
  const failure = new Error('git log failed')
  const shown = (): GraphView => ({ pages: loaded(), failure: null })

  it('keeps the list as it was when reading the first page again fails', () => {
    const view = shown()
    expect(settleLoad(view, 'refresh', { error: failure })).toBe(view)
  })

  it('keeps the list and ends it with the failure when the next page fails', () => {
    expect(settleLoad(shown(), 'append', { error: failure })).toEqual({ pages: loaded(), failure: { mode: 'append', error: failure } })
  })

  it('shows a new query\'s failed first page in place of the list', () => {
    expect(settleLoad(EMPTY_VIEW, 'reset', { error: failure })).toEqual({ pages: NO_PAGES, failure: { mode: 'reset', error: failure } })
  })

  it('clears a failure once a load succeeds', () => {
    const failed = settleLoad(shown(), 'append', { error: failure })
    expect(settleLoad(failed, 'refresh', { page: page(['n1', 'a5', 'a4'], true) })).toMatchObject({ failure: null })
    // A failed first page, shown again: reading it again brings the list.
    const nothing = settleLoad(EMPTY_VIEW, 'reset', { error: failure })
    expect(settleLoad(nothing, 'refresh', { page: page(['a1'], false) })).toEqual({ pages: { commits: [c('a1')], read: 1, more: false }, failure: null })
  })
})

describe('commit graph loader', () => {
  function setup() {
    const calls: { mode: GraphLoadMode; done: ReturnType<typeof deferred<GitCommitGraph>> }[] = []
    let inFlight = 0
    let mostInFlight = 0
    const settle = vi.fn()
    const loader = new GraphLoader((mode) => {
      const done = deferred<GitCommitGraph>()
      calls.push({ mode, done })
      mostInFlight = Math.max(mostInFlight, ++inFlight)
      return done.promise.finally(() => { inFlight-- })
    }, settle)
    /** Lets the loader react to a finished fetch. */
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
    return { loader, calls, settle, flush, mostInFlight: () => mostInFlight }
  }

  it('runs one git log for a burst of scroll-driven appends', async () => {
    const { loader, calls, settle, flush } = setup()
    for (let i = 0; i < 50; i++) loader.load('append')
    expect(calls.map((call) => call.mode)).toEqual(['append'])
    expect(loader.busy).toBe(true)
    calls[0].done.resolve(page(['a'], true))
    await flush()
    expect(settle).toHaveBeenCalledWith('append', { page: page(['a'], true) })
    expect(loader.busy).toBe(false)
    expect(calls).toHaveLength(1)
  })

  it('lets a refresh wait behind an append, and starts it before the append settles', async () => {
    const { loader, calls, settle, flush, mostInFlight } = setup()
    loader.load('append')
    loader.load('refresh')
    loader.load('refresh')
    expect(calls).toHaveLength(1)
    // Whatever the settled append sets off finds the refresh already running.
    let busyWhenSettled: boolean | undefined
    settle.mockImplementationOnce(() => { busyWhenSettled = loader.busy })
    calls[0].done.resolve(page(['a'], true))
    await flush()
    expect(settle).toHaveBeenNthCalledWith(1, 'append', { page: page(['a'], true) })
    expect(busyWhenSettled).toBe(true)
    expect(calls.map((call) => call.mode)).toEqual(['append', 'refresh'])
    calls[1].done.resolve(page(['n'], true))
    await flush()
    expect(settle).toHaveBeenNthCalledWith(2, 'refresh', { page: page(['n'], true) })
    expect(mostInFlight()).toBe(1)
  })

  it('drops a refresh asked for while a reset runs', async () => {
    const { loader, calls, flush } = setup()
    loader.load('reset')
    loader.load('refresh')
    calls[0].done.resolve(page(['a'], false))
    await flush()
    expect(calls).toHaveLength(1)
  })

  it('runs a reset after the running load, dropping what that load returns', async () => {
    const { loader, calls, settle, flush, mostInFlight } = setup()
    loader.load('append')
    loader.load('reset')
    loader.load('reset')
    loader.load('refresh')
    calls[0].done.resolve(page(['old'], true))
    await flush()
    expect(settle).not.toHaveBeenCalled()
    expect(calls.map((call) => call.mode)).toEqual(['append', 'reset'])
    calls[1].done.resolve(page(['new'], false))
    await flush()
    expect(settle).toHaveBeenCalledOnce()
    expect(settle).toHaveBeenCalledWith('reset', { page: page(['new'], false) })
    expect(mostInFlight()).toBe(1)
  })

  it('settles a failed load as an error, then accepts loads again', async () => {
    const { loader, calls, settle, flush } = setup()
    loader.load('reset')
    const failure = new Error('git log failed')
    calls[0].done.reject(failure)
    await flush()
    expect(settle).toHaveBeenCalledWith('reset', { error: failure })
    loader.load('reset')
    expect(calls).toHaveLength(2)
  })

  it('settles and starts nothing once disposed', async () => {
    const { loader, calls, settle, flush } = setup()
    loader.load('append')
    loader.load('reset')
    loader.dispose()
    calls[0].done.resolve(page(['a'], true))
    await flush()
    loader.load('reset')
    expect(settle).not.toHaveBeenCalled()
    expect(calls).toHaveLength(1)
  })
})
