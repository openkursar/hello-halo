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
  GitRepositoryEntry,
  GitRepositoryList,
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
  repositories: GitRepositoryEntry[]
  /** Failed selected status reads; pruned whenever repository paths are removed. */
  unavailableRoots: ReadonlySet<string>
  repositoryBusy: boolean
  repoRoot: string | null
  status: GitWorkingTreeStatus | null
  list: GitChangeList | null
  /** The compare scope itself failed (snapshot pruned, branch gone); the rest of the view still works. */
  listError: GitFailure | null
  /** The selected repository or its path list could not be loaded. */
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

/** A selected root alone is not evidence that its diff has loaded. */
export function gitRevealReadiness(state: Pick<GitChangesState, 'phase' | 'refreshing' | 'repoRoot' | 'status' | 'list'>): 'pending' | 'ready' | 'unavailable' {
  if (state.refreshing || state.phase === 'loading') return 'pending'
  return state.phase === 'ready' && state.repoRoot !== null
    && state.status?.repo.root === state.repoRoot && state.list !== null
    ? 'ready' : 'unavailable'
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
  openRepository(root: string): Promise<GitFailure | null>
  setScope(scope: StoredCompareScope): Promise<void>
  resetWorkingDirectory(): Promise<void>
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

const MAX_VISIBLE_REPOSITORIES = 1_385
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
    unavailableRoots: new Set(),
    repositoryBusy: false,
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
  let directoryGeneration = 0
  let selectionVersion = 0
  let repositoriesDirty = true
  let repositoryGeneration = 0
  let repositoryRequest: { known: Promise<void>; shallow: Promise<void> } | null = null
  let discoveryError: GitFailure | null = null
  let lastLoadAt = 0
  let disposed = false
  let checkTimer: ReturnType<typeof setTimeout> | null = null
  let checking = false
  let checkAgain = false
  /** A check was skipped while the window was hidden. */
  let checkWhenShown = false
  let treeVersion = 0
  const discoveries = new Map<string, GitRepositoryEntry>()
  const stopDiscovery = gitClient.onRepositoryDiscovered(spaceId, (repository) => {
    if (disposed) return
    const previous = get().repositories.find((item) => item.root === repository.root)
    if (!previous && get().repositories.length >= MAX_VISIBLE_REPOSITORIES) {
      console.warn('[ChangesView] Discovered repository omitted: repository list limit reached')
      return
    }
    discoveries.set(repository.root, repository)
    if (discoveries.size > 64) discoveries.delete(discoveries.keys().next().value!)
    if (previous?.remembered === repository.remembered) return
    set((state) => ({ repositories: previous
      ? state.repositories.map((item) => item.root === repository.root ? repository : item)
      : [...state.repositories, repository] }))
  })

  function publishRepositories(found: GitRepositoryList, replace: boolean): void {
    const current = get()
    const merged = new Map<string, GitRepositoryEntry>()
    for (const repository of replace ? [] : current.repositories) merged.set(repository.root, repository)
    for (const repository of found.repositories) merged.set(repository.root, repository)
    for (const repository of discoveries.values()) merged.set(repository.root, repository)
    if (merged.size > MAX_VISIBLE_REPOSITORIES) console.warn('[ChangesView] Repository paths omitted: repository list limit reached', { spaceId })
    const repositories = [...merged.values()].slice(0, MAX_VISIBLE_REPOSITORIES)
    const roots = new Set(repositories.map((repository) => repository.root))
    set({
      git: found.git,
      repositories,
      unavailableRoots: new Set([...current.unavailableRoots].filter((root) => roots.has(root))),
    })
  }

  function listRepositories(): { known: Promise<void>; shallow: Promise<void> } {
    if (!repositoriesDirty && repositoryRequest) return repositoryRequest
    repositoriesDirty = false
    discoveryError = null
    discoveries.clear()
    const mine = ++repositoryGeneration
    const known = gitClient.listRepositories(spaceId, { shallow: false }).then((found) => {
      if (!disposed && mine === repositoryGeneration) publishRepositories(found, true)
    }, (error: unknown) => {
      if (!disposed && mine === repositoryGeneration) repositoriesDirty = true
      throw error
    })
    const shallow = known.then(async () => {
      if (disposed || mine !== repositoryGeneration || !get().git?.available) return
      try {
        const found = await gitClient.listRepositories(spaceId, { shallow: true })
        if (!disposed && mine === repositoryGeneration) publishRepositories(found, false)
      } catch (error) {
        if (disposed || mine !== repositoryGeneration) return
        discoveryError = failureOf(error)
        console.warn('[ChangesView] Shallow repository discovery could not complete:', { spaceId, ...discoveryError })
      }
    }, () => {})
    repositoryRequest = { known, shallow }
    return repositoryRequest
  }

  const latestReview = async (root: string): Promise<GitReviewRecord | null> => {
    try {
      return await gitClient.latestReview(spaceId, root)
    } catch (error) {
      // The review record only enables "since last review" and the review card.
      console.warn('[ChangesView] Could not read the latest review:', failureOf(error))
      return null
    }
  }

  const loadList = async (root: string, review: GitReviewRecord | null, mine: number) => {
    if (disposed || mine !== generation) return { list: null, listError: null }
    if (memory.scope.kind === 'since-review' && !review) memory.scope = { kind: 'uncommitted' }
    try {
      return { list: await gitClient.getChanges(spaceId, root, resolveScope(memory.scope, review)), listError: null }
    } catch (error) {
      return { list: null, listError: failureOf(error) }
    }
  }

  async function load(options: { relist?: boolean } = {}): Promise<void> {
    if (disposed || mutationBusy()) return
    if (options.relist) repositoriesDirty = true
    const mine = ++generation
    let loadingRoot: string | null = null
    lastLoadAt = Date.now()
    set({ refreshing: true })
    try {
      if (repositoriesDirty || !get().git || !get().repoRoot) {
        const request = listRepositories()
        await request.known
        if (mine !== generation || disposed) return
        const wanted = memory.repoRoot ?? initialRepoRoot
        if (get().git?.available && (get().repositories.length === 0 || (wanted && !get().repositories.some((repository) => repository.root === wanted)))) {
          await request.shallow
        }
      }
      if (mine !== generation || disposed) return
      const { git, repositories } = get()
      if (!git) return
      if (!git.available) {
        cache.clear()
        set({ phase: 'no-git', repoRoot: null, status: null, list: null, review: null, listError: null, refreshing: false, loadError: null, newChanges: 0 })
        return
      }
      if (repositories.length === 0) {
        memory.repoRoot = undefined
        memory.detail = null
        memory.forced = []
        if (memory.scope.kind === 'commit') memory.scope = { kind: 'uncommitted' }
        cache.clear()
        set({ phase: discoveryError ? 'error' : 'no-repo', repoRoot: null, status: null, list: null, review: null, listError: null, newChanges: 0, refreshing: false, loadError: discoveryError })
        return
      }
      const wanted = memory.repoRoot ?? initialRepoRoot
      const chosen = repositories.find((repo) => repo.root === wanted) ?? repositories[0]
      const root = chosen.root
      if (root !== get().repoRoot) prepareRepository(root)
      memory.repoRoot = root
      loadingRoot = root

      const reviewRequest = latestReview(root)
      const [status, review, { list, listError }] = await Promise.all([
        gitClient.getStatus(spaceId, root, chosen.remembered ? undefined : true).then((status) => {
          if (!disposed && mine === generation && status.remembered) {
            const repository = { ...chosen, remembered: true }
            discoveries.set(root, repository)
            if (discoveries.size > 64) discoveries.delete(discoveries.keys().next().value!)
            set((state) => ({ repositories: state.repositories.map((entry) => entry.root === root ? repository : entry) }))
          }
          if (!disposed && mine === generation && get().unavailableRoots.has(root)) {
            const unavailableRoots = new Set(get().unavailableRoots)
            unavailableRoots.delete(root)
            set({ unavailableRoots })
          }
          return status
        }),
        reviewRequest,
        memory.scope.kind === 'since-review'
          ? reviewRequest.then((found) => loadList(root, found, mine))
          : loadList(root, null, mine),
      ])
      if (mine !== generation || disposed) return
      cache.clear()
      set((state) => ({
        phase: 'ready',
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
      generation++
      const failure = failureOf(error)
      console.warn('[ChangesView] Repository could not be loaded:', { spaceId, root: loadingRoot, reason: failure.code ?? failure.error?.split('\n', 1)[0] })
      cache.clear()
      set((state) => {
        const unavailableRoots = new Set(state.unavailableRoots)
        if (loadingRoot && state.repositories.some((repository) => repository.root === loadingRoot)) unavailableRoots.add(loadingRoot)
        return {
          phase: 'error',
          status: null,
          list: null,
          review: null,
          listError: null,
          loadError: failure,
          unavailableRoots,
          newChanges: 0,
          refreshing: false,
        }
      })
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

  function mutationBusy(): boolean {
    return get().operation !== null || get().busyPaths.size > 0
  }

  function prepareRepository(root: string): void {
    const previous = memory.repoRoot ?? get().repoRoot
    memory.repoRoot = root
    if (previous && previous !== root) {
      memory.detail = null
      memory.forced = []
      // A commit picked in the old repository's graph is not one of the new repository's.
      if (memory.scope.kind === 'commit') memory.scope = { kind: 'uncommitted' }
    }
    cache.clear()
    set({ repoRoot: root, list: null, status: null, review: null, listError: null, loadError: null, newChanges: 0, refreshing: true })
  }

  async function selectRepository(root: string): Promise<void> {
    if (disposed || mutationBusy() || !get().repositories.some((repository) => repository.root === root)) return
    selectionVersion++
    if (root === get().repoRoot && !get().unavailableRoots.has(root)) return
    prepareRepository(root)
    await load()
  }

  async function openRepository(root: string): Promise<GitFailure | null> {
    if (disposed || mutationBusy() || get().repositoryBusy) return { code: 'GIT_BUSY' }
    const selectedAtStart = selectionVersion
    const directoryAtStart = directoryGeneration
    set({ repositoryBusy: true })
    try {
      const repository = await gitClient.openRepository(spaceId, root)
      if (disposed || directoryAtStart !== directoryGeneration) return null
      generation++
      repositoryGeneration++
      repositoryRequest = null
      repositoriesDirty = true
      const entry: GitRepositoryEntry = { root: repository.root, name: repository.name, relativePath: repository.relativePath, remembered: true }
      set((state) => ({ repositories: state.repositories.some((item) => item.root === entry.root)
        ? state.repositories.map((item) => item.root === entry.root ? entry : item)
        : [...state.repositories, entry] }))
      if (selectedAtStart === selectionVersion) prepareRepository(repository.root)
      await load({ relist: true })
      return disposed ? null : get().loadError
    } catch (error) {
      const failure = failureOf(error)
      console.warn('[ChangesView] Could not open remembered repository:', { spaceId, root, code: failure.code })
      return failure
    } finally {
      if (!disposed && directoryAtStart === directoryGeneration) set({ repositoryBusy: false })
    }
  }

  async function setScope(scope: StoredCompareScope): Promise<void> {
    memory.scope = scope
    memory.detail = null
    // A commit picked in the graph opens the changes page at once: the list left there
    // must not pass for the commit's while the commit's loads.
    if (scope.kind === 'commit') set({ list: null, listError: null })
    await load()
  }

  async function resetWorkingDirectory(): Promise<void> {
    if (disposed) return
    directoryGeneration++
    generation++
    repositoryGeneration++
    selectionVersion++
    repositoryRequest = null
    repositoriesDirty = true
    discoveries.clear()
    gitClient.invalidateDiscovery(spaceId)
    memory.repoRoot = undefined
    memory.detail = null
    memory.forced = []
    memory.scope = { kind: 'uncommitted' }
    initialRepoRoot = undefined
    cache.clear()
    set({ phase: 'loading', git: null, repositories: [], unavailableRoots: new Set(), repositoryBusy: false, repoRoot: null, status: null, list: null, review: null, listError: null, loadError: null, newChanges: 0, refreshing: true })
    await load({ relist: true })
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
    if (disposed || get().repositoryBusy || get().refreshing) return { code: 'GIT_BUSY' }
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
    if (disposed || get().repositoryBusy || get().refreshing) return { failure: { code: 'GIT_BUSY' } }
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
    if (disposed || get().repositoryBusy || get().refreshing) return { failure: { code: 'GIT_BUSY' } }
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
    openRepository,
    setScope,
    resetWorkingDirectory,
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
      stopDiscovery()
      discoveries.clear()
      generation++
      repositoryGeneration++
      repositoryRequest = null
      if (checkTimer) clearTimeout(checkTimer)
      cache.clear()
    },
  }
}
