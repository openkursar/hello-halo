/**
 * Data of one mounted Git changes view: the space's repositories, the chosen
 * repository's working-tree status, the change list for the compare scope,
 * its latest review, and file contents on demand.
 *
 * Loads happen when the view mounts (the tab was opened or shown again), when
 * the window regains focus, after the user's own operations, and on Refresh —
 * never on a timer. File events only feed the "new changes" hint, from a
 * debounced status read that waits while the window is hidden, and the count
 * the review card checks before it counts again; they never redraw what the
 * user is looking at. File contents are read a few at a time, newest request first.
 */

import { createStore, type StoreApi } from 'zustand/vanilla'
import type {
  GitAvailability,
  GitChangeList,
  GitCommitRequest,
  GitCommitResult,
  GitFileContents,
  GitRepository,
  GitReviewRecord,
  GitSyncResult,
  GitWorkingTreeStatus,
} from '../../../../../../shared/types/git'
import { ContentCache } from './content-cache'
import { failureOf, gitClient } from './git-client'
import type { GitFailure } from './git-errors'
import { abortError, RequestQueue } from './request-queue'
import { relativeTo } from '../model/paths'
import { resolveScope } from '../model/scope'
import { countChangedFiles } from './status-diff'
import type { ViewFile } from '../model/view-files'
import type { ChangesViewMemory, StoredCompareScope } from '../../../../../types/changes-view'

export type GitPhase = 'loading' | 'ready' | 'no-git' | 'no-repo' | 'error'

export interface GitChangesState {
  phase: GitPhase
  git: GitAvailability | null
  repositories: GitRepository[]
  repoRoot: string | null
  status: GitWorkingTreeStatus | null
  list: GitChangeList | null
  /** The compare scope itself failed (snapshot pruned, branch gone); the rest of the view still works. */
  listError: GitFailure | null
  /** The last load failed; data from an earlier load may still be shown. */
  loadError: GitFailure | null
  review: GitReviewRecord | null
  refreshing: boolean
  /** Bumped by every load: file contents may have changed, cards read theirs again. */
  version: number
  /** Files that changed on disk since the list loaded; 0 hides the hint. */
  newChanges: number
  /**
   * Bumped when the user refreshes or discards: the moments worth counting the
   * files changed since the latest review again (each count snapshots the
   * whole working tree), unlike focus returns and file events.
   */
  recount: number
  /** Paths with a stage / unstage / discard in flight. */
  busyPaths: ReadonlySet<string>
  operation: 'commit' | 'push' | 'sync' | null
}

export type FileContentsValue = GitFileContents & { size: number }

export interface GitChangesController {
  store: StoreApi<GitChangesState>
  load(options?: { relist?: boolean }): Promise<void>
  /** A load the user asked for (Refresh). */
  refresh(options?: { relist?: boolean }): Promise<void>
  /** A load for a focus or tab return: skipped right after another one. */
  refreshIfStale(): void
  selectRepository(root: string): Promise<void>
  setScope(scope: StoredCompareScope): Promise<void>
  setReview(review: GitReviewRecord | null): void
  stage(paths: string[]): Promise<GitFailure | null>
  unstage(paths: string[]): Promise<GitFailure | null>
  discard(paths: string[]): Promise<GitFailure | null>
  commit(request: GitCommitRequest): Promise<{ result: GitCommitResult } | { failure: GitFailure }>
  sync(): Promise<{ result: GitSyncResult } | { failure: GitFailure }>
  /** Both sides of a file of the list; a read still waiting when `signal` aborts is dropped. */
  contents(file: ViewFile, signal?: AbortSignal): Promise<FileContentsValue>
  /** Absolute paths that changed on disk, or null when everything may have. */
  noteFileChanges(paths: readonly string[] | null): void
  /** Grows with every file change noted in the repository; no git is run for it. */
  treeVersion(): number
  dismissNewChanges(): void
  dispose(): void
}

const NEW_CHANGES_DEBOUNCE_MS = 1_000
const STALE_AFTER_MS = 2_000
/** File content reads in flight at once: as many as the main process runs at a time (each costs two git processes). */
const CONTENT_READS_IN_FLIGHT = 3
/** A read the main process turned away as busy (it ran nothing) is asked again once, after this. */
const BUSY_RETRY_MS = 1_000

/** Waits `ms`, or rejects as soon as `signal` aborts. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(abortError())
    }, { once: true })
  })
}

function isInsideGitDir(relative: string): boolean {
  return relative === '.git' || relative.startsWith('.git/') || relative.includes('/.git/')
}

function windowHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

export function createGitChangesController(
  spaceId: string,
  memory: ChangesViewMemory,
  initialRepoRoot: string | undefined
): GitChangesController {
  const store = createStore<GitChangesState>(() => ({
    phase: 'loading',
    git: null,
    repositories: [],
    repoRoot: null,
    status: null,
    list: null,
    listError: null,
    loadError: null,
    review: null,
    refreshing: false,
    version: 0,
    newChanges: 0,
    recount: 0,
    busyPaths: new Set(),
    operation: null,
  }))
  const { getState: get, setState: set } = store
  const cache = new ContentCache<FileContentsValue>()
  const reads = new RequestQueue(CONTENT_READS_IN_FLIGHT)

  let generation = 0
  let lastLoadAt = 0
  let disposed = false
  let checkTimer: ReturnType<typeof setTimeout> | null = null
  let checking = false
  let checkAgain = false
  /** A check was skipped while the window was hidden. */
  let checkWhenShown = false
  let treeVersion = 0

  const latestReview = async (root: string): Promise<GitReviewRecord | null> => {
    try {
      return await gitClient.latestReview(spaceId, root)
    } catch (error) {
      // The review record only enables "since last review" and the review card.
      console.warn('[ChangesView] Could not read the latest review:', failureOf(error))
      return null
    }
  }

  const loadList = async (root: string, review: GitReviewRecord | null) => {
    if (memory.scope.kind === 'since-review' && !review) memory.scope = { kind: 'uncommitted' }
    try {
      return { list: await gitClient.getChanges(spaceId, root, resolveScope(memory.scope, review)), listError: null }
    } catch (error) {
      return { list: null, listError: failureOf(error) }
    }
  }

  async function load(options: { relist?: boolean } = {}): Promise<void> {
    const mine = ++generation
    lastLoadAt = Date.now()
    set({ refreshing: true })
    try {
      let { git, repositories } = get()
      if (options.relist || !git) {
        const found = await gitClient.listRepositories(spaceId)
        if (mine !== generation) return
        git = found.git
        repositories = found.repositories
      }
      if (!git.available) {
        set({ phase: 'no-git', git, repositories: [], repoRoot: null, status: null, list: null, refreshing: false, loadError: null })
        return
      }
      if (repositories.length === 0) {
        set({ phase: 'no-repo', git, repositories, repoRoot: null, status: null, list: null, refreshing: false, loadError: null })
        return
      }
      const wanted = memory.repoRoot ?? initialRepoRoot
      const root = repositories.find((repo) => repo.root === wanted)?.root ?? repositories[0].root
      memory.repoRoot = root

      const reviewRequest = latestReview(root)
      const [status, review, { list, listError }] = await Promise.all([
        gitClient.getStatus(spaceId, root),
        reviewRequest,
        memory.scope.kind === 'since-review'
          ? reviewRequest.then((found) => loadList(root, found))
          : loadList(root, null),
      ])
      if (mine !== generation || disposed) return
      cache.clear()
      set((state) => ({
        phase: 'ready',
        git,
        repositories,
        repoRoot: root,
        status,
        review,
        list,
        listError,
        loadError: null,
        refreshing: false,
        version: state.version + 1,
        newChanges: 0,
      }))
    } catch (error) {
      if (mine !== generation || disposed) return
      const failure = failureOf(error)
      if (failure.code === 'GIT_NOT_A_REPOSITORY' && !options.relist) {
        memory.repoRoot = undefined
        return load({ relist: true })
      }
      if (failure.code === 'GIT_UNAVAILABLE') {
        set({ phase: 'no-git', git: { available: false, reason: 'not-runnable', detail: failure.error }, refreshing: false })
        return
      }
      set((state) => ({ phase: state.phase === 'ready' ? 'ready' : 'error', loadError: failure, refreshing: false }))
    }
  }

  function refreshIfStale(): void {
    if (disposed || get().refreshing) return
    if (Date.now() - lastLoadAt >= STALE_AFTER_MS) {
      // The load answers whatever a check skipped while the window was hidden would have.
      checkWhenShown = false
      void load()
      return
    }
    if (checkWhenShown) {
      checkWhenShown = false
      scheduleCheck()
    }
  }

  async function refresh(options: { relist?: boolean } = {}): Promise<void> {
    set((state) => ({ recount: state.recount + 1 }))
    await load(options)
  }

  async function selectRepository(root: string): Promise<void> {
    if (root === get().repoRoot) return
    memory.repoRoot = root
    memory.detail = null
    // A named revision or a graph-picked commit belongs to the old repository; it cannot be resolved in the new one.
    if (memory.scope.kind === 'revision' || memory.scope.kind === 'commit') memory.scope = { kind: 'uncommitted' }
    set({ list: null, status: null, review: null, listError: null })
    await load()
  }

  async function setScope(scope: StoredCompareScope): Promise<void> {
    memory.scope = scope
    memory.detail = null
    // The old list belongs to the old scope: drop it rather than show it under the new label.
    set({ list: null, listError: null })
    await load()
  }

  function setReview(review: GitReviewRecord | null): void {
    set({ review })
  }

  function setBusy(paths: string[], busy: boolean): void {
    set((state) => {
      const next = new Set(state.busyPaths)
      for (const path of paths) {
        if (busy) next.add(path)
        else next.delete(path)
      }
      return { busyPaths: next }
    })
  }

  async function onPaths(run: (root: string) => Promise<void>, paths: string[], changesWorkingTree = false): Promise<GitFailure | null> {
    const root = get().repoRoot
    if (!root) return null
    setBusy(paths, true)
    try {
      await run(root)
      // Staging leaves the files as they are; discarding changes them.
      if (changesWorkingTree) set((state) => ({ recount: state.recount + 1 }))
      return null
    } catch (error) {
      return failureOf(error)
    } finally {
      setBusy(paths, false)
      void load()
    }
  }

  async function commit(request: GitCommitRequest): Promise<{ result: GitCommitResult } | { failure: GitFailure }> {
    const root = get().repoRoot
    if (!root) return { failure: { code: 'GIT_NOT_A_REPOSITORY' } }
    set({ operation: request.push ? 'push' : 'commit' })
    try {
      return { result: await gitClient.commit(spaceId, root, request) }
    } catch (error) {
      return { failure: failureOf(error) }
    } finally {
      set({ operation: null })
      void load()
    }
  }

  async function sync(): Promise<{ result: GitSyncResult } | { failure: GitFailure }> {
    const root = get().repoRoot
    if (!root) return { failure: { code: 'GIT_NOT_A_REPOSITORY' } }
    set({ operation: 'sync' })
    try {
      const result = await gitClient.sync(spaceId, root)
      set((state) => ({ status: state.status ? { ...state.status, repo: result.repo } : state.status }))
      return { result }
    } catch (error) {
      return { failure: failureOf(error) }
    } finally {
      set({ operation: null })
      void load()
    }
  }

  function contents(file: ViewFile, signal?: AbortSignal): Promise<FileContentsValue> {
    const { list, repoRoot, version } = get()
    if (!list || !repoRoot) return Promise.reject(new Error('No change list loaded'))
    const read = () => reads.run(async () => {
      const value = await gitClient.getFileContents(spaceId, repoRoot, {
        scope: list.scope,
        beforeRevision: list.beforeRevision,
        path: file.path,
        oldPath: file.oldPath,
      })
      return { ...value, size: (value.before?.length ?? 0) + (value.after?.length ?? 0) }
    }, signal)
    return cache.get(`${version}|${file.path}|${file.oldPath ?? ''}`, () => read().catch(async (error: unknown) => {
      if (failureOf(error).code !== 'GIT_BUSY') throw error
      await pause(BUSY_RETRY_MS, signal)
      return read()
    }))
  }

  async function checkForNewChanges(): Promise<void> {
    // Nobody sees the hint while the window is hidden: coming back reloads, or checks then.
    if (windowHidden()) {
      checkWhenShown = true
      return
    }
    if (checking) {
      checkAgain = true
      return
    }
    const { status: loaded, repoRoot, phase } = get()
    if (!loaded || !repoRoot || phase !== 'ready') return
    checking = true
    const mine = generation
    try {
      const now = await gitClient.getStatus(spaceId, repoRoot)
      if (mine !== generation || disposed) return
      set({ newChanges: countChangedFiles(loaded, now) })
    } catch (error) {
      // Only the hint is lost; the next event or refresh tries again.
      console.warn('[ChangesView] Status check for new changes failed:', failureOf(error))
    } finally {
      checking = false
      if (checkAgain && !disposed) {
        checkAgain = false
        scheduleCheck()
      }
    }
  }

  function scheduleCheck(): void {
    if (checkTimer) clearTimeout(checkTimer)
    checkTimer = setTimeout(() => {
      checkTimer = null
      void checkForNewChanges()
    }, NEW_CHANGES_DEBOUNCE_MS)
  }

  function noteFileChanges(paths: readonly string[] | null): void {
    const { repoRoot, phase } = get()
    if (disposed || phase !== 'ready' || !repoRoot) return
    if (paths) {
      const relevant = paths.some((path) => {
        const relative = relativeTo(repoRoot, path)
        return relative !== null && relative !== '' && !isInsideGitDir(relative)
      })
      if (!relevant) return
    }
    treeVersion += 1
    scheduleCheck()
  }

  return {
    store,
    load,
    refresh,
    refreshIfStale,
    selectRepository,
    setScope,
    setReview,
    stage: (paths) => onPaths((root) => gitClient.stage(spaceId, root, paths), paths),
    unstage: (paths) => onPaths((root) => gitClient.unstage(spaceId, root, paths), paths),
    discard: (paths) => onPaths((root) => gitClient.discard(spaceId, root, paths), paths, true),
    commit,
    sync,
    contents,
    noteFileChanges,
    treeVersion: () => treeVersion,
    dismissNewChanges: () => set({ newChanges: 0 }),
    dispose: () => {
      disposed = true
      generation++
      if (checkTimer) clearTimeout(checkTimer)
      cache.clear()
    },
  }
}
