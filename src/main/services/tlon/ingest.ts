/**
 * Tlon ingest orchestration — compounding curator.
 *
 * Each source file is folded into the wiki by a headless agent (the Halo agent
 * engine via `query`) whose working directory IS the KB's wiki/ dir. The agent
 * searches existing pages (Glob/Grep), reads the relevant ones, and merges the
 * new source in (Write/Edit) — so the wiki compounds across sources instead of
 * accumulating per-document summaries.
 *
 * Files are processed STRICTLY SEQUENTIALLY: each agent run must see the wiki
 * state left by the previous file, and concurrent runs would race writes to the
 * same pages.
 *
 * Learned status is persisted only on success (hashes.json), and index.md is
 * always rebuilt programmatically from the wiki directory — the agent never
 * touches it.
 */

import { join, sep } from 'path'
import { readFileSync, writeFileSync, existsSync, appendFileSync, readdirSync, statSync } from 'fs'
import { v4 as uuidv4 } from 'uuid'
import { sendToRenderer } from '../../foundation/window.service'
import { broadcastToAll } from '../../http/websocket'
import { getConfig } from '../../foundation/config.service'
import { getApiCredentials, getHeadlessElectronPath } from '../agent/helpers'
import { resolveCredentialsForSdk, buildBaseSdkOptions } from '../agent/sdk-config'
import { query } from '../agent/resolved-sdk'
import type {
  IngestJob,
  IngestProgressEvent,
  IngestHashesV1,
} from '../../../shared/types/tlon'
import {
  getKBSchemaPath,
  getKBLogPath,
  getKBWikiDir,
} from './paths'
import {
  getKB,
  readHashes,
  writeHashes,
  listWikiPages,
  refreshStats,
  markIngestCompleted,
  setKBStatus,
  collectIngestCandidates,
  clearWikiAndHashes,
  sha256,
} from './service'
import { extractText } from './extract'
import {
  buildCuratorSystemPrompt,
  buildCuratorUserMessage,
  DEFAULT_INDEX_MD,
} from './defaults'

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
 * Append jobs to a KB's queue. Does NOT start processing — callers that want
 * a correct batch total must enqueue everything first, then call processQueue.
 */
export function enqueueFiles(
  kbId: string,
  entries: Array<{ sourcePath: string; absolutePath: string; sourceType: 'raw' | 'linked' }>
): void {
  const queue = queues.get(kbId) || []
  for (const e of entries) {
    // De-dup against pending jobs for the same source path.
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
 * Enqueue ALL changed raw + linked files for a KB, set the batch total once,
 * then start processing. This is the user-triggered "Learn everything" path.
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

/**
 * Wipe the generated wiki + learned-status, then re-ingest every source from
 * scratch with the current compounding curator. Used to rebuild older KBs.
 */
export async function clearAndRelearn(kbId: string): Promise<void> {
  if (processing.has(kbId)) throw new Error('Ingest already in progress')
  clearWikiAndHashes(kbId)
  emitStatsUpdated(kbId)
  await triggerFullIngest(kbId)
}

/**
 * Process the queue: fold each pending file into the wiki one at a time via the
 * curator agent. Strictly sequential — each run must see the previous file's
 * merges, and concurrent runs would race writes to the same pages.
 */
export async function processQueue(kbId: string): Promise<void> {
  if (processing.has(kbId)) return
  const queue = queues.get(kbId)
  if (!queue || queue.length === 0) return

  processing.add(kbId)
  const total = queue.length
  let completed = 0

  const existing = progress.get(kbId)
  if (!existing || existing.phase !== 'running' || existing.total < total) {
    emitProgress({ kbId, total, completed: 0, phase: 'running' })
  }

  try {
    while (queue.length > 0) {
      const job = queue.shift() as IngestJob
      emitProgress({
        kbId,
        total,
        completed,
        current: job.sourcePath.split(sep).pop() || job.sourcePath,
        phase: 'running',
      })
      try {
        await runCuratorIngest(kbId, job)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[Tlon] Ingest failed for ${job.sourcePath}:`, message)
        setKBStatus(kbId, 'error')
        emitProgress({ kbId, total, completed, phase: 'error', error: message })
      }
      completed++
      emitProgress({ kbId, total, completed, phase: 'running' })
    }
  } finally {
    processing.delete(kbId)
    queues.delete(kbId)
  }

  markIngestCompleted(kbId)
  emitProgress({ kbId, total, completed, phase: 'done' })
  emitStatsUpdated(kbId)
}

// ============================================================================
// Curator agent (compounding ingest)
// ============================================================================

/**
 * Fold one source file into the wiki via the curator agent, then record its
 * learned status and rebuild the index. Throws on agent failure so the caller
 * marks the KB errored and the file stays "not learned".
 */
async function runCuratorIngest(kbId: string, job: IngestJob): Promise<void> {
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

  let fileContent: string
  try {
    fileContent = await extractText(job.absolutePath, buf)
  } catch (error) {
    console.warn(`[Tlon] Failed to extract ${job.sourcePath}: ${error instanceof Error ? error.message : String(error)}`)
    job.status = 'skipped'
    return
  }
  if (!fileContent.trim()) {
    console.warn(`[Tlon] No text extracted from ${job.sourcePath}, skipping`)
    job.status = 'skipped'
    return
  }

  const wikiDir = getKBWikiDir(kbId)
  const before = snapshotWikiMtimes(wikiDir)

  await runCuratorAgent(kbId, job.sourcePath, fileContent, wikiDir)

  // Pages whose files changed during this run are this source's wiki pages.
  const affected = changedPages(before, snapshotWikiMtimes(wikiDir))

  rebuildIndexMd(kbId)
  appendLog(job, affected)

  const hashes: IngestHashesV1 = readHashes(kbId)
  hashes.files[job.sourcePath] = {
    hash: contentHash,
    ingestedAt: new Date().toISOString(),
    wikiPages: affected,
  }
  writeHashes(kbId, hashes)

  job.status = 'completed'
  job.completedAt = new Date().toISOString()
  job.contentHash = contentHash
  job.wikiPagesAffected = affected
}

/**
 * Run the headless curator agent over the KB's wiki dir for one source. cwd is
 * the wiki, so the agent's Read/Glob/Grep/Write/Edit tools operate directly on
 * existing pages. Restricted toolset (no Bash/Skill/web), bypass permissions
 * (headless, no UI), no MCP/digital-humans/browser.
 */
async function runCuratorAgent(
  kbId: string,
  sourcePath: string,
  fileContent: string,
  wikiDir: string
): Promise<void> {
  const config = getConfig()
  const credentials = await getApiCredentials(config)
  const resolved = await resolveCredentialsForSdk(credentials)
  const electronPath = getHeadlessElectronPath()
  const schema = existsSync(getKBSchemaPath(kbId))
    ? readFileSync(getKBSchemaPath(kbId), 'utf-8')
    : ''

  const sdkOptions = buildBaseSdkOptions({
    credentials: resolved,
    workDir: wikiDir,
    electronPath,
    spaceId: `tlon-ingest:${kbId}`,
    conversationId: `tlon-ingest-${uuidv4()}`,
    mcpServers: null,
    maxTurns: 60,
    promptProfile: config.agent?.promptProfile,
    configDirMode: config.agent?.configDirMode,
    customConfigDir: config.agent?.customConfigDir,
    aiBrowserEnabled: false,
    digitalHumansEnabled: false,
  })
  sdkOptions.systemPrompt = buildCuratorSystemPrompt(schema)
  sdkOptions.allowedTools = ['Read', 'Write', 'Edit', 'Grep', 'Glob']
  sdkOptions.disallowedTools = ['Bash', 'Skill', 'Task', 'WebSearch', 'WebFetch', 'TodoWrite']
  sdkOptions.maxThinkingTokens = 0

  const userMessage = buildCuratorUserMessage(sourcePath, fileContent)

  let resultError: string | null = null
  for await (const msg of query({ prompt: userMessage, options: sdkOptions })) {
    const m = msg as { type?: string; subtype?: string; is_error?: boolean }
    if (m?.type === 'result') {
      if (m.is_error) resultError = m.subtype || 'agent error'
      break
    }
  }
  if (resultError) {
    throw new Error(`Curator agent failed: ${resultError}`)
  }
}

/** Map of wiki-relative .md path -> mtime (ms), to detect changed pages. */
function snapshotWikiMtimes(wikiDir: string): Map<string, number> {
  const out = new Map<string, number>()
  if (!existsSync(wikiDir)) return out
  const stack = ['']
  while (stack.length > 0) {
    const rel = stack.pop() as string
    let entries: string[]
    try { entries = readdirSync(join(wikiDir, rel)) } catch { continue }
    for (const name of entries) {
      const childRel = rel ? join(rel, name) : name
      let st
      try { st = statSync(join(wikiDir, childRel)) } catch { continue }
      if (st.isDirectory()) stack.push(childRel)
      else if (st.isFile() && childRel.toLowerCase().endsWith('.md')) {
        out.set(childRel.split(sep).join('/'), st.mtimeMs)
      }
    }
  }
  return out
}

/** Pages added or modified between two mtime snapshots. */
function changedPages(before: Map<string, number>, after: Map<string, number>): string[] {
  const changed: string[] = []
  after.forEach((mtime, path) => {
    const prev = before.get(path)
    if (prev === undefined || mtime > prev) changed.push(path)
  })
  return changed.sort()
}

/**
 * Rebuild index.md from the wiki directory. Each line carries the topic title,
 * a one-line synopsis (so the agent has ambient awareness without reading), the
 * original source document, and the absolute path to Read for detail.
 *
 * Exported so the bootstrap can refresh existing KBs into this richer format
 * without re-ingesting.
 */
export function rebuildIndexMd(kbId: string): void {
  const kb = getKB(kbId)
  if (!kb) return
  const pages = listWikiPages(kbId)
  const wikiDir = getKBWikiDir(kbId)

  if (pages.length === 0) {
    writeFileSync(join(kb.path, 'index.md'), DEFAULT_INDEX_MD, 'utf-8')
    return
  }

  let md = `# ${kb.name}\n\n`
  md += `Topics you know — each has a one-line synopsis and its source. `
  md += `Read a topic's file only for exact detail.\n\n`
  for (const page of pages) {
    const absPath = join(wikiDir, ...page.path.split('/'))
    let synopsis = ''
    try {
      synopsis = pageSynopsis(readFileSync(absPath, 'utf-8'))
    } catch { /* ignore */ }
    const sources = page.sources.map(s => s.split(/[\\/]/).pop() || s)
    const from = sources.length ? ` _(from ${sources.join(', ')})_` : ''
    md += `- **${page.title}**${synopsis ? ` — ${synopsis}` : ''}${from} — \`${absPath}\`\n`
  }
  md += '\n'
  writeFileSync(join(kb.path, 'index.md'), md, 'utf-8')
}

/**
 * First prose line of a wiki page (preferring its Summary section), stripped of
 * markdown and capped — used as the index synopsis. Skips headings, source
 * blockquotes, lists, tables, and markers so model chatter does not leak in.
 */
function pageSynopsis(content: string): string {
  const lines = content.split('\n')
  const summaryIdx = lines.findIndex(l => /^#{1,6}\s+summary\b/i.test(l.trim()))
  const scan = summaryIdx >= 0 ? lines.slice(summaryIdx + 1) : lines
  for (const raw of scan) {
    const line = raw.trim()
    if (!line) continue
    if (/^#{1,6}\s/.test(line)) continue
    if (line.startsWith('>') || line.startsWith('<!--') || line.startsWith('```') || line.startsWith('|')) continue
    if (/^[-*+]\s/.test(line)) continue
    const s = line
      .replace(/`/g, '')
      .replace(/\*\*?/g, '')
      .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1')
      .trim()
    if (!s) continue
    return s.length > 160 ? s.slice(0, 157).trimEnd() + '…' : s
  }
  return ''
}

function appendLog(job: IngestJob, wikiPages: string[]): void {
  const date = new Date().toISOString().slice(0, 10)
  const summary = wikiPages.length > 0 ? wikiPages.join(', ') : '(no pages)'
  const line = `## [${date}] ingest | ${job.sourcePath} — ${summary}\n`
  try {
    appendFileSync(getKBLogPath(job.kbId), line, 'utf-8')
  } catch (error) {
    console.error(`[Tlon] Failed to append log for ${job.kbId}:`, error)
  }
}
