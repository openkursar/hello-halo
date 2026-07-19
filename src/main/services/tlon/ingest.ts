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
 */

import { join, sep } from 'path'
import {
  readFileSync,
  writeFileSync,
  existsSync,
  appendFileSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
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
  sha256,
} from './service'
import { extractText } from './extract'
import { DEFAULT_INDEX_MD } from './defaults'

// ============================================================================
// State
// ============================================================================

const queues = new Map<string, IngestJob[]>()
const processing = new Set<string>()
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
  entries: Array<{ sourcePath: string; absolutePath: string; sourceType: 'raw' | 'linked' }>
): void {
  const queue = queues.get(kbId) || []
  for (const e of entries) {
    if (queue.some(j => j.sourcePath === e.sourcePath)) continue
    queue.push({
      id: uuidv4(),
      kbId,
      sourcePath: e.sourcePath,
      absolutePath: e.absolutePath,
      sourceType: e.sourceType,
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

  const candidates = collectIngestCandidates(kbId)
  enqueueFiles(kbId, candidates)

  const queue = queues.get(kbId) || []
  emitProgress({
    kbId,
    total: queue.length,
    completed: 0,
    phase: queue.length > 0 ? 'running' : 'done',
  })

  if (queue.length === 0) {
    emitStatsUpdated(kbId)
    return
  }

  await processQueue(kbId)
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
    try {
      if (collectIngestCandidates(kb.id).length > 0) {
        await triggerFullIngest(kb.id)
      }
    } catch (error) {
      console.error(`[Tlon] Text-index migration failed for ${kb.id}:`, error)
    }
  }
}

/**
 * Process the queue: extract each pending file to text/ one at a time. Kept
 * sequential so progress is monotonic and writes stay simple; each step is
 * cheap (no model call).
 */
function fileName(sourcePath: string): string {
  return sourcePath.split(sep).pop() || sourcePath
}

export async function processQueue(kbId: string): Promise<void> {
  if (processing.has(kbId)) return
  const queue = queues.get(kbId)
  if (!queue || queue.length === 0) return

  processing.add(kbId)
  let completed = 0
  const errors: Array<{ file: string; message: string }> = []

  emitProgress({
    kbId,
    // Recomputed on every emit: the watcher may enqueue into this live queue
    // mid-batch, so a total captured once would go stale (e.g. "7/5").
    total: completed + queue.length,
    completed,
    current: fileName(queue[0].sourcePath),
    phase: 'running',
  })

  try {
    while (queue.length > 0) {
      const job = queue.shift() as IngestJob
      try {
        await extractSource(kbId, job)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[Tlon] Extract failed for ${job.sourcePath}:`, message)
        // One bad file must not error the whole KB (status stays 'active', so
        // it keeps being injected). Failures accumulate and ride every emit.
        job.status = 'error'
        job.error = message
        errors.push({ file: fileName(job.sourcePath), message })
      }
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
  } finally {
    processing.delete(kbId)
    queues.delete(kbId)
  }

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

/** text/-relative filename holding a source's extracted plaintext. */
function textFileName(sourcePath: string): string {
  return sha256(sourcePath).slice(0, 16) + '.txt'
}

/**
 * Extract one source to text/, then record its learned status and rebuild the
 * index. The original bytes are hashed for learned-status; the extracted text
 * (prefixed with a source marker for citation) is what queries grep/read.
 */
async function extractSource(kbId: string, job: IngestJob): Promise<void> {
  job.status = 'running'
  job.startedAt = new Date().toISOString()

  let buf: Buffer
  try {
    buf = readFileSync(job.absolutePath)
  } catch {
    job.status = 'skipped'
    console.warn(`[Tlon] Cannot read ${job.absolutePath}, skipping`)
    return
  }
  const contentHash = sha256(buf)

  // Extraction failures propagate to processQueue, which records them on the
  // batch's error list (the file stays unlearned and retries on the next scan).
  const fileContent = await extractText(job.absolutePath, buf)
  if (!fileContent.trim()) {
    console.warn(`[Tlon] No text extracted from ${job.sourcePath}, skipping`)
    // Record the attempt so a text-less source (e.g. an image with no text) is
    // not re-extracted on every launch; it retries only when its bytes change.
    const hashes: IngestHashesV1 = readHashes(kbId)
    hashes.files[job.sourcePath] = { hash: contentHash, ingestedAt: new Date().toISOString(), empty: true }
    writeHashes(kbId, hashes)
    job.status = 'skipped'
    return
  }

  const textDir = getKBTextDir(kbId)
  if (!existsSync(textDir)) mkdirSync(textDir, { recursive: true })
  const textPath = textFileName(job.sourcePath)
  writeFileSync(
    join(textDir, textPath),
    `<!-- source: ${job.sourcePath} -->\n\n${fileContent}`,
    'utf-8'
  )

  appendLog(job, textPath)

  const hashes: IngestHashesV1 = readHashes(kbId)
  hashes.files[job.sourcePath] = {
    hash: contentHash,
    ingestedAt: new Date().toISOString(),
    textPath,
  }
  writeHashes(kbId, hashes)

  job.status = 'completed'
  job.completedAt = new Date().toISOString()
  job.contentHash = contentHash
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
  const textDir = getKBTextDir(kbId)
  const hashes = readHashes(kbId)

  const docs = Object.entries(hashes.files)
    .filter(([, info]) => info.textPath && existsSync(join(textDir, info.textPath)))
    .map(([sourcePath, info]) => ({
      name: sourcePath.split(/[\\/]/).pop() || sourcePath,
      absPath: join(textDir, info.textPath as string),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  if (docs.length === 0) {
    writeFileSync(getKBIndexMdPath(kbId), DEFAULT_INDEX_MD, 'utf-8')
    return
  }

  let md = `# ${kb.name}\n\n`
  md += `The source documents in this knowledge base. To answer, Grep/Glob and `
  md += `Read the document files below for exact passages, then cite the document by name.\n\n`
  for (const doc of docs.slice(0, INDEX_MAX_DOCS)) {
    let synopsis = ''
    try {
      synopsis = firstProseLine(readFileHead(doc.absPath))
    } catch { /* ignore */ }
    md += `- **${doc.name}**${synopsis ? ` — ${synopsis}` : ''} — \`${doc.absPath}\`\n`
  }
  if (docs.length > INDEX_MAX_DOCS) {
    md += `\n…and ${docs.length - INDEX_MAX_DOCS} more documents — Glob \`${textDir}\` to list all.\n`
  }
  md += '\n'
  writeFileSync(getKBIndexMdPath(kbId), md, 'utf-8')
}

/** Keeps the injected document map bounded for large KBs. */
const INDEX_MAX_DOCS = 200
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

/** First non-empty prose line of extracted text (skips the source marker), capped. */
function firstProseLine(content: string): string {
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('<!--')) continue
    return line.length > 160 ? line.slice(0, 157).trimEnd() + '…' : line
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
