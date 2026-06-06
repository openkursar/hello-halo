/**
 * AI Browser Download Utilities
 *
 * Shared filename sanitization and unique path resolution used by both
 * the BrowserContext download tracking and the DaemonBrowserManager.
 */

import * as path from 'path'
import * as fs from 'fs'

/**
 * Sanitize a filename to prevent path traversal and invalid characters.
 *
 * - Strips directory components via path.basename()
 * - Removes null bytes and control characters
 * - Removes leading dots (hidden files / directory traversal)
 * - Replaces Windows reserved characters (: * ? " < > |)
 * - Handles Windows reserved names (CON, PRN, NUL, etc.)
 * - Truncates to 200 characters to avoid filesystem limits
 * - Falls back to 'download' if empty after sanitization
 */
export function sanitizeFilename(name: string): string {
  // Strip directory components
  let safe = path.basename(name)
  // Remove null bytes and control characters
  safe = safe.replace(/[\x00-\x1f]/g, '')
  // Remove leading dots (hidden files / traversal)
  safe = safe.replace(/^\.+/, '')
  // Replace Windows reserved characters
  safe = safe.replace(/[:<>"|?*]/g, '_')
  // Strip trailing dots and spaces (Windows disallows these)
  safe = safe.replace(/[\s.]+$/, '')
  // Handle Windows reserved names (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
  const reservedPattern = /^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\..+)?$/i
  if (reservedPattern.test(safe)) {
    safe = `_${safe}`
  }
  // Truncate to 200 characters (leave room for dedup suffixes and extension)
  if (safe.length > 200) {
    const ext = path.extname(safe)
    const base = safe.slice(0, 200 - ext.length)
    safe = base + ext
  }
  // Collapse empty to default
  if (!safe) safe = 'download'
  return safe
}

/**
 * Resolve a unique file path, appending (1), (2), etc. if the file already exists.
 * Upper bound of 999 to prevent infinite loops, with timestamp fallback.
 */
export function resolveUniquePath(dir: string, filename: string): string {
  let filePath = path.join(dir, filename)
  if (!fs.existsSync(filePath)) return filePath

  const ext = path.extname(filename)
  const base = path.basename(filename, ext)

  for (let i = 1; i <= 999; i++) {
    filePath = path.join(dir, `${base} (${i})${ext}`)
    if (!fs.existsSync(filePath)) return filePath
  }

  // Fallback with timestamp
  return path.join(dir, `${base}_${Date.now()}${ext}`)
}
