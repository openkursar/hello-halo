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
 * Tree update event pushed to renderer with pre-computed data.
 * The renderer can apply these directly without any IPC round-trips.
 */
export interface ArtifactTreeUpdateEvent {
  spaceId: string
  updatedDirs: Array<{ dirPath: string; children: CachedTreeNode[] }>
  changes: ArtifactChangeEvent[]
}

/**
 * Space cache entry
 */
interface SpaceCache {
  spaceId: string
  rootPath: string
  subscription: AsyncSubscription | null
  // Tracks in-flight watcher initialization to prevent duplicate subscriptions.
  // Without this, concurrent calls to initWatcher() can race past the
  // `if (cache.subscription)` guard before the first subscribe() resolves.
  watcherPromise: Promise<void> | null
  ignoreFilter: Ignore | null
  // Cache for flat list (only top-level items for card view)
  flatItems: Map<string, CachedArtifact>
  // Cache for tree structure: key = directory absolute path, value = sorted children
  // Only directories in loadedDirs (or root) have entries
  treeNodes: Map<string, CachedTreeNode[]>
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
 * Create a CachedTreeNode from a CachedArtifact.
 * Used by watcher events to insert new items into treeNodes cache.
 */
function createTreeNodeFromArtifact(
  artifact: CachedArtifact,
  depth: number
): CachedTreeNode {
  return {
    id: generateId(),
    name: artifact.name,
    type: artifact.type,
    path: artifact.path,
    relativePath: artifact.relativePath,
    extension: artifact.extension,
    icon: artifact.icon,
    depth,
    children: artifact.type === 'folder' ? [] : undefined,
    childrenLoaded: false
  }
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

  // Prevent concurrent initialization — return the in-flight promise if one exists
  if (cache.watcherPromise) {
    return cache.watcherPromise
  }

  // Disk root detection - skip watcher to prevent system freeze
  if (isDiskRoot(cache.rootPath)) {
    console.warn(`[ArtifactCache] Disk root detected (${cache.rootPath}), skipping watcher initialization`)
    return
  }

  console.log(`[ArtifactCache] Initializing native watcher for space: ${cache.spaceId} at ${cache.rootPath}`)

  // Store the promise so concurrent callers can await/deduplicate
  const doInit = async (): Promise<void> => {
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
    } finally {
      // Clear the promise so future calls (after destroy/re-init) can proceed
      cache.watcherPromise = null
    }
  }

  cache.watcherPromise = doInit()
  return cache.watcherPromise
}

/**
 * Recursively remove a directory and all its descendant entries from treeNodes and loadedDirs.
 * Called when a tracked directory is deleted.
 */
function removeTreeNodeDescendants(cache: SpaceCache, dirPath: string): void {
  // Remove the directory's own children entry
  cache.treeNodes.delete(dirPath)
  cache.loadedDirs.delete(dirPath)

  // Find and remove all descendant entries (keys that start with dirPath + separator)
  const prefix = dirPath + sep
  for (const key of Array.from(cache.treeNodes.keys())) {
    if (key.startsWith(prefix)) {
      cache.treeNodes.delete(key)
      cache.loadedDirs.delete(key)
    }
  }
}

/**
 * Process a single watcher event: update flatItems + incrementally update treeNodes.
 *
 * Key design: treeNodes is a dir->children map. For each event, we only touch the
 * parent directory's children array if the parent is tracked (i.e. has been expanded).
 * If the parent is NOT tracked, we skip treeNodes update entirely — the scan will
 * happen on first expand via loadDirectoryChildren().
 */
async function processWatcherEvent(cache: SpaceCache, event: WatcherEvent): Promise<void> {
  const { path: filePath, type: eventType } = event
  const relativePath = relative(cache.rootPath, filePath)
  const parentDir = getParentPath(filePath)
  const parentIsTracked = cache.treeNodes.has(parentDir)

  if (eventType === 'delete') {
    // For deletes, we can't stat to check if it was a directory.
    // Check caches to determine type.
    const wasCachedDir = cache.loadedDirs.has(filePath) ||
      cache.flatItems.get(filePath)?.type === 'folder'
    const changeType = wasCachedDir ? 'unlinkDir' : 'unlink'

    // 1. Remove from flatItems
    cache.flatItems.delete(filePath)

    // 2. If parent is tracked: filter out the deleted path from parent's children
    if (parentIsTracked) {
      const parentChildren = cache.treeNodes.get(parentDir)!
      cache.treeNodes.set(parentDir, parentChildren.filter(n => n.path !== filePath))
    }

    // 3. If deleted path was a directory: remove its treeNodes entry + all descendants
    if (wasCachedDir) {
      removeTreeNodeDescendants(cache, filePath)
    }

    emitChange({
      type: changeType,
      path: filePath,
      relativePath,
      spaceId: cache.spaceId
    })
    return
  }

  // For create/update, stat the file to get metadata
  const artifact = await createArtifactFromPath(filePath, cache.rootPath, cache.spaceId)
  if (!artifact) return

  const isDir = artifact.type === 'folder'
  const changeType = mapEventType(event, isDir)

  // 1. Update flatItems
  addToFlatItemsCache(cache, filePath, artifact)

  // 2. Incremental treeNodes update (only if parent dir is tracked/expanded)
  if (parentIsTracked) {
    const parentChildren = cache.treeNodes.get(parentDir)!
    // Calculate depth from relative path
    const relPath = relative(cache.rootPath, filePath)
    const depth = relPath ? relPath.split(/[\\/]/).length - 1 : 0

    // Upsert: check if node already exists (handles duplicate create events from OS,
    // e.g. FSEvents may fire create+create across two callback batches for a single file)
    const existingIdx = parentChildren.findIndex(n => n.path === filePath)

    if (existingIdx !== -1) {
      // Node exists: replace in-place, preserving children/childrenLoaded for expanded folders
      const existing = parentChildren[existingIdx]
      const updatedNode = createTreeNodeFromArtifact(artifact, depth)
      if (existing.type === 'folder' && updatedNode.type === 'folder') {
        updatedNode.children = existing.children
        updatedNode.childrenLoaded = existing.childrenLoaded
      }
      parentChildren[existingIdx] = updatedNode
    } else {
      // New node: insert and re-sort
      parentChildren.push(createTreeNodeFromArtifact(artifact, depth))
      sortTreeNodes(parentChildren)
    }
  }

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

// Pending events to be broadcast (grouped by spaceId, deduped by path)
// Outer key: spaceId, inner key: file path → last event for that path
const pendingBroadcastEvents = new Map<string, Map<string, ArtifactChangeEvent>>()
let broadcastTimer: ReturnType<typeof setTimeout> | null = null
const BROADCAST_DEBOUNCE_MS = 150

/**
 * Flush pending events to all clients.
 *
 * Smart batching: for each spaceId, collect unique parent directories that are tracked
 * in treeNodes and build an `updatedDirs` payload with pre-computed children.
 * This means 5 file changes in `/src/components/` become 1 `artifact:tree-update`
 * with 1 `updatedDirs` entry.
 *
 * Also sends individual `artifact:changed` events for backwards compatibility (card view).
 */
function flushPendingBroadcasts(): void {
  if (pendingBroadcastEvents.size === 0) return

  for (const [spaceId, eventsMap] of pendingBroadcastEvents.entries()) {
    const dedupedEvents = Array.from(eventsMap.values())
    const cache = cacheMap.get(spaceId)

    // Build updatedDirs: collect unique parent dirs that are tracked in treeNodes
    const updatedDirs: Array<{ dirPath: string; children: CachedTreeNode[] }> = []

    if (cache) {
      const seenDirs = new Set<string>()
      for (const event of dedupedEvents) {
        const parentDir = getParentPath(event.path)
        if (!seenDirs.has(parentDir) && cache.treeNodes.has(parentDir)) {
          seenDirs.add(parentDir)
          // Read pre-computed children directly from cache (O(1))
          updatedDirs.push({
            dirPath: parentDir,
            children: cache.treeNodes.get(parentDir)!
          })
        }
      }
    }

    // Emit tree-update event with pre-computed data (primary channel for tree view)
    if (updatedDirs.length > 0 || dedupedEvents.length > 0) {
      const treeUpdateEvent: ArtifactTreeUpdateEvent = {
        spaceId,
        updatedDirs,
        changes: dedupedEvents
      }
      broadcastToAllClients('artifact:tree-update', treeUpdateEvent as unknown as Record<string, unknown>)
    }

    // Also send individual artifact:changed events for backwards compat (card view)
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
 * This normalizes duplicate OS events (e.g. @parcel/watcher firing create+create
 * for atomic save) before they reach any downstream consumer (tree view, card view).
 * Same approach as VS Code's file watcher coalescing.
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

  // Queue event for debounced broadcast, deduplicating by path.
  // Use a Map<path, event> so duplicate paths naturally collapse to last-write-wins.
  if (!pendingBroadcastEvents.has(event.spaceId)) {
    pendingBroadcastEvents.set(event.spaceId, new Map())
  }
  pendingBroadcastEvents.get(event.spaceId)!.set(event.path, event)

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
    watcherPromise: null,
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

  if (!cache.subscription && !cache.watcherPromise) {
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

  // Wait for any in-flight initialization before destroying
  if (cache.watcherPromise) {
    await cache.watcherPromise.catch(() => {})
    cache.watcherPromise = null
  }

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
 * Get artifacts as tree structure (lazy loading).
 * Returns cached children for rootPath on cache hit (Map.get, O(1)).
 * On miss, scans disk once and populates the cache.
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
    console.log(`[ArtifactCache] listArtifactsTree CACHE HIT: ${cached.length} nodes`)
    return cached
  }

  if (!cache.ignoreFilter) {
    cache.ignoreFilter = loadIgnoreRules(rootPath)
  }

  // Cache miss: scan root level only, then populate cache
  console.log(`[ArtifactCache] listArtifactsTree CACHE MISS, scanning: ${rootPath}`)
  const nodes = await scanDirectoryTreeShallow(rootPath, rootPath, 0, cache.ignoreFilter)

  // Store in cache (rootPath -> children)
  cache.treeNodes.set(rootPath, nodes)
  cache.loadedDirs.add(rootPath)

  return nodes
}

/**
 * Load children for a specific directory (lazy loading).
 * Returns cached children on cache hit (O(1)).
 * On miss, scans disk and populates cache. Re-checks cache after async scan
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
    console.log(`[ArtifactCache] loadDirectoryChildren CACHE HIT: ${cached.length} nodes (${dirPath})`)
    return cached
  }

  if (!cache.ignoreFilter) {
    cache.ignoreFilter = loadIgnoreRules(rootPath)
  }

  // Calculate depth based on relative path
  const relPath = relative(rootPath, dirPath)
  const depth = relPath ? relPath.split(/[\\/]/).length : 0

  // Cache miss: scan from disk
  console.log(`[ArtifactCache] loadDirectoryChildren CACHE MISS, scanning: ${dirPath}`)
  const children = await scanDirectoryTreeShallow(dirPath, rootPath, depth + 1, cache.ignoreFilter)

  // Race condition guard: watcher may have populated the cache during the await.
  // Prefer watcher's version since it's more up-to-date.
  const watcherVersion = cache.treeNodes.get(dirPath)
  if (watcherVersion) {
    console.log(`[ArtifactCache] loadDirectoryChildren: watcher populated cache during scan, using watcher version`)
    cache.loadedDirs.add(dirPath)
    return watcherVersion
  }

  // Store in cache
  cache.treeNodes.set(dirPath, children)
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
