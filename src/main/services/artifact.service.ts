/**
 * Artifact Service - Scans and manages files created by the agent
 * Provides real-time artifact discovery and file information
 *
 * PERFORMANCE OPTIMIZED:
 * - Async functions for non-blocking I/O
 * - Lazy loading support for tree view
 * - Integration with artifact-cache.service for file watching
 */

import { statSync, existsSync, realpathSync, readFileSync, writeFileSync, openSync, readSync, closeSync } from 'fs'
import { join, extname, basename, sep } from 'path'
import { getTempSpacePath } from './config.service'
import { getSpace } from './space.service'
import {
  listArtifacts as listArtifactsCached,
  listArtifactsTree as listArtifactsTreeCached,
  loadDirectoryChildren,
  initSpaceCache,
  ensureSpaceCache,
  onArtifactChange,
  type CachedArtifact,
  type CachedTreeNode,
  type ArtifactChangeEvent
} from './artifact-cache.service'

export interface Artifact {
  id: string
  spaceId: string
  conversationId: string
  name: string
  type: 'file' | 'folder'
  path: string
  extension: string
  icon: string
  createdAt: string
  preview?: string
  size?: number
}

// Get working directory for a space
function getWorkingDir(spaceId: string): string {
  if (spaceId === 'halo-temp') {
    const artifactsDir = join(getTempSpacePath(), 'artifacts')
    return artifactsDir
  }

  const space = getSpace(spaceId)
  if (space) {
    return space.workingDir || space.path
  }

  return getTempSpacePath()
}

/**
 * List all artifacts in a space
 * Uses caching and file watching for optimal performance
 */
export async function listArtifacts(spaceId: string): Promise<Artifact[]> {
  console.log(`[Artifact] listArtifacts for space: ${spaceId}`)

  const workDir = getWorkingDir(spaceId)

  if (!existsSync(workDir)) {
    console.log(`[Artifact] Directory does not exist: ${workDir}`)
    return []
  }

  const cachedArtifacts = await listArtifactsCached(spaceId, workDir, 2)

  // Convert to Artifact format
  const artifacts: Artifact[] = cachedArtifacts.map(ca => ({
    id: ca.id,
    spaceId: ca.spaceId,
    conversationId: 'all',
    name: ca.name,
    type: ca.type,
    path: ca.path,
    extension: ca.extension,
    icon: ca.icon,
    createdAt: ca.createdAt,
    size: ca.size,
    preview: undefined  // Don't load preview by default for performance
  }))

  console.log(`[Artifact] Found ${artifacts.length} artifacts`)
  return artifacts
}

// Get artifact by ID
export function getArtifact(artifactId: string): Artifact | null {
  // This would typically query a database or cache
  // For now, we don't have persistent artifact storage
  return null
}

// Watch for file changes
// Note: File watching is implemented in artifact-cache.service.ts using @parcel/watcher.
// This function is kept for API compatibility but delegates to the cache service.
export function watchArtifacts(
  spaceId: string,
  callback: (artifacts: Artifact[]) => void
): () => void {
  // File watching is handled by artifact-cache.service.ts via IPC events
  // Callers should use api.onArtifactChanged() instead
  return () => {}
}

/**
 * List artifacts as tree structure (lazy loading)
 * Only loads root level initially, children are loaded on demand
 */
export async function listArtifactsTree(spaceId: string): Promise<CachedTreeNode[]> {
  console.log(`[Artifact] listArtifactsTree for space: ${spaceId}`)

  const workDir = getWorkingDir(spaceId)

  if (!existsSync(workDir)) {
    console.log(`[Artifact] Directory does not exist: ${workDir}`)
    return []
  }

  const nodes = await listArtifactsTreeCached(spaceId, workDir)

  console.log(`[Artifact] Found ${nodes.length} root nodes`)
  return nodes
}

/**
 * Load children of a directory (lazy loading for tree view)
 */
export async function loadTreeChildren(
  spaceId: string,
  dirPath: string
): Promise<CachedTreeNode[]> {
  console.log(`[Artifact] loadTreeChildren for: ${dirPath}`)

  const workDir = getWorkingDir(spaceId)

  if (!existsSync(dirPath)) {
    console.log(`[Artifact] Directory does not exist: ${dirPath}`)
    return []
  }

  // Security: Validate path is within workspace to prevent path traversal
  try {
    const realPath = realpathSync(dirPath)
    const realWorkDir = realpathSync(workDir)
    // Must use sep suffix to prevent /workspace_tmp matching /workspace
    const realWorkDirWithSep = realWorkDir.endsWith(sep) ? realWorkDir : realWorkDir + sep
    if (realPath !== realWorkDir && !realPath.startsWith(realWorkDirWithSep)) {
      console.warn(`[Artifact] Path traversal blocked: ${dirPath}`)
      return []
    }
  } catch {
    console.warn(`[Artifact] Failed to resolve path: ${dirPath}`)
    return []
  }

  try {
    return await loadDirectoryChildren(spaceId, dirPath, workDir)
  } catch (error) {
    console.error(`[Artifact] loadTreeChildren error:`, error)
    return []
  }
}

/**
 * Initialize artifact watcher for a space
 */
export async function initArtifactWatcher(spaceId: string): Promise<void> {
  const workDir = getWorkingDir(spaceId)

  if (!existsSync(workDir)) {
    console.log(`[Artifact] Cannot init watcher, directory does not exist: ${workDir}`)
    return
  }

  await ensureSpaceCache(spaceId, workDir)
}

/**
 * Subscribe to artifact change events
 */
export function subscribeToArtifactChanges(
  callback: (event: ArtifactChangeEvent) => void
): () => void {
  return onArtifactChange(callback)
}

// Re-export types for external use
export type { ArtifactChangeEvent }

// ============================================
// Content Canvas Support
// ============================================

// MIME type mapping for common extensions
const MIME_TYPES: Record<string, string> = {
  // Text
  txt: 'text/plain',
  log: 'text/plain',
  // Code
  js: 'text/javascript',
  jsx: 'text/javascript',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  py: 'text/x-python',
  rb: 'text/x-ruby',
  go: 'text/x-go',
  rs: 'text/x-rust',
  java: 'text/x-java',
  c: 'text/x-c',
  cpp: 'text/x-c++',
  h: 'text/x-c',
  hpp: 'text/x-c++',
  cs: 'text/x-csharp',
  swift: 'text/x-swift',
  kt: 'text/x-kotlin',
  php: 'text/x-php',
  sh: 'text/x-shellscript',
  bash: 'text/x-shellscript',
  zsh: 'text/x-shellscript',
  sql: 'text/x-sql',
  // Markup
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  scss: 'text/x-scss',
  less: 'text/x-less',
  xml: 'text/xml',
  svg: 'image/svg+xml',
  // Data
  json: 'application/json',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  md: 'text/markdown',
  markdown: 'text/markdown',
  // Config
  env: 'text/plain',
  gitignore: 'text/plain',
  dockerignore: 'text/plain',
  // Images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
}

/**
 * Get MIME type for a file extension
 */
function getMimeType(ext: string): string {
  const normalized = ext.toLowerCase().replace('.', '')
  return MIME_TYPES[normalized] || 'text/plain'
}

/**
 * Check if file is binary (image, etc.)
 */
function isBinaryFile(ext: string): boolean {
  const binaryExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'pdf', 'zip', 'tar', 'gz', 'rar']
  return binaryExtensions.includes(ext.toLowerCase().replace('.', ''))
}

/**
 * Read file content for Content Canvas
 * Returns content as string (for text files) or base64 (for binary files)
 */
export interface ArtifactContent {
  content: string
  mimeType: string
  encoding: 'utf-8' | 'base64'
  size: number
}

export function readArtifactContent(filePath: string): ArtifactContent {
  console.log(`[Artifact] Reading content: ${filePath}`)

  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`)
  }

  const stats = statSync(filePath)
  if (stats.isDirectory()) {
    throw new Error(`Cannot read directory content: ${filePath}`)
  }

  const ext = extname(filePath)
  const mimeType = getMimeType(ext)

  // Check file size limit (10MB for text, 50MB for binary)
  const maxTextSize = 10 * 1024 * 1024  // 10MB
  const maxBinarySize = 50 * 1024 * 1024  // 50MB
  const isBinary = isBinaryFile(ext)
  const maxSize = isBinary ? maxBinarySize : maxTextSize

  if (stats.size > maxSize) {
    throw new Error(`File too large: ${stats.size} bytes (max: ${maxSize} bytes)`)
  }

  try {
    if (isBinary) {
      // Read as base64 for binary files
      const buffer = readFileSync(filePath)
      return {
        content: buffer.toString('base64'),
        mimeType,
        encoding: 'base64',
        size: stats.size
      }
    } else {
      // Read as UTF-8 for text files
      const content = readFileSync(filePath, 'utf-8')
      return {
        content,
        mimeType,
        encoding: 'utf-8',
        size: stats.size
      }
    }
  } catch (error) {
    console.error(`[Artifact] Failed to read file: ${filePath}`, error)
    throw new Error(`Failed to read file: ${(error as Error).message}`)
  }
}

/**
 * Get artifact download info for remote mode
 */
export function getArtifactDownloadInfo(filePath: string): {
  exists: boolean
  name: string
  size: number
  mimeType: string
} | null {
  if (!existsSync(filePath)) {
    return null
  }

  try {
    const stats = statSync(filePath)
    const ext = extname(filePath)
    return {
      exists: true,
      name: basename(filePath),
      size: stats.size,
      mimeType: getMimeType(ext)
    }
  } catch {
    return null
  }
}

// ============================================
// File Type Detection (for Canvas viewability)
// ============================================

/**
 * Content types for Canvas viewing
 */
export type CanvasContentType =
  | 'code'
  | 'markdown'
  | 'html'
  | 'image'
  | 'pdf'
  | 'text'
  | 'json'
  | 'csv'
  | 'binary'

/**
 * File type detection result
 */
export interface FileTypeInfo {
  isText: boolean           // Whether the file is text-based
  canViewInCanvas: boolean  // Whether it can be viewed in Canvas
  contentType: CanvasContentType
  language?: string         // Programming language (for code files)
  mimeType: string          // MIME type
}

// Known binary extensions (will NOT open in Canvas)
const BINARY_EXTENSIONS = new Set([
  // Executables & Libraries
  'exe', 'dll', 'so', 'dylib', 'bin', 'app', 'msi', 'dmg', 'pkg',
  // Archives
  'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar', 'tgz',
  // Media (non-viewable)
  'mp3', 'mp4', 'avi', 'mov', 'mkv', 'flv', 'wmv', 'wav', 'flac', 'aac', 'ogg',
  // Office documents (use external app)
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
  // Fonts
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // Database
  'db', 'sqlite', 'sqlite3', 'mdb',
  // Other binary
  'class', 'pyc', 'pyo', 'o', 'obj', 'a', 'lib',
  'iso', 'img', 'vmdk', 'vdi',
])

// Known image extensions (open in ImageViewer)
const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'tiff', 'tif',
])

// Known code extensions with their languages
const CODE_EXTENSIONS: Record<string, string> = {
  // JavaScript/TypeScript
  js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  mjs: 'javascript', cjs: 'javascript',
  // Web frameworks
  vue: 'vue', svelte: 'svelte',
  // Systems programming
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
  cs: 'csharp', swift: 'swift', kt: 'kotlin', kts: 'kotlin',
  scala: 'scala', dart: 'dart', m: 'objectivec', mm: 'objectivec',
  d: 'd', cr: 'crystal',
  // Scripting
  php: 'php', lua: 'lua', pl: 'perl', pm: 'perl',
  r: 'r', R: 'r', rmd: 'r', hs: 'haskell', tcl: 'tcl',
  // Shell
  sh: 'bash', bash: 'bash', zsh: 'bash',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  // Config & Data
  sql: 'sql', yaml: 'yaml', yml: 'yaml', xml: 'xml',
  toml: 'toml', ini: 'ini', conf: 'ini', properties: 'properties',
  proto: 'protobuf',
  // Functional
  clj: 'clojure', cljs: 'clojure', cljc: 'clojure', edn: 'clojure',
  erl: 'erlang', hrl: 'erlang', ex: 'elixir', exs: 'elixir', elm: 'elm',
  fs: 'fsharp', fsi: 'fsharp', fsx: 'fsharp',
  ml: 'ocaml', mli: 'ocaml', sml: 'sml',
  // Scientific
  jl: 'julia', f: 'fortran', f90: 'fortran', f95: 'fortran', for: 'fortran',
  // Legacy
  pas: 'pascal', dpr: 'pascal', vb: 'vb', vbs: 'vbscript', bas: 'vb',
  scm: 'scheme', rkt: 'scheme', lisp: 'lisp', lsp: 'lisp', cl: 'lisp',
  // CSS & Templates
  css: 'css', scss: 'scss', less: 'less', sass: 'sass', styl: 'stylus',
  pug: 'pug', jade: 'pug', coffee: 'coffeescript', groovy: 'groovy',
  // Hardware
  v: 'verilog', sv: 'verilog', vhd: 'vhdl', vhdl: 'vhdl',
  // DevOps
  pp: 'puppet', nsh: 'nsis',
  // Other
  diff: 'diff', patch: 'diff', dockerfile: 'dockerfile',
}

// Special filenames (no extension) that are code
const SPECIAL_FILENAMES: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gemfile: 'ruby',
  rakefile: 'ruby',
  podfile: 'ruby',
  vagrantfile: 'ruby',
  jenkinsfile: 'groovy',
  '.gitignore': 'gitignore',
  '.dockerignore': 'gitignore',
  '.editorconfig': 'ini',
  '.env': 'shell',
  '.env.local': 'shell',
  '.env.development': 'shell',
  '.env.production': 'shell',
}

/**
 * Detect if file content is binary by checking for NULL bytes
 * Reads first 8KB of file and checks for binary indicators
 */
function detectBinaryContent(filePath: string): boolean {
  try {
    const fd = openSync(filePath, 'r')
    const buffer = Buffer.alloc(8192) // Read first 8KB
    const bytesRead = readSync(fd, buffer, 0, 8192, 0)
    closeSync(fd)

    // Empty file is considered text
    if (bytesRead === 0) {
      return false
    }

    // Check for NULL bytes (strong indicator of binary)
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) {
        return true
      }
    }

    // Check ratio of non-printable characters
    let nonPrintable = 0
    for (let i = 0; i < bytesRead; i++) {
      const byte = buffer[i]
      // Allow common text characters: printable ASCII, newline, tab, carriage return
      if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
        nonPrintable++
      }
      // Allow extended ASCII and UTF-8
      // High bytes (> 127) are valid in UTF-8 sequences
    }

    // If more than 10% non-printable, likely binary
    return nonPrintable / bytesRead > 0.1
  } catch {
    // If we can't read the file, assume binary to be safe
    return true
  }
}

/**
 * Detect file type and viewability for Canvas
 * Uses extension first (fast), falls back to content detection for unknown types
 */
export function detectFileType(filePath: string): FileTypeInfo {
  if (!existsSync(filePath)) {
    return {
      isText: false,
      canViewInCanvas: false,
      contentType: 'binary',
      mimeType: 'application/octet-stream',
    }
  }

  const stats = statSync(filePath)
  if (stats.isDirectory()) {
    return {
      isText: false,
      canViewInCanvas: false,
      contentType: 'binary',
      mimeType: 'inode/directory',
    }
  }

  const ext = extname(filePath).toLowerCase().replace('.', '')
  const filename = basename(filePath).toLowerCase()

  // Check special filenames first
  if (SPECIAL_FILENAMES[filename]) {
    return {
      isText: true,
      canViewInCanvas: true,
      contentType: 'code',
      language: SPECIAL_FILENAMES[filename],
      mimeType: 'text/plain',
    }
  }

  // Known binary extensions → cannot view
  if (BINARY_EXTENSIONS.has(ext)) {
    return {
      isText: false,
      canViewInCanvas: false,
      contentType: 'binary',
      mimeType: 'application/octet-stream',
    }
  }

  // Known image extensions → ImageViewer
  if (IMAGE_EXTENSIONS.has(ext)) {
    return {
      isText: false,
      canViewInCanvas: true,
      contentType: 'image',
      mimeType: getMimeType(ext),
    }
  }

  // PDF → BrowserView
  if (ext === 'pdf') {
    return {
      isText: false,
      canViewInCanvas: true,
      contentType: 'pdf',
      mimeType: 'application/pdf',
    }
  }

  // Known code extensions → CodeViewer
  if (CODE_EXTENSIONS[ext]) {
    return {
      isText: true,
      canViewInCanvas: true,
      contentType: 'code',
      language: CODE_EXTENSIONS[ext],
      mimeType: getMimeType(ext),
    }
  }

  // Markdown
  if (ext === 'md' || ext === 'markdown') {
    return {
      isText: true,
      canViewInCanvas: true,
      contentType: 'markdown',
      language: 'markdown',
      mimeType: 'text/markdown',
    }
  }

  // HTML
  if (ext === 'html' || ext === 'htm') {
    return {
      isText: true,
      canViewInCanvas: true,
      contentType: 'html',
      language: 'html',
      mimeType: 'text/html',
    }
  }

  // JSON
  if (ext === 'json' || ext === 'lock') {
    return {
      isText: true,
      canViewInCanvas: true,
      contentType: 'json',
      language: 'json',
      mimeType: 'application/json',
    }
  }

  // CSV
  if (ext === 'csv') {
    return {
      isText: true,
      canViewInCanvas: true,
      contentType: 'csv',
      mimeType: 'text/csv',
    }
  }

  // Known text extensions without syntax highlighting
  const textExtensions = ['txt', 'log', 'env', 'gitignore', 'dockerignore']
  if (textExtensions.includes(ext)) {
    return {
      isText: true,
      canViewInCanvas: true,
      contentType: 'text',
      mimeType: 'text/plain',
    }
  }

  // Unknown extension → detect by content
  const isBinary = detectBinaryContent(filePath)

  if (isBinary) {
    return {
      isText: false,
      canViewInCanvas: false,
      contentType: 'binary',
      mimeType: 'application/octet-stream',
    }
  }

  // Unknown but appears to be text → open as plain text (editable)
  return {
    isText: true,
    canViewInCanvas: true,
    contentType: 'text',
    mimeType: 'text/plain',
  }
}

/**
 * Save content to a file
 * Used by CodeViewer edit mode
 */
export function saveArtifactContent(filePath: string, content: string): void {
  console.log(`[Artifact] Saving content to: ${filePath}`)

  if (!filePath) {
    throw new Error('File path is required')
  }

  try {
    writeFileSync(filePath, content, 'utf-8')
    console.log(`[Artifact] File saved successfully: ${filePath}`)
  } catch (error) {
    console.error(`[Artifact] Failed to save file: ${filePath}`, error)
    throw new Error(`Failed to save file: ${(error as Error).message}`)
  }
}
