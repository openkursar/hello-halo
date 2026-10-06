/**
 * Artifact Cache Service - Manages in-memory file system cache
 *
 * Features:
 * - Per-space caching with lazy loading
 * - Batched event delivery with automatic debouncing
 * - Event-driven notifications to renderer
 * - Memory-efficient with LRU-style cleanup
 *
 * All file system I/O (watcher, readdir, stat, .gitignore) is delegated to the
 * file-watcher worker process via watcher-host.service.ts.
 * This service only manages in-memory caches and IPC broadcasts.
 */

import { relative, sep } from 'path'
import { getMainWindow } from '../foundation/window.service'
import { broadcastToAll } from '../http/websocket'
import {
  retainSpaceWatcher,
  releaseSpaceWatcher,
  scanTreeViaWorker,
  refreshIgnoreRules as refreshWorkerIgnoreRules,
  addFsEventsHandler,
  addFsEventsLostHandler,
  shutdown as shutdownWorker
} from './watcher-host.service'
import type { ProcessedFsEvent } from '../../shared/protocol/file-watcher.protocol'
import { isDiskRoot } from '../../shared/disk-paths'

// Re-export shared types for downstream consumers (artifact.service.ts etc.)
export type {
  CachedArtifact,
  CachedTreeNode,
  ArtifactChangeEvent,
  ArtifactTreeUpdateEvent,
  ArtifactChange,
  ArtifactChangeBatchEvent
} from '../../shared/types/artifact'

import type {
  CachedTreeNode,
  ArtifactChangeEvent,
  ArtifactTreeUpdateEvent,
  ArtifactChange,
  ArtifactChangeBatchEvent
} from '../../shared/types/artifact'

/**
 * Broadcast event to all clients (Electron IPC + WebSocket)
 * Pattern from agent/helpers.ts:broadcastToAllClients
 */
function broadcastToAllClients(channel: string, data: Record<string, unknown>): void {
  // 1. Send to Electron renderer via IPC
  try {
    const mainWindow = getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, data)
    }
  } catch (error) {
    console.error('[ArtifactCache] Failed to send event to renderer:', error)
  }

  // 2. Broadcast to remote WebSocket clients
  try {
    broadcastToAll(channel, data)
  } catch (error) {
    // WebSocket module might not be initialized yet, ignore
  }
}

/**
 * Space cache entry.
 * Only in-memory data structures -- no fs handles or watcher references.
 */
interface SpaceCache {
  spaceId: string
  rootPath: string
  // Cache for tree structure: key = directory absolute path, value = sorted children
  treeNodes: Map<string, CachedTreeNode[]>
  // Track loaded directories for lazy loading
  loadedDirs: Set<string>
  // Whether watcher has been requested for this space
  watcherInitialized: boolean
  /** Client id → when it last retained this space (holds are leases; see sweepExpiredSpaceHolds). */
  clients: Map<string, number>
  // Last time any request touched this space; orders eviction
  lastUsed: number
}

// Global cache map (per-space)
const cacheMap = new Map<string, SpaceCache>()

/** Holder key under which this cache retains a space's watcher. */
const WATCHER_HOLDER = 'artifact-cache'

/**
 * Most spaces kept cached at once. Clients release the spaces they stop
 * showing; this bounds what a client that never releases (crashed or reloaded
 * renderer, closed remote tab) can leave behind. Spaces nobody holds go first.
 */
export const MAX_CACHED_SPACES = 3

// Event listeners registry
type ChangeListener = (event: ArtifactChangeEvent) => void
const changeListeners: ChangeListener[] = []

/**
 * Get parent directory path from a file path.
 * Supports both / and \ separators.
 */
function getParentPath(filePath: string): string {
  const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return lastSep > 0 ? filePath.substring(0, lastSep) : filePath
}

/**
 * Sort tree nodes: folders first, then alphabetically by name.
 * Mutates and returns the array for convenience.
 */
function sortTreeNodes(nodes: CachedTreeNode[]): CachedTreeNode[] {
  return nodes.sort((a, b) => {
    if (a.type === 'folder' && b.type !== 'folder') return -1
    if (a.type !== 'folder' && b.type === 'folder') return 1
    return a.name.localeCompare(b.name)
  })
}

/**
 * Recursively remove a directory and all its descendant entries from treeNodes and loadedDirs.
 * Called when a tracked directory is deleted.
 */
function removeTreeNodeDescendants(cache: SpaceCache, dirPath: string): void {
  cache.treeNodes.delete(dirPath)
  cache.loadedDirs.delete(dirPath)

  const prefix = dirPath + sep
  for (const key of Array.from(cache.treeNodes.keys())) {
    if (key.startsWith(prefix)) {
      cache.treeNodes.delete(key)
      cache.loadedDirs.delete(key)
    }
  }
}

// ============================================
// Worker Event Integration
// ============================================

/**
 * Apply one worker batch to a space's caches.
 *
 * Children of a directory are indexed by path once per batch and re-sorted once
 * per directory, so a burst into one large directory stays linear.
 */
export function applyFsEvents(spaceId: string, events: ProcessedFsEvent[]): void {
  const cache = cacheMap.get(spaceId)
  if (!cache) return

  const childIndexes = new Map<string, Map<string, number>>()
  const needsSort = new Set<string>()
  const removals = new Map<string, Set<string>>()
  const indexOf = (dirPath: string, children: CachedTreeNode[]): Map<string, number> => {
    let index = childIndexes.get(dirPath)
    if (!index) {
      index = new Map(children.map((node, i) => [node.path, i]))
      childIndexes.set(dirPath, index)
    }
    return index
  }

  for (const event of events) {
    const parentChildren = cache.treeNodes.get(event.parentDir)

    if (event.changeType === 'unlink' || event.changeType === 'unlinkDir') {
      // The worker cannot stat a deleted path, so whether it was a directory
      // comes from what the cache knew about it.
      const knownNode = parentChildren ? parentChildren[indexOf(event.parentDir, parentChildren).get(event.filePath) ?? -1] : undefined
      const wasCachedDir = cache.loadedDirs.has(event.filePath) || knownNode?.type === 'folder'
      const resolvedChangeType = wasCachedDir ? 'unlinkDir' : event.changeType

      if (parentChildren) {
        let removed = removals.get(event.parentDir)
        if (!removed) {
          removed = new Set()
          removals.set(event.parentDir, removed)
        }
        removed.add(event.filePath)
      }

      if (wasCachedDir || event.changeType === 'unlinkDir') {
        removeTreeNodeDescendants(cache, event.filePath)
      }

      emitChange({
        type: resolvedChangeType,
        path: event.filePath,
        relativePath: event.relativePath,
        spaceId,
      })
      continue
    }

    if (parentChildren && event.treeNode) {
      const index = indexOf(event.parentDir, parentChildren)
      const existingIdx = index.get(event.filePath)

      if (existingIdx !== undefined) {
        // Node exists: replace in-place, preserving children/childrenLoaded for expanded folders
        const existing = parentChildren[existingIdx]
        const updatedNode = { ...event.treeNode }
        if (existing.type === 'folder' && updatedNode.type === 'folder') {
          updatedNode.children = existing.children
          updatedNode.childrenLoaded = existing.childrenLoaded
        }
        parentChildren[existingIdx] = updatedNode
      } else {
        index.set(event.filePath, parentChildren.length)
        parentChildren.push(event.treeNode)
        needsSort.add(event.parentDir)
      }
    }

    emitChange({
      type: event.changeType,
      path: event.filePath,
      relativePath: event.relativePath,
      spaceId,
      item: event.artifact,
    })
  }

  for (const [dirPath, removed] of removals) {
    const children = cache.treeNodes.get(dirPath)
    if (children) cache.treeNodes.set(dirPath, children.filter(n => !removed.has(n.path)))
  }
  for (const dirPath of needsSort) {
    const children = cache.treeNodes.get(dirPath)
    if (children) sortTreeNodes(children)
  }
}

addFsEventsHandler(applyFsEvents, { resolvedOnly: true })

// Events were lost (burst over the limit, watcher failure, worker restart):
// clients' per-file state is stale. Tree directories are reconciled by the host.
addFsEventsLostHandler((spaceId) => {
  if (cacheMap.has(spaceId)) markResync(spaceId)
})

// ============================================
// Debounced IPC Broadcasting
// ============================================

interface PendingBroadcast {
  changes: Map<string, ArtifactChange>
  resync: boolean
}

// Pending changes to be broadcast, per space, deduped by path (last wins).
const pendingBroadcasts = new Map<string, PendingBroadcast>()
let broadcastTimer: ReturnType<typeof setTimeout> | null = null
let broadcastMaxWaitTimer: ReturnType<typeof setTimeout> | null = null
const BROADCAST_DEBOUNCE_MS = 500
// Sustained activity must not postpone delivery indefinitely.
const BROADCAST_MAX_WAIT_MS = 2000
/** Largest `artifact:changed-batch` payload; bigger flushes are split. */
export const MAX_CHANGES_PER_BATCH = 1000
/** Past this many pending changes a space is sent as a resync instead. */
export const MAX_PENDING_CHANGES_PER_SPACE = 20_000

function pendingFor(spaceId: string): PendingBroadcast {
  let pending = pendingBroadcasts.get(spaceId)
  if (!pending) {
    pending = { changes: new Map(), resync: false }
    pendingBroadcasts.set(spaceId, pending)
  }
  return pending
}

function scheduleBroadcast(): void {
  if (broadcastTimer) clearTimeout(broadcastTimer)
  broadcastTimer = setTimeout(flushPendingBroadcasts, BROADCAST_DEBOUNCE_MS)
  if (!broadcastMaxWaitTimer) {
    broadcastMaxWaitTimer = setTimeout(flushPendingBroadcasts, BROADCAST_MAX_WAIT_MS)
  }
}

function markResync(spaceId: string): void {
  const pending = pendingFor(spaceId)
  pending.resync = true
  pending.changes.clear()
  scheduleBroadcast()
}

/**
 * Flush pending changes to all clients: per space, one `artifact:tree-update`
 * carrying the recomputed children of every affected loaded directory, and the
 * changes themselves as `artifact:changed-batch` (split at MAX_CHANGES_PER_BATCH).
 */
export function flushPendingBroadcasts(): void {
  if (broadcastTimer) { clearTimeout(broadcastTimer); broadcastTimer = null }
  if (broadcastMaxWaitTimer) { clearTimeout(broadcastMaxWaitTimer); broadcastMaxWaitTimer = null }
  if (pendingBroadcasts.size === 0) return

  const flushing = Array.from(pendingBroadcasts.entries())
  pendingBroadcasts.clear()

  for (const [spaceId, pending] of flushing) {
    const changes = Array.from(pending.changes.values())
    const cache = cacheMap.get(spaceId)

    if (cache && changes.length > 0) {
      const updatedDirs: Array<{ dirPath: string; children: CachedTreeNode[] }> = []
      const seenDirs = new Set<string>()
      for (const change of changes) {
        const parentDir = getParentPath(change.path)
        if (seenDirs.has(parentDir)) continue
        seenDirs.add(parentDir)
        const children = cache.treeNodes.get(parentDir)
        if (children) updatedDirs.push({ dirPath: parentDir, children })
      }
      if (updatedDirs.length > 0) {
        const treeUpdateEvent: ArtifactTreeUpdateEvent = { spaceId, updatedDirs }
        broadcastToAllClients('artifact:tree-update', treeUpdateEvent as unknown as Record<string, unknown>)
      }
    }

    if (pending.resync) {
      const batch: ArtifactChangeBatchEvent = { spaceId, changes: [], resync: true }
      broadcastToAllClients('artifact:changed-batch', batch as unknown as Record<string, unknown>)
      continue
    }
    for (let i = 0; i < changes.length; i += MAX_CHANGES_PER_BATCH) {
      const batch: ArtifactChangeBatchEvent = { spaceId, changes: changes.slice(i, i + MAX_CHANGES_PER_BATCH) }
      broadcastToAllClients('artifact:changed-batch', batch as unknown as Record<string, unknown>)
    }
  }
}

/**
 * Emit change event to all listeners (with debounced IPC broadcast).
 *
 * Dedup: within a single debounce window, only the LAST event per path is kept.
 */
function emitChange(event: ArtifactChangeEvent): void {
  // Notify registered listeners immediately (internal callbacks)
  for (const listener of changeListeners) {
    try {
      listener(event)
    } catch (error) {
      console.error('[ArtifactCache] Listener error:', error)
    }
  }

  const pending = pendingFor(event.spaceId)
  if (!pending.resync) {
    pending.changes.set(event.path, { type: event.type, path: event.path, relativePath: event.relativePath })
    if (pending.changes.size > MAX_PENDING_CHANGES_PER_SPACE) {
      console.warn(`[ArtifactCache] Over ${MAX_PENDING_CHANGES_PER_SPACE} pending changes for ${event.spaceId}; sending resync`)
      pending.resync = true
      pending.changes.clear()
    }
  }
  scheduleBroadcast()
}

// ============================================
// Public API
// ============================================

/**
 * Initialize cache for a space
 */
export async function initSpaceCache(spaceId: string, rootPath: string): Promise<void> {
  console.log(`[ArtifactCache] Initializing cache for space: ${spaceId}`)

  // Clean up existing cache if any
  if (cacheMap.has(spaceId)) {
    await destroySpaceCache(spaceId)
  }

  const cache: SpaceCache = {
    spaceId,
    rootPath,
    treeNodes: new Map(),
    loadedDirs: new Set(),
    watcherInitialized: false,
    clients: new Map(),
    lastUsed: Date.now(),
  }

  cacheMap.set(spaceId, cache)

  // Initialize watcher in worker process (non-blocking)
  if (!isDiskRoot(rootPath)) {
    cache.watcherInitialized = true
    retainSpaceWatcher(spaceId, rootPath, WATCHER_HOLDER)
  }

  evictSpaceCaches(spaceId)
}

/**
 * Drop least-recently-used caches beyond MAX_CACHED_SPACES, never `keep` and
 * never one a client still retains: that client shows the space's tree and would
 * silently stop receiving its changes. Retained caches leave when their last
 * client releases them, so the cap bounds only the caches nobody is showing.
 */
function evictSpaceCaches(keep: string): void {
  if (cacheMap.size <= MAX_CACHED_SPACES) return
  const candidates = Array.from(cacheMap.values())
    .filter(c => c.spaceId !== keep && c.clients.size === 0)
    .sort((a, b) => a.lastUsed - b.lastUsed)
  for (const cache of candidates) {
    if (cacheMap.size <= MAX_CACHED_SPACES) break
    console.log(`[ArtifactCache] Evicting cache for ${cache.spaceId} (over ${MAX_CACHED_SPACES} spaces, no client)`)
    void destroySpaceCache(cache.spaceId)
  }
}

/** The space's cache, created on first use and marked as just used. */
async function useSpaceCache(spaceId: string, rootPath: string): Promise<SpaceCache> {
  let cache = cacheMap.get(spaceId)
  if (!cache) {
    await initSpaceCache(spaceId, rootPath)
    cache = cacheMap.get(spaceId)!
  }
  cache.lastUsed = Date.now()
  return cache
}

/**
 * Ensure cache exists without tearing down existing watcher
 */
export async function ensureSpaceCache(spaceId: string, rootPath: string): Promise<void> {
  const cache = await useSpaceCache(spaceId, rootPath)
  if (!cache.watcherInitialized && !isDiskRoot(rootPath)) {
    cache.watcherInitialized = true
    retainSpaceWatcher(spaceId, rootPath, WATCHER_HOLDER)
  }
}

/**
 * A client hold is a lease: the client re-sends `retain` while it shows the
 * space (every minute), and a hold not renewed for SPACE_HOLD_LEASE_MS is
 * dropped. Explicit release stays the fast path; the lease cleans up after a
 * renderer reload or crash and a remote tab that closed without releasing —
 * none of which reaches main as a release.
 */
export const SPACE_HOLD_LEASE_MS = 3 * 60 * 1000
const HOLD_SWEEP_INTERVAL_MS = 60 * 1000
let holdSweepTimer: ReturnType<typeof setInterval> | null = null

/** Drop holds not renewed within the lease; destroy caches left with no client. */
export async function sweepExpiredSpaceHolds(now = Date.now()): Promise<number> {
  let dropped = 0
  for (const cache of Array.from(cacheMap.values())) {
    if (cache.clients.size === 0) continue
    for (const [clientId, seenAt] of cache.clients) {
      if (now - seenAt < SPACE_HOLD_LEASE_MS) continue
      cache.clients.delete(clientId)
      dropped += 1
    }
    if (cache.clients.size === 0) {
      console.log(`[ArtifactCache] Space ${cache.spaceId}: every client hold expired; releasing`)
      await destroySpaceCache(cache.spaceId)
    }
  }
  if (!Array.from(cacheMap.values()).some(c => c.clients.size > 0) && holdSweepTimer) {
    clearInterval(holdSweepTimer)
    holdSweepTimer = null
  }
  return dropped
}

function ensureHoldSweep(): void {
  if (holdSweepTimer) return
  holdSweepTimer = setInterval(() => { void sweepExpiredSpaceHolds() }, HOLD_SWEEP_INTERVAL_MS)
  holdSweepTimer.unref?.()
}

/**
 * A client declares (or renews) that it is showing `spaceId`. The hold is a
 * lease: the cache and watcher stay alive while any client renews within
 * SPACE_HOLD_LEASE_MS and has not released; a held cache is never evicted.
 * Returns true when this client held nothing here — on a renewal that means
 * its hold lapsed and the cache was rebuilt, so changes in between were lost.
 */
export async function retainSpaceCache(spaceId: string, rootPath: string, clientId: string): Promise<boolean> {
  const recreated = !cacheMap.get(spaceId)?.clients.has(clientId)
  await ensureSpaceCache(spaceId, rootPath)
  cacheMap.get(spaceId)?.clients.set(clientId, Date.now())
  ensureHoldSweep()
  return recreated
}

/** A client stopped showing `spaceId`; the cache goes when no client is left. */
export async function releaseSpaceCache(spaceId: string, clientId: string): Promise<void> {
  const cache = cacheMap.get(spaceId)
  if (!cache) return
  cache.clients.delete(clientId)
  if (cache.clients.size === 0) await destroySpaceCache(spaceId)
}

/**
 * Destroy cache for a space
 */
export async function destroySpaceCache(spaceId: string): Promise<void> {
  const cache = cacheMap.get(spaceId)
  if (!cache) return

  console.log(`[ArtifactCache] Destroying cache for space: ${spaceId}`)

  if (cache.watcherInitialized) {
    releaseSpaceWatcher(spaceId, WATCHER_HOLDER)
  }

  cache.treeNodes.clear()
  cache.loadedDirs.clear()

  cacheMap.delete(spaceId)
  pendingBroadcasts.delete(spaceId)
  lastReconcileTime.delete(spaceId)
  reconcileInFlight.delete(spaceId)
}

/**
 * The space's folder changed. The cache keeps its client holds but forgets the
 * old folder's tree, so the next listing reads the new one; the watcher itself
 * is moved by the watcher host (`rerootSpaceWatcher`). A disk root is never
 * watched, as when a cache starts there.
 */
export function rerootSpaceCache(spaceId: string, rootPath: string): void {
  const cache = cacheMap.get(spaceId)
  if (!cache || cache.rootPath === rootPath) return
  cache.rootPath = rootPath
  cache.treeNodes.clear()
  cache.loadedDirs.clear()
  pendingBroadcasts.delete(spaceId)
  lastReconcileTime.delete(spaceId)
  if (cache.watcherInitialized && isDiskRoot(rootPath)) {
    cache.watcherInitialized = false
    releaseSpaceWatcher(spaceId, WATCHER_HOLDER)
  } else if (!cache.watcherInitialized && !isDiskRoot(rootPath)) {
    cache.watcherInitialized = true
    retainSpaceWatcher(spaceId, rootPath, WATCHER_HOLDER)
  }
  console.log(`[ArtifactCache] Space ${spaceId} now lists ${rootPath}`)
}

/**
 * Get artifacts as tree structure (lazy loading).
 * Returns cached children for rootPath on cache hit (Map.get, O(1)).
 * On miss, scans via worker and populates the cache.
 */
export async function listArtifactsTree(
  spaceId: string,
  rootPath: string
): Promise<CachedTreeNode[]> {
  const cache = await useSpaceCache(spaceId, rootPath)

  // Cache hit: return immediately (O(1) Map.get)
  const cached = cache.treeNodes.get(rootPath)
  if (cached) {
    console.debug(`[ArtifactCache] listArtifactsTree CACHE HIT: ${cached.length} nodes`)
    return cached
  }

  // Cache miss: scan via worker
  console.debug(`[ArtifactCache] listArtifactsTree CACHE MISS, scanning: ${rootPath}`)
  const nodes = await scanTreeViaWorker(spaceId, rootPath, rootPath, 0)

  // Store in cache
  cache.treeNodes.set(rootPath, nodes)
  cache.loadedDirs.add(rootPath)

  return nodes
}

/**
 * Load children for a specific directory (lazy loading).
 * Returns cached children on cache hit (O(1)).
 * On miss, scans via worker and populates cache. Re-checks cache after async scan
 * to handle race condition where watcher populated the cache during the await.
 */
export async function loadDirectoryChildren(
  spaceId: string,
  dirPath: string,
  rootPath: string
): Promise<CachedTreeNode[]> {
  const cache = await useSpaceCache(spaceId, rootPath)

  // Cache hit: return immediately
  const cached = cache.treeNodes.get(dirPath)
  if (cached) {
    console.debug(`[ArtifactCache] loadDirectoryChildren CACHE HIT: ${cached.length} nodes (${dirPath})`)
    return cached
  }

  // Calculate depth based on relative path
  const relPath = relative(rootPath, dirPath)
  const depth = relPath ? relPath.split(/[\\/]/).length : 0

  // Cache miss: scan via worker
  console.debug(`[ArtifactCache] loadDirectoryChildren CACHE MISS, scanning: ${dirPath} (depth=${depth + 1}, rootPath=${rootPath})`)
  const children = await scanTreeViaWorker(spaceId, dirPath, rootPath, depth + 1)
  console.debug(`[ArtifactCache] loadDirectoryChildren scan result: ${children.length} nodes for ${dirPath}`)

  // Race condition guard: watcher may have populated the cache during the await.
  // Prefer watcher's version since it's more up-to-date.
  const watcherVersion = cache.treeNodes.get(dirPath)
  if (watcherVersion) {
    console.debug(`[ArtifactCache] loadDirectoryChildren: watcher populated cache during scan, using watcher version (${watcherVersion.length} nodes)`)
    cache.loadedDirs.add(dirPath)
    return watcherVersion
  }

  // Store in cache
  cache.treeNodes.set(dirPath, children)
  cache.loadedDirs.add(dirPath)
  console.debug(`[ArtifactCache] loadDirectoryChildren cached: ${children.length} nodes for ${dirPath}`)

  return children
}

/**
 * Register a change listener
 */
export function onArtifactChange(listener: ChangeListener): () => void {
  changeListeners.push(listener)
  return () => {
    const index = changeListeners.indexOf(listener)
    if (index > -1) {
      changeListeners.splice(index, 1)
    }
  }
}

/**
 * Get cache statistics (for debugging)
 */
export function getCacheStats(spaceId: string): {
  treeNodes: number
  loadedDirs: number
  watcherActive: boolean
} | null {
  const cache = cacheMap.get(spaceId)
  if (!cache) return null

  return {
    treeNodes: cache.treeNodes.size,
    loadedDirs: cache.loadedDirs.size,
    watcherActive: cache.watcherInitialized
  }
}

// ============================================
// Reconciliation (Push + Pull Recovery)
// ============================================

// Cooldown guard: minimum interval between reconciliations (per space)
const RECONCILE_COOLDOWN_MS = 2000
const lastReconcileTime = new Map<string, number>()
// The run in progress per space: a request made meanwhile joins it rather than
// scanning again, so an older run can never finish last and restore its listing.
const reconcileInFlight = new Map<string, Promise<void>>()

/**
 * Reconcile all loaded directories against actual filesystem state.
 *
 * For each directory previously loaded into cache (tracked via loadedDirs),
 * re-scans via worker, diffs against cached treeNodes, and broadcasts
 * corrections through the existing artifact:tree-update channel.
 *
 * Designed to recover from missed @parcel/watcher events (OS queue overflow,
 * App Nap, race conditions). Triggered when the watcher errs or its process
 * restarts, and on manual refresh. One run per space at a time: a request made
 * during a run resolves when that run does.
 *
 * @param reason - Trigger source (watcher-error / worker-restart / artifact-api /
 *   ...). Logged so the rescan frequency can be attributed to a cause when
 *   diagnosing high-frequency directory scanning.
 */
export async function reconcileLoadedDirs(spaceId: string, reason = 'manual'): Promise<void> {
  const cache = cacheMap.get(spaceId)
  if (!cache || cache.loadedDirs.size === 0) return

  const running = reconcileInFlight.get(spaceId)
  if (running) {
    console.debug(`[ArtifactCache] Reconcile already running for ${spaceId}, joining it (reason=${reason})`)
    return running
  }

  // Cooldown guard: prevent rapid-fire reconciliation
  const now = Date.now()
  const lastTime = lastReconcileTime.get(spaceId) || 0
  if (now - lastTime < RECONCILE_COOLDOWN_MS) {
    console.debug(`[ArtifactCache] Reconcile skipped for ${spaceId} (cooldown, reason=${reason})`)
    return
  }
  lastReconcileTime.set(spaceId, now)

  const run = runReconcile(spaceId, cache, reason).finally(() => {
    if (reconcileInFlight.get(spaceId) === run) reconcileInFlight.delete(spaceId)
  })
  reconcileInFlight.set(spaceId, run)
  return run
}

async function runReconcile(spaceId: string, cache: SpaceCache, reason: string): Promise<void> {
  const dirsToCheck = Array.from(cache.loadedDirs)
  let changedDirCount = 0
  const updatedDirs: Array<{ dirPath: string; children: CachedTreeNode[] }> = []

  console.log(`[ArtifactCache] Reconcile run: reason=${reason}, ${dirsToCheck.length} loaded dirs, space=${spaceId}`)

  // Scan all loaded directories in parallel via worker (off main thread)
  const scanResults = await Promise.allSettled(
    dirsToCheck.map(async (dirPath) => {
      const relPath = dirPath === cache.rootPath ? '' : relative(cache.rootPath, dirPath)
      const depth = relPath ? relPath.split(/[\\/]/).length : 0
      const freshNodes = await scanTreeViaWorker(spaceId, dirPath, cache.rootPath, depth + 1)
      return { dirPath, freshNodes }
    })
  )

  for (let i = 0; i < scanResults.length; i++) {
    const result = scanResults[i]
    if (result.status === 'rejected') {
      // Directory was likely deleted while we were away — clean up from cache
      const failedDir = dirsToCheck[i]
      const error = result.reason as Error
      console.warn(`[ArtifactCache] Reconcile scan failed for ${failedDir}: ${error.message}. Removing from cache.`)
      removeTreeNodeDescendants(cache, failedDir)
      // Remove from parent's treeNodes children list
      const parentDir = failedDir.substring(0, Math.max(failedDir.lastIndexOf('/'), failedDir.lastIndexOf('\\')))
      if (parentDir && cache.treeNodes.has(parentDir)) {
        const parentChildren = cache.treeNodes.get(parentDir)!
        cache.treeNodes.set(parentDir, parentChildren.filter(n => n.path !== failedDir))
      }
      changedDirCount++
      // Broadcast parent dir update so UI removes the dead entry
      if (parentDir && cache.treeNodes.has(parentDir)) {
        updatedDirs.push({ dirPath: parentDir, children: cache.treeNodes.get(parentDir)! })
      }
      continue
    }

    const { dirPath, freshNodes } = result.value
    const cachedNodes = cache.treeNodes.get(dirPath)

    // If directory no longer has cache entry (was removed during scan), skip
    if (!cache.loadedDirs.has(dirPath)) continue

    // Diff: compare cached vs fresh by building path-keyed maps
    const hasChanged = diffTreeNodes(cachedNodes, freshNodes)
    if (!hasChanged) continue

    // Apply fresh state to cache
    changedDirCount++
    cache.treeNodes.set(dirPath, freshNodes)

    if (cachedNodes) {
      const freshPaths = new Set(freshNodes.map(n => n.path))
      for (const oldNode of cachedNodes) {
        // A removed directory takes its loaded descendants with it
        if (oldNode.type === 'folder' && !freshPaths.has(oldNode.path)) {
          removeTreeNodeDescendants(cache, oldNode.path)
        }
      }
    }

    updatedDirs.push({ dirPath, children: freshNodes })
  }

  // Broadcast changes through existing channel if anything changed
  if (updatedDirs.length > 0) {
    const treeUpdateEvent: ArtifactTreeUpdateEvent = { spaceId, updatedDirs }
    broadcastToAllClients('artifact:tree-update', treeUpdateEvent as unknown as Record<string, unknown>)
    console.log(`[ArtifactCache] Reconciled ${changedDirCount}/${dirsToCheck.length} dirs with changes for space: ${spaceId}`)
  } else {
    console.debug(`[ArtifactCache] Reconcile complete: no drift detected (${dirsToCheck.length} dirs checked)`)
  }
}

/**
 * Compare two tree node arrays for differences.
 * Returns true if any difference is detected (add, remove, or attribute change).
 */
function diffTreeNodes(
  cached: CachedTreeNode[] | undefined,
  fresh: CachedTreeNode[]
): boolean {
  if (!cached) return fresh.length > 0
  if (cached.length !== fresh.length) return true

  // Build path → node map for O(n) comparison
  const cachedMap = new Map<string, CachedTreeNode>()
  for (const node of cached) {
    cachedMap.set(node.path, node)
  }

  for (const freshNode of fresh) {
    const cachedNode = cachedMap.get(freshNode.path)
    if (!cachedNode) return true // New file/folder
    // Check for type change or size change (covers most meaningful changes)
    if (cachedNode.type !== freshNode.type) return true
    if (cachedNode.type === 'file' && freshNode.type === 'file' &&
        cachedNode.size !== freshNode.size) return true
  }

  return false
}

/**
 * Force refresh cache for a space
 */
export async function refreshCache(spaceId: string, rootPath: string): Promise<void> {
  console.log(`[ArtifactCache] Force refreshing cache for space: ${spaceId}`)

  const cache = cacheMap.get(spaceId)
  if (cache) {
    // Tell worker to reload .gitignore rules
    refreshWorkerIgnoreRules(spaceId, rootPath)
    cache.treeNodes.clear()
    cache.loadedDirs.clear()
  }
}

/**
 * Cleanup all caches (call on app exit)
 */
export async function cleanupAllCaches(): Promise<void> {
  console.log('[ArtifactCache] Cleaning up all caches')

  // Clear all in-memory caches
  for (const spaceId of Array.from(cacheMap.keys())) {
    const cache = cacheMap.get(spaceId)
    if (cache) {
      cache.treeNodes.clear()
      cache.loadedDirs.clear()
    }
    cacheMap.delete(spaceId)
  }

  if (holdSweepTimer) {
    clearInterval(holdSweepTimer)
    holdSweepTimer = null
  }

  // Shutdown the worker process
  await shutdownWorker()
}
