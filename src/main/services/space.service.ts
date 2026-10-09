/**
 * Space Service - Manages workspaces/spaces
 *
 * Architecture:
 * - spaces-index.json (v3) stores space registration info (name/icon/path/timestamps)
 * - Preferences are NOT stored in the index — they live in per-space meta.json
 * - Module-level registry Map is the in-memory working copy of the index
 * - Halo temp space is unified into the registry (no special branches)
 * - Lazy-loaded on first access; auto-migrates from v1/v2 formats if needed
 * - Mutations (create/update/delete) update both memory and disk atomically
 * - listSpaces() is pure memory read — zero disk I/O after startup
 * - getSpace() is pure memory read — zero disk I/O (no preferences)
 * - getSpaceWithPreferences() loads preferences from meta.json on demand (for IPC/UI only)
 * - listSpaces() preserves missing paths and marks them unavailable instead of deleting entries
 */

import { shell } from 'electron'
import { isAbsolute, join, resolve } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, renameSync } from 'fs'
import { getHaloDir, getTempSpacePath, getSpacesDir, resolveClaudeConfigDir } from '../foundation/config.service'
import { canonicalPath, isPathWithin } from '../foundation/path-containment'
import { v4 as uuidv4 } from 'uuid'
import { getAppManager } from './app-bridge'
import { getTaskStateService } from '../platform/task-state'
import { resolveMemoryLayout, type MemoryLayout } from '../platform/memory'
import { resolveMemorySettings, sanitizeMemorySettings, type MemorySettings, type ResolvedMemorySettings } from '../../shared/types/memory'

// Re-export config helper for backward compatibility with existing imports
export { getSpacesDir } from '../foundation/config.service'

// ============================================================================
// Types
// ============================================================================

interface Space {
  id: string
  name: string
  icon: string
  color?: string
  path: string
  isTemp: boolean
  createdAt: string
  updatedAt: string
  lastActiveAt?: string  // Last user activity time (cached, used for sorting/display)
  preferences?: SpacePreferences
  workingDir?: string  // Project directory for custom spaces (agent cwd, artifacts, file explorer)
  isMissing?: boolean  // True when the space data path is currently unavailable (e.g. external drive disconnected)
  sortOrder?: number  // User-defined display order (lower = earlier). Absent = legacy fallback to activity sort.
}

interface SpaceLayoutPreferences {
  artifactRailExpanded?: boolean
  chatWidth?: number
}

interface SpacePreferences {
  layout?: SpaceLayoutPreferences
  /** Memory shared by this space's conversations; see shared/types/memory. */
  memory?: MemorySettings
}

interface SpaceMeta {
  id: string
  name: string
  icon: string
  color?: string
  createdAt: string
  updatedAt: string
  preferences?: SpacePreferences
  workingDir?: string  // Project directory for custom spaces
}

// ============================================================================
// Space Index (v3) — id -> space registration info (no preferences)
// ============================================================================

interface SpaceIndexEntry {
  path: string
  name: string
  icon: string
  color?: string
  createdAt: string
  updatedAt: string
  lastActiveAt?: string  // Last user activity time (cached, derivable from conversation data)
  workingDir?: string
  sortOrder?: number  // User-defined display order; absent on legacy entries
  isTemp?: boolean  // true only for halo-temp (not persisted to disk)
}

interface SpaceIndexV3 {
  version: 3
  spaces: Record<string, SpaceIndexEntry>
}

// Module-level registry: in-memory working copy of spaces-index.json
let registry: Map<string, SpaceIndexEntry> | null = null

/** For testing only — reset the in-memory registry so the next read reloads from disk */
export function _resetSpaceRegistry(): void {
  registry = null
}

function getSpaceIndexPath(): string {
  return join(getHaloDir(), 'spaces-index.json')
}

/**
 * Get the registry Map (lazy-loaded).
 * First call loads from disk and auto-migrates v1/v2 formats if needed.
 */
function getRegistry(): Map<string, SpaceIndexEntry> {
  if (!registry) {
    registry = loadSpaceIndex()
  }
  return registry
}

/**
 * Build a SpaceIndexEntry from a SpaceMeta + path (for migration only).
 */
function metaToEntry(meta: SpaceMeta, spacePath: string): SpaceIndexEntry {
  return {
    path: spacePath,
    name: meta.name,
    icon: meta.icon,
    color: meta.color,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    workingDir: meta.workingDir
  }
}

/**
 * Backfill missing sortOrder on persisted entries using the activity-sort
 * order. Eliminates the mixed-state window where some entries have sortOrder
 * and others don't — that window would force listSpaces() onto its activity
 * fallback and let a newly created space's position diverge between the
 * backend index and the in-memory store.
 *
 * Runs once at load; persisted entries stay stable across restarts. Entries
 * keep the order they would have had under the legacy activity sort, so users
 * upgrading see no visual change. After this runs, listSpaces()'s activity
 * fallback never triggers in practice.
 */
function backfillSortOrder(map: Map<string, SpaceIndexEntry>): number {
  const persistable: SpaceIndexEntry[] = []
  for (const [, entry] of map) {
    if (entry.isTemp) continue
    if (typeof entry.sortOrder !== 'number') persistable.push(entry)
  }
  if (persistable.length === 0) return 0

  persistable.sort((a, b) => {
    const aTime = new Date(a.lastActiveAt || a.updatedAt).getTime()
    const bTime = new Date(b.lastActiveAt || b.updatedAt).getTime()
    return bTime - aTime
  })

  let next = 0
  // Place backfilled entries after any that already have sortOrder, so a
  // partial-legacy index (some dragged, some not) keeps dragged order intact.
  for (const [, entry] of map) {
    if (entry.isTemp) continue
    if (typeof entry.sortOrder === 'number' && entry.sortOrder >= next) {
      next = entry.sortOrder + 1
    }
  }
  for (const entry of persistable) {
    entry.sortOrder = next++
  }
  console.log(`[Space] Backfilled sortOrder for ${persistable.length} entries`)
  return persistable.length
}

/**
 * Load space index from disk. Handles v3 (direct), v2 (migration), v1/missing (full scan).
 * Always registers halo-temp into the returned map.
 *
 * Single write point: every path only builds the map; sortOrder backfill and
 * the (at most one) persistIndex happen at the shared exit.
 */
function loadSpaceIndex(): Map<string, SpaceIndexEntry> {
  const indexPath = getSpaceIndexPath()
  const map = new Map<string, SpaceIndexEntry>()

  // Try to read existing file
  let raw: Record<string, unknown> | null = null
  if (existsSync(indexPath)) {
    try {
      raw = JSON.parse(readFileSync(indexPath, 'utf-8'))
    } catch {
      console.warn('[Space] spaces-index.json corrupted, will rebuild')
    }
  }

  // True when the on-disk format was upgraded and must be re-persisted even
  // if backfillSortOrder finds nothing to do.
  let migrated = false

  if (raw && raw.version === 3 && raw.spaces && typeof raw.spaces === 'object') {
    // v3: direct load
    const spaces = raw.spaces as Record<string, SpaceIndexEntry>
    for (const [id, entry] of Object.entries(spaces)) {
      if (entry && typeof entry.path === 'string' && typeof entry.name === 'string') {
        map.set(id, entry)
      }
    }
    console.log(`[Space] Index v3 loaded: ${map.size} spaces`)
  } else if (raw && raw.version === 2 && raw.spaces && typeof raw.spaces === 'object') {
    // v2: one-time migration (read each meta.json once)
    console.log('[Space] Migrating space index v2 -> v3...')
    const v2Spaces = raw.spaces as Record<string, { path: string }>
    for (const [id, v2Entry] of Object.entries(v2Spaces)) {
      if (!v2Entry || typeof v2Entry.path !== 'string') continue
      const meta = tryReadMeta(v2Entry.path)
      if (meta) {
        map.set(id, metaToEntry(meta, v2Entry.path))
      }
    }
    migrated = true
    console.log(`[Space] Index v3 migration complete: ${map.size} spaces`)
  } else {
    // v1 or missing: one-time migration via full scan
    console.log('[Space] Migrating space index to v3 (full scan)...')
    const oldCustomPaths: string[] = Array.isArray((raw as Record<string, unknown>)?.customPaths)
      ? (raw as { customPaths: string[] }).customPaths
      : []

    // Scan default spaces directory
    const spacesDir = getSpacesDir()
    if (existsSync(spacesDir)) {
      try {
        for (const dir of readdirSync(spacesDir)) {
          const spacePath = join(spacesDir, dir)
          try {
            if (!statSync(spacePath).isDirectory()) continue
          } catch { continue }
          const meta = tryReadMeta(spacePath)
          if (meta) {
            map.set(meta.id, metaToEntry(meta, spacePath))
          }
        }
      } catch (error) {
        console.error('[Space] Error scanning spaces directory:', error)
      }
    }

    // Scan old custom paths
    for (const customPath of oldCustomPaths) {
      if (existsSync(customPath)) {
        const meta = tryReadMeta(customPath)
        if (meta && !map.has(meta.id)) {
          map.set(meta.id, metaToEntry(meta, customPath))
        }
      }
    }

    migrated = true
    console.log(`[Space] Index v3 migration complete: ${map.size} spaces`)
  }

  const backfilled = backfillSortOrder(map)
  if (migrated || backfilled > 0) {
    // Not fatal: the next start migrates/backfills again from the same input.
    try { persistIndex(map) } catch { /* logged in persistIndex */ }
  }
  registerHaloTemp(map)
  return map
}

/**
 * Register halo-temp into the registry (in-memory only, never persisted to index).
 */
function registerHaloTemp(map: Map<string, SpaceIndexEntry>): void {
  const tempPath = getTempSpacePath()
  const now = new Date().toISOString()
  map.set('halo-temp', {
    path: tempPath,
    name: 'Halo',
    icon: 'sparkles',
    createdAt: now,
    updatedAt: now,
    isTemp: true
  })
}

/**
 * Try to read SpaceMeta from a path. Returns null on any failure.
 */
function tryReadMeta(spacePath: string): SpaceMeta | null {
  const metaPath = join(spacePath, '.halo', 'meta.json')
  if (!existsSync(metaPath)) return null
  try {
    return JSON.parse(readFileSync(metaPath, 'utf-8'))
  } catch {
    return null
  }
}

/**
 * On Windows, replacing a file another process holds open (an antivirus or
 * indexer scanning it) fails with one of these until that process lets go.
 */
const TRANSIENT_LOCK_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400]

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!code || !TRANSIENT_LOCK_CODES.has(code) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw error
      console.warn(`[Space] Index rename hit ${code}, retry ${attempt + 1}/${RENAME_RETRY_DELAYS_MS.length}`)
      sleepSync(RENAME_RETRY_DELAYS_MS[attempt])
    }
  }
}

/**
 * Persist the registry Map to disk as v3 (atomic write via tmp + rename).
 * Excludes halo-temp (isTemp entries are memory-only).
 *
 * Throws when the index could not be written, since a change kept only in
 * memory would come back undone on the next start. Callers undo or report it.
 */
function persistIndex(map: Map<string, SpaceIndexEntry>): void {
  // Filter out halo-temp before persisting
  const persistable: Record<string, SpaceIndexEntry> = {}
  for (const [id, entry] of map) {
    if (!entry.isTemp) {
      persistable[id] = entry
    }
  }

  const data: SpaceIndexV3 = {
    version: 3,
    spaces: persistable
  }
  const indexPath = getSpaceIndexPath()
  const tmpPath = indexPath + '.tmp'
  try {
    // Ensure parent directory exists
    const dir = getHaloDir()
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(tmpPath, JSON.stringify(data, null, 2))
    renameWithRetry(tmpPath, indexPath)
  } catch (error) {
    console.error(`[Space] Failed to persist index ${indexPath}:`, error)
    // Clean up tmp file if rename failed
    try { if (existsSync(tmpPath)) rmSync(tmpPath) } catch { /* ignore */ }
    throw error
  }
}

/**
 * Apply a change to the given registry entries and persist it. If persisting
 * fails, the entries are put back as they were and the error is rethrown.
 */
function commitRegistryChange(ids: Iterable<string>, change: () => void): void {
  const reg = getRegistry()
  const before = new Map<string, SpaceIndexEntry | undefined>()
  for (const id of ids) {
    const entry = reg.get(id)
    before.set(id, entry ? { ...entry } : undefined)
  }
  change()
  try {
    persistIndex(reg)
  } catch (error) {
    for (const [id, saved] of before) {
      if (saved) reg.set(id, saved)
      else reg.delete(id)
    }
    throw error
  }
}

// ============================================================================
// Core Space Functions
// ============================================================================

/**
 * Build a Space object from a registry entry (without preferences).
 */
function entryToSpace(id: string, entry: SpaceIndexEntry): Space {
  return {
    id,
    name: entry.name,
    icon: entry.icon,
    color: entry.color,
    path: entry.path,
    isTemp: !!entry.isTemp,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    lastActiveAt: entry.lastActiveAt,
    workingDir: entry.workingDir,
    sortOrder: entry.sortOrder,
    isMissing: !entry.isTemp && !existsSync(entry.path)
  }
}

/**
 * Build a Space object with preferences loaded from meta.json.
 */
function entryToSpaceWithPreferences(id: string, entry: SpaceIndexEntry): Space {
  const space = entryToSpace(id, entry)
  if (space.isMissing) {
    return space
  }
  const meta = tryReadMeta(entry.path)
  if (meta?.preferences) {
    space.preferences = meta.preferences
  }
  return space
}

/**
 * Get Halo temp space. Delegates to unified getSpace().
 */
export function getHaloSpace(): Space {
  return getSpace('halo-temp')!
}

/**
 * Get a specific space by ID. Pure memory read from registry — zero disk I/O.
 * Does NOT include preferences. Use getSpaceWithPreferences() if you need them.
 */
export function getSpace(spaceId: string): Space | null {
  const entry = getRegistry().get(spaceId)
  if (!entry) return null
  return entryToSpace(spaceId, entry)
}

/**
 * Canonical working directory of a space — the boundary that defines
 * "what belongs to this space" for the AI agent (cwd), the Artifact panel,
 * the file explorer, and outbound file gates.
 *
 * Why a dedicated helper: `space.path` is Halo's internal record-keeping
 * location (memory, session JSONL, app data). The user's actual workspace
 * — and the AI's cwd — is `workingDir` when set. Treating these as the same
 * is a category error that has caused real bugs (e.g. file-export gates
 * rejecting files the AI legitimately produced in its own cwd).
 *
 * Read-only: never creates directories. Callers that need the directory
 * to exist (agent spawn, artifact mkdir) must handle that themselves.
 *
 * @returns Absolute path, or '' for unknown spaceIds. Callers passing the
 *          result to `FileExportGate` can rely on the gate filtering empty
 *          roots; other callers must handle '' explicitly.
 */
export function getSpaceDir(spaceId: string): string {
  if (spaceId === 'halo-temp') {
    return join(getTempSpacePath(), 'artifacts')
  }
  const space = getSpace(spaceId)
  if (!space) return ''
  return space.workingDir || space.path
}

/**
 * Get a specific space with preferences loaded from meta.json (single disk read).
 * Use this only when preferences are needed (IPC/UI layer).
 */
export function getSpaceWithPreferences(spaceId: string): Space | null {
  const entry = getRegistry().get(spaceId)
  if (!entry) return null
  return entryToSpaceWithPreferences(spaceId, entry)
}

/**
 * List all spaces. Pure memory read — zero disk I/O except lightweight path existence checks.
 * Missing paths are preserved in the index and returned with isMissing=true so users can
 * reconnect external drives or recover legacy spaces without data loss.
 * Does NOT include preferences (not needed for dropdown display).
 */
export function listSpaces(): Space[] {
  const spaces: Space[] = []
  let missingCount = 0

  for (const [id, entry] of getRegistry()) {
    if (entry.isTemp) continue  // halo-temp is returned via getHaloSpace()

    const space = entryToSpace(id, entry)
    if (space.isMissing) {
      missingCount += 1
      console.warn(`[Space] Space ${id} path unavailable, preserving index entry: ${entry.path}`)
    }
    spaces.push(space)
  }

  // Sort: prefer user-defined sortOrder when every space has one; otherwise
  // fall back to most-recent-activity (legacy behavior). This lets old indexes
  // work without migration — once reorderSpaces() runs, all entries get
  // sortOrder and the activity fallback stops applying.
  const allHaveSortOrder = spaces.every(s => s.sortOrder !== undefined)
  if (allHaveSortOrder) {
    spaces.sort((a, b) => (a.sortOrder! - b.sortOrder!))
  } else {
    spaces.sort((a, b) => {
      const aTime = new Date(a.lastActiveAt || a.updatedAt).getTime()
      const bTime = new Date(b.lastActiveAt || b.updatedAt).getTime()
      return bTime - aTime
    })
  }
  console.log('[Space] listSpaces: count=%d missing=%d sortedBy=%s', spaces.length, missingCount, allHaveSortOrder ? 'sortOrder' : 'activity')
  return spaces
}

/**
 * Get all valid space paths (for security checks).
 * Pure memory read from registry — zero disk I/O.
 */
export function getAllSpacePaths(): string[] {
  const paths: string[] = []

  for (const [, entry] of getRegistry()) {
    if (existsSync(entry.path)) {
      paths.push(entry.path)
    }
    if (entry.workingDir && existsSync(entry.workingDir)) {
      paths.push(entry.workingDir)
    }
  }

  return paths
}

/**
 * Create a new space. Registers in both memory and disk index.
 */
export function createSpace(input: { name: string; icon: string; color?: string; customPath?: string }): Space {
  const id = uuidv4()
  const now = new Date().toISOString()

  // Data always stored centrally under ~/.halo/spaces/{id}/
  const spacePath = join(getSpacesDir(), id)

  // customPath is stored as workingDir (agent cwd, artifact root, file explorer)
  const workingDir = input.customPath || undefined

  // Create directories
  mkdirSync(spacePath, { recursive: true })
  mkdirSync(join(spacePath, '.halo'), { recursive: true })
  mkdirSync(join(spacePath, '.halo', 'conversations'), { recursive: true })

  // Create meta file
  const meta: SpaceMeta = {
    id,
    name: input.name,
    icon: input.icon,
    color: input.color,
    createdAt: now,
    updatedAt: now,
    workingDir
  }

  writeFileSync(join(spacePath, '.halo', 'meta.json'), JSON.stringify(meta, null, 2))

  // Register in index (memory + disk). New spaces sort first: give the new
  // space a sortOrder smaller than every existing space so it lands at the
  // top of the list immediately after creation (a created space must be
  // visible without scrolling). reorderSpaces() re-normalizes to 0..n on the
  // next drag, so the negative values here never accumulate unbounded.
  let minSortOrder = Infinity
  for (const [, existing] of getRegistry()) {
    if (existing.isTemp || typeof existing.sortOrder !== 'number') continue
    if (existing.sortOrder < minSortOrder) minSortOrder = existing.sortOrder
  }
  const sortOrder = minSortOrder === Infinity ? 0 : minSortOrder - 1
  const entry: SpaceIndexEntry = {
    path: spacePath,
    name: input.name,
    icon: input.icon,
    color: input.color,
    createdAt: now,
    updatedAt: now,
    workingDir,
    sortOrder
  }
  try {
    commitRegistryChange([id], () => getRegistry().set(id, entry))
  } catch (error) {
    try { rmSync(spacePath, { recursive: true, force: true }) } catch { /* unregistered, unreachable */ }
    throw error
  }

  console.log(`[Space] Created space ${id}: path=${spacePath}${workingDir ? `, workingDir=${workingDir}` : ''}`)

  return entryToSpace(id, entry)
}

/**
 * Remove a space's registry entry without touching anything on disk —
 * distinct from deleteSpace(), which deletes files. For spaces whose path
 * is currently unreachable (external drive unplugged, etc.): the data isn't
 * gone, Halo just stops tracking it. Reconnecting the drive and creating a
 * space pointed at the same path won't recover the old id/conversations —
 * this only clears the dead entry, it doesn't preserve a path to relink one.
 *
 * Refuses to run on a space whose path actually resolves — this is not a
 * shortcut around deleteSpace()'s confirmation flow for live spaces.
 */
export function forgetSpace(spaceId: string): boolean {
  const entry = getRegistry().get(spaceId)
  if (!entry || entry.isTemp) return false
  if (existsSync(entry.path)) {
    console.warn(`[Space] forgetSpace refused: path still resolves for ${spaceId}`)
    return false
  }

  try {
    commitRegistryChange([spaceId], () => getRegistry().delete(spaceId))
  } catch {
    return false
  }
  console.log(`[Space] Forgot unreachable space ${spaceId} (path: ${entry.path})`)
  return true
}

/**
 * Delete a space. The index on disk drops it first, so a delete that cannot
 * be recorded fails before anything is removed rather than coming back on
 * the next start. Files left behind by a failed removal are only logged.
 */
export async function deleteSpace(spaceId: string): Promise<boolean> {
  const entry = getRegistry().get(spaceId)
  if (!entry || entry.isTemp) return false

  const spacePath = entry.path
  const spacesDir = getSpacesDir()
  const isCentralized = spacePath.startsWith(spacesDir)

  // The entry stays in memory until cleanup is done: app cleanup resolves
  // this space's paths through the registry.
  const withoutSpace = new Map(getRegistry())
  withoutSpace.delete(spaceId)
  try {
    persistIndex(withoutSpace)
  } catch {
    console.error(`[Space] Delete of ${spaceId} aborted: the index could not be written`)
    return false
  }

  // Clean up all apps belonging to this space from the database
  // This must happen BEFORE deleting files to ensure proper cleanup
  const manager = getAppManager()
  if (manager) {
    try {
      await manager.deleteAppsInSpace(spaceId)
    } catch (err) {
      console.error(`[Space] Failed to cleanup apps for space ${spaceId}:`, err)
    }
  }

  try {
    getTaskStateService()?.deleteAllInSpace(spaceId)
  } catch (err) {
    console.error(`[Space] Failed to cleanup task state for space ${spaceId}:`, err)
  }

  getRegistry().delete(spaceId)
  // Another write during the app cleanup above may have put the entry back on disk.
  try { persistIndex(getRegistry()) } catch { /* logged in persistIndex */ }

  // Centralized storage: delete the entire folder. Legacy custom path: only
  // its .halo folder, keeping the user's files.
  const target = isCentralized ? spacePath : join(spacePath, '.halo')
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
  } catch (err) {
    console.error(`[Space] Deleted space ${spaceId} but could not remove ${target}:`, err)
  }

  return true
}

/**
 * Open space folder in file explorer.
 */
export function openSpaceFolder(spaceId: string): boolean {
  const entry = getRegistry().get(spaceId)
  if (!entry) return false

  if (entry.isTemp) {
    const artifactsPath = join(entry.path, 'artifacts')
    if (existsSync(artifactsPath)) {
      shell.openPath(artifactsPath)
      return true
    }
  } else {
    // Open workingDir (project folder) if available, otherwise data path
    const targetPath = entry.workingDir || entry.path
    shell.openPath(targetPath)
    return true
  }

  return false
}

/**
 * Update space metadata. Updates registry (memory + disk) and meta.json.
 */
export function updateSpace(spaceId: string, updates: { name?: string; icon?: string; color?: string }): Space | null {
  const entry = getRegistry().get(spaceId)
  if (!entry || entry.isTemp) return null

  try {
    commitRegistryChange([spaceId], () => {
      if (updates.name) entry.name = updates.name
      if (updates.icon) entry.icon = updates.icon
      if (updates.color !== undefined) entry.color = updates.color
      entry.updatedAt = new Date().toISOString()
    })
    writeMeta(spaceId, entry)

    return entryToSpaceWithPreferences(spaceId, entry)
  } catch (error) {
    console.error('[Space] Failed to update space:', error)
    return null
  }
}

/**
 * Write meta.json from the registry entry, keeping the preferences already
 * stored there. Replaced whole, so a failed write leaves the old file intact.
 */
function writeMeta(spaceId: string, entry: SpaceIndexEntry): void {
  const existingMeta = tryReadMeta(entry.path)
  const meta: SpaceMeta = {
    id: spaceId,
    name: entry.name,
    icon: entry.icon,
    color: entry.color,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    preferences: existingMeta?.preferences,
    workingDir: entry.workingDir
  }
  const metaPath = join(entry.path, '.halo', 'meta.json')
  const tmpPath = `${metaPath}.tmp`
  try {
    writeFileSync(tmpPath, JSON.stringify(meta, null, 2))
    renameSync(tmpPath, metaPath)
  } catch (error) {
    try { rmSync(tmpPath, { force: true }) } catch { /* ignore */ }
    throw error
  }
}

/**
 * Why `workingDir` cannot be a space's working directory, or null when it can:
 * an existing folder, given by its full path, outside the folders where Halo and
 * the engine keep their own data — except `ownDataDir`, the space's own data
 * folder, where a space without a project folder works. Nothing is created
 * here — Halo neither makes nor removes the user's folders.
 */
export function workingDirProblem(workingDir: string, ownDataDir?: string): string | null {
  if (!workingDir || !isAbsolute(workingDir)) return 'Choose a folder by its full path.'
  const dir = resolve(workingDir)
  try {
    if (!statSync(dir).isDirectory()) return 'That is not a folder.'
  } catch {
    return 'That folder does not exist.'
  }
  const isOwnDataDir = ownDataDir !== undefined && canonicalPath(dir) === canonicalPath(ownDataDir)
  if (!isOwnDataDir && [getHaloDir(), resolveClaudeConfigDir()].some(root => isPathWithin(dir, root))) {
    return 'That folder holds Halo’s own data. Choose a project folder.'
  }
  return null
}

/**
 * Why this space's working directory cannot be changed to `workingDir`, or null
 * when it can. A space whose own data folder is gone — a legacy space kept in
 * the project folder that was deleted — has nothing left to point elsewhere.
 */
export function workingDirChangeProblem(spaceId: string, workingDir: string): string | null {
  const entry = getRegistry().get(spaceId)
  if (!entry || entry.isTemp) return 'This workspace’s folder cannot be changed.'
  const problem = workingDirProblem(workingDir, entry.path)
  if (problem) return problem
  if (!existsSync(join(entry.path, '.halo'))) {
    return 'This workspace’s conversations and settings were kept in a folder that is no longer there; choosing another folder cannot bring them back. Restore or reconnect that folder first.'
  }
  return null
}

/**
 * Point a space at another working directory. Only the record changes: the
 * agent, the file panel and the space's digital humans follow it, and Halo's
 * own data for the space stays where it is. The default space keeps its own.
 * meta.json is written first, so a failure changes nothing.
 *
 * @returns the updated space, or null for an unknown or default space
 * @throws Error with a readable reason when the folder cannot be used or the
 *   record cannot be written
 */
export function setSpaceWorkingDir(spaceId: string, workingDir: string): Space | null {
  const entry = getRegistry().get(spaceId)
  if (!entry || entry.isTemp) return null
  const problem = workingDirChangeProblem(spaceId, workingDir)
  if (problem) throw new Error(problem)

  const changed: SpaceIndexEntry = { ...entry, workingDir: resolve(workingDir), updatedAt: new Date().toISOString() }
  writeMeta(spaceId, changed)
  try {
    commitRegistryChange([spaceId], () => {
      entry.workingDir = changed.workingDir
      entry.updatedAt = changed.updatedAt
    })
  } catch (error) {
    try { writeMeta(spaceId, getRegistry().get(spaceId)!) } catch { /* the index stays authoritative */ }
    throw error
  }
  console.log(`[Space] Working directory of ${spaceId} is now ${entry.workingDir}`)
  return entryToSpaceWithPreferences(spaceId, entry)
}

/**
 * Persist a user-defined space ordering. Assigns sortOrder = index for each id
 * in the given order. Callers must pass the full dedicated-space id list in the
 * desired order; partial lists are rejected to prevent sortOrder collisions
 * that would corrupt the persisted index.
 */
export function reorderSpaces(spaceIds: string[]): Space[] {
  const registry = getRegistry()

  // Reject partial lists: assigning sortOrder only to a subset leaves the
  // unlisted spaces with stale values that collide with the new ones.
  const expectedIds = new Set<string>()
  for (const [id, entry] of registry) {
    if (!entry.isTemp) expectedIds.add(id)
  }
  if (spaceIds.length !== expectedIds.size || !spaceIds.every(id => expectedIds.has(id))) {
    const reason = spaceIds.length !== expectedIds.size
      ? `length ${spaceIds.length} !== expected ${expectedIds.size}`
      : 'unknown id present'
    console.warn('[Space] reorderSpaces rejected partial list: %s', reason)
    return listSpaces()
  }

  commitRegistryChange(spaceIds, () => {
    for (let i = 0; i < spaceIds.length; i++) {
      const entry = registry.get(spaceIds[i])
      if (!entry || entry.isTemp) continue
      entry.sortOrder = i
    }
  })
  console.log('[Space] reorderSpaces: assigned sortOrder to %d spaces', spaceIds.length)
  return listSpaces()
}

/**
 * Update space preferences (layout settings, etc.).
 * Only writes meta.json — does NOT write index (preferences are not in the index).
 */
export function updateSpacePreferences(
  spaceId: string,
  preferences: Partial<SpacePreferences>
): Space | null {
  const entry = getRegistry().get(spaceId)
  if (!entry) return null

  const metaPath = join(entry.path, '.halo', 'meta.json')

  try {
    // Ensure .halo directory exists
    const haloDir = join(entry.path, '.halo')
    if (!existsSync(haloDir)) {
      mkdirSync(haloDir, { recursive: true })
    }

    // Read existing meta to get current preferences
    const existingMeta = tryReadMeta(entry.path)
    const currentPrefs: SpacePreferences = existingMeta?.preferences || {}

    // Deep merge preferences
    if (preferences.layout) {
      currentPrefs.layout = {
        ...currentPrefs.layout,
        ...sanitizeLayoutPreferences(preferences.layout)
      }
    }
    if (preferences.memory) {
      currentPrefs.memory = {
        ...currentPrefs.memory,
        ...sanitizeMemorySettings(preferences.memory)
      }
    }

    // Write meta.json with merged preferences
    const meta: SpaceMeta = {
      id: spaceId,
      name: entry.name,
      icon: entry.icon,
      createdAt: entry.createdAt,
      updatedAt: entry.isTemp ? entry.updatedAt : new Date().toISOString(),
      preferences: currentPrefs,
      workingDir: entry.workingDir
    }

    // Update updatedAt in registry for non-temp spaces
    if (!entry.isTemp) {
      entry.updatedAt = meta.updatedAt
    }

    writeFileSync(metaPath, JSON.stringify(meta, null, 2))

    console.log(`[Space] Updated preferences for ${spaceId}:`, preferences)

    // Return space with freshly merged preferences
    const space = entryToSpace(spaceId, entry)
    space.preferences = currentPrefs
    return space
  } catch (error) {
    console.error('[Space] Failed to update space preferences:', error)
    return null
  }
}

/**
 * Get space preferences only. Reads from meta.json on demand.
 */
export function getSpacePreferences(spaceId: string): SpacePreferences | null {
  const entry = getRegistry().get(spaceId)
  if (!entry) return null

  const meta = tryReadMeta(entry.path)
  return meta?.preferences || null
}

// ============================================================================
// Space Memory
// ============================================================================

/** The recognised layout preferences of an untrusted object (an IPC or HTTP body). */
function sanitizeLayoutPreferences(input: unknown): SpaceLayoutPreferences {
  const out: SpaceLayoutPreferences = {}
  if (!input || typeof input !== 'object') return out
  const raw = input as Record<string, unknown>
  if (typeof raw.artifactRailExpanded === 'boolean') out.artifactRailExpanded = raw.artifactRailExpanded
  if (typeof raw.chatWidth === 'number' && Number.isFinite(raw.chatWidth)) out.chatWidth = raw.chatWidth
  return out
}

/** A space's memory settings, defaults filled in (memory and auto-consolidation on). */
export function getSpaceMemorySettings(spaceId: string): ResolvedMemorySettings {
  return resolveMemorySettings(getSpacePreferences(spaceId)?.memory)
}

export function isSpaceMemoryEnabled(spaceId: string): boolean {
  return getSpaceMemorySettings(spaceId).enabled
}

/**
 * Where a space's memory lives: in the space's data directory, never the
 * working directory, so it stays out of the user's project files.
 */
export function getSpaceMemoryLayout(spaceId: string): MemoryLayout | null {
  const space = getSpace(spaceId)
  if (!space || space.isMissing) return null
  return resolveMemoryLayout({ type: 'user', spaceId, spacePath: space.path }, 'space')
}

// ============================================================================
// Space Activity Tracking
// ============================================================================

// Throttle state: per-space timers to coalesce disk writes.
// When touchSpaceActivity is called, memory is updated immediately.
// Disk persist is throttled: first touch writes immediately, subsequent
// touches within ACTIVITY_THROTTLE_MS only update memory. A trailing
// timer ensures the final value is always persisted.
const ACTIVITY_THROTTLE_MS = 60_000
const activityTimers = new Map<string, NodeJS.Timeout>()
const activityDirty = new Set<string>()  // Spaces with in-memory updates not yet persisted

/**
 * Record user activity in a space.
 *
 * Called from conversation.service when a user creates a conversation or
 * sends a message. Updates lastActiveAt in the in-memory registry immediately;
 * disk writes are throttled to at most once per ACTIVITY_THROTTLE_MS per space.
 *
 * Safe to call at high frequency (e.g. during streaming) — only the first
 * call within the throttle window triggers a disk write; a trailing timer
 * guarantees the final value is persisted.
 */
function persistActivity(spaceId: string): boolean {
  try {
    persistIndex(getRegistry())
    activityDirty.delete(spaceId)
    return true
  } catch {
    activityDirty.add(spaceId)
    return false
  }
}

export function touchSpaceActivity(spaceId: string): void {
  const entry = getRegistry().get(spaceId)
  if (!entry || entry.isTemp) return

  const now = new Date().toISOString()
  entry.lastActiveAt = now

  // If there's already a pending trailing timer, the space is within the
  // throttle window — just mark dirty and let the timer handle persist.
  if (activityTimers.has(spaceId)) {
    activityDirty.add(spaceId)
    return
  }

  // First touch in this window: persist immediately and start trailing timer.
  // A failed write leaves the space dirty, so the trailing timer tries again.
  if (persistActivity(spaceId)) console.log(`[Space] Activity recorded for ${spaceId}`)

  // Set trailing timer: when it fires, persist if any new touches arrived.
  const timer = setTimeout(() => {
    activityTimers.delete(spaceId)
    if (activityDirty.has(spaceId) && persistActivity(spaceId)) {
      console.log(`[Space] Activity flushed (trailing) for ${spaceId}`)
    }
  }, ACTIVITY_THROTTLE_MS)

  // Prevent timer from keeping the process alive during shutdown
  timer.unref()
  activityTimers.set(spaceId, timer)
}

/**
 * Flush all pending activity timestamps to disk.
 *
 * Called during graceful shutdown (cleanupExtendedServices) to ensure
 * in-memory lastActiveAt values are not lost. Clears all throttle timers.
 */
export function flushSpaceActivity(): void {
  // Clear all pending timers
  for (const [spaceId, timer] of activityTimers) {
    clearTimeout(timer)
    activityTimers.delete(spaceId)
  }

  // If any spaces have dirty (un-persisted) activity, write once
  if (activityDirty.size > 0) {
    activityDirty.clear()
    try {
      persistIndex(getRegistry())
      console.log('[Space] Activity flushed on shutdown')
    } catch { /* logged in persistIndex; only timestamps are lost */ }
  }
}

/** For testing only — reset activity throttle state */
export function _resetActivityState(): void {
  for (const timer of activityTimers.values()) {
    clearTimeout(timer)
  }
  activityTimers.clear()
  activityDirty.clear()
}

// ============================================================================
// Onboarding Functions
// ============================================================================

export function writeOnboardingArtifact(spaceId: string, fileName: string, content: string): boolean {
  const space = getSpace(spaceId)
  if (!space) {
    console.error(`[Space] writeOnboardingArtifact: Space not found: ${spaceId}`)
    return false
  }

  if (space.isMissing) {
    console.error(`[Space] writeOnboardingArtifact: Space path unavailable: ${spaceId}`)
    return false
  }

  try {
    const artifactsDir = space.isTemp
      ? join(space.path, 'artifacts')
      : (space.workingDir || space.path)

    mkdirSync(artifactsDir, { recursive: true })

    const filePath = join(artifactsDir, fileName)
    writeFileSync(filePath, content, 'utf-8')

    console.log(`[Space] writeOnboardingArtifact: Saved ${fileName} to ${filePath}`)
    return true
  } catch (error) {
    console.error(`[Space] writeOnboardingArtifact failed:`, error)
    return false
  }
}

export function saveOnboardingConversation(
  spaceId: string,
  userMessage: string,
  aiResponse: string
): string | null {
  const space = getSpace(spaceId)
  if (!space) {
    console.error(`[Space] saveOnboardingConversation: Space not found: ${spaceId}`)
    return null
  }

  if (space.isMissing) {
    console.error(`[Space] saveOnboardingConversation: Space path unavailable: ${spaceId}`)
    return null
  }

  try {
    const conversationId = uuidv4()
    const now = new Date().toISOString()

    const conversationsDir = space.isTemp
      ? join(space.path, 'conversations')
      : join(space.path, '.halo', 'conversations')

    mkdirSync(conversationsDir, { recursive: true })

    const conversation = {
      id: conversationId,
      title: 'Welcome to Halo',
      createdAt: now,
      updatedAt: now,
      messages: [
        {
          id: uuidv4(),
          role: 'user',
          content: userMessage,
          timestamp: now
        },
        {
          id: uuidv4(),
          role: 'assistant',
          content: aiResponse,
          timestamp: now
        }
      ]
    }

    const filePath = join(conversationsDir, `${conversationId}.json`)
    writeFileSync(filePath, JSON.stringify(conversation, null, 2), 'utf-8')

    console.log(`[Space] saveOnboardingConversation: Saved to ${filePath}`)
    return conversationId
  } catch (error) {
    console.error(`[Space] saveOnboardingConversation failed:`, error)
    return null
  }
}
