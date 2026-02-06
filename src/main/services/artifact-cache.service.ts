/**
 * Artifact Cache Service - Manages file system cache with native watcher
 *
 * Features:
 * - Per-space caching with lazy loading
 * - Native file system watching (one OS-level handle per workspace)
 * - .gitignore-aware filtering (no manual exclude list maintenance)
 * - Batched event delivery with automatic debouncing
 * - Event-driven notifications to renderer
 * - Memory-efficient with LRU-style cleanup
 */

import watcher from '@parcel/watcher'
import type { AsyncSubscription, Event as WatcherEvent } from '@parcel/watcher'
import ignore from 'ignore'
import type { Ignore } from 'ignore'
import { join, extname, basename, relative, sep } from 'path'
import { promises as fs, readFileSync, Dirent } from 'fs'
import { existsSync } from 'fs'
import { getMainWindow } from '../index'
import { broadcastToAll } from '../http/websocket'
import { ALWAYS_IGNORE_DIRS, BASELINE_IGNORE_PATTERNS, CPP_LEVEL_IGNORE_DIRS } from '../../shared/constants/ignore-patterns'

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

// File type icon IDs mapping (same as artifact.service.ts)
const FILE_ICON_IDS: Record<string, string> = {
  html: 'globe', htm: 'globe', css: 'palette', scss: 'palette', less: 'palette',
  js: 'file-code', jsx: 'file-code', ts: 'file-code', tsx: 'file-code',
  json: 'file-json', md: 'book', markdown: 'book', txt: 'file-text',
  py: 'file-code', rs: 'cpu', go: 'file-code', java: 'coffee',
  cpp: 'cpu', c: 'cpu', h: 'cpu', hpp: 'cpu', vue: 'file-code',
  svelte: 'file-code', php: 'file-code', rb: 'gem', swift: 'file-code',
  kt: 'file-code', sql: 'database', sh: 'terminal', bash: 'terminal',
  zsh: 'terminal', yaml: 'file-json', yml: 'file-json', xml: 'file-json',
  svg: 'image', png: 'image', jpg: 'image', jpeg: 'image', gif: 'image',
  webp: 'image', ico: 'image', pdf: 'book', default: 'file-text'
}

// Hidden patterns - system junk files that should never be shown in UI
const HIDDEN_PATTERNS = [
  /\.DS_Store$/,      // macOS system file
  /Thumbs\.db$/,      // Windows thumbnail cache
  /desktop\.ini$/,    // Windows folder settings
]

/**
 * Artifact item for flat list view
 */
export interface CachedArtifact {
  id: string
  spaceId: string
  name: string
  type: 'file' | 'folder'
  path: string
  relativePath: string  // Path relative to space root
  extension: string
  icon: string
  size?: number
  createdAt: string
  modifiedAt: string
}

/**
 * Tree node for hierarchical view
 */
export interface CachedTreeNode {
  id: string
  name: string
  type: 'file' | 'folder'
  path: string
  relativePath: string
  extension: string
  icon: string
  size?: number
  depth: number
  children?: CachedTreeNode[]
  childrenLoaded: boolean  // For lazy loading
}

/**
 * File change event for incremental updates
 */
export interface ArtifactChangeEvent {
  type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'
  path: string
  relativePath: string
  spaceId: string
  item?: CachedArtifact | CachedTreeNode
}

/**
 * Space cache entry
 */
interface SpaceCache {
  spaceId: string
  rootPath: string
  subscription: AsyncSubscription | null
  ignoreFilter: Ignore | null
  // Cache for flat list (only top-level items for card view)
  flatItems: Map<string, CachedArtifact>
  // Cache for tree structure (with lazy-loaded children)
  treeNodes: Map<string, CachedTreeNode>
  // Track loaded directories for lazy loading
  loadedDirs: Set<string>
  // Last update timestamp
  lastUpdate: number
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
    for (const key of cache.flatItems.keys()) {
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
 * Get file icon ID from extension
 */
function getFileIconId(ext: string): string {
  const normalized = ext.toLowerCase().replace('.', '')
  return FILE_ICON_IDS[normalized] || FILE_ICON_IDS.default
}

/**
 * Generate unique ID for artifacts using auto-increment counter.
 * IDs are only used for React keys and in-memory references, not persisted.
 */
let artifactIdCounter = 0
function generateId(): string {
  return `artifact-${++artifactIdCounter}`
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
 * Check if path should be hidden (system junk files)
 */
function shouldHide(filePath: string): boolean {
  return HIDDEN_PATTERNS.some(pattern => pattern.test(filePath))
}

/**
 * Check if path is a disk root directory.
 * Disk roots are dangerous to scan/watch due to massive file counts.
 */
function isDiskRoot(path: string): boolean {
  // Windows: C:\, D:\, etc.
  if (/^[A-Z]:\\?$/i.test(path)) return true
  // Unix root
  if (path === '/') return true
  // macOS volumes root: /Volumes/xxx (but not subdirectories)
  if (/^\/Volumes\/[^/]+\/?$/.test(path)) return true
  // Linux mount points
  if (/^\/mnt\/[^/]+\/?$/.test(path)) return true
  if (/^\/media\/[^/]+\/?$/.test(path)) return true
  return false
}

// ============================================
// .gitignore Integration
// ============================================

/**
 * Build ignore rules for a workspace by stacking three layers:
 *
 *   1. ALWAYS_IGNORE_DIRS — VCS/app metadata (.git, .halo, etc.)
 *   2. BASELINE_IGNORE_PATTERNS — common build/cache/dependency dirs, always active
 *   3. Project .gitignore — additive, project-specific rules
 *
 * Layers are additive, not either/or. Duplicate rules are harmless.
 */
function loadIgnoreRules(rootPath: string): Ignore {
  const ig = ignore()

  // Layer 1: VCS/app metadata (also excluded at C++ level, added here for scan filtering)
  ig.add(ALWAYS_IGNORE_DIRS)

  // Layer 2: Baseline — always active regardless of .gitignore existence
  ig.add(BASELINE_IGNORE_PATTERNS)

  // Layer 3: Project .gitignore — additive on top of baseline
  const rootGitignore = join(rootPath, '.gitignore')
  if (existsSync(rootGitignore)) {
    try {
      const content = readFileSync(rootGitignore, 'utf-8')
      ig.add(content)
      console.log(`[ArtifactCache] Loaded .gitignore from ${rootPath}`)
    } catch (error) {
      console.warn(`[ArtifactCache] Failed to read .gitignore:`, error)
    }
  }

  return ig
}

/**
 * Check if a relative path should be ignored by .gitignore rules.
 * Normalizes path separators for cross-platform compatibility.
 * Optimized: only converts separators on Windows (where sep is '\\').
 */
function isIgnored(ig: Ignore, relativePath: string): boolean {
  if (!relativePath || relativePath === '.') return false
  // ignore lib expects forward slashes; only convert on Windows
  const normalized = sep === '/' ? relativePath : relativePath.split(sep).join('/')
  return ig.ignores(normalized)
}

// ============================================
// File Operations
// ============================================

/**
 * Create artifact from Dirent (zero stat calls).
 * For initial scan, we use Dirent directly to avoid expensive fs.stat() calls.
 * Size and timestamps are not available from Dirent, so they are omitted.
 */
function createArtifactFromDirent(
  entry: Dirent,
  dirPath: string,
  rootPath: string,
  spaceId: string
): CachedArtifact {
  const fullPath = join(dirPath, entry.name)
  const ext = extname(entry.name)
  const relativePath = relative(rootPath, fullPath)
  const isDir = entry.isDirectory()

  return {
    id: generateId(),
    spaceId,
    name: entry.name,
    type: isDir ? 'folder' : 'file',
    path: fullPath,
    relativePath,
    extension: ext.replace('.', ''),
    icon: isDir ? 'folder' : getFileIconId(ext),
    // size, createdAt, modifiedAt omitted for performance (no stat call)
    createdAt: '',
    modifiedAt: ''
  }
}

/**
 * Create artifact from path (for watcher events).
 * Uses fs.stat only to determine file vs directory type.
 * Size and timestamps are omitted for consistency with initial scan.
 */
async function createArtifactFromPath(
  fullPath: string,
  rootPath: string,
  spaceId: string
): Promise<CachedArtifact | null> {
  try {
    const stats = await fs.stat(fullPath)
    const ext = extname(fullPath)
    const name = basename(fullPath)
    const relativePath = relative(rootPath, fullPath)
    const isDir = stats.isDirectory()

    return {
      id: generateId(),
      spaceId,
      name,
      type: isDir ? 'folder' : 'file',
      path: fullPath,
      relativePath,
      extension: ext.replace('.', ''),
      icon: isDir ? 'folder' : getFileIconId(ext),
      // size, createdAt, modifiedAt omitted for consistency with initial scan
      createdAt: '',
      modifiedAt: ''
    }
  } catch (error) {
    console.error(`[ArtifactCache] Failed to create artifact for ${fullPath}:`, error)
    return null
  }
}

/**
 * Create tree node from Dirent (zero stat calls).
 */
function createTreeNodeFromDirent(
  entry: Dirent,
  dirPath: string,
  rootPath: string,
  depth: number
): CachedTreeNode {
  const fullPath = join(dirPath, entry.name)
  const ext = extname(entry.name)
  const relativePath = relative(rootPath, fullPath)
  const isDir = entry.isDirectory()

  return {
    id: generateId(),
    name: entry.name,
    type: isDir ? 'folder' : 'file',
    path: fullPath,
    relativePath,
    extension: ext.replace('.', ''),
    icon: isDir ? 'folder' : getFileIconId(ext),
    // size omitted for performance (no stat call)
    depth,
    children: isDir ? [] : undefined,
    childrenLoaded: false
  }
}

/**
 * Scan directory for immediate children only (sync from Dirent, zero stat calls)
 */
async function scanDirectoryShallow(
  dirPath: string,
  rootPath: string,
  spaceId: string,
  ig: Ignore | null = null
): Promise<CachedArtifact[]> {
  const startTime = performance.now()
  const artifacts: CachedArtifact[] = []

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })

    // Filter and create artifacts synchronously (no stat calls)
    for (const entry of entries) {
      if (shouldHide(entry.name)) continue
      if (ig) {
        const entryRelative = relative(rootPath, join(dirPath, entry.name))
        if (isIgnored(ig, entryRelative)) continue
      }
      artifacts.push(createArtifactFromDirent(entry, dirPath, rootPath, spaceId))
    }
  } catch (error) {
    console.error(`[ArtifactCache] Failed to scan directory ${dirPath}:`, error)
  }

  const elapsed = performance.now() - startTime
  console.log(`[ArtifactCache] ⏱️ scanDirectoryShallow: ${artifacts.length} items in ${elapsed.toFixed(1)}ms (path=${dirPath})`)

  return artifacts
}

/**
 * Scan directory and return tree nodes (first level only, zero stat calls)
 */
async function scanDirectoryTreeShallow(
  dirPath: string,
  rootPath: string,
  depth: number = 0,
  ig: Ignore | null = null
): Promise<CachedTreeNode[]> {
  const startTime = performance.now()
  const nodes: CachedTreeNode[] = []

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })

    // Sort: folders first, then files, alphabetically
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1
      if (!a.isDirectory() && b.isDirectory()) return 1
      return a.name.localeCompare(b.name)
    })

    // Filter and create nodes synchronously (no stat calls)
    // Order is preserved because for...of is synchronous and continue doesn't change order
    for (const entry of entries) {
      if (shouldHide(entry.name)) continue
      if (ig) {
        const entryRelative = relative(rootPath, join(dirPath, entry.name))
        if (isIgnored(ig, entryRelative)) continue
      }
      nodes.push(createTreeNodeFromDirent(entry, dirPath, rootPath, depth))
    }
    // No re-sort needed: synchronous for-loop preserves sorted order from entries

  } catch (error) {
    console.error(`[ArtifactCache] Failed to scan tree ${dirPath}:`, error)
  }

  const elapsed = performance.now() - startTime
  console.log(`[ArtifactCache] ⏱️ scanDirectoryTreeShallow: ${nodes.length} nodes in ${elapsed.toFixed(1)}ms (depth=${depth}, path=${dirPath})`)

  return nodes
}

// ============================================
// Native File Watcher (@parcel/watcher)
// ============================================

/**
 * Map @parcel/watcher event type to our event type.
 * Also detects directory vs file events.
 */
function mapEventType(event: WatcherEvent, isDir: boolean): ArtifactChangeEvent['type'] {
  switch (event.type) {
    case 'create':
      return isDir ? 'addDir' : 'add'
    case 'delete':
      return isDir ? 'unlinkDir' : 'unlink'
    case 'update':
      return 'change'
    default:
      return 'change'
  }
}

/**
 * Initialize native file watcher for a space.
 *
 * Key differences from chokidar:
 * - One OS-level handle for the entire directory tree (not one per subdirectory)
 * - Events are batched and debounced by the native backend automatically
 * - .gitignore rules are applied in JS on the batched events (not per-file)
 * - No depth limit needed -- OS-level recursive watching has zero overhead
 * - No polling, no awaitWriteFinish hacks -- pure native FS events
 */
async function initWatcher(cache: SpaceCache): Promise<void> {
  if (cache.subscription) {
    return // Already initialized
  }

  // Disk root detection - skip watcher to prevent system freeze
  if (isDiskRoot(cache.rootPath)) {
    console.warn(`[ArtifactCache] Disk root detected (${cache.rootPath}), skipping watcher initialization`)
    return
  }

  console.log(`[ArtifactCache] Initializing native watcher for space: ${cache.spaceId} at ${cache.rootPath}`)

  // Load .gitignore rules for this workspace
  cache.ignoreFilter = loadIgnoreRules(cache.rootPath)

  try {
    const subscription = await watcher.subscribe(
      cache.rootPath,
      async (err, events) => {
        if (err) {
          console.error(`[ArtifactCache] Watcher error for ${cache.spaceId}:`, err)
          return
        }

        // Filter events first
        const filteredEvents = events.filter(event => {
          const relativePath = relative(cache.rootPath, event.path)
          if (cache.ignoreFilter && isIgnored(cache.ignoreFilter, relativePath)) {
            return false
          }
          if (shouldHide(event.path)) {
            return false
          }
          return true
        })

        if (filteredEvents.length === 0) return

        // Group events by path to ensure same-path events are processed sequentially
        const eventsByPath = new Map<string, WatcherEvent[]>()
        for (const event of filteredEvents) {
          const existing = eventsByPath.get(event.path) || []
          existing.push(event)
          eventsByPath.set(event.path, existing)
        }

        // Process different paths in parallel, same path events sequentially
        await Promise.all(
          Array.from(eventsByPath.entries()).map(async ([, pathEvents]) => {
            // Process events for the same path sequentially to maintain order
            for (const event of pathEvents) {
              await processWatcherEvent(cache, event)
            }
          })
        )
      },
      {
        // @parcel/watcher ignore: paths matched in C++ layer, never reach JS.
        // CPP_LEVEL_IGNORE_DIRS contains universally-safe directories that are
        // NEVER user content (node_modules, __pycache__, .gradle, etc.).
        // Project-specific ignoring is handled by .gitignore filter above.
        ignore: CPP_LEVEL_IGNORE_DIRS.map(dir => join(cache.rootPath, dir))
      }
    )

    cache.subscription = subscription
    console.log(`[ArtifactCache] Native watcher active for space: ${cache.spaceId}`)
  } catch (error) {
    console.error(`[ArtifactCache] Failed to start native watcher for ${cache.spaceId}:`, error)

    // Notify renderer about the degraded state
    try {
      const mainWindow = getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('artifact:watcher-error', {
          spaceId: cache.spaceId,
          error: 'WATCHER_INIT_FAILED',
          message: 'File watcher initialization failed. File changes will not be detected automatically.'
        })
      }
    } catch (e) {
      // Ignore notification errors
    }
  }
}

/**
 * Process a single watcher event and emit change notifications.
 */
async function processWatcherEvent(cache: SpaceCache, event: WatcherEvent): Promise<void> {
  const { path: filePath, type: eventType } = event
  const relativePath = relative(cache.rootPath, filePath)

  if (eventType === 'delete') {
    // For deletes, we can't stat to check if it was a directory.
    // Check if we had it cached as a directory, otherwise treat as file.
    const wasCachedDir = cache.loadedDirs.has(filePath) ||
      cache.flatItems.get(filePath)?.type === 'folder'

    const changeType = wasCachedDir ? 'unlinkDir' : 'unlink'

    cache.flatItems.delete(filePath)
    cache.treeNodes.delete(filePath)
    cache.loadedDirs.delete(filePath)

    emitChange({
      type: changeType,
      path: filePath,
      relativePath,
      spaceId: cache.spaceId
    })
    return
  }

  // For create/update, stat the file to get metadata (watcher events need stat)
  const artifact = await createArtifactFromPath(filePath, cache.rootPath, cache.spaceId)
  if (!artifact) return

  const isDir = artifact.type === 'folder'
  const changeType = mapEventType(event, isDir)

  addToFlatItemsCache(cache, filePath, artifact)

  emitChange({
    type: changeType,
    path: filePath,
    relativePath,
    spaceId: cache.spaceId,
    item: artifact
  })
}

// ============================================
// Debounced IPC Broadcasting
// ============================================

// Pending events to be broadcast (grouped by spaceId)
const pendingBroadcastEvents = new Map<string, ArtifactChangeEvent[]>()
let broadcastTimer: ReturnType<typeof setTimeout> | null = null
const BROADCAST_DEBOUNCE_MS = 150

/**
 * Flush pending events to all clients
 */
function flushPendingBroadcasts(): void {
  if (pendingBroadcastEvents.size === 0) return

  // Collect all events
  const allEvents: ArtifactChangeEvent[] = []
  for (const events of pendingBroadcastEvents.values()) {
    allEvents.push(...events)
  }
  pendingBroadcastEvents.clear()

  // Broadcast batched events
  if (allEvents.length === 1) {
    // Single event - send as before for backwards compatibility
    broadcastToAllClients('artifact:changed', allEvents[0] as unknown as Record<string, unknown>)
  } else {
    // Multiple events - send as batch
    broadcastToAllClients('artifact:changed-batch', { events: allEvents } as unknown as Record<string, unknown>)
    // Also send individual events for backwards compatibility
    for (const event of allEvents) {
      broadcastToAllClients('artifact:changed', event as unknown as Record<string, unknown>)
    }
  }
}

/**
 * Emit change event to all listeners (with debounced IPC broadcast)
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
  const existing = pendingBroadcastEvents.get(event.spaceId) || []
  existing.push(event)
  pendingBroadcastEvents.set(event.spaceId, existing)

  // Reset debounce timer
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
    subscription: null,
    ignoreFilter: null,
    flatItems: new Map(),
    treeNodes: new Map(),
    loadedDirs: new Set(),
    lastUpdate: Date.now()
  }

  cacheMap.set(spaceId, cache)

  // Initialize watcher in background (don't block)
  initWatcher(cache).catch(error => {
    console.error(`[ArtifactCache] Background watcher init failed for ${spaceId}:`, error)
  })
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

  if (!cache.subscription) {
    initWatcher(cache).catch(error => {
      console.error(`[ArtifactCache] Background watcher init failed for ${spaceId}:`, error)
    })
  }
}

/**
 * Destroy cache for a space
 */
export async function destroySpaceCache(spaceId: string): Promise<void> {
  const cache = cacheMap.get(spaceId)
  if (!cache) return

  console.log(`[ArtifactCache] Destroying cache for space: ${spaceId}`)

  if (cache.subscription) {
    try {
      await cache.subscription.unsubscribe()
    } catch (error) {
      console.error(`[ArtifactCache] Error unsubscribing watcher for ${spaceId}:`, error)
    }
    cache.subscription = null
  }

  cache.ignoreFilter = null
  cache.flatItems.clear()
  cache.treeNodes.clear()
  cache.loadedDirs.clear()

  cacheMap.delete(spaceId)
}

/**
 * Get artifacts as flat list (for card view)
 * Only returns top-level items
 */
export async function listArtifacts(
  spaceId: string,
  rootPath: string,
  maxDepth: number = 1
): Promise<CachedArtifact[]> {
  console.log(`[ArtifactCache] listArtifacts for space: ${spaceId}`)

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

  // If cache is fresh (within 5 seconds), return cached items
  const now = Date.now()
  if (cache.flatItems.size > 0 && now - cache.lastUpdate < 5000) {
    console.log(`[ArtifactCache] Returning cached ${cache.flatItems.size} items`)
    return Array.from(cache.flatItems.values())
      .sort((a, b) => sortByName(a, b))
  }

  // Ensure .gitignore filter is loaded (may not be if watcher hasn't initialized yet)
  if (!cache.ignoreFilter) {
    cache.ignoreFilter = loadIgnoreRules(rootPath)
  }

  // Scan root directory with .gitignore filtering
  const artifacts = await scanDirectoryRecursive(rootPath, rootPath, spaceId, maxDepth, 0, cache.ignoreFilter)

  // Update cache
  cache.flatItems.clear()
  for (const artifact of artifacts) {
    cache.flatItems.set(artifact.path, artifact)
  }
  cache.lastUpdate = now

  // Sort by name (folders first, then alphabetically) since timestamps are not available
  return artifacts.sort((a, b) => sortByName(a, b))
}

/**
 * Recursively scan directory with depth limit (zero stat calls)
 */
async function scanDirectoryRecursive(
  dirPath: string,
  rootPath: string,
  spaceId: string,
  maxDepth: number,
  currentDepth: number,
  ig: Ignore | null
): Promise<CachedArtifact[]> {
  if (currentDepth >= maxDepth || !existsSync(dirPath)) {
    return []
  }

  const artifacts: CachedArtifact[] = []

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })

    // Filter entries first
    const filteredEntries = entries.filter(entry => {
      if (shouldHide(entry.name)) return false
      // Apply .gitignore filtering during scan to skip ignored subtrees entirely.
      // This is critical for performance: without this, scanning recurses into
      // directories like target/classes (Java) or node_modules (Node).
      if (ig) {
        const entryRelative = relative(rootPath, join(dirPath, entry.name))
        if (isIgnored(ig, entryRelative)) return false
      }
      return true
    })

    // Create artifacts synchronously (no stat calls)
    for (const entry of filteredEntries) {
      artifacts.push(createArtifactFromDirent(entry, dirPath, rootPath, spaceId))

      // Recursively scan subdirectories
      if (entry.isDirectory()) {
        const fullPath = join(dirPath, entry.name)
        const subItems = await scanDirectoryRecursive(
          fullPath, rootPath, spaceId, maxDepth, currentDepth + 1, ig
        )
        artifacts.push(...subItems)
      }
    }
  } catch (error) {
    console.error(`[ArtifactCache] Failed to scan ${dirPath}:`, error)
  }

  return artifacts
}

/**
 * Get artifacts as tree structure (lazy loading)
 */
export async function listArtifactsTree(
  spaceId: string,
  rootPath: string
): Promise<CachedTreeNode[]> {
  console.log(`[ArtifactCache] listArtifactsTree for space: ${spaceId}`)

  // Ensure cache is initialized
  if (!cacheMap.has(spaceId)) {
    await initSpaceCache(spaceId, rootPath)
  }

  const cache = cacheMap.get(spaceId)!
  if (!cache.ignoreFilter) {
    cache.ignoreFilter = loadIgnoreRules(rootPath)
  }

  // Scan root level only, with .gitignore filtering
  return scanDirectoryTreeShallow(rootPath, rootPath, 0, cache.ignoreFilter)
}

/**
 * Load children for a specific directory (lazy loading)
 */
export async function loadDirectoryChildren(
  spaceId: string,
  dirPath: string,
  rootPath: string
): Promise<CachedTreeNode[]> {
  console.log(`[ArtifactCache] Loading children for: ${dirPath}`)

  let cache = cacheMap.get(spaceId)
  if (!cache) {
    await initSpaceCache(spaceId, rootPath)
    cache = cacheMap.get(spaceId)!
  }

  if (!cache.ignoreFilter) {
    cache.ignoreFilter = loadIgnoreRules(rootPath)
  }

  // Calculate depth based on relative path
  const relativePath = relative(rootPath, dirPath)
  const depth = relativePath ? relativePath.split(/[\\/]/).length : 0

  const children = await scanDirectoryTreeShallow(dirPath, rootPath, depth + 1, cache.ignoreFilter)

  // Mark directory as loaded
  cache.loadedDirs.add(dirPath)

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
    watcherActive: cache.subscription !== null
  }
}

/**
 * Force refresh cache for a space
 */
export async function refreshCache(spaceId: string, rootPath: string): Promise<void> {
  console.log(`[ArtifactCache] Force refreshing cache for space: ${spaceId}`)

  const cache = cacheMap.get(spaceId)
  if (cache) {
    // Reload .gitignore in case it changed
    cache.ignoreFilter = loadIgnoreRules(rootPath)
    cache.flatItems.clear()
    cache.treeNodes.clear()
    cache.loadedDirs.clear()
    cache.lastUpdate = 0
  }
}

/**
 * Cleanup all caches (call on app exit)
 */
export async function cleanupAllCaches(): Promise<void> {
  console.log('[ArtifactCache] Cleaning up all caches')

  for (const spaceId of Array.from(cacheMap.keys())) {
    await destroySpaceCache(spaceId)
  }
}
