/**
 * File Watcher -- runs inside file-watcher utility process.
 *
 * Responsibilities:
 * - @parcel/watcher subscription management
 * - Event filtering (.gitignore, hidden patterns)
 * - Event coalescing (last-write-wins per path within throttle window)
 * - fs.stat for determining file/folder type (bounded concurrency)
 * - Throttled, chunked event emission to main process
 *
 * HARD CONSTRAINT: This file MUST NOT import anything from 'electron'.
 */

import parcelWatcher from '@parcel/watcher'
import type { AsyncSubscription, Event as ParcelEvent } from '@parcel/watcher'
import { promises as fs } from 'fs'
import { join, relative, sep } from 'path'
import type { Ignore } from 'ignore'
import { CPP_LEVEL_IGNORE_DIRS } from '../../shared/constants/ignore-patterns'
import { isDiskRoot } from '../../shared/disk-paths'
import type { ProcessedFsEvent } from '../../shared/protocol/file-watcher.protocol'
import {
  loadIgnoreRules,
  isIgnored,
  shouldHide,
  createArtifactFromPath,
  createTreeNodeFromArtifact
} from './scanner'
import { createConcurrencyLimiter } from './limiter'
import { PathIndex, type PathQueryResult } from './path-index'

interface SpaceWatcher {
  spaceId: string
  /** Root as the space knows it; every path leaving this module is under it. */
  rootPath: string
  /** Canonical root; the OS reports event paths under this one. */
  realRoot: string
  subscription: AsyncSubscription | null
  ignoreFilter: Ignore
  /** Built on the first file query, dropped after PATH_INDEX_IDLE_MS without one. */
  index: PathIndex | null
  lastQueryAt: number
}

const watchers = new Map<string, SpaceWatcher>()
const startingWatchers = new Map<string, Promise<void>>()

/**
 * A path index is only worth its memory (~370 bytes per path) while someone
 * searches the space: spaces watched only for automation triggers never build
 * one, and an index nobody queried for this long is dropped.
 */
export const PATH_INDEX_IDLE_MS = 10 * 60_000
const INDEX_SWEEP_INTERVAL_MS = 60_000
let indexSweepTimer: ReturnType<typeof setInterval> | null = null

function sweepIdleIndexes(): void {
  const now = Date.now()
  let live = 0
  for (const sw of watchers.values()) {
    if (!sw.index) continue
    if (now - sw.lastQueryAt >= PATH_INDEX_IDLE_MS) {
      sw.index.dispose()
      sw.index = null
    } else {
      live++
    }
  }
  if (live === 0 && indexSweepTimer) {
    clearInterval(indexSweepTimer)
    indexSweepTimer = null
  }
}

// --- Limits ---

/** Largest `fs-events` message; bigger flushes are split. */
export const MAX_EVENTS_PER_MESSAGE = 500
/** Past this many pending events a space is resynced by rescan instead of by events. */
export const MAX_PENDING_EVENTS_PER_SPACE = 20_000
export const MAX_CONCURRENT_STATS = 32

const statLimiter = createConcurrencyLimiter(MAX_CONCURRENT_STATS)

// --- Event Coalescing ---

// Pending events per space, keyed by path. Last-write-wins within throttle window.
const pendingEvents = new Map<string, Map<string, ProcessedFsEvent>>()

/**
 * A space whose burst overflowed in the current window. Its events are still
 * collected — without stat — so subscribers that act per path (automation file
 * triggers) lose nothing; only derived state (tree, caches) resyncs by rescan.
 */
interface OverflowWindow {
  events: Map<string, ProcessedFsEvent>
  /** Events past MAX_OVERFLOW_EVENTS_PER_SPACE, counted but not kept. */
  dropped: number
}
const overflowedSpaces = new Map<string, OverflowWindow>()
let throttleTimer: ReturnType<typeof setTimeout> | null = null
let maxWaitTimer: ReturnType<typeof setTimeout> | null = null
const THROTTLE_MS = 300
const MAX_WAIT_MS = THROTTLE_MS * 5 // 1500ms max wait to prevent starvation

/** Memory ceiling for one overflow window; beyond it events are only counted. */
export const MAX_OVERFLOW_EVENTS_PER_SPACE = 200_000

/**
 * `resolved` is false for events delivered from an overflow window: type comes
 * from the OS event alone (a created directory reads as 'add') and they carry
 * no artifact / tree node.
 */
type EventsCallback = (spaceId: string, events: ProcessedFsEvent[], resolved: boolean) => void

let onEventsCallback: EventsCallback | null = null
let onOverflowCallback: ((spaceId: string, overflowedEvents: number, droppedEvents: number) => void) | null = null
let onErrorCallback: ((spaceId: string, error: string) => void) | null = null

export function setOnEventsCallback(cb: EventsCallback): void {
  onEventsCallback = cb
}

export function setOnOverflowCallback(cb: (spaceId: string, overflowedEvents: number, droppedEvents: number) => void): void {
  onOverflowCallback = cb
}

export function setOnErrorCallback(cb: (spaceId: string, error: string) => void): void {
  onErrorCallback = cb
}

function emitChunked(spaceId: string, events: ProcessedFsEvent[], resolved: boolean): void {
  for (let i = 0; i < events.length; i += MAX_EVENTS_PER_MESSAGE) {
    onEventsCallback?.(spaceId, events.slice(i, i + MAX_EVENTS_PER_MESSAGE), resolved)
  }
}

function flushEvents(): void {
  if (throttleTimer) { clearTimeout(throttleTimer); throttleTimer = null }
  if (maxWaitTimer) { clearTimeout(maxWaitTimer); maxWaitTimer = null }

  for (const [spaceId, window] of overflowedSpaces) {
    onOverflowCallback?.(spaceId, window.events.size + window.dropped, window.dropped)
    emitChunked(spaceId, Array.from(window.events.values()), false)
  }
  overflowedSpaces.clear()

  for (const [spaceId, eventsMap] of pendingEvents) {
    emitChunked(spaceId, Array.from(eventsMap.values()), true)
  }
  pendingEvents.clear()
}

function scheduleFlush(): void {
  if (throttleTimer) clearTimeout(throttleTimer)
  // Max-wait cap: prevents starvation under sustained activity
  if (!maxWaitTimer) {
    maxWaitTimer = setTimeout(flushEvents, MAX_WAIT_MS)
  }
  throttleTimer = setTimeout(flushEvents, THROTTLE_MS)
}

function overflowWindow(spaceId: string): OverflowWindow {
  let window = overflowedSpaces.get(spaceId)
  if (!window) {
    window = { events: new Map(), dropped: 0 }
    const pending = pendingEvents.get(spaceId)
    if (pending) {
      for (const [path, event] of pending) window.events.set(path, event)
      pendingEvents.delete(spaceId)
    }
    overflowedSpaces.set(spaceId, window)
  }
  return window
}

function queueOverflowEvent(spaceId: string, event: ProcessedFsEvent): void {
  const window = overflowWindow(spaceId)
  if (window.events.has(event.filePath) || window.events.size < MAX_OVERFLOW_EVENTS_PER_SPACE) {
    window.events.set(event.filePath, event)
  } else {
    window.dropped++
  }
  scheduleFlush()
}

function queueEvent(spaceId: string, event: ProcessedFsEvent): void {
  if (overflowedSpaces.has(spaceId)) {
    queueOverflowEvent(spaceId, event)
    return
  }
  let events = pendingEvents.get(spaceId)
  if (!events) {
    events = new Map()
    pendingEvents.set(spaceId, events)
  }
  events.set(event.filePath, event)
  if (events.size > MAX_PENDING_EVENTS_PER_SPACE) overflowWindow(spaceId)
  scheduleFlush()
}

function unresolvedEvent(type: ParcelEvent['type'], filePath: string, relativePath: string): ProcessedFsEvent {
  return {
    changeType: type === 'create' ? 'add' : type === 'update' ? 'change' : 'unlink',
    filePath,
    relativePath,
    parentDir: getParentPath(filePath),
  }
}

// --- Event Processing ---

function getParentPath(filePath: string): string {
  const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return lastSep > 0 ? filePath.substring(0, lastSep) : filePath
}

function withTrailingSep(path: string): string {
  return path.endsWith(sep) ? path : path + sep
}

/**
 * Map an OS-reported path back under the space's own root.
 *
 * The OS reports canonical paths, so a root reached through a symlink
 * (`/tmp` on macOS, a project folder linked to another disk) yields event
 * paths outside `rootPath`. Returns null for a path under neither root.
 */
export function mapToWatchedRoot(eventPath: string, realRoot: string, rootPath: string): string | null {
  if (eventPath === rootPath || eventPath.startsWith(withTrailingSep(rootPath))) return eventPath
  if (realRoot === rootPath) return null
  if (eventPath === realRoot) return rootPath
  const realPrefix = withTrailingSep(realRoot)
  if (eventPath.startsWith(realPrefix)) {
    return withTrailingSep(rootPath) + eventPath.slice(realPrefix.length)
  }
  return null
}

async function resolveRealRoot(rootPath: string): Promise<string> {
  try {
    return await fs.realpath(rootPath)
  } catch {
    return rootPath
  }
}

interface AcceptedEvent {
  type: ParcelEvent['type']
  filePath: string
  relativePath: string
}

async function processParcelEvents(
  sw: SpaceWatcher,
  events: ParcelEvent[]
): Promise<void> {
  const accepted: AcceptedEvent[] = []
  for (const event of events) {
    const filePath = mapToWatchedRoot(event.path, sw.realRoot, sw.rootPath)
    if (filePath === null) continue
    const relativePath = relative(sw.rootPath, filePath)
    if (relativePath === '.gitignore') {
      sw.ignoreFilter = loadIgnoreRules(sw.rootPath)
      sw.index?.scheduleRebuild()
    }
    if (isIgnored(sw.ignoreFilter, relativePath)) continue
    if (shouldHide(filePath)) continue
    accepted.push({ type: event.type, filePath, relativePath })
  }

  if (accepted.length === 0) return
  if (overflowedSpaces.has(sw.spaceId) || accepted.length > MAX_PENDING_EVENTS_PER_SPACE) {
    sw.index?.scheduleRebuild()
    for (const { type, filePath, relativePath } of accepted) {
      queueOverflowEvent(sw.spaceId, unresolvedEvent(type, filePath, relativePath))
    }
    return
  }

  await Promise.all(accepted.map(async ({ type, filePath, relativePath }) => {
    const parentDir = getParentPath(filePath)

    if (type === 'delete') {
      sw.index?.remove(relativePath)
      queueEvent(sw.spaceId, {
        changeType: 'unlink', // Cannot determine file/dir here; main process resolves from cache
        filePath,
        relativePath,
        parentDir,
      })
      return
    }

    // A space that overflowed while this event waited is resynced by rescan; skip the stat.
    if (overflowedSpaces.has(sw.spaceId)) {
      sw.index?.scheduleRebuild()
      queueOverflowEvent(sw.spaceId, unresolvedEvent(type, filePath, relativePath))
      return
    }

    // create / update -> stat to determine file/folder
    const artifact = await statLimiter.run(() =>
      createArtifactFromPath(filePath, sw.rootPath, sw.spaceId, relativePath)
    )
    if (!artifact) return

    const isDir = artifact.type === 'folder'
    const changeType = type === 'create'
      ? (isDir ? 'addDir' : 'add')
      : 'change'
    if (type === 'create') sw.index?.add(relativePath, isDir)

    const depth = relativePath ? relativePath.split(/[\\/]/).length - 1 : 0
    const treeNode = createTreeNodeFromArtifact(artifact, depth)

    queueEvent(sw.spaceId, {
      changeType,
      filePath,
      relativePath,
      artifact,
      treeNode,
      parentDir,
    })
  }))
}

// --- Public API ---

export async function startWatcher(spaceId: string, rootPath: string): Promise<void> {
  if (watchers.has(spaceId)) return
  // A re-init racing the first subscribe must not create a second subscription.
  const inFlight = startingWatchers.get(spaceId)
  if (inFlight) return inFlight

  const starting = subscribeSpace(spaceId, rootPath).finally(() => {
    startingWatchers.delete(spaceId)
  })
  startingWatchers.set(spaceId, starting)
  return starting
}

async function subscribeSpace(spaceId: string, rootPath: string): Promise<void> {
  const realRoot = await resolveRealRoot(rootPath)
  if (isDiskRoot(rootPath) || isDiskRoot(realRoot)) {
    console.warn(`[Watcher] Disk root detected (${rootPath}), skipping`)
    return
  }

  const sw: SpaceWatcher = {
    spaceId,
    rootPath,
    realRoot,
    subscription: null,
    ignoreFilter: loadIgnoreRules(rootPath),
    index: null,
    lastQueryAt: 0,
  }

  try {
    const subscription = await parcelWatcher.subscribe(
      realRoot,
      async (err, events) => {
        if (watchers.get(spaceId) !== sw) return
        if (err) {
          console.error(`[Watcher] Error for ${spaceId}:`, err)
          // Notify host process about watcher failure so it can trigger reconciliation
          onErrorCallback?.(spaceId, String(err))
          return
        }
        try {
          await processParcelEvents(sw, events)
        } catch (error) {
          // The batch is lost; the host reconciles the space to recover it.
          const message = error instanceof Error ? error.message : String(error)
          console.error(`[Watcher] Dropped ${events.length} events for ${spaceId}: ${message}`)
          onErrorCallback?.(spaceId, `event processing failed: ${message}`)
        }
      },
      {
        ignore: CPP_LEVEL_IGNORE_DIRS.map(dir => join(realRoot, dir))
      }
    )

    sw.subscription = subscription
    watchers.set(spaceId, sw)
    console.log(
      `[Watcher] Active for space: ${spaceId}` + (realRoot !== rootPath ? ` (resolved root ${realRoot})` : '')
    )
  } catch (error) {
    console.error(`[Watcher] Failed to start for ${spaceId}:`, error)
    throw error
  }
}

export async function stopWatcher(spaceId: string): Promise<void> {
  const starting = startingWatchers.get(spaceId)
  if (starting) await starting.catch(() => undefined)

  const sw = watchers.get(spaceId)
  if (!sw) return

  watchers.delete(spaceId)
  pendingEvents.delete(spaceId)
  overflowedSpaces.delete(spaceId)
  sw.index?.dispose()
  sw.index = null

  if (sw.subscription) {
    try {
      await sw.subscription.unsubscribe()
    } catch (error) {
      console.error(`[Watcher] Error unsubscribing ${spaceId}:`, error)
    }
  }
  console.log(`[Watcher] Stopped for space: ${spaceId}`)
}

export function refreshIgnoreRules(spaceId: string, rootPath: string): void {
  const sw = watchers.get(spaceId)
  if (sw) {
    sw.ignoreFilter = loadIgnoreRules(rootPath)
    sw.index?.scheduleRebuild()
    console.log(`[Watcher] Reloaded ignore rules for ${spaceId}`)
  }
}

/**
 * Best matches for a file query in a watched space; the first query starts
 * building the space's index (results are partial while `indexing`). Null for
 * a space that is not watched.
 */
export function queryPaths(spaceId: string, query: string, limit: number, maxDepth?: number): (PathQueryResult & { rootPath: string }) | null {
  const sw = watchers.get(spaceId)
  if (!sw) return null
  sw.lastQueryAt = Date.now()
  if (!sw.index) {
    const owner = sw
    sw.index = new PathIndex(sw.rootPath, () => owner.ignoreFilter)
    void sw.index.rebuild()
    if (!indexSweepTimer) {
      indexSweepTimer = setInterval(sweepIdleIndexes, INDEX_SWEEP_INTERVAL_MS)
      indexSweepTimer.unref?.()
    }
  }
  return { ...sw.index.query(query, limit, maxDepth), rootPath: sw.rootPath }
}

/** Whether a space currently holds a path index (diagnostics). */
export function hasPathIndex(spaceId: string): boolean {
  return !!watchers.get(spaceId)?.index
}

export async function stopAll(): Promise<void> {
  if (indexSweepTimer) {
    clearInterval(indexSweepTimer)
    indexSweepTimer = null
  }
  if (throttleTimer || maxWaitTimer) {
    flushEvents() // Flush remaining events before exit
  }
  for (const spaceId of Array.from(watchers.keys())) {
    await stopWatcher(spaceId)
  }
}
