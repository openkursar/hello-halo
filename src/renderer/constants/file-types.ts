/**
 * File Type Utilities - Shared constants and functions for file type detection
 *
 * Used by:
 * - canvas-lifecycle.ts (Content Canvas file opening)
 * - ArtifactCard.tsx (Card view click handling)
 * - ArtifactTree.tsx (Tree view click handling)
 */

/**
 * Binary file extensions that should NOT be opened in Canvas
 * These will open with system application or download in web mode
 */
export const BINARY_EXTENSIONS = new Set([
  // Executables & Libraries
  'exe', 'dll', 'so', 'dylib', 'bin', 'app', 'msi', 'dmg', 'pkg',
  // Archives
  'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar', 'tgz',
  // Media (audio/video)
  'mp3', 'mp4', 'avi', 'mov', 'mkv', 'flv', 'wmv', 'wav', 'flac', 'aac', 'ogg',
  'm4a', 'm4v', 'webm',
  // Legacy/OpenDocument office formats (no in-canvas viewer; use external app).
  // docx/xlsx/xls/pptx are deliberately absent — Canvas has viewers for them.
  'doc', 'ppt', 'odt', 'ods', 'odp',
  // Fonts
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // Database
  'db', 'sqlite', 'sqlite3', 'mdb',
  // Compiled/Binary code
  'class', 'pyc', 'pyo', 'o', 'obj', 'a', 'lib',
  // Disk images
  'iso', 'img', 'vmdk', 'vdi',
])

/**
 * Office documents and PDFs, which open in a dedicated Canvas viewer.
 *
 * In remote/web mode these keep an explicit download control next to the
 * preview. Preview is an addition there, not a replacement: a user on another
 * device is more likely to want the file itself — to open it in real Office —
 * than to read it in a browser pane, and for .pptx the preview is only a
 * placeholder. Desktop needs no equivalent: the file is already on disk and
 * double-click opens it in the system application.
 */
export const DOCUMENT_EXTENSIONS = new Set([
  'xlsx', 'xls', 'docx', 'pptx', 'pdf',
])

export function isDocumentExtension(extension: string | undefined): boolean {
  return !!extension && DOCUMENT_EXTENSIONS.has(extension.toLowerCase())
}

/**
 * Check if extension is a known binary format
 */
export function isBinaryExtension(ext: string): boolean {
  return BINARY_EXTENSIONS.has(ext.toLowerCase())
}

/**
 * Check if a file can be opened in Canvas
 * Uses blacklist approach: anything NOT in binary list can be attempted
 */
export function canOpenInCanvas(extension: string | undefined): boolean {
  if (!extension) return true // Files without extension - try to open, backend will detect
  return !BINARY_EXTENSIONS.has(extension.toLowerCase())
}
