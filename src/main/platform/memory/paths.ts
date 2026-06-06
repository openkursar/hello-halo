/**
 * platform/memory -- Path Resolution
 *
 * Maps (caller, scope) pairs to filesystem paths.
 * This is the single source of truth for where memory files live.
 *
 * Path conventions (from architecture doc section 3.4):
 *
 *   user-memory:   {haloDir}/user-memory.md
 *   space-memory:  {spacePath}/.halo/memory.md
 *   app-memory:    {spacePath}/.halo/apps/{appId}/memory.md
 *
 * Each scope also has a memory/ subdirectory for archives:
 *   {basePath}/memory/   (session summaries, compaction archives)
 */

import { join, sep } from 'path'
import { getHaloDir } from '../../foundation/config.service'
import type { MemoryCallerScope, MemoryScopeType } from './types'

/** Memory file name (main file for each scope) */
const MEMORY_FILENAME = 'memory.md'

/** Subdirectory for compaction archives; session summaries go to memory/run/ */
const MEMORY_ARCHIVE_DIR = 'memory'

// ============================================================================
// Path Resolution
// ============================================================================

/**
 * Get the base directory for a given memory scope.
 *
 * The base directory is where memory.md and memory/ live.
 *
 * @param caller - Identity of the caller
 * @param scope  - Which memory scope
 * @returns Absolute path to the base directory
 * @throws If the scope requires an appId but none is provided
 */
export function getMemoryBaseDir(caller: MemoryCallerScope, scope: MemoryScopeType): string {
  switch (scope) {
    case 'user':
      // User memory lives directly in the halo data directory
      return getHaloDir()

    case 'space':
      // Space memory lives in the space's .halo directory
      return join(caller.spacePath, '.halo')

    case 'app': {
      if (!caller.appId) {
        throw new Error('Memory scope "app" requires an appId in the caller scope')
      }
      // App memory lives in the space's .halo/apps/{appId}/ directory
      return join(caller.spacePath, '.halo', 'apps', caller.appId)
    }

    default:
      throw new Error(`Unknown memory scope: ${scope as string}`)
  }
}

/**
 * Get the path to the main memory file (memory.md) for a given scope.
 *
 * Special case: user scope uses "user-memory.md" instead of "memory.md"
 * to avoid confusion with other files in the halo directory.
 */
export function getMemoryFilePath(caller: MemoryCallerScope, scope: MemoryScopeType): string {
  const baseDir = getMemoryBaseDir(caller, scope)

  if (scope === 'user') {
    return join(baseDir, 'user-memory.md')
  }

  return join(baseDir, MEMORY_FILENAME)
}

/**
 * Get the path to the memory archive directory (memory/).
 */
export function getMemoryArchiveDir(caller: MemoryCallerScope, scope: MemoryScopeType): string {
  const baseDir = getMemoryBaseDir(caller, scope)

  if (scope === 'user') {
    return join(baseDir, 'user-memory')
  }

  return join(baseDir, MEMORY_ARCHIVE_DIR)
}

/**
 * Resolve a relative path within the memory archive directory.
 *
 * Used when reading a specific file from the memory/ archive.
 * Validates that the resolved path stays within the archive directory
 * (prevents directory traversal attacks).
 *
 * @param caller - Identity of the caller
 * @param scope  - Which memory scope
 * @param relativePath - Relative file path (e.g., "2024-01-15-1430.md")
 * @returns Absolute path to the file
 * @throws If the path escapes the archive directory
 */
export function resolveArchivePath(
  caller: MemoryCallerScope,
  scope: MemoryScopeType,
  relativePath: string
): string {
  const archiveDir = getMemoryArchiveDir(caller, scope)
  const resolved = join(archiveDir, relativePath)

  // Security: prevent directory traversal.
  // Use archiveDir + sep to ensure a file named with archiveDir as prefix
  // (e.g. archiveDir + "evil") cannot bypass the check.
  if (!resolved.startsWith(archiveDir + sep)) {
    throw new Error(`Path traversal detected: "${relativePath}" escapes the memory archive directory`)
  }

  return resolved
}
