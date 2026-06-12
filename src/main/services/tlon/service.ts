/**
 * Tlon Service — knowledge base registry, CRUD, binding, file ops,
 * wiki reads, conversation-integration references, and learned-status.
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
import { join, sep, isAbsolute, normalize, dirname } from 'path'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  rmSync,
  renameSync,
  copyFileSync,
} from 'fs'
import { v4 as uuidv4 } from 'uuid'
import type {
  KnowledgeBaseId,
  KnowledgeBaseEntry,
  KBIndexV1,
  KBStats,
  KBStatus,
  LinkedDirectory,
  WikiPageMeta,
  KBReference,
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
  getKBSchemaPath,
  getKBIndexMdPath,
  getKBLogPath,
  getKBRawDir,
  getKBWikiDir,
  getKBIngestDir,
  getKBHashesPath,
} from './paths'
import {
  DEFAULT_SCHEMA_MD,
  DEFAULT_INDEX_MD,
  DEFAULT_LOG_MD,
} from './defaults'
import { isExtractable } from './extract'

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

/** True when the path has an accepted (document-like) text extension. */
export function isAcceptedTextFile(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot < 0) return false
  return TEXT_EXTENSIONS.has(lower.slice(dot))
}

/**
 * True when a file can become a source: plain text, or an extractable document
 * (PDF / PPTX / DOCX / XLSX — text is pulled out at ingest time, see extract.ts).
 */
export function isAcceptedSourceFile(filePath: string): boolean {
  return isAcceptedTextFile(filePath) || isExtractable(filePath)
}

/** True if the first 8KB of a buffer contains a NUL byte (binary guard). */
export function looksBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 8192)
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

export function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex')
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
        entry.stats = entry.stats || { rawFileCount: 0, wikiPageCount: 0, rawSizeBytes: 0 }
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
  mkdirSync(getKBWikiDir(id), { recursive: true })
  mkdirSync(getKBIngestDir(id), { recursive: true })

  writeFileSync(getKBSchemaPath(id), DEFAULT_SCHEMA_MD, 'utf-8')
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
    stats: { rawFileCount: 0, wikiPageCount: 0, rawSizeBytes: 0 },
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

export function addLinkedDir(
  kbId: string,
  dir: { path: string; label: string }
): LinkedDirectory | null {
  const entry = getRegistry().get(kbId)
  if (!entry) return null
  if (!existsSync(dir.path)) {
    console.warn(`[Tlon] addLinkedDir: path does not exist: ${dir.path}`)
    return null
  }
  if (entry.linkedDirs.some(d => d.path === dir.path)) {
    return entry.linkedDirs.find(d => d.path === dir.path) || null
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

  return linked
}

export function removeLinkedDir(kbId: string, linkId: string): boolean {
  const entry = getRegistry().get(kbId)
  if (!entry) return false
  const linked = entry.linkedDirs.find(d => d.id === linkId)
  if (!linked) return false
  entry.linkedDirs = entry.linkedDirs.filter(d => d.id !== linkId)
  saveEntry(entry)

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
      for (const rel of walkFiles(src, name => IGNORED_IMPORT_DIRS.has(name))) {
        copyRawFile(rawDir, join(src, rel), join(folderName, rel), result)
      }
    } else if (st.isFile()) {
      copyRawFile(rawDir, src, src.split(/[\\/]/).pop() || src, result)
    }
  }

  refreshStats(kbId)
  return result
}

/** Copy one source file to raw/<destRel>, rejecting non-text by extension. */
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
  const dest = resolveWithinDir(rawDir, destRel)
  if (!dest) {
    result.rejected.push(destRel)
    return
  }
  try {
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(src, dest)
    result.added.push(destRel)
  } catch (error) {
    console.error(`[Tlon] Failed to copy ${src}:`, error)
    result.rejected.push(destRel)
  }
}

/**
 * Recursively list relative paths of all files under a directory. `skipDir`,
 * when provided, prunes a subdirectory by name before descending into it.
 */
function walkFiles(root: string, skipDir?: (name: string) => boolean): string[] {
  const out: string[] = []
  if (!existsSync(root)) return out
  const stack = ['']
  while (stack.length > 0) {
    const rel = stack.pop() as string
    const abs = join(root, rel)
    let entries: string[]
    try {
      entries = readdirSync(abs)
    } catch { continue }
    for (const name of entries) {
      const childRel = rel ? join(rel, name) : name
      const childAbs = join(root, childRel)
      let st
      try { st = statSync(childAbs) } catch { continue }
      if (st.isDirectory()) {
        if (skipDir && skipDir(name)) continue
        stack.push(childRel)
      } else if (st.isFile()) {
        out.push(childRel)
      }
    }
  }
  return out
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
// Wiki reads (read-only)
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

export function listWikiPages(kbId: string): WikiPageMeta[] {
  const wikiDir = getKBWikiDir(kbId)
  const hashes = readHashes(kbId)
  const sourcesByPage = new Map<string, string[]>()
  for (const [src, info] of Object.entries(hashes.files)) {
    for (const page of info.wikiPages) {
      const arr = sourcesByPage.get(page) || []
      arr.push(src)
      sourcesByPage.set(page, arr)
    }
  }

  const pages: WikiPageMeta[] = []
  for (const rel of walkFiles(wikiDir)) {
    if (!rel.toLowerCase().endsWith('.md')) continue
    const abs = join(wikiDir, rel)
    let content = ''
    let generatedAt = ''
    try {
      content = readFileSync(abs, 'utf-8')
      generatedAt = statSync(abs).mtime.toISOString()
    } catch { continue }
    const normalizedRel = rel.split(sep).join('/')
    pages.push({
      path: normalizedRel,
      title: extractTitle(content) || normalizedRel,
      sources: sourcesByPage.get(normalizedRel) || [],
      generatedAt,
      sourceHash: sha256(content),
    })
  }
  pages.sort((a, b) => a.path.localeCompare(b.path))
  return pages
}

function extractTitle(content: string): string | null {
  for (const line of content.split('\n')) {
    const m = line.match(/^#\s+(.+)$/)
    if (m) return m[1].trim()
  }
  return null
}

export function readWikiPage(kbId: string, pagePath: string): string | null {
  const wikiDir = getKBWikiDir(kbId)
  const abs = resolveWithinDir(wikiDir, pagePath)
  if (!abs || !existsSync(abs)) return null
  try {
    return stripMarkdownFence(readFileSync(abs, 'utf-8'))
  } catch {
    return null
  }
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

// ============================================================================
// Conversation integration (SYNC, pure memory read — hot path)
// ============================================================================

export function getKBReferencesForSpace(spaceId: string): KBReference[] {
  const refs: KBReference[] = []
  for (const kb of getRegistry().values()) {
    if (kb.status !== 'active') continue
    if (!kb.spaceIds.includes(spaceId)) continue
    const indexContent = readIndexMd(kb.id)
    if (!indexContent) continue
    refs.push({ id: kb.id, name: kb.name, indexContent })
  }
  return refs
}

/**
 * Context for a direct "chat with this knowledge base" turn: the wiki/ dir to
 * use as the agent's working directory and the KB reference to inject into the
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
  return {
    workDir: getKBWikiDir(kb.id),
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
  const wikiDir = getKBWikiDir(kbId)

  let rawFileCount = 0
  let rawSizeBytes = 0
  for (const rel of walkFiles(rawDir)) {
    try {
      rawSizeBytes += statSync(join(rawDir, rel)).size
      rawFileCount++
    } catch { /* ignore */ }
  }
  const wikiPageCount = walkFiles(wikiDir).filter(r => r.toLowerCase().endsWith('.md')).length

  const stats: KBStats = {
    rawFileCount,
    wikiPageCount,
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
 * Wipe the generated wiki + learned-status so the KB can be relearned from
 * scratch (raw/ and watched folders are the sources and are left untouched).
 * Used by the "clear & relearn" flow to rebuild older KBs with the current
 * compounding curator.
 */
export function clearWikiAndHashes(kbId: string): boolean {
  const entry = getRegistry().get(kbId)
  if (!entry) return false
  const wikiDir = getKBWikiDir(kbId)
  try {
    rmSync(wikiDir, { recursive: true, force: true })
  } catch (error) {
    console.error(`[Tlon] Failed to clear wiki for ${kbId}:`, error)
  }
  mkdirSync(wikiDir, { recursive: true })
  writeHashes(kbId, { version: 1, files: {} })
  try {
    writeFileSync(getKBIndexMdPath(kbId), DEFAULT_INDEX_MD, 'utf-8')
  } catch { /* ignore */ }
  refreshStats(kbId)
  return true
}

/**
 * Live learned-status for all raw files. A file is `learned` IFF hashes.json
 * has an entry whose stored hash equals the current content hash.
 */
export function getRawFileLearnedStatus(kbId: string): RawFileStatus[] {
  const rawDir = getKBRawDir(kbId)
  const hashes = readHashes(kbId)
  const result: RawFileStatus[] = []

  for (const rel of walkFiles(rawDir)) {
    const abs = join(rawDir, rel)
    let size = 0
    let learned = false
    try {
      size = statSync(abs).size
      const recorded = hashes.files[rel.split(sep).join('/')]
      if (recorded) {
        const current = sha256(readFileSync(abs))
        learned = recorded.hash === current
      }
    } catch { /* ignore */ }
    result.push({
      name: rel.split(sep).pop() || rel,
      path: rel.split(sep).join('/'),
      size,
      learned,
    })
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
  entry.stats.lastIngestAt = new Date().toISOString()
  try {
    writeFileSync(getKBMetaPath(kbId), JSON.stringify(entry, null, 2), 'utf-8')
  } catch { /* ignore */ }
  persistIndex(getRegistry())
}

/** Set status (e.g. 'error') and persist. */
export function setKBStatus(kbId: string, status: KBStatus): void {
  const entry = getRegistry().get(kbId)
  if (!entry || entry.status === status) return
  entry.status = status
  saveEntry(entry)
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
  const candidates: Array<{ sourcePath: string; absolutePath: string; sourceType: 'raw' | 'linked' }> = []

  const consider = (sourcePath: string, absolutePath: string, sourceType: 'raw' | 'linked') => {
    if (!isAcceptedSourceFile(absolutePath)) return
    let current: string
    try {
      const buf = readFileSync(absolutePath)
      // PDF/Office are binary by nature — only text files get the NUL-byte guard.
      if (!isExtractable(absolutePath) && looksBinary(buf)) return
      current = sha256(buf)
    } catch { return }
    const recorded = hashes.files[sourcePath]
    if (recorded && recorded.hash === current) return // already learned
    candidates.push({ sourcePath, absolutePath, sourceType })
  }

  const rawDir = getKBRawDir(kbId)
  for (const rel of walkFiles(rawDir)) {
    const sourcePath = rel.split(sep).join('/')
    consider(sourcePath, join(rawDir, rel), 'raw')
  }

  for (const linked of entry.linkedDirs) {
    if (!existsSync(linked.path)) continue
    for (const rel of walkFiles(linked.path)) {
      const absolutePath = join(linked.path, rel)
      // Linked files are keyed by absolute path in hashes.json.
      consider(absolutePath, absolutePath, 'linked')
    }
  }

  return candidates
}
