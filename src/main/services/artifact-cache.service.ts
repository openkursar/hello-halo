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
import { getMainWindow } from '../index'
import { broadcastToAll } from '../http/websocket'
import {
  initSpaceWatcher,
  destroySpaceWatcher,
  scanTreeViaWorker,
  scanFlatViaWorker,
  refreshIgnoreRules as refreshWorkerIgnoreRules,
  setFsEventsHandler,
  shutdown as shutdownWorker
} from './watcher-host.service'
import type { ProcessedFsEvent } from '../../shared/protocol/file-watcher.protocol'
import { isDiskRoot } from '../../shared/disk-paths'

// Re-export shared types for downstream consumers (artifact.service.ts etc.)
export type {
  CachedArtifact,
  CachedTreeNode,
  ArtifactChangeEvent,
  ArtifactTreeUpdateEvent
} from '../../shared/types/artifact'

import type {
  CachedArtifact,
  CachedTreeNode,
  ArtifactChangeEvent,
  ArtifactTreeUpdateEvent
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
  // Cache for flat list (only top-level items for card view)
  flatItems: Map<string, CachedArtifact>
  // Cache for tree structure: key = directory absolute path, value = sorted children
  treeNodes: Map<string, CachedTreeNode[]>
  // Track loaded directories for lazy loading
  loadedDirs: Set<string>
  // Last update timestamp
  lastUpdate: number
  // Maximum depth used for the last flat scan (for cache invalidation)
  cachedMaxDepth: number
  // Whether watcher has been requested for this space
  watcherInitialized: boolean
}

// Global cache map (per-space)
const cacheMap = new Map<string, SpaceCache>()

// Maximum number of items in flatItems cache to prevent memory leaks
const MAX_FLAT_ITEMS_CACHE_SIZE = 10000

// Event listeners registry
type ChangeListener = (event: ArtifactChangeEvent) => void
const changeListeners: ChangeListener[] = []

/**
 * Add item to flatItems cache with size limit enforcement.
 * Uses FIFO eviction when limit is reached.
 */
function addToFlatItemsCache(cache: SpaceCache, path: string, artifact: CachedArtifact): void {
  // Evict oldest entries if at capacity
  if (cache.flatItems.size >= MAX_FLAT_ITEMS_CACHE_SIZE) {
    const keysToDelete: string[] = []
    const deleteCount = Math.ceil(MAX_FLAT_ITEMS_CACHE_SIZE * 0.1) // Evict 10%
    let count = 0
    for (const key of Array.from(cache.flatItems.keys())) {
      if (count >= deleteCount) break
      keysToDelete.push(key)
      count++
    }
    for (const key of keysToDelete) {
      cache.flatItems.delete(key)
    }
    console.log(`[ArtifactCache] Evicted ${keysToDelete.length} items from cache (limit: ${MAX_FLAT_ITEMS_CACHE_SIZE})`)
  }
  cache.flatItems.set(path, artifact)
}

/**
 * Sort artifacts: folders first, then alphabetically by name
 */
function sortByName(a: CachedArtifact, b: CachedArtifact): number {
  if (a.type === 'folder' && b.type !== 'folder') return -1
  if (a.type !== 'folder' && b.type === 'folder') return 1
  return a.name.localeCompare(b.name)
}

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

// Register once: receive fs events from the worker process and apply to caches.
// This replaces the old in-process processWatcherEvent() function.
setFsEventsHandler((spaceId: string, events: ProcessedFsEvent[]) => {
  const cache = cacheMap.get(spaceId)
  if (!cache) return

  for (const event of events) {
    const parentIsTracked = cache.treeNodes.has(event.parentDir)

    if (event.changeType === 'unlink' || event.changeType === 'unlinkDir') {
      // Delete from caches.
      // For 'unlink' events from the worker, we check local cache to determine
      // if the deleted path was a directory (worker can't stat deleted files).
      const wasCachedDir = cache.loadedDirs.has(event.filePath) ||
        cache.flatItems.get(event.filePath)?.type === 'folder'
      const resolvedChangeType = wasCachedDir ? 'unlinkDir' : event.changeType

      cache.flatItems.delete(event.filePath)

      if (parentIsTracked) {
        const parentChildren = cache.treeNodes.get(event.parentDir)!
        cache.treeNodes.set(event.parentDir, parentChildren.filter(n => n.path !== event.filePath))
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
    } else {
      // Add/update caches
      if (event.artifact) {
        addToFlatItemsCache(cache, event.filePath, event.artifact)
      }

      if (parentIsTracked && event.treeNode) {
        const parentChildren = cache.treeNodes.get(event.parentDir)!
        const existingIdx = parentChildren.findIndex(n => n.path === event.filePath)

        if (existingIdx !== -1) {
          // Node exists: replace in-place, preserving children/childrenLoaded for expanded folders
          const existing = parentChildren[existingIdx]
          const updatedNode = { ...event.treeNode }
          if (existing.type === 'folder' && updatedNode.type === 'folder') {
            updatedNode.children = existing.children
            updatedNode.childrenLoaded = existing.childrenLoaded
          }
          parentChildren[existingIdx] = updatedNode
        } else {
          // New node: insert and re-sort
          parentChildren.push(event.treeNode)
          sortTreeNodes(parentChildren)
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
  }
})

// ============================================
// Debounced IPC Broadcasting
// ============================================

// Pending events to be broadcast (grouped by spaceId, deduped by path)
const pendingBroadcastEvents = new Map<string, Map<string, ArtifactChangeEvent>>()
let broadcastTimer: ReturnType<typeof setTimeout> | null = null
const BROADCAST_DEBOUNCE_MS = 500

/**
 * Flush pending events to all clients.
 *
 * Smart batching: for each spaceId, collect unique parent directories that are tracked
 * in treeNodes and build an `updatedDirs` payload with pre-computed children.
 * Also sends individual `artifact:changed` events for backwards compatibility (card view).
 */
function flushPendingBroadcasts(): void {
  if (pendingBroadcastEvents.size === 0) return

  for (const [spaceId, eventsMap] of Array.from(pendingBroadcastEvents.entries())) {
    const dedupedEvents = Array.from(eventsMap.values())
    const cache = cacheMap.get(spaceId)

    const updatedDirs: Array<{ dirPath: string; children: CachedTreeNode[] }> = []

    if (cache) {
      const seenDirs = new Set<string>()
      for (const event of dedupedEvents) {
        const parentDir = getParentPath(event.path)
        if (!seenDirs.has(parentDir) && cache.treeNodes.has(parentDir)) {
          seenDirs.add(parentDir)
          updatedDirs.push({
            dirPath: parentDir,
            children: cache.treeNodes.get(parentDir)!
          })
        }
      }
    }

    if (updatedDirs.length > 0 || dedupedEvents.length > 0) {
      const treeUpdateEvent: ArtifactTreeUpdateEvent = {
        spaceId,
        updatedDirs,
        changes: dedupedEvents
      }
      broadcastToAllClients('artifact:tree-update', treeUpdateEvent as unknown as Record<string, unknown>)
    }

    for (const event of dedupedEvents) {
      broadcastToAllClients('artifact:changed', event as unknown as Record<string, unknown>)
    }
  }

  pendingBroadcastEvents.clear()
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

  // Queue event for debounced broadcast
  if (!pendingBroadcastEvents.has(event.spaceId)) {
    pendingBroadcastEvents.set(event.spaceId, new Map())
  }
  pendingBroadcastEvents.get(event.spaceId)!.set(event.path, event)

  if (broadcastTimer) {
    clearTimeout(broadcastTimer)
  }
  broadcastTimer = setTimeout(flushPendingBroadcasts, BROADCAST_DEBOUNCE_MS)
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
    flatItems: new Map(),
    treeNodes: new Map(),
    loadedDirs: new Set(),
    lastUpdate: Date.now(),
    cachedMaxDepth: 0,
    watcherInitialized: false
  }

  cacheMap.set(spaceId, cache)

  // Initialize watcher in worker process (non-blocking)
  if (!isDiskRoot(rootPath)) {
    cache.watcherInitialized = true
    initSpaceWatcher(spaceId, rootPath)
  }
}

/**
 * Ensure cache exists without tearing down existing watcher
 */
export async function ensureSpaceCache(spaceId: string, rootPath: string): Promise<void> {
  const cache = cacheMap.get(spaceId)
  if (!cache) {
    await initSpaceCache(spaceId, rootPath)
    return
  }

  if (!cache.watcherInitialized && !isDiskRoot(rootPath)) {
    cache.watcherInitialized = true
    initSpaceWatcher(spaceId, rootPath)
  }
}

/**
 * Destroy cache for a space
 */
export async function destroySpaceCache(spaceId: string): Promise<void> {
  const cache = cacheMap.get(spaceId)
  if (!cache) return

  console.log(`[ArtifactCache] Destroying cache for space: ${spaceId}`)

  // Tell worker to stop watching this space
  if (cache.watcherInitialized) {
    destroySpaceWatcher(spaceId)
  }

  cache.flatItems.clear()
  cache.treeNodes.clear()
  cache.loadedDirs.clear()

  cacheMap.delete(spaceId)
}

/**
 * Get artifacts as flat list (for card view)
 */
export async function listArtifacts(
  spaceId: string,
  rootPath: string,
  maxDepth: number = 1
): Promise<CachedArtifact[]> {
  console.debug(`[ArtifactCache] listArtifacts for space: ${spaceId}`)

  // Disk root detection - degrade to prevent system freeze
  if (isDiskRoot(rootPath)) {
    console.warn(`[ArtifactCache] Disk root detected (${rootPath}), degrading to depth 0`)
    maxDepth = 0
  }

  // Ensure cache is initialized
  if (!cacheMap.has(spaceId)) {
    await initSpaceCache(spaceId, rootPath)
  }

  const cache = cacheMap.get(spaceId)!

  // If cache is fresh (within 5 seconds) AND was scanned at sufficient depth, return cached
  const now = Date.now()
  if (cache.flatItems.size > 0 && now - cache.lastUpdate < 5000 && cache.cachedMaxDepth >= maxDepth) {
    console.debug(`[ArtifactCache] Returning cached ${cache.flatItems.size} items (depth=${cache.cachedMaxDepth}, requested=${maxDepth})`)
    return Array.from(cache.flatItems.values())
      .sort((a, b) => sortByName(a, b))
  }

  // Scan via worker process
  const artifacts = await scanFlatViaWorker(spaceId, rootPath, rootPath, maxDepth)

  // Update cache (track maxDepth for invalidation)
  cache.flatItems.clear()
  for (const artifact of artifacts) {
    cache.flatItems.set(artifact.path, artifact)
  }
  cache.lastUpdate = now
  cache.cachedMaxDepth = maxDepth

  return artifacts.sort((a, b) => sortByName(a, b))
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
  // Ensure cache is initialized
  if (!cacheMap.has(spaceId)) {
    await initSpaceCache(spaceId, rootPath)
  }

  const cache = cacheMap.get(spaceId)!

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
  let cache = cacheMap.get(spaceId)
  if (!cache) {
    await initSpaceCache(spaceId, rootPath)
    cache = cacheMap.get(spaceId)!
  }

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
  flatItems: number
  treeNodes: number
  loadedDirs: number
  watcherActive: boolean
} | null {
  const cache = cacheMap.get(spaceId)
  if (!cache) return null

  return {
    flatItems: cache.flatItems.size,
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

/**
 * Reconcile all loaded directories against actual filesystem state.
 *
 * For each directory previously loaded into cache (tracked via loadedDirs),
 * re-scans via worker, diffs against cached treeNodes, and broadcasts
 * corrections through the existing artifact:tree-update channel.
 *
 * Designed to recover from missed @parcel/watcher events (OS queue overflow,
 * App Nap, race conditions). Triggered on window focus and manual refresh.
 *
 * @param reason - Trigger source (window-focus / watcher-error / worker-restart /
 *   artifact-api / ...). Logged so the rescan frequency can be attributed to a
 *   cause when diagnosing high-frequency directory scanning.
 */
export async function reconcileLoadedDirs(spaceId: string, reason = 'manual'): Promise<void> {
  const cache = cacheMap.get(spaceId)
  if (!cache || cache.loadedDirs.size === 0) return

  // Cooldown guard: prevent rapid-fire reconciliation
  const now = Date.now()
  const lastTime = lastReconcileTime.get(spaceId) || 0
  if (now - lastTime < RECONCILE_COOLDOWN_MS) {
    console.debug(`[ArtifactCache] Reconcile skipped for ${spaceId} (cooldown, reason=${reason})`)
    return
  }
  lastReconcileTime.set(spaceId, now)

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
      cache.flatItems.delete(failedDir)
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

    // Update flatItems: remove stale entries, add new ones
    if (cachedNodes) {
      const freshPaths = new Set(freshNodes.map(n => n.path))
      for (const oldNode of cachedNodes) {
        if (!freshPaths.has(oldNode.path)) {
          cache.flatItems.delete(oldNode.path)
          // If removed item was a tracked directory, clean up descendants
          if (oldNode.type === 'folder') {
            removeTreeNodeDescendants(cache, oldNode.path)
          }
        }
      }
    }
    for (const freshNode of freshNodes) {
      if (freshNode.type === 'file') {
        addToFlatItemsCache(cache, freshNode.path, {
          id: freshNode.path,
          spaceId,
          name: freshNode.name,
          type: 'file',
          path: freshNode.path,
          relativePath: relative(cache.rootPath, freshNode.path),
          extension: freshNode.name.includes('.') ? freshNode.name.slice(freshNode.name.lastIndexOf('.')) : '',
          icon: '',
          createdAt: new Date().toISOString(),
          size: freshNode.size,
        })
      }
    }

    updatedDirs.push({ dirPath, children: freshNodes })
  }

  // Broadcast changes through existing channel if anything changed
  if (updatedDirs.length > 0) {
    cache.lastUpdate = Date.now()
    const treeUpdateEvent: ArtifactTreeUpdateEvent = {
      spaceId,
      updatedDirs,
      changes: [] // No individual change events — this is a bulk reconciliation
    }
    broadcastToAllClients('artifact:tree-update', treeUpdateEvent as unknown as Record<string, unknown>)
    console.log(`[ArtifactCache] Reconciled ${changedDirCount}/${dirsToCheck.length} dirs with changes for space: ${spaceId}`)
  } else {
    console.debug(`[ArtifactCache] Reconcile complete: no drift detected (${dirsToCheck.length} dirs checked)`)
  }
}

/**
 * Reconcile ALL cached spaces. Called on window focus.
 *
 * @param reason - Trigger source, forwarded to reconcileLoadedDirs for attribution.
 */
export async function reconcileAllSpaces(reason = 'window-focus'): Promise<void> {
  const spaceIds = Array.from(cacheMap.keys())
  if (spaceIds.length === 0) return

  await Promise.allSettled(
    spaceIds.map(spaceId => reconcileLoadedDirs(spaceId, reason))
  )
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
    cache.flatItems.clear()
    cache.treeNodes.clear()
    cache.loadedDirs.clear()
    cache.lastUpdate = 0
    cache.cachedMaxDepth = 0
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
      cache.flatItems.clear()
      cache.treeNodes.clear()
      cache.loadedDirs.clear()
    }
    cacheMap.delete(spaceId)
  }

  // Shutdown the worker process
  await shutdownWorker()
}
