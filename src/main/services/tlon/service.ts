/**
 * Tlon Service — knowledge base registry, CRUD, binding, file ops,
 * source-citation resolution, conversation-integration references, and
 * learned-status.
 *
 * Registry pattern mirrors space.service.ts:
 * - module-level Map is the in-memory working copy of knowledge-bases-index.json
 * - lazy getRegistry() loads + migrates on first access
 * - persistIndex() writes atomically (tmp + rename)
 *
 * Learned-status (the authoritative "has this file been ingested?") is derived
 * live from .ingest/hashes.json + current file content — never from events.
 */

import { createHash } from 'crypto'
import { join, sep, isAbsolute, normalize, dirname, relative } from 'path'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  realpathSync,
  statSync,
  rmSync,
  renameSync,
  copyFileSync,
  type Dirent,
} from 'fs'
import { v4 as uuidv4 } from 'uuid'
import type {
  KnowledgeBaseId,
  KnowledgeBaseEntry,
  KBIndexV1,
  KBStats,
  LinkedDirectory,
  KBReference,
  KBSource,
  RawFileStatus,
  IngestHashesV1,
  CreateKBInput,
  UpdateKBInput,
  AddRawFilesResult,
} from '../../../shared/types/tlon'
import {
  getTlonRoot,
  getKBIndexPath,
  getKBDir,
  getKBMetaPath,
  getKBIndexMdPath,
  getKBLogPath,
  getKBRawDir,
  getKBWikiDir,
  getKBTextDir,
  getKBIngestDir,
  getKBHashesPath,
} from './paths'
import {
  DEFAULT_INDEX_MD,
  DEFAULT_LOG_MD,
} from './defaults'
import { isExtractable } from './extract'
import { CPP_LEVEL_IGNORE_DIRS } from '../../../shared/constants/ignore-patterns'
import { isDiskRoot } from '../../../shared/disk-paths'

// ============================================================================
// Accepted source extensions (case-insensitive). Everything else is rejected.
//
// Deliberately DOCUMENT-like only: prose, notes, tabular data, web pages.
// Source code and config/data dumps (.ts/.py/.go/.json/.yaml/.xml/.sh/.log…)
// are NOT knowledge — accepting them turns the wiki into noise (e.g. dropping a
// whole repo). Documents that need extraction (PDF/PPTX/DOCX/XLSX) are handled
// separately by isExtractable.
// ============================================================================

const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.text', '.rst', '.org',
  '.csv', '.tsv', '.html', '.htm',
])

/**
 * Directory names never worth copying into a knowledge base. Pruned during
 * recursive folder import so dropping a project root does not pull in VCS
 * metadata, dependency trees, or build artifacts.
 */
const IGNORED_IMPORT_DIRS = new Set([
  '.git', '.svn', '.hg', 'node_modules', '.venv', '__pycache__',
  'dist', 'build', '.next', 'target', 'vendor', 'coverage',
  '.idea', '.vscode', '.cache', '.gradle',
])

/**
 * Watched folders hold a small set of documents, not bulk corpora. Linking a
 * folder with more accepted source files than this is rejected up front, and a
 * folder that grows past the cap after linking is ignored by ingest, listing,
 * and stats until it drops back under it.
 */
export const MAX_LINKED_DIR_FILES = 500

/**
 * Ceiling on directory entries visited by a single walk. Bounds the cost of
 * scanning huge trees regardless of file-type mix: a walk that hits the
 * ceiling reports itself truncated instead of grinding through millions of
 * entries.
 */
const WALK_ENTRY_BUDGET = 20000

/** Directory names pruned from every watched-folder walk — matches the watcher's native `ignore` list. */
const CPP_IGNORED_DIR_NAMES = new Set(CPP_LEVEL_IGNORE_DIRS)

/** True when the path has an accepted (document-like) text extension. */
export function isAcceptedTextFile(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot < 0) return false
  return TEXT_EXTENSIONS.has(lower.slice(dot))
}

/**
 * Lock / owner / metadata junk that carries a document extension but is not a
 * document. `~$Report.docx` is the owner file Office writes while a document is
 * OPEN (a ~165-byte binary, not a zip) — extracting it just errors. These are
 * never knowledge and must be skipped before extension checks.
 */
function isJunkSourceName(filePath: string): boolean {
  const base = (filePath.split(/[\\/]/).pop() || filePath).toLowerCase()
  return (
    base.startsWith('~$') ||       // MS Office owner/lock file
    base.startsWith('.~lock.') ||  // LibreOffice lock file
    base === '.ds_store' ||        // macOS
    base === 'thumbs.db' ||        // Windows
    base === 'desktop.ini'         // Windows
  )
}

/**
 * True when a file can become a source: plain text, or an extractable document
 * (PDF / PPTX / DOCX / XLSX — text is pulled out at ingest time, see extract.ts).
 */
export function isAcceptedSourceFile(filePath: string): boolean {
  if (isJunkSourceName(filePath)) return false
  return isAcceptedTextFile(filePath) || isExtractable(filePath)
}

/** True if the first 8KB of a buffer contains a NUL byte (binary guard). */
export function looksBinary(buf: Buffer): boolean {
  // A UTF-16 BOM marks NUL-heavy but valid text.
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return false
  const limit = Math.min(buf.length, 8192)
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

export function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * Content-hash memo keyed by absolute path. Learned-status pulls and ingest
 * scans re-hash every source repeatedly (per progress pull, per boot); an
 * unchanged mtime+size reuses the digest instead of re-reading the bytes.
 * Bounded, LRU eviction: Map iteration order tracks insertion order, and a
 * hit re-inserts its entry so the oldest key is always the least recently
 * used one — without this, a KB with more files than the cap would evict
 * entries in the same 1Hz poll that just reused them, degrading every scan
 * back to full re-reads.
 */
const HASH_CACHE_MAX = 4096
const hashCache = new Map<string, { mtimeMs: number; size: number; hash: string; binary: boolean }>()

/** For testing only — drop memoized digests so rewritten files re-hash. */
export function _resetTlonHashCache(): void {
  hashCache.clear()
}

/** Hash a file's content, reusing the cached digest when mtime+size match. Throws on IO errors. */
export function hashFileCached(absolutePath: string): { hash: string; size: number; binary: boolean } {
  const st = statSync(absolutePath)
  const cached = hashCache.get(absolutePath)
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    hashCache.delete(absolutePath)
    hashCache.set(absolutePath, cached)
    return cached
  }

  const buf = readFileSync(absolutePath)
  const entry = { mtimeMs: st.mtimeMs, size: st.size, hash: sha256(buf), binary: looksBinary(buf) }
  hashCache.delete(absolutePath)
  hashCache.set(absolutePath, entry)
  if (hashCache.size > HASH_CACHE_MAX) {
    const oldest = hashCache.keys().next().value
    if (oldest !== undefined) hashCache.delete(oldest)
  }
  return entry
}

// ============================================================================
// Registry
// ============================================================================

let registry: Map<KnowledgeBaseId, KnowledgeBaseEntry> | null = null

/** For testing only — reset the in-memory registry so the next read reloads. */
export function _resetTlonRegistry(): void {
  registry = null
}

function getRegistry(): Map<KnowledgeBaseId, KnowledgeBaseEntry> {
  if (!registry) {
    registry = loadIndex()
  }
  return registry
}

function loadIndex(): Map<KnowledgeBaseId, KnowledgeBaseEntry> {
  const map = new Map<KnowledgeBaseId, KnowledgeBaseEntry>()
  const indexPath = getKBIndexPath()

  if (!existsSync(indexPath)) {
    return map
  }

  let raw: Record<string, unknown> | null = null
  try {
    raw = JSON.parse(readFileSync(indexPath, 'utf-8'))
  } catch {
    console.warn('[Tlon] knowledge-bases-index.json corrupted, starting empty')
    return map
  }

  if (raw && raw.version === 1 && raw.knowledgeBases && typeof raw.knowledgeBases === 'object') {
    const entries = raw.knowledgeBases as Record<string, KnowledgeBaseEntry>
    for (const [id, entry] of Object.entries(entries)) {
      if (entry && typeof entry.id === 'string' && typeof entry.path === 'string') {
        // Defensive defaults for forward/backward compatibility.
        entry.linkedDirs = Array.isArray(entry.linkedDirs) ? entry.linkedDirs : []
        entry.spaceIds = Array.isArray(entry.spaceIds) ? entry.spaceIds : []
        entry.appIds = Array.isArray(entry.appIds) ? entry.appIds : []
        entry.stats = entry.stats || { rawFileCount: 0, indexedCount: 0, rawSizeBytes: 0 }
        map.set(id, entry)
      }
    }
    console.log(`[Tlon] Index v1 loaded: ${map.size} knowledge base(s)`)
  }

  return map
}

function persistIndex(map: Map<KnowledgeBaseId, KnowledgeBaseEntry>): void {
  const knowledgeBases: Record<KnowledgeBaseId, KnowledgeBaseEntry> = {}
  for (const [id, entry] of map) {
    knowledgeBases[id] = entry
  }
  const data: KBIndexV1 = { version: 1, knowledgeBases }

  const indexPath = getKBIndexPath()
  const tmpPath = indexPath + '.tmp'
  try {
    const root = getTlonRoot()
    if (!existsSync(root)) mkdirSync(root, { recursive: true })
    writeFileSync(tmpPath, JSON.stringify(data, null, 2))
    renameSync(tmpPath, indexPath)
  } catch (error) {
    console.error('[Tlon] Failed to persist index:', error)
    try { if (existsSync(tmpPath)) rmSync(tmpPath) } catch { /* ignore */ }
  }
}

// ============================================================================
// CRUD
// ============================================================================

export function createKB(input: CreateKBInput): KnowledgeBaseEntry {
  const id = uuidv4()
  const now = new Date().toISOString()
  const dir = getKBDir(id)

  mkdirSync(getKBRawDir(id), { recursive: true })
  mkdirSync(getKBTextDir(id), { recursive: true })
  mkdirSync(getKBIngestDir(id), { recursive: true })

  writeFileSync(getKBIndexMdPath(id), DEFAULT_INDEX_MD, 'utf-8')
  writeFileSync(getKBLogPath(id), DEFAULT_LOG_MD, 'utf-8')
  writeFileSync(
    getKBHashesPath(id),
    JSON.stringify({ version: 1, files: {} } as IngestHashesV1, null, 2),
    'utf-8'
  )

  const linkedDirs: LinkedDirectory[] = (input.linkedDirs || []).map(d => ({
    id: uuidv4(),
    path: d.path,
    label: d.label,
    watching: existsSync(d.path),
  }))

  const entry: KnowledgeBaseEntry = {
    id,
    name: input.name,
    icon: input.icon || '📚',
    description: input.description || '',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    path: dir,
    linkedDirs,
    spaceIds: [],
    appIds: [],
    stats: { rawFileCount: 0, indexedCount: 0, rawSizeBytes: 0 },
  }

  writeFileSync(getKBMetaPath(id), JSON.stringify(entry, null, 2), 'utf-8')

  getRegistry().set(id, entry)
  persistIndex(getRegistry())
  console.log(`[Tlon] Created KB ${id}: ${input.name}`)

  // Start watching raw/ + any linked dirs (best-effort, lazy import to avoid
  // the watcher -> service import cycle).
  import('./watcher')
    .then(({ startWatchersForKB }) => startWatchersForKB(id))
    .catch(err => console.error('[Tlon] createKB watch start failed:', err))

  return entry
}

export function getKB(kbId: string): KnowledgeBaseEntry | null {
  return getRegistry().get(kbId) || null
}

/**
 * Mark one KB as the default (or pass null to clear). At most one KB is default;
 * new conversations auto-load it. Persists meta.json for every changed entry.
 */
export function setDefaultKB(kbId: string | null): boolean {
  const reg = getRegistry()
  if (kbId !== null && !reg.has(kbId)) return false
  for (const [id, entry] of reg) {
    const shouldBeDefault = id === kbId
    if (!!entry.isDefault !== shouldBeDefault) {
      entry.isDefault = shouldBeDefault
      try {
        writeFileSync(getKBMetaPath(id), JSON.stringify(entry, null, 2), 'utf-8')
      } catch (error) {
        console.error(`[Tlon] Failed to persist default flag for ${id}:`, error)
      }
    }
  }
  persistIndex(reg)
  return true
}

export function getDefaultKB(): KnowledgeBaseEntry | null {
  for (const entry of getRegistry().values()) {
    if (entry.isDefault) return entry
  }
  return null
}

export function listKBs(): KnowledgeBaseEntry[] {
  return Array.from(getRegistry().values()).sort((a, b) => {
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  })
}

export function listKBsForSpace(spaceId: string): KnowledgeBaseEntry[] {
  return listKBs().filter(kb => kb.spaceIds.includes(spaceId))
}

export function listKBsForApp(appId: string): KnowledgeBaseEntry[] {
  return listKBs().filter(kb => kb.appIds.includes(appId))
}

/** Persist an entry's meta.json and update the registry timestamp + index. */
function saveEntry(entry: KnowledgeBaseEntry): void {
  entry.updatedAt = new Date().toISOString()
  try {
    writeFileSync(getKBMetaPath(entry.id), JSON.stringify(entry, null, 2), 'utf-8')
  } catch (error) {
    console.error(`[Tlon] Failed to write meta.json for ${entry.id}:`, error)
  }
  persistIndex(getRegistry())
}

export function updateKB(kbId: string, updates: UpdateKBInput): KnowledgeBaseEntry | null {
  const entry = getRegistry().get(kbId)
  if (!entry) return null
  if (updates.name !== undefined) entry.name = updates.name
  if (updates.icon !== undefined) entry.icon = updates.icon
  if (updates.description !== undefined) entry.description = updates.description
  if (updates.status !== undefined) entry.status = updates.status
  saveEntry(entry)
  return entry
}

export async function deleteKB(kbId: string): Promise<boolean> {
  const entry = getRegistry().get(kbId)
  if (!entry) return false
  try {
    // Stop watchers before removing the directory. Lazy import to avoid a
    // cycle (watcher.ts imports service.ts for listKBs/getKB).
    const { stopWatchersForKB } = await import('./watcher')
    await stopWatchersForKB(kbId)

    // Same lazy-import pattern (ingest.ts imports service.ts).
    const { evictIngestState } = await import('./ingest')
    evictIngestState(kbId)
    for (const linked of entry.linkedDirs) {
      lastCapWarnStatus.delete(linked.path)
    }
    lastCapWarnStatus.delete(getKBRawDir(kbId))
    lastCapWarnStatus.delete(getKBTextDir(kbId))

    const dir = getKBDir(kbId)
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
    }
    getRegistry().delete(kbId)
    persistIndex(getRegistry())
    console.log(`[Tlon] Deleted KB ${kbId}`)
    return true
  } catch (error) {
    console.error(`[Tlon] Failed to delete KB ${kbId}:`, error)
    return false
  }
}

// ============================================================================
// Binding (many-to-many)
// ============================================================================

function addToList(list: string[], value: string): boolean {
  if (list.includes(value)) return false
  list.push(value)
  return true
}

function removeFromList(list: string[], value: string): boolean {
  const idx = list.indexOf(value)
  if (idx < 0) return false
  list.splice(idx, 1)
  return true
}

export function bindToSpace(kbId: string, spaceId: string): boolean {
  const entry = getRegistry().get(kbId)
  if (!entry) return false
  if (!addToList(entry.spaceIds, spaceId)) return false
  saveEntry(entry)
  return true
}

export function unbindFromSpace(kbId: string, spaceId: string): boolean {
  const entry = getRegistry().get(kbId)
  if (!entry) return false
  if (!removeFromList(entry.spaceIds, spaceId)) return false
  saveEntry(entry)
  return true
}

export function bindToApp(kbId: string, appId: string): boolean {
  const entry = getRegistry().get(kbId)
  if (!entry) return false
  if (!addToList(entry.appIds, appId)) return false
  saveEntry(entry)
  return true
}

export function unbindFromApp(kbId: string, appId: string): boolean {
  const entry = getRegistry().get(kbId)
  if (!entry) return false
  if (!removeFromList(entry.appIds, appId)) return false
  saveEntry(entry)
  return true
}

// ============================================================================
// Linked directories
// ============================================================================

/** addLinkedDir outcome: the created (or pre-existing) link, or a machine-readable rejection. */
export type AddLinkedDirResult =
  | { ok: true; linked: LinkedDirectory }
  | {
      ok: false
      reason: 'kb-not-found' | 'path-missing' | 'disk-root' | 'folder-too-large' | 'too-many-files'
      /** Accepted source files counted (exact — the walk completed). */
      count?: number
      limit?: number
    }

const lastCapWarnStatus = new Map<string, string>()

function warnLinkedDirIgnored(linkedPath: string, status: 'too-many-files' | 'truncated'): void {
  // Learned-status listing runs at up to 1Hz during ingest; warn once per path
  // per status so a later status change still gets its own warning.
  if (lastCapWarnStatus.get(linkedPath) === status) return
  lastCapWarnStatus.set(linkedPath, status)
  if (status === 'truncated') {
    console.warn(
      `[Tlon] Watched folder is too large to scan (over ${WALK_ENTRY_BUDGET} entries), ignoring it: ${linkedPath}`
    )
  } else {
    console.warn(
      `[Tlon] Watched folder is over the ${MAX_LINKED_DIR_FILES}-file cap, ignoring it: ${linkedPath}`
    )
  }
}

/**
 * Walk a KB's internal raw/ or text/ directory. Unlike `walkLinkedSources`
 * these have no file-count cap — only the same entry-count walk budget
 * applies — and truncation is warned once per path so an unexpectedly huge
 * KB directory doesn't silently drop files from stats and listings instead
 * of failing loudly.
 */
function walkKbDir(dirPath: string): WalkResult {
  const result = walkFiles(dirPath)
  if (result.truncated && lastCapWarnStatus.get(dirPath) !== 'truncated') {
    lastCapWarnStatus.set(dirPath, 'truncated')
    console.warn(
      `[Tlon] Directory is too large to scan fully (over ${WALK_ENTRY_BUDGET} entries), listing is partial: ${dirPath}`
    )
  }
  return result
}

type LinkedSourcesOutcome =
  | { status: 'ok'; files: string[] }
  | { status: 'too-many-files'; count: number }
  | { status: 'truncated' }

/**
 * Walk one watched folder under the single cap policy shared by add-time
 * rejection and every runtime read. Resolves symlinks first so all consumers
 * (add, ingest, listing, stats) classify the same physical tree.
 */
function walkLinkedSources(linkedPath: string): LinkedSourcesOutcome {
  let resolved = linkedPath
  try {
    resolved = realpathSync(linkedPath)
  } catch { /* keep the original path */ }
  const walk = walkFiles(resolved, { skipDir: name => CPP_IGNORED_DIR_NAMES.has(name) })
  if (walk.truncated) return { status: 'truncated' }
  const files = walk.files.filter(isAcceptedSourceFile)
  if (files.length > MAX_LINKED_DIR_FILES) {
    return { status: 'too-many-files', count: files.length }
  }
  return { status: 'ok', files }
}

/**
 * Accepted source files of one watched folder, or null when the folder is over
 * the cap or too large to walk. Shared by ingest, learned-status listing, and
 * stats so an over-cap folder is ignored consistently everywhere — the same
 * policy that rejects it at add time.
 */
function listLinkedSourceFiles(linkedPath: string): string[] | null {
  const outcome = walkLinkedSources(linkedPath)
  if (outcome.status === 'ok') return outcome.files
  warnLinkedDirIgnored(linkedPath, outcome.status)
  return null
}

export function addLinkedDir(
  kbId: string,
  dir: { path: string; label: string }
): AddLinkedDirResult {
  const entry = getRegistry().get(kbId)
  if (!entry) return { ok: false, reason: 'kb-not-found' }
  if (!existsSync(dir.path)) {
    console.warn(`[Tlon] addLinkedDir: path does not exist: ${dir.path}`)
    return { ok: false, reason: 'path-missing' }
  }
  // Resolve symlinks so a link pointing at a whole volume is still caught.
  let resolved = dir.path
  try {
    resolved = realpathSync(dir.path)
  } catch { /* keep the original path */ }
  if (isDiskRoot(resolved)) {
    console.warn(`[Tlon] addLinkedDir: refusing disk root: ${dir.path}`)
    return { ok: false, reason: 'disk-root' }
  }
  if (entry.linkedDirs.some(d => d.path === dir.path)) {
    return { ok: true, linked: entry.linkedDirs.find(d => d.path === dir.path) as LinkedDirectory }
  }
  const outcome = walkLinkedSources(resolved)
  if (outcome.status === 'truncated') {
    console.warn(`[Tlon] addLinkedDir: folder too large to walk: ${dir.path}`)
    return { ok: false, reason: 'folder-too-large' }
  }
  if (outcome.status === 'too-many-files') {
    console.warn(
      `[Tlon] addLinkedDir: folder over the ${MAX_LINKED_DIR_FILES}-file cap: ${dir.path}`
    )
    return { ok: false, reason: 'too-many-files', count: outcome.count, limit: MAX_LINKED_DIR_FILES }
  }
  const linked: LinkedDirectory = {
    id: uuidv4(),
    path: dir.path,
    label: dir.label,
    watching: true,
  }
  entry.linkedDirs.push(linked)
  saveEntry(entry)

  // Start watching + initial scan (best-effort, lazy import to avoid cycle).
  import('./watcher')
    .then(({ startLinkedDirWatch }) => startLinkedDirWatch(kbId, linked))
    .catch(err => console.error('[Tlon] addLinkedDir watch start failed:', err))

  return { ok: true, linked }
}

export function removeLinkedDir(kbId: string, linkId: string): boolean {
  const entry = getRegistry().get(kbId)
  if (!entry) return false
  const linked = entry.linkedDirs.find(d => d.id === linkId)
  if (!linked) return false
  entry.linkedDirs = entry.linkedDirs.filter(d => d.id !== linkId)
  saveEntry(entry)
  lastCapWarnStatus.delete(linked.path)

  import('./watcher')
    .then(({ stopLinkedDirWatch }) => stopLinkedDirWatch(kbId, linked))
    .catch(err => console.error('[Tlon] removeLinkedDir watch stop failed:', err))

  return true
}

// ============================================================================
// Raw file operations (TEXT FILES ONLY)
// ============================================================================

/**
 * Add source paths to raw/. Each path may be a single text file or a directory:
 * a directory is recursively imported under `raw/<folderName>/` preserving its
 * structure (ignored dirs pruned). Non-text files are rejected by extension.
 */
export function addRawFiles(kbId: string, inputPaths: string[]): AddRawFilesResult {
  const entry = getRegistry().get(kbId)
  const result: AddRawFilesResult = { added: [], rejected: [] }
  if (!entry) return result

  const rawDir = getKBRawDir(kbId)
  if (!existsSync(rawDir)) mkdirSync(rawDir, { recursive: true })

  for (const src of inputPaths) {
    let st
    try {
      st = statSync(src)
    } catch (error) {
      console.error(`[Tlon] Cannot stat ${src}:`, error)
      result.rejected.push(src.split(/[\\/]/).pop() || src)
      continue
    }
    if (st.isDirectory()) {
      const folderName = src.split(/[\\/]/).filter(Boolean).pop() || 'imported'
      const walk = walkFiles(src, { skipDir: name => IGNORED_IMPORT_DIRS.has(name) })
      for (const rel of walk.files) {
        copyRawFile(rawDir, join(src, rel), join(folderName, rel), result)
      }
    } else if (st.isFile()) {
      copyRawFile(rawDir, src, src.split(/[\\/]/).pop() || src, result)
    }
  }

  refreshStats(kbId)
  return result
}

/**
 * Copy one source file to raw/<destRel>, rejecting non-text by extension.
 * A name collision with different content is uniquified (`name-2.ext`, …)
 * instead of silently overwriting; identical content is kept as-is.
 */
function copyRawFile(
  rawDir: string,
  src: string,
  destRel: string,
  result: AddRawFilesResult
): void {
  if (!isAcceptedSourceFile(destRel)) {
    result.rejected.push(destRel)
    return
  }
  try {
    let finalRel = destRel
    let dest = resolveWithinDir(rawDir, finalRel)
    if (!dest) {
      result.rejected.push(destRel)
      return
    }
    if (existsSync(dest)) {
      const srcHash = sha256(readFileSync(src))
      const relDir = dirname(destRel)
      const base = destRel.split(/[\\/]/).pop() as string
      const dot = base.lastIndexOf('.')
      const stem = dot > 0 ? base.slice(0, dot) : base
      const ext = dot > 0 ? base.slice(dot) : ''
      for (let n = 2; existsSync(dest); n++) {
        if (sha256(readFileSync(dest)) === srcHash) {
          // Same bytes already present under this name — nothing to copy.
          result.added.push(finalRel)
          return
        }
        finalRel = join(relDir === '.' ? '' : relDir, `${stem}-${n}${ext}`)
        const next = resolveWithinDir(rawDir, finalRel)
        if (!next) {
          result.rejected.push(destRel)
          return
        }
        dest = next
      }
    }
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(src, dest)
    result.added.push(finalRel)
  } catch (error) {
    console.error(`[Tlon] Failed to copy ${src}:`, error)
    result.rejected.push(destRel)
  }
}

interface WalkResult {
  files: string[]
  /** True when the entry budget was hit — `files` is a partial list. */
  truncated: boolean
}

/**
 * Recursively list relative paths of all files under a directory.
 *
 * Dirent entries carry the file type from readdir itself, so no per-entry
 * stat is needed, and symlinks match neither isDirectory() nor isFile() —
 * they are skipped rather than followed, which also makes symlink cycles
 * impossible. `skipDir` prunes a subdirectory by name before descending into
 * it; `maxEntries` bounds the total entries visited and leaves `truncated`
 * true when the ceiling was hit.
 */
function walkFiles(
  root: string,
  opts: { skipDir?: (name: string) => boolean; maxEntries?: number } = {}
): WalkResult {
  const files: string[] = []
  if (!existsSync(root)) return { files, truncated: false }
  const maxEntries = opts.maxEntries ?? WALK_ENTRY_BUDGET
  let entriesVisited = 0
  const stack: string[] = ['']
  while (stack.length > 0) {
    const rel = stack.pop() as string
    const abs = join(root, rel)
    let dirents: Dirent[]
    try {
      dirents = readdirSync(abs, { withFileTypes: true })
    } catch { continue }
    for (const dirent of dirents) {
      if (++entriesVisited > maxEntries) return { files, truncated: true }
      const childRel = rel ? join(rel, dirent.name) : dirent.name
      if (dirent.isDirectory()) {
        if (opts.skipDir && opts.skipDir(dirent.name)) continue
        stack.push(childRel)
      } else if (dirent.isFile()) {
        files.push(childRel)
      }
    }
  }
  return { files, truncated: false }
}

export function listRawFiles(kbId: string): RawFileStatus[] {
  return getRawFileLearnedStatus(kbId)
}

export function removeRawFile(kbId: string, relativePath: string): boolean {
  const rawDir = getKBRawDir(kbId)
  const abs = resolveWithinDir(rawDir, relativePath)
  if (!abs || !existsSync(abs)) return false
  try {
    rmSync(abs)
    // Drop the learned-status entry so counts stay correct.
    const hashes = readHashes(kbId)
    if (hashes.files[relativePath]) {
      delete hashes.files[relativePath]
      writeHashes(kbId, hashes)
    }
    refreshStats(kbId)
    return true
  } catch (error) {
    console.error(`[Tlon] Failed to remove raw file ${relativePath}:`, error)
    return false
  }
}

// ============================================================================
// Path-traversal-safe resolution
// ============================================================================

/**
 * Resolve a relative path strictly within baseDir. Returns null if the
 * resolved path escapes baseDir (path traversal guard).
 */
function resolveWithinDir(baseDir: string, rel: string): string | null {
  if (isAbsolute(rel)) return null
  const resolved = normalize(join(baseDir, rel))
  const baseNorm = normalize(baseDir)
  if (resolved !== baseNorm && !resolved.startsWith(baseNorm + sep)) {
    return null
  }
  return resolved
}

// ============================================================================
// Index reads (read-only)
// ============================================================================

/** Strip a leading/trailing fenced ```markdown / ``` wrapper if present. */
function stripMarkdownFence(content: string): string {
  const trimmed = content.trim()
  const fenceMatch = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/)
  if (fenceMatch) {
    return fenceMatch[1]
  }
  return content
}

export function readIndexMd(kbId: string): string | null {
  const path = getKBIndexMdPath(kbId)
  if (!existsSync(path)) return null
  try {
    return stripMarkdownFence(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
}

/**
 * Cheap availability probe: would getKBReferenceById resolve this KB?
 * Checks registry status + index.md presence WITHOUT reading the content.
 * Runs on the per-message hot path (session knowledge fingerprint), where the
 * full resolution's index.md read would be wasted on every reused session.
 */
export function isKBIndexReady(kbId: string): boolean {
  const kb = getRegistry().get(kbId)
  if (!kb || kb.status !== 'active') return false
  try {
    return statSync(getKBIndexMdPath(kbId)).size > 0
  } catch {
    return false
  }
}

/**
 * Resolve the text-corpus files an agent Read during a KB chat turn back to the
 * original source documents (name + absolute path) for clickable citations.
 * Reads are keyed by the extracted-text filename; map it back via hashes.json.
 * Filters to sources that map to a real, existing file; dedupes by source.
 */
export function resolveSources(kbId: string, readPaths: string[]): KBSource[] {
  const hashes = readHashes(kbId)
  const rawDir = getKBRawDir(kbId)
  const bySource = new Map<string, string>()
  for (const [sourcePath, info] of Object.entries(hashes.files)) {
    if (info.textPath) bySource.set(info.textPath, sourcePath)
  }
  const out: KBSource[] = []
  const seen = new Set<string>()
  for (const p of readPaths) {
    const base = p.split(/[\\/]/).pop() || p
    const sourcePath = bySource.get(base)
    if (!sourcePath || seen.has(sourcePath)) continue
    // Raw sources are raw-relative; linked sources are stored as absolute paths.
    const openPath = isAbsolute(sourcePath) ? sourcePath : join(rawDir, sourcePath)
    if (!existsSync(openPath)) continue
    seen.add(sourcePath)
    out.push({ name: sourcePath.split(/[\\/]/).pop() || sourcePath, path: openPath })
  }
  return out
}

/**
 * Resolve read text-corpus paths to their source documents without knowing the
 * KB up front: each path's KB is inferred from its location under the tlon root
 * (`<root>/<kbId>/text/…`), so a single main-chat turn that Read across several
 * loaded KBs resolves in one call. Paths outside any KB text dir are ignored.
 */
export function resolveSourcesForReadPaths(readPaths: string[]): KBSource[] {
  const root = getTlonRoot()
  const byKb = new Map<string, string[]>()
  for (const p of readPaths) {
    const rel = relative(root, p)
    if (rel.startsWith('..') || isAbsolute(rel)) continue
    const kbId = rel.split(/[\\/]/)[0]
    if (!kbId) continue
    const arr = byKb.get(kbId) || []
    arr.push(p)
    byKb.set(kbId, arr)
  }
  const out: KBSource[] = []
  const seen = new Set<string>()
  for (const [kbId, paths] of byKb) {
    for (const s of resolveSources(kbId, paths)) {
      if (seen.has(s.path)) continue
      seen.add(s.path)
      out.push(s)
    }
  }
  return out
}

// ============================================================================
// Conversation integration (SYNC, pure memory read — hot path)
// ============================================================================

/**
 * KB ids to seed onto a new conversation created in this space: the space-bound
 * KBs plus the global default, deduped. Snapshotted onto the conversation record
 * at creation (conversation.service). Ids are stored as-is — status and index
 * availability are gated at use time (getKBReferenceById), so a KB that is
 * paused now but reactivated later still resolves for a seeded conversation,
 * matching the old realtime space-binding behavior.
 */
export function getSeedKBIds(spaceId: string): string[] {
  const ids = new Set<string>()
  for (const kb of getRegistry().values()) {
    if (kb.spaceIds.includes(spaceId)) ids.add(kb.id)
  }
  const def = getDefaultKB()
  if (def) ids.add(def.id)
  return [...ids]
}

/**
 * One-time seed of an app's `appIds` binding at install/backfill time: the
 * space-bound KBs plus the global default, same computation as `getSeedKBIds`
 * (conversation seeding) applied to `bindToApp` instead of a snapshot array.
 * `spaceId === null` (global apps) seeds only the default KB. Idempotent via
 * `bindToApp`'s addToList dedupe, so callers do not need to pre-check.
 */
export function seedAppKnowledgeBases(appId: string, spaceId: string | null): void {
  const ids = new Set<string>()
  if (spaceId) {
    for (const kb of getRegistry().values()) {
      if (kb.spaceIds.includes(spaceId)) ids.add(kb.id)
    }
  }
  const def = getDefaultKB()
  if (def) ids.add(def.id)

  const seeded: string[] = []
  for (const id of ids) {
    if (bindToApp(id, appId)) seeded.push(id)
  }
  if (seeded.length > 0) {
    const names = seeded.map(id => getRegistry().get(id)?.name || id)
    console.log(`[Tlon] Seeded ${seeded.length} knowledge base(s) for app ${appId}: [${names.join(', ')}]`)
  }
}

/**
 * Context for a direct "chat with this knowledge base" turn: the text/ dir to
 * use as the agent's working directory (so Read/Glob/Grep search the extracted
 * document corpus — agentic search) and the KB reference to inject into the
 * system prompt. Unlike the space/app paths this targets one KB by id and does
 * not require a space binding (the user opened the KB explicitly). Returns null
 * if the KB or its index is missing.
 */
export function getKBChatContext(
  kbId: string
): { workDir: string; reference: KBReference } | null {
  const kb = getRegistry().get(kbId)
  if (!kb) return null
  const indexContent = readIndexMd(kb.id)
  if (indexContent === null) return null
  // A wiki-era KB may not have a text/ dir yet (migration runs async on launch);
  // ensure it exists so the agent's working dir is never a nonexistent path.
  const workDir = getKBTextDir(kb.id)
  if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true })
  return {
    workDir,
    reference: { id: kb.id, name: kb.name, indexContent },
  }
}

/**
 * Resolve a single KB into a prompt reference by id (active + index present).
 * Used when a conversation loads a specific KB regardless of space binding.
 */
export function getKBReferenceById(kbId: string): KBReference | null {
  const kb = getRegistry().get(kbId)
  if (!kb || kb.status !== 'active') return null
  const indexContent = readIndexMd(kb.id)
  if (!indexContent) return null
  return { id: kb.id, name: kb.name, indexContent }
}

export function getKBReferencesForApp(appId: string): KBReference[] {
  const refs: KBReference[] = []
  for (const kb of getRegistry().values()) {
    if (kb.status !== 'active') continue
    if (!kb.appIds.includes(appId)) continue
    const indexContent = readIndexMd(kb.id)
    if (!indexContent) continue
    refs.push({ id: kb.id, name: kb.name, indexContent })
  }
  return refs
}

// ============================================================================
// Hashes (learned-status source of truth)
// ============================================================================

export function readHashes(kbId: string): IngestHashesV1 {
  const path = getKBHashesPath(kbId)
  if (!existsSync(path)) {
    return { version: 1, files: {} }
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    if (parsed && parsed.version === 1 && parsed.files) {
      return parsed as IngestHashesV1
    }
  } catch {
    console.warn(`[Tlon] hashes.json corrupted for ${kbId}, resetting`)
  }
  return { version: 1, files: {} }
}

export function writeHashes(kbId: string, hashes: IngestHashesV1): void {
  const dir = getKBIngestDir(kbId)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const path = getKBHashesPath(kbId)
  const tmp = path + '.tmp'
  try {
    writeFileSync(tmp, JSON.stringify(hashes, null, 2), 'utf-8')
    renameSync(tmp, path)
  } catch (error) {
    console.error(`[Tlon] Failed to write hashes.json for ${kbId}:`, error)
    try { if (existsSync(tmp)) rmSync(tmp) } catch { /* ignore */ }
  }
}

// ============================================================================
// Stats / learned status
// ============================================================================

export function refreshStats(kbId: string): KBStats {
  const entry = getRegistry().get(kbId)
  const rawDir = getKBRawDir(kbId)
  const textDir = getKBTextDir(kbId)

  let rawFileCount = 0
  let rawSizeBytes = 0
  const rawWalk = walkKbDir(rawDir)
  for (const rel of rawWalk.files) {
    try {
      rawSizeBytes += statSync(join(rawDir, rel)).size
      rawFileCount++
    } catch { /* ignore */ }
  }
  // Watched-folder sources are ingested like raw files, so they count toward the
  // total too — otherwise indexedCount (which includes them) could exceed it.
  for (const linked of entry?.linkedDirs ?? []) {
    if (!existsSync(linked.path)) continue
    const sources = listLinkedSourceFiles(linked.path)
    if (sources === null) continue
    for (const rel of sources) {
      try {
        rawSizeBytes += statSync(join(linked.path, rel)).size
        rawFileCount++
      } catch { /* ignore */ }
    }
  }
  const textWalk = walkKbDir(textDir)
  const indexedCount = textWalk.files.filter(r => r.toLowerCase().endsWith('.txt')).length
  // An over-cap watched folder contributes 0 above, but text extracted from it
  // earlier still counts here — floor the total so indexedCount never exceeds it.
  const rawFileCountFloored = Math.max(rawFileCount, indexedCount)

  const stats: KBStats = {
    rawFileCount: rawFileCountFloored,
    indexedCount,
    rawSizeBytes,
    lastIngestAt: entry?.stats.lastIngestAt,
  }

  if (entry) {
    entry.stats = stats
    // Persist meta + index without bumping a user-visible updatedAt churn.
    try {
      writeFileSync(getKBMetaPath(kbId), JSON.stringify(entry, null, 2), 'utf-8')
    } catch { /* ignore */ }
    persistIndex(getRegistry())
  }
  return stats
}

/**
 * Wipe the extracted text (and any offline wiki) + learned-status so the KB can
 * be re-indexed from scratch (raw/ and watched folders are the sources and are
 * left untouched). Used by the "clear & relearn" flow.
 */
export function clearWikiAndHashes(kbId: string): boolean {
  const entry = getRegistry().get(kbId)
  if (!entry) return false
  const textDir = getKBTextDir(kbId)
  const wikiDir = getKBWikiDir(kbId)
  for (const dir of [textDir, wikiDir]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (error) {
      console.error(`[Tlon] Failed to clear ${dir}:`, error)
    }
  }
  mkdirSync(textDir, { recursive: true })
  writeHashes(kbId, { version: 1, files: {} })
  try {
    writeFileSync(getKBIndexMdPath(kbId), DEFAULT_INDEX_MD, 'utf-8')
  } catch { /* ignore */ }
  refreshStats(kbId)
  return true
}

/**
 * Live learned-status for all raw files. A file is `learned` IFF hashes.json
 * has an entry whose stored hash equals the current content hash. The refined
 * `state` distinguishes text-less sources and failed extractions (both facts
 * come from the same hashes.json entry, valid only while the hash matches).
 */
export function getRawFileLearnedStatus(kbId: string): RawFileStatus[] {
  const entry = getRegistry().get(kbId)
  const rawDir = getKBRawDir(kbId)
  const textDir = getKBTextDir(kbId)
  const hashes = readHashes(kbId)
  const result: RawFileStatus[] = []

  // A source is learned IFF hashes.json records the current content hash with an
  // existing textPath; the same entry (valid only while the hash matches) also
  // carries the 'no-text'/'failed' refinements. `recordedKey` matches how ingest
  // keys a source: raw-relative for raw/, absolute for watched (linked) folders.
  const derive = (recordedKey: string, abs: string): { size: number; state: RawFileStatus['state']; error?: string } => {
    let size = 0
    let state: RawFileStatus['state'] = 'pending'
    let error: string | undefined
    try {
      size = statSync(abs).size
      const recorded = hashes.files[recordedKey]
      if (recorded && recorded.hash === hashFileCached(abs).hash) {
        if (recorded.textPath && existsSync(join(textDir, recorded.textPath))) state = 'learned'
        else if (recorded.empty) state = 'no-text'
        else if (recorded.lastError) {
          state = 'failed'
          error = recorded.lastError
        }
      }
    } catch { /* ignore */ }
    return { size, state, error }
  }

  const rawWalk = walkKbDir(rawDir)
  for (const rel of rawWalk.files) {
    const recordedKey = rel.split(sep).join('/')
    const { size, state, error } = derive(recordedKey, join(rawDir, rel))
    result.push({
      name: rel.split(sep).pop() || rel,
      path: recordedKey,
      size,
      learned: state === 'learned',
      state,
      source: 'raw',
      ...(error !== undefined ? { error } : {}),
    })
  }

  // Watched folders: files are ingested in place (keyed by absolute path), so
  // list them too — otherwise a folder's files learn invisibly.
  for (const linked of entry?.linkedDirs ?? []) {
    if (!existsSync(linked.path)) continue
    const sources = listLinkedSourceFiles(linked.path)
    if (sources === null) continue
    for (const rel of sources) {
      const abs = join(linked.path, rel)
      const { size, state, error } = derive(abs, abs)
      result.push({
        name: rel.split(sep).pop() || rel,
        path: abs,
        size,
        learned: state === 'learned',
        state,
        source: 'linked',
        dirLabel: linked.label,
        ...(error !== undefined ? { error } : {}),
      })
    }
  }

  result.sort((a, b) => a.path.localeCompare(b.path))
  return result
}

// ============================================================================
// Internal helpers exposed for ingest.ts / watcher.ts (same-module surface)
// ============================================================================

/** Set lastIngestAt and persist (called by ingest after a batch completes). */
export function markIngestCompleted(kbId: string): void {
  const entry = getRegistry().get(kbId)
  if (!entry) return
  // 'error' is a legacy status from older builds (nothing sets it now); a
  // completed batch heals it, while leaving a user-set 'paused' KB paused.
  if (entry.status === 'error') entry.status = 'active'
  entry.stats.lastIngestAt = new Date().toISOString()
  try {
    writeFileSync(getKBMetaPath(kbId), JSON.stringify(entry, null, 2), 'utf-8')
  } catch { /* ignore */ }
  persistIndex(getRegistry())
}

/** Compute the full list of changed raw + linked source files for a KB. */
export function collectIngestCandidates(kbId: string): Array<{
  sourcePath: string
  absolutePath: string
  sourceType: 'raw' | 'linked'
}> {
  const entry = getRegistry().get(kbId)
  if (!entry) return []
  const hashes = readHashes(kbId)
  const textDir = getKBTextDir(kbId)
  const candidates: Array<{ sourcePath: string; absolutePath: string; sourceType: 'raw' | 'linked' }> = []

  const consider = (sourcePath: string, absolutePath: string, sourceType: 'raw' | 'linked') => {
    if (!isAcceptedSourceFile(absolutePath)) return
    let current: string
    try {
      const info = hashFileCached(absolutePath)
      // PDF/Office are binary by nature — only text files get the NUL-byte guard.
      if (!isExtractable(absolutePath) && info.binary) return
      current = info.hash
    } catch { return }
    const recorded = hashes.files[sourcePath]
    // Skip when the bytes are unchanged and we've already handled them: either
    // the extracted text still exists, or extraction was attempted and yielded
    // nothing (`empty`). A legacy entry (neither field) still re-extracts.
    if (recorded && recorded.hash === current
        && ((recorded.textPath && existsSync(join(textDir, recorded.textPath))) || recorded.empty)) return
    candidates.push({ sourcePath, absolutePath, sourceType })
  }

  const rawDir = getKBRawDir(kbId)
  const rawWalk = walkKbDir(rawDir)
  for (const rel of rawWalk.files) {
    const sourcePath = rel.split(sep).join('/')
    consider(sourcePath, join(rawDir, rel), 'raw')
  }

  for (const linked of entry.linkedDirs) {
    if (!existsSync(linked.path)) continue
    const sources = listLinkedSourceFiles(linked.path)
    if (sources === null) continue
    for (const rel of sources) {
      const absolutePath = join(linked.path, rel)
      // Linked files are keyed by absolute path in hashes.json.
      consider(absolutePath, absolutePath, 'linked')
    }
  }

  return candidates
}
