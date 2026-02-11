/**		      	    				  	  	  	 		 		       	 	 	         	 	    					 
 * Space Service - Manages workspaces/spaces
 *
 * Architecture:
 * - spaces-index.json (v2) stores id -> path mapping for O(1) lookups
 * - Module-level registry Map is the in-memory working copy of the index
 * - Lazy-loaded on first access; auto-migrates from v1 format if needed
 * - Mutations (create/delete) update both memory and disk atomically
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
// Space Index (v2) — id -> path registry
// ============================================================================

interface SpaceIndexEntry {
  path: string
}

interface SpaceIndexV2 {
  version: 2
  spaces: Record<string, SpaceIndexEntry>
}

// Module-level registry: in-memory working copy of spaces-index.json
let registry: Map<string, SpaceIndexEntry> | null = null

// LRU cache for Space objects (avoids repeated meta.json reads)
const MAX_SPACE_CACHE_SIZE = 10
const spaceCache = new Map<string, Space>()

function getSpaceIndexPath(): string {
  return join(getHaloDir(), 'spaces-index.json')
}

/**
 * Get the registry Map (lazy-loaded).
 * First call loads from disk and auto-migrates v1 format if needed.
 */
function getRegistry(): Map<string, SpaceIndexEntry> {
  if (!registry) {
    registry = loadSpaceIndex()
  }
  return registry
}

/**
 * Load space index from disk. Handles v2, v1 (migration), and missing file.
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

  // v2: direct load
  if (raw && raw.version === 2 && raw.spaces && typeof raw.spaces === 'object') {
    const spaces = raw.spaces as Record<string, SpaceIndexEntry>
    for (const [id, entry] of Object.entries(spaces)) {
      if (entry && typeof entry.path === 'string') {
        map.set(id, { path: entry.path })
      }
    }
    console.log(`[Space] Index v2 loaded: ${map.size} spaces`)
    return map
  }

  // v1 or missing: one-time migration via full scan
  console.log('[Space] Migrating space index to v2...')
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
          map.set(meta.id, { path: spacePath })
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
        map.set(meta.id, { path: customPath })
      }
    }
  }

  // Persist v2 format
  persistIndex(map)
  console.log(`[Space] Index v2 migration complete: ${map.size} spaces`)
  return map
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
 * Persist the registry Map to disk (atomic write via tmp + rename).
 */
function persistIndex(map: Map<string, SpaceIndexEntry>): void {
  const data: SpaceIndexV2 = {
    version: 2,
    spaces: Object.fromEntries(map)
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
// Halo Temp Space
// ============================================================================

const HALO_SPACE: Space = {
  id: 'halo-temp',
  name: 'Halo',
  icon: 'sparkles',
  path: '',
  isTemp: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
}

export function getHaloSpace(): Space {
  const tempPath = getTempSpacePath()

  let preferences: SpacePreferences | undefined
  const metaPath = join(tempPath, '.halo', 'meta.json')
  if (existsSync(metaPath)) {
    try {
      const meta: SpaceMeta = JSON.parse(readFileSync(metaPath, 'utf-8'))
      preferences = meta.preferences
    } catch {
      // Ignore parse errors
    }
  }

  return {
    ...HALO_SPACE,
    path: tempPath,
    preferences
  }
}

// ============================================================================
// Core Space Functions
// ============================================================================

/**
 * Load a space from a filesystem path (reads meta.json).
 */
function loadSpaceFromPath(spacePath: string): Space | null {
  const metaPath = join(spacePath, '.halo', 'meta.json')

  if (!existsSync(metaPath)) return null

  try {
    const meta: SpaceMeta = JSON.parse(readFileSync(metaPath, 'utf-8'))

    return {
      id: meta.id,
      name: meta.name,
      icon: meta.icon,
      path: spacePath,
      isTemp: false,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      preferences: meta.preferences,
      workingDir: meta.workingDir
    }
  } catch (error) {
    console.error(`[Space] Failed to read space meta for ${spacePath}:`, error)
    return null
  }
}

/**
 * Get a specific space by ID. Uses LRU cache to avoid repeated disk reads.
 */
export function getSpace(spaceId: string): Space | null {
  if (spaceId === 'halo-temp') {
    return getHaloSpace()
  }

  // Check LRU cache (move to end if hit, maintaining LRU order)
  if (spaceCache.has(spaceId)) {
    const cached = spaceCache.get(spaceId)!
    spaceCache.delete(spaceId)
    spaceCache.set(spaceId, cached)
    return cached
  }

  const entry = getRegistry().get(spaceId)
  if (!entry) return null

  // Validate path still exists (user may have deleted folder externally)
  if (!existsSync(join(entry.path, '.halo', 'meta.json'))) {
    console.warn(`[Space] Space ${spaceId} path invalid (${entry.path}), removing from index`)
    getRegistry().delete(spaceId)
    persistIndex(getRegistry())
    return null
  }

  const space = loadSpaceFromPath(entry.path)
  if (!space) return null

  console.log(`[Space] Loaded "${space.name}" (${spaceId}): path=${entry.path}, workingDir=${space.workingDir ?? '(none)'}`)

  // Add to LRU cache, evict oldest if full
  spaceCache.set(spaceId, space)
  if (spaceCache.size > MAX_SPACE_CACHE_SIZE) {
    const oldest = spaceCache.keys().next().value
    if (oldest) spaceCache.delete(oldest)
  }

  return space
}

/**
 * List all spaces. Iterates registry, reads meta.json for each.
 * Does NOT calculate stats (callers request stats separately if needed).
 */
export function listSpaces(): Space[] {
  const spaces: Space[] = []
  let dirty = false

  for (const [id, entry] of getRegistry()) {
    const space = loadSpaceFromPath(entry.path)
    if (space) {
      spaces.push(space)
    } else {
      // Path no longer valid, clean up
      console.warn(`[Space] Space ${id} at ${entry.path} no longer valid, removing from index`)
      getRegistry().delete(id)
      dirty = true
    }
  }

  if (dirty) {
    persistIndex(getRegistry())
  }

  spaces.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
  return spaces
}

/**
 * Get all valid space paths (for security checks).
 * Reads from registry instead of scanning filesystem.
 */
export function getAllSpacePaths(): string[] {
  const paths: string[] = [getTempSpacePath()]

  for (const [, entry] of getRegistry()) {
    if (existsSync(entry.path)) {
      paths.push(entry.path)
    }
    // Include workingDir for project-linked spaces (agent/artifact operations happen there)
    const meta = tryReadMeta(entry.path)
    if (meta?.workingDir && existsSync(meta.workingDir)) {
      paths.push(meta.workingDir)
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
  getRegistry().set(id, { path: spacePath })
  persistIndex(getRegistry())

  console.log(`[Space] Created space ${id}: path=${spacePath}${workingDir ? `, workingDir=${workingDir}` : ''}`)

  return {
    id,
    name: input.name,
    icon: input.icon,
    path: spacePath,
    isTemp: false,
    createdAt: now,
    updatedAt: now,
    workingDir
  }
}

/**
 * Delete a space. Removes from both memory and disk index.
 */
export function deleteSpace(spaceId: string): boolean {
  const space = getSpace(spaceId)
  if (!space || space.isTemp) {
    return false
  }

  const spacePath = space.path
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

    // Unregister from index (memory + disk) and invalidate cache
    getRegistry().delete(spaceId)
    spaceCache.delete(spaceId)
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
  const space = getSpace(spaceId)

  if (space) {
    if (space.isTemp) {
      const artifactsPath = join(space.path, 'artifacts')
      if (existsSync(artifactsPath)) {
        shell.openPath(artifactsPath)
        return true
      }
    } else {
      // Open workingDir (project folder) if available, otherwise data path
      const targetPath = space.workingDir || space.path
      shell.openPath(targetPath)
      return true
    }
  }

  return false
}

/**
 * Update space metadata. Returns updated space directly (no redundant getSpace call).
 */
export function updateSpace(spaceId: string, updates: { name?: string; icon?: string }): Space | null {
  const space = getSpace(spaceId)

  if (!space || space.isTemp) {
    return null
  }

  const metaPath = join(space.path, '.halo', 'meta.json')

  try {
    const meta: SpaceMeta = JSON.parse(readFileSync(metaPath, 'utf-8'))

    if (updates.name) meta.name = updates.name
    if (updates.icon) meta.icon = updates.icon
    meta.updatedAt = new Date().toISOString()

    writeFileSync(metaPath, JSON.stringify(meta, null, 2))

    // Build updated space and refresh cache
    const updatedSpace: Space = {
      id: space.id,
      name: meta.name,
      icon: meta.icon,
      path: space.path,
      isTemp: false,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      preferences: meta.preferences,
      workingDir: meta.workingDir
    }
    spaceCache.set(spaceId, updatedSpace)

    return updatedSpace
  } catch (error) {
    console.error('[Space] Failed to update space:', error)
    return null
  }
}

/**
 * Update space preferences (layout settings, etc.).
 * Returns updated space directly (no redundant getSpace call).
 */
export function updateSpacePreferences(
  spaceId: string,
  preferences: Partial<SpacePreferences>
): Space | null {
  const space = getSpace(spaceId)

  if (!space) {
    return null
  }

  const metaPath = join(space.path, '.halo', 'meta.json')

  try {
    // Ensure .halo directory exists for temp space
    const haloDir = join(space.path, '.halo')
    if (!existsSync(haloDir)) {
      mkdirSync(haloDir, { recursive: true })
    }

    // Load or create meta
    let meta: SpaceMeta
    if (existsSync(metaPath)) {
      meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
    } else {
      meta = {
        id: space.id,
        name: space.name,
        icon: space.icon,
        createdAt: space.createdAt,
        updatedAt: new Date().toISOString()
      }
    }

    // Deep merge preferences
    meta.preferences = meta.preferences || {}

    if (preferences.layout) {
      meta.preferences.layout = {
        ...meta.preferences.layout,
        ...preferences.layout
      }
    }

    meta.updatedAt = new Date().toISOString()

    writeFileSync(metaPath, JSON.stringify(meta, null, 2))

    console.log(`[Space] Updated preferences for ${spaceId}:`, preferences)

    // Build updated space and refresh cache (skip temp space)
    const updatedSpace: Space = {
      id: space.id,
      name: meta.name,
      icon: meta.icon,
      path: space.path,
      isTemp: space.isTemp,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      preferences: meta.preferences,
      workingDir: meta.workingDir
    }
    if (!space.isTemp) {
      spaceCache.set(spaceId, updatedSpace)
    }

    return updatedSpace
  } catch (error) {
    console.error('[Space] Failed to update space preferences:', error)
    return null
  }
}

/**
 * Get space preferences only (lightweight, without full space load).
 */
export function getSpacePreferences(spaceId: string): SpacePreferences | null {
  const space = getSpace(spaceId)

  if (!space) {
    return null
  }

  const metaPath = join(space.path, '.halo', 'meta.json')

  try {
    if (existsSync(metaPath)) {
      const meta: SpaceMeta = JSON.parse(readFileSync(metaPath, 'utf-8'))
      return meta.preferences || null
    }
    return null
  } catch (error) {
    console.error('[Space] Failed to get space preferences:', error)
    return null
  }
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
