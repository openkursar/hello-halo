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
 * - listSpaces() validates paths in batch; invalid entries are cleaned up
 */

import { shell } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, renameSync } from 'fs'
import { getHaloDir, getTempSpacePath, getSpacesDir } from './config.service'
import { v4 as uuidv4 } from 'uuid'

// Re-export config helper for backward compatibility with existing imports
export { getSpacesDir } from './config.service'

// ============================================================================
// Types
// ============================================================================

interface Space {
  id: string
  name: string
  icon: string
  path: string
  isTemp: boolean
  createdAt: string
  updatedAt: string
  preferences?: SpacePreferences
  workingDir?: string  // Project directory for custom spaces (agent cwd, artifacts, file explorer)
}

interface SpaceLayoutPreferences {
  artifactRailExpanded?: boolean
  chatWidth?: number
}

interface SpacePreferences {
  layout?: SpaceLayoutPreferences
}

interface SpaceMeta {
  id: string
  name: string
  icon: string
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
  createdAt: string
  updatedAt: string
  workingDir?: string
  isTemp?: boolean  // true only for halo-temp (not persisted to disk)
}

interface SpaceIndexV3 {
  version: 3
  spaces: Record<string, SpaceIndexEntry>
}

// Module-level registry: in-memory working copy of spaces-index.json
let registry: Map<string, SpaceIndexEntry> | null = null

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
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    workingDir: meta.workingDir
  }
}

/**
 * Load space index from disk. Handles v3 (direct), v2 (migration), v1/missing (full scan).
 * Always registers halo-temp into the returned map.
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

  // v3: direct load
  if (raw && raw.version === 3 && raw.spaces && typeof raw.spaces === 'object') {
    const spaces = raw.spaces as Record<string, SpaceIndexEntry>
    for (const [id, entry] of Object.entries(spaces)) {
      if (entry && typeof entry.path === 'string' && typeof entry.name === 'string') {
        map.set(id, entry)
      }
    }
    console.log(`[Space] Index v3 loaded: ${map.size} spaces`)
    registerHaloTemp(map)
    return map
  }

  // v2: one-time migration (read each meta.json once)
  if (raw && raw.version === 2 && raw.spaces && typeof raw.spaces === 'object') {
    console.log('[Space] Migrating space index v2 -> v3...')
    const v2Spaces = raw.spaces as Record<string, { path: string }>
    for (const [id, v2Entry] of Object.entries(v2Spaces)) {
      if (!v2Entry || typeof v2Entry.path !== 'string') continue
      const meta = tryReadMeta(v2Entry.path)
      if (meta) {
        map.set(id, metaToEntry(meta, v2Entry.path))
      }
    }
    persistIndex(map)
    console.log(`[Space] Index v3 migration complete: ${map.size} spaces`)
    registerHaloTemp(map)
    return map
  }

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

  // Persist v3 format
  persistIndex(map)
  console.log(`[Space] Index v3 migration complete: ${map.size} spaces`)
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
 * Persist the registry Map to disk as v3 (atomic write via tmp + rename).
 * Excludes halo-temp (isTemp entries are memory-only).
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
    renameSync(tmpPath, indexPath)
  } catch (error) {
    console.error('[Space] Failed to persist index:', error)
    // Clean up tmp file if rename failed
    try { if (existsSync(tmpPath)) rmSync(tmpPath) } catch { /* ignore */ }
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
    path: entry.path,
    isTemp: !!entry.isTemp,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    workingDir: entry.workingDir
  }
}

/**
 * Build a Space object with preferences loaded from meta.json.
 */
function entryToSpaceWithPreferences(id: string, entry: SpaceIndexEntry): Space {
  const space = entryToSpace(id, entry)
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
 * Get a specific space with preferences loaded from meta.json (single disk read).
 * Use this only when preferences are needed (IPC/UI layer).
 */
export function getSpaceWithPreferences(spaceId: string): Space | null {
  const entry = getRegistry().get(spaceId)
  if (!entry) return null
  return entryToSpaceWithPreferences(spaceId, entry)
}

/**
 * List all spaces. Pure memory read — zero disk I/O.
 * Validates paths in batch; removes invalid entries.
 * Does NOT include preferences (not needed for dropdown display).
 */
export function listSpaces(): Space[] {
  const spaces: Space[] = []
  const invalidIds: string[] = []

  for (const [id, entry] of getRegistry()) {
    if (entry.isTemp) continue  // halo-temp is returned via getHaloSpace()

    if (!existsSync(entry.path)) {
      invalidIds.push(id)
      continue
    }
    spaces.push(entryToSpace(id, entry))
  }

  // Batch cleanup invalid entries
  if (invalidIds.length > 0) {
    for (const id of invalidIds) {
      console.warn(`[Space] Space ${id} path invalid, removing from index`)
      getRegistry().delete(id)
    }
    persistIndex(getRegistry())
  }

  spaces.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
  console.log('[Space] listSpaces: count=%d', spaces.length)
  return spaces
}

/**
 * Get all valid space paths (for security checks).
 * Pure memory read from registry — zero disk I/O.
 */
export function getAllSpacePaths(): string[] {
  const paths: string[] = []

  for (const [, entry] of getRegistry()) {
    paths.push(entry.path)
    if (entry.workingDir) {
      paths.push(entry.workingDir)
    }
  }

  return paths
}

/**
 * Create a new space. Registers in both memory and disk index.
 */
export function createSpace(input: { name: string; icon: string; customPath?: string }): Space {
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
    createdAt: now,
    updatedAt: now,
    workingDir
  }

  writeFileSync(join(spacePath, '.halo', 'meta.json'), JSON.stringify(meta, null, 2))

  // Register in index (memory + disk)
  const entry: SpaceIndexEntry = {
    path: spacePath,
    name: input.name,
    icon: input.icon,
    createdAt: now,
    updatedAt: now,
    workingDir
  }
  getRegistry().set(id, entry)
  persistIndex(getRegistry())

  console.log(`[Space] Created space ${id}: path=${spacePath}${workingDir ? `, workingDir=${workingDir}` : ''}`)

  return entryToSpace(id, entry)
}

/**
 * Delete a space. Removes from both memory and disk index.
 */
export function deleteSpace(spaceId: string): boolean {
  const entry = getRegistry().get(spaceId)
  if (!entry || entry.isTemp) return false

  const spacePath = entry.path
  const spacesDir = getSpacesDir()
  const isCentralized = spacePath.startsWith(spacesDir)

  try {
    if (isCentralized) {
      // Centralized storage (new spaces + default spaces): delete entire folder
      rmSync(spacePath, { recursive: true, force: true })
    } else {
      // Legacy custom path spaces: only delete .halo folder (preserve user's files)
      const haloDir = join(spacePath, '.halo')
      if (existsSync(haloDir)) {
        rmSync(haloDir, { recursive: true, force: true })
      }
    }

    // Unregister from index (memory + disk)
    getRegistry().delete(spaceId)
    persistIndex(getRegistry())

    return true
  } catch (error) {
    console.error(`[Space] Failed to delete space ${spaceId}:`, error)
    return false
  }
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
export function updateSpace(spaceId: string, updates: { name?: string; icon?: string }): Space | null {
  const entry = getRegistry().get(spaceId)
  if (!entry || entry.isTemp) return null

  try {
    // Update registry entry in memory
    if (updates.name) entry.name = updates.name
    if (updates.icon) entry.icon = updates.icon
    entry.updatedAt = new Date().toISOString()

    // Persist index
    persistIndex(getRegistry())

    // Write meta.json — read existing to preserve preferences
    const existingMeta = tryReadMeta(entry.path)
    const meta: SpaceMeta = {
      id: spaceId,
      name: entry.name,
      icon: entry.icon,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      preferences: existingMeta?.preferences,
      workingDir: entry.workingDir
    }
    writeFileSync(join(entry.path, '.halo', 'meta.json'), JSON.stringify(meta, null, 2))

    return entryToSpaceWithPreferences(spaceId, entry)
  } catch (error) {
    console.error('[Space] Failed to update space:', error)
    return null
  }
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
        ...preferences.layout
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
// Onboarding Functions
// ============================================================================

export function writeOnboardingArtifact(spaceId: string, fileName: string, content: string): boolean {
  const space = getSpace(spaceId)
  if (!space) {
    console.error(`[Space] writeOnboardingArtifact: Space not found: ${spaceId}`)
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

  try {
    const { v4: uuidv4 } = require('uuid')
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
