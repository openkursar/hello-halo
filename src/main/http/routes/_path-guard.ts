/**
 * Which paths a remote client may touch: writes stay inside a space, reads
 * also reach the knowledge base and the team folders. Every check resolves
 * symlinks, and a path that does not exist is refused.
 */

import type { Response } from 'express'
import { existsSync, realpathSync } from 'fs'
import { isAbsolute, relative, resolve } from 'path'
import { getTeamFolderRoot } from '../../foundation/config.service'
import { getAllSpacePaths } from '../../services/space.service'
import { getTlonRoot } from '../../services/tlon'

/**
 * Check if target path is inside base path.
 * Uses realpathSync to resolve symlinks and prevent symlink-based path traversal attacks.
 */
export function isPathInside(target: string, base: string): boolean {
  try {
    // Use realpathSync to resolve symlinks for security
    const realBase = realpathSync(base)
    const realTarget = realpathSync(target)
    const relativePath = relative(realBase, realTarget)
    return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
  } catch {
    // If path doesn't exist or can't be resolved, deny access
    return false
  }
}

/**
 * Check whether the target lies inside any of the base directories.
 * Resolves symlinks to prevent directory traversal via symlinks.
 */
function isWithinAnyBase(target: string, bases: string[]): boolean {
  // First check if path exists
  if (!existsSync(target)) {
    return false
  }

  try {
    const realTarget = realpathSync(target)
    const allowedBases = bases.filter(p => existsSync(p))
    return allowedBases.some(base => {
      try {
        const realBase = realpathSync(base)
        const relativePath = relative(realBase, realTarget)
        return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
      } catch {
        return false
      }
    })
  } catch {
    return false
  }
}

/** Check if target path is allowed for writes (inside any space directory). */
export function isPathAllowed(target: string): boolean {
  return isWithinAnyBase(target, getAllSpacePaths())
}

/**
 * Read access additionally covers the knowledge-base tree so remote citation
 * clicks can open source documents, and the team folders so a remote Team view
 * can download what a collaboration published there. Writes stay space-only
 * (isPathAllowed).
 */
export function isReadPathAllowed(target: string): boolean {
  return isWithinAnyBase(target, [...getAllSpacePaths(), getTlonRoot(), getTeamFolderRoot()])
}

export function validateFilePath(
  res: Response,
  filePath?: string,
  access: 'read' | 'write' = 'write'
): string | null {
  if (!filePath) {
    res.status(400).json({ success: false, error: 'Missing file path' })
    return null
  }

  const allowed = access === 'read' ? isReadPathAllowed(filePath) : isPathAllowed(filePath)
  if (!allowed) {
    res.status(403).json({ success: false, error: 'Access denied' })
    return null
  }

  return resolve(filePath)
}
