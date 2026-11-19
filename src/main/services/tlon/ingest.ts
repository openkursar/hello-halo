/**
 * Tlon ingest orchestration — cheap text extraction (no LLM).
 *
 * Each source file is extracted to plaintext under text/ so the knowledge base
 * is queryable immediately via agentic search (the chat agent greps/reads the
 * text/ corpus at query time — see service.getKBChatContext). Ingest does NO
 * model work: it is IO/CPU only, so dozens of files finish in seconds.
 *
 * index.md is rebuilt programmatically as a document map (name → absolute text
 * path) injected into agent prompts. Learned status is persisted only on
 * success (hashes.json: textPath per source).
 *
 * A batch stages its text and records and commits them together at the end,
 * so a KB is never searched half-updated.
 */

import { isAbsolute, join, relative, sep } from 'path'
import { setImmediate as yieldToMain } from 'node:timers/promises'
import {
  readFileSync,
  writeFileSync,
  existsSync,
  appendFileSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  lstatSync,
  statSync,
  renameSync,
  rmSync,
  copyFileSync,
} from 'fs'
import { v4 as uuidv4 } from 'uuid'
import { sendToRenderer } from '../../foundation/window.service'
import { broadcastToAll } from '../../http/websocket'
import type {
  IngestJob,
  IngestProgressEvent,
  IngestHashesV1,
} from '../../../shared/types/tlon'
import {
  getKBLogPath,
  getKBIndexMdPath,
  getKBTextDir,
  getKBStagingDir,
} from './paths'
import {
  getKB,
  listKBs,
  readHashes,
  writeHashes,
  refreshStats,
  markIngestCompleted,
  collectIngestCandidates,
  clearWikiAndHashes,
  retireRemovedSources,
  sweepRemovedSources,
  scanIngestSources,
  isRetirementMigrated,
  markRetirementMigrated,
  generatedTextName,
  generatedTextHeader,
  sha256,
  effectiveKBOptions,
  collectLinkedVersions,
  linkedDirForSource,
  pendingForgets,
  retireForgottenSources,
} from './service'
import { extractText } from './extract'
import { DEFAULT_INDEX_MD } from './defaults'
import { extractionRevision, ownedTextPath, sameTextStamp, stampOf, type TextStamp } from './extraction-revision'
import { upgradeXlsxSource } from './xlsx-upgrade'

// ============================================================================
// State
// ============================================================================

const queues = new Map<string, IngestJob[]>()
const processing = new Set<string>()
/** The batch each KB is running, so a mid-batch scan does not queue what it already extracted. */
const activeBatches = new Map<string, IngestBatch>()
const progress = new Map<string, IngestProgressEvent>()

function emitProgress(event: IngestProgressEvent): void {
  progress.set(event.kbId, event)
  sendToRenderer('tlon:ingest-progress', event as unknown as Record<string, unknown>)
  broadcastToAll('tlon:ingest-progress', event as unknown as Record<string, unknown>)
}

function emitStatsUpdated(kbId: string): void {
  const stats = refreshStats(kbId)
  const payload = { kbId, stats }
  sendToRenderer('tlon:stats-updated', payload as unknown as Record<string, unknown>)
  broadcastToAll('tlon:stats-updated', payload as unknown as Record<string, unknown>)
}

/** Tell the views a KB changed outside an ingest run (a watched folder paused or resumed). */
export function notifyStatsUpdated(kbId: string): void {
  emitStatsUpdated(kbId)
}

export function getIngestProgress(kbId: string): IngestProgressEvent {
  return (
    progress.get(kbId) || {
      kbId,
      total: 0,
      completed: 0,
      phase: 'idle',
    }
  )
}

// ============================================================================
// Public enqueue API
// ============================================================================

/**
 * Append jobs to a KB's queue. Does NOT start processing. Safe to call while a
 * batch is running: processQueue drains the live array and recomputes totals.
 */
export function enqueueFiles(
  kbId: string,
  entries: Array<{ sourcePath: string; absolutePath: string; sourceType: 'raw' | 'linked' }>,
  options: { automatic?: boolean } = {}
): void {
  const queue = queues.get(kbId) || []
  const batch = activeBatches.get(kbId)
  for (const e of entries) {
    if (batch && extractedUnchanged(batch, e.sourcePath, e.absolutePath)) continue
    const existing = queue.find(j => j.sourcePath === e.sourcePath)
    if (existing) {
      if (!options.automatic) existing.automatic = false
      continue
    }
    queue.push({
      id: uuidv4(),
      kbId,
      sourcePath: e.sourcePath,
      absolutePath: e.absolutePath,
      sourceType: e.sourceType,
      automatic: options.automatic === true,
      status: 'pending',
    })
  }
  queues.set(kbId, queue)
}

/**
 * Enqueue ALL changed raw + linked files for a KB, then start processing.
 * This is the user-triggered "Learn everything" path.
 */
export async function triggerFullIngest(kbId: string): Promise<void> {
  const kb = getKB(kbId)
  if (!kb) return

  // A watched folder reached through a symlink may point elsewhere since it
  // was subscribed (a release switched); re-aim its watch first. Lazy import:
  // watcher.ts imports this module.
  if (kb.status === 'active' && kb.linkedDirs.length > 0) {
    try {
      const { refreshLinkedWatches } = await import('./watcher')
      await refreshLinkedWatches(kbId)
    } catch (error) {
      console.error(`[Tlon] Refreshing watches failed for ${kbId}:`, error)
    }
  }

  await sweepRemovedSourcesAndIndex(kbId)
  if (!getKB(kbId)) return
  markRetirementMigrated(kbId)
  const candidates = collectIngestCandidates(kbId)
  enqueueFiles(kbId, candidates)

  const queue = queues.get(kbId) || []
  const pending = queue.length > 0 || hasPendingCommit(kbId)
  emitProgress({
    kbId,
    total: queue.length,
    completed: 0,
    phase: pending ? 'running' : 'done',
  })

  if (!pending) {
    emitStatsUpdated(kbId)
    return
  }

  await processQueue(kbId)
}

function afterRetirement(kbId: string, removed: number): number {
  if (removed > 0 && getKB(kbId)) {
    rebuildIndexMd(kbId)
    emitStatsUpdated(kbId)
  }
  return removed
}

/**
 * The ingest walk, with recorded sources it no longer finds proven gone and
 * retired — no second pass over the KB.
 */
export function collectCandidatesRetiringRemoved(kbId: string): ReturnType<typeof scanIngestSources>['candidates'] {
  const { candidates, unseen } = scanIngestSources(kbId)
  if (unseen.length > 0) afterRetirement(kbId, retireRemovedSources(kbId, unseen))
  return candidates
}

/** Full reconciliation, including text left without a record ("learn everything", one-time migration). */
export async function sweepRemovedSourcesAndIndex(kbId: string): Promise<number> {
  return afterRetirement(kbId, await sweepRemovedSources(kbId))
}

/** True while a KB's queue is being processed (used to block clear-relearn). */
export function isIngesting(kbId: string): boolean {
  return processing.has(kbId)
}

/** Drop a deleted KB's queued jobs and last progress event. */
export function evictIngestState(kbId: string): void {
  const queue = queues.get(kbId)
  // Empty in place: an in-flight processQueue drains this live array and would
  // otherwise keep extracting for the deleted KB.
  if (queue) queue.length = 0
  queues.delete(kbId)
  progress.delete(kbId)
}

/**
 * Wipe the extracted text + learned-status, then re-extract every source from
 * scratch. Used to rebuild older KBs onto the current text index.
 */
export async function clearAndRelearn(kbId: string): Promise<void> {
  if (processing.has(kbId)) throw new Error('Ingest already in progress')
  clearWikiAndHashes(kbId)
  emitStatsUpdated(kbId)
  await triggerFullIngest(kbId)
}

/**
 * Extract any not-yet-indexed sources of every KB into text/. Idempotent (a
 * source with a valid textPath is skipped), so this migrates wiki-era KBs onto
 * the text index on startup without re-doing work. Fire-and-forget.
 */
export async function migrateKBsToTextIndex(): Promise<void> {
  for (const kb of listKBs()) {
    await yieldToMain()
    const current = getKB(kb.id)
    if (!current || current.status === 'paused') continue
    try {
      // Text left behind by removals before this cleanup existed is found by
      // one full pass per KB; afterwards each scan's own walk finds removals.
      if (!isRetirementMigrated(kb.id)) {
        await sweepRemovedSourcesAndIndex(kb.id)
        if (!getKB(kb.id)) continue
        markRetirementMigrated(kb.id)
      }
      const candidates = collectCandidatesRetiringRemoved(kb.id)
      if (candidates.length > 0) {
        enqueueFiles(kb.id, candidates, { automatic: true })
        await processQueue(kb.id)
      }
    } catch (error) {
      console.error(`[Tlon] Text-index migration failed for ${kb.id}:`, error)
    }
  }
}

function fileName(sourcePath: string): string {
  return sourcePath.split(sep).pop() || sourcePath
}

/**
 * True when a batch must commit even with nothing to extract: a forgotten
 * folder is waiting to leave, or a watched folder's version moved.
 */
export function hasPendingCommit(kbId: string): boolean {
  const hashes = readHashes(kbId)
  if (pendingForgets(kbId, hashes).length > 0) return true
  return !sameVersions(hashes.versions, collectLinkedVersions(kbId, hashes.versions))
}

function sameVersions(a: Record<string, string> | undefined, b: Record<string, string>): boolean {
  const keys = Object.keys(a ?? {})
  return keys.length === Object.keys(b).length && keys.every(k => a?.[k] === b[k])
}

type IngestRecord = IngestHashesV1['files'][string]

/**
 * One batch's pending writes. Extracted text is staged and records are held
 * until the batch commits, so a chat reading the KB mid-batch sees the
 * previous complete set, not a mix of old and new documents.
 */
interface IngestBatch {
  stagingDir: string
  /** Source key → its new record, its staged text (if any), the file identity read, and its job. */
  records: Map<string, { record: IngestRecord; staged?: string; read: TextStamp; job: IngestJob }>
  /** Folder versions at batch start, recorded on each learned source. */
  versions: Record<string, string>
}

/** Extracted by this batch and not changed since. */
function extractedUnchanged(batch: IngestBatch, sourcePath: string, absolutePath: string): boolean {
  const done = batch.records.get(sourcePath)
  if (!done) return false
  try {
    return sameTextStamp(done.read, stampOf(statSync(absolutePath)))
  } catch {
    return false
  }
}

/**
 * Process the queue: extract each pending file one at a time into the batch,
 * then commit the batch. Kept sequential so progress is monotonic; each step
 * is cheap (no model call).
 */
export async function processQueue(kbId: string): Promise<void> {
  if (processing.has(kbId)) return
  const queue = queues.get(kbId) || []
  if (queue.length === 0 && !hasPendingCommit(kbId)) return
  // Registered so the watcher enqueues into the array this batch drains.
  queues.set(kbId, queue)

  processing.add(kbId)
  let completed = 0
  let pausedJobs = 0
  const errors: Array<{ file: string; message: string }> = []
  const stagingDir = getKBStagingDir(kbId)
  // Left by an interrupted batch: never committed, so never visible.
  rmSync(stagingDir, { recursive: true, force: true })
  const batch: IngestBatch = {
    stagingDir,
    records: new Map(),
    versions: collectLinkedVersions(kbId, readHashes(kbId).versions),
  }
  activeBatches.set(kbId, batch)

  emitProgress({
    kbId,
    // Recomputed on every emit: the watcher may enqueue into this live queue
    // mid-batch, so a total captured once would go stale (e.g. "7/5").
    total: completed + queue.length,
    completed,
    current: queue[0] ? fileName(queue[0].sourcePath) : undefined,
    phase: 'running',
  })

  try {
    while (queue.length > 0) {
      const job = queue.shift() as IngestJob
      try {
        if (job.automatic && getKB(kbId)?.status === 'paused') {
          job.status = 'skipped'
          pausedJobs++
        } else await extractSource(kbId, job, batch)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[Tlon] Extract failed for ${job.sourcePath}:`, message)
        // One bad file must not error the whole KB (status stays 'active', so
        // it keeps being injected). Failures accumulate and ride every emit.
        job.status = 'error'
        job.error = message
        errors.push({ file: fileName(job.sourcePath), message })
      }
      if (!getKB(kbId)) break
      completed++
      emitProgress({
        kbId,
        total: completed + queue.length,
        completed,
        current: queue[0] ? fileName(queue[0].sourcePath) : undefined,
        phase: 'running',
        errors: errors.length > 0 ? [...errors] : undefined,
      })
    }
    // A KB deleted mid-batch has nothing to commit into.
    if (getKB(kbId)) commitBatch(kbId, batch)
  } finally {
    activeBatches.delete(kbId)
    rmSync(stagingDir, { recursive: true, force: true })
    processing.delete(kbId)
    queues.delete(kbId)
  }

  if (!getKB(kbId)) return
  if (pausedJobs) console.log(`[Tlon] Deferred ${pausedJobs} automatic source(s) while knowledge base ${kbId} is paused`)

  // Rebuild the document map once per batch (not per file) — O(n), not O(n^2).
  rebuildIndexMd(kbId)
  markIngestCompleted(kbId)
  emitProgress({
    kbId,
    total: completed,
    completed,
    phase: 'done',
    errors: errors.length > 0 ? errors : undefined,
  })
  emitStatsUpdated(kbId)
}

// ============================================================================
// Extraction (the ingest unit of work)
// ============================================================================

const changedNotices = new Set<string>()
const MAX_CHANGED_NOTICES = 1000

/**
 * Bytes read for a job are committed only while the same file is still at its
 * path: one removed, or removed and recreated, while its extraction was queued
 * or running is not written back. Checked synchronously right before each
 * commit; a change after the check produces a watcher event and a new scan.
 */
function sourceChangedDuringExtraction(job: IngestJob, read: TextStamp): boolean {
  let current: TextStamp | null = null
  try {
    current = stampOf(statSync(job.absolutePath))
  } catch { /* removed */ }
  if (current && sameTextStamp(read, current)) return false
  const notice = `${job.kbId}\0${job.sourcePath}\0${current ? 'replaced' : 'removed'}`
  if (!changedNotices.has(notice)) {
    if (changedNotices.size >= MAX_CHANGED_NOTICES) changedNotices.clear()
    changedNotices.add(notice)
    console.warn(`[Tlon] Source ${current ? 'replaced' : 'removed'} during extraction, not recorded: ${job.sourcePath}`)
  }
  job.status = 'skipped'
  return true
}

/**
 * Extract one source into the batch: its text is staged and its record held
 * until commitBatch. The original bytes are hashed for learned-status; the
 * extracted text (prefixed with a source marker for citation) is what queries
 * grep/read.
 */
async function extractSource(kbId: string, job: IngestJob, batch: IngestBatch): Promise<void> {
  job.status = 'running'
  job.startedAt = new Date().toISOString()
  const textPath = generatedTextName(job.sourcePath)
  // Legacy spreadsheet upgrades keep writing in place: they replace text with
  // an equivalent rendering, not a new document set.
  if (await upgradeXlsxSource(job, textPath, () => appendLog(job, textPath))) return
  const revision = extractionRevision(job.absolutePath)
  const kb = getKB(kbId)
  const dir = kb && job.sourceType === 'linked' ? linkedDirForSource(kb, job.sourcePath) : undefined
  const folderVersion = dir ? batch.versions[dir.path] : undefined
  const version = {
    ...(revision === undefined ? {} : { extractorRevision: revision }),
    ...(folderVersion ? { version: folderVersion } : {}),
  }

  let buf: Buffer
  let read: TextStamp
  try {
    read = stampOf(statSync(job.absolutePath))
    buf = readFileSync(job.absolutePath)
  } catch {
    job.status = 'skipped'
    console.warn(`[Tlon] Cannot read ${job.absolutePath}, skipping`)
    return
  }
  const contentHash = sha256(buf)
  const identity = job.sourceType === 'linked' ? { ...version, sourceDev: read.dev } : version

  // Extraction failures propagate to processQueue, which records them on the
  // batch's error list; lastError is persisted so the UI can show why the file
  // is unlearned. The hash entry has neither textPath nor empty, so the file
  // retries on the next scan.
  let fileContent: string
  try {
    fileContent = await extractText(job.absolutePath, buf)
  } catch (error) {
    if (sourceChangedDuringExtraction(job, read)) return
    const message = error instanceof Error ? error.message : String(error)
    batch.records.set(job.sourcePath, {
      record: { hash: contentHash, ingestedAt: new Date().toISOString(), lastError: message, ...identity },
      read,
      job,
    })
    throw error
  }
  if (sourceChangedDuringExtraction(job, read)) return
  if (!fileContent.trim()) {
    console.warn(`[Tlon] No text extracted from ${job.sourcePath}, skipping`)
    // Record the attempt so a text-less source (e.g. an image with no text) is
    // not re-extracted on every launch; it retries only when its bytes change.
    batch.records.set(job.sourcePath, {
      record: { hash: contentHash, ingestedAt: new Date().toISOString(), empty: true, ...identity },
      read,
      job,
    })
    job.status = 'skipped'
    return
  }

  if (!existsSync(batch.stagingDir)) mkdirSync(batch.stagingDir, { recursive: true })
  const staged = join(batch.stagingDir, textPath)
  writeFileSync(staged, `${generatedTextHeader(job.sourcePath)}\n\n${fileContent}`, 'utf-8')
  batch.records.set(job.sourcePath, {
    record: { hash: contentHash, ingestedAt: new Date().toISOString(), textPath, ...identity },
    staged,
    read,
    job,
  })

  job.status = 'completed'
  job.completedAt = new Date().toISOString()
  job.contentHash = contentHash
}

/**
 * Make a batch visible: staged text moves into text/ first, then every record
 * is merged into the current hashes in one write (records changed meanwhile
 * by a retirement or another writer are kept), then pending forgets apply.
 * A source replaced or removed since it was read is left out.
 */
function commitBatch(kbId: string, batch: IngestBatch): void {
  const textDir = getKBTextDir(kbId)
  const accepted: Array<[string, IngestRecord]> = []
  for (const [sourcePath, entry] of batch.records) {
    if (sourceChangedDuringExtraction(entry.job, entry.read)) continue
    if (entry.staged) {
      try {
        if (!existsSync(textDir)) mkdirSync(textDir, { recursive: true })
        moveFile(entry.staged, join(textDir, entry.record.textPath as string))
      } catch (error) {
        // Unrecorded, so the source is extracted again on the next scan.
        console.error(`[Tlon] Failed to commit text for ${sourcePath}:`, error)
        continue
      }
      appendLog(entry.job, entry.record.textPath as string)
    }
    accepted.push([sourcePath, entry.record])
  }
  const hashes: IngestHashesV1 = readHashes(kbId)
  for (const [sourcePath, record] of accepted) hashes.files[sourcePath] = record
  const versions = collectLinkedVersions(kbId, hashes.versions)
  if (Object.keys(versions).length > 0) hashes.versions = versions
  else delete hashes.versions
  writeHashes(kbId, hashes)
  retireForgottenSources(kbId)
}

/** Rename within one volume; copy then remove when staging and text/ differ. */
function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    copyFileSync(from, to)
    rmSync(from, { force: true })
  }
}

// ============================================================================
// Document map (index.md) — injected into agent prompts
// ============================================================================

/**
 * Rebuild index.md as a document map: each source document with a one-line
 * synopsis and the ABSOLUTE path of its extracted text, so the agent can
 * Grep/Read it regardless of its working directory. Programmatic — cheap.
 *
 * Exported so a bootstrap refresh can regenerate the map without re-extracting.
 */
export function rebuildIndexMd(kbId: string): void {
  const kb = getKB(kbId)
  if (!kb) return
  const indexPath = getKBIndexMdPath(kbId)
  try {
    if (lstatSync(indexPath).isSymbolicLink()) {
      console.warn(`[Tlon] Preserved a linked knowledge index: ${kbId}`)
      return
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const textDir = getKBTextDir(kbId)
  const hashes = readHashes(kbId)
  const { mapMaxDocs } = effectiveKBOptions(kb)

  // Grouped by watched folder (in configured order, named relative to it and
  // tagged with its version), then added files, then anything else learned.
  const groups = kb.linkedDirs.map(dir => ({
    heading: `${mapLabel(dir.label || dir.path)}${hashes.versions?.[dir.path] ? ` (version ${mapLabel(hashes.versions[dir.path])})` : ''}`,
    docs: [] as MapDoc[],
  }))
  const added: MapDoc[] = []
  const other: MapDoc[] = []
  for (const [sourcePath, info] of Object.entries(hashes.files)) {
    const absPath = info.textPath ? ownedTextPath(textDir, info.textPath) : null
    if (!absPath) continue
    if (!isAbsolute(sourcePath)) {
      added.push({ name: sourcePath.split(/[\\/]/).join('/'), absPath })
      continue
    }
    const at = kb.linkedDirs.findIndex(d => isWithinDir(d.path, sourcePath))
    if (at >= 0) groups[at].docs.push({ name: relative(kb.linkedDirs[at].path, sourcePath).split(sep).join('/'), absPath })
    else other.push({ name: sourcePath.split(/[\\/]/).pop() || sourcePath, absPath })
  }

  const total = groups.reduce((n, g) => n + g.docs.length, 0) + added.length + other.length
  if (total === 0) {
    writeFileSync(getKBIndexMdPath(kbId), DEFAULT_INDEX_MD, 'utf-8')
    return
  }

  let md = `# ${kb.name}\n\n`
  md += `The source documents in this knowledge base. To answer, Grep/Glob and `
  md += `Read the document files below for exact passages, then cite the document by name.\n\n`
  let listed = 0
  const list = (docs: MapDoc[]): void => {
    for (const doc of docs.sort((a, b) => a.name.localeCompare(b.name))) {
      if (listed >= mapMaxDocs) return
      listed++
      let synopsis = ''
      try {
        synopsis = firstProseLine(readFileHead(doc.absPath))
      } catch { /* ignore */ }
      md += `- **${doc.name}**${synopsis ? ` — ${synopsis}` : ''} — \`${doc.absPath}\`\n`
    }
  }
  if (kb.linkedDirs.length === 0) {
    // No watched folders: one flat list, as before.
    list([...added.map(d => ({ ...d, name: d.name.split('/').pop() || d.name })), ...other])
  } else {
    const sections: Array<{ heading: string; docs: MapDoc[] }> = [
      ...groups,
      { heading: 'Added files', docs: added },
      { heading: 'Other documents', docs: other },
    ]
    for (const section of sections) {
      if (section.docs.length === 0 || listed >= mapMaxDocs) continue
      md += `## ${section.heading}\n\n`
      list(section.docs)
      md += '\n'
    }
  }
  if (total > listed) {
    md += `\n…and ${total - listed} more documents — Glob \`${textDir}\` to list all.\n`
  }
  md += '\n'
  writeFileSync(getKBIndexMdPath(kbId), md, 'utf-8')
}

interface MapDoc { name: string; absPath: string }

/** A label or version as one safe line of the map. */
function mapLabel(text: string): string {
  const line = text.replace(/[\r\n]+/g, ' ').replace(/[#`]/g, '').trim()
  return line.length > 80 ? line.slice(0, 80) : line
}

function isWithinDir(dir: string, path: string): boolean {
  const rel = relative(dir, path)
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
}

const SYNOPSIS_READ_BYTES = 4096

/** Read only the first bytes of a text file — synopses never need the whole document. */
function readFileHead(path: string): string {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(SYNOPSIS_READ_BYTES)
    const bytesRead = readSync(fd, buf, 0, SYNOPSIS_READ_BYTES, 0)
    return buf.toString('utf-8', 0, bytesRead)
  } finally {
    closeSync(fd)
  }
}

/**
 * One-line synopsis of extracted text: a front-matter description/summary when
 * present, else the first non-empty prose line (skipping the source marker), capped.
 */
function firstProseLine(content: string): string {
  const cap = (line: string): string => line.length > 160 ? line.slice(0, 157).trimEnd() + '…' : line
  const lines = content.split('\n')
  let i = 0
  while (i < lines.length && (!lines[i].trim() || lines[i].trim().startsWith('<!--'))) i++
  if (lines[i]?.trim() === '---') {
    let summary = ''
    for (i = i + 1; i < lines.length && lines[i].trim() !== '---'; i++) {
      const m = /^(description|summary)\s*:\s*(.+)$/.exec(lines[i].trim())
      if (m && !summary) summary = m[2].replace(/^['"]|['"]$/g, '').trim()
    }
    i++ // past the closing ---
    if (summary) return cap(summary)
  }
  for (; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith('<!--')) continue
    return cap(line)
  }
  return ''
}

function appendLog(job: IngestJob, textPath: string): void {
  const date = new Date().toISOString().slice(0, 10)
  const line = `## [${date}] extract | ${job.sourcePath} — text/${textPath}\n`
  try {
    appendFileSync(getKBLogPath(job.kbId), line, 'utf-8')
  } catch (error) {
    console.error(`[Tlon] Failed to append log for ${job.kbId}:`, error)
  }
}
