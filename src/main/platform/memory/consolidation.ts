/**
 * platform/memory -- Consolidation (file side)
 *
 * A consolidation reorganises a memory that has grown: settled knowledge moves
 * from `# now` and old `# History` into topics, old History is archived. The
 * reorganising is done by an agent (services/memory-consolidation); this file
 * owns everything around it that must never depend on the agent behaving:
 *
 *   assess    whether the memory is due, against its cadence's thresholds
 *   prepare   copy memory.md + topics/ into a private working folder
 *   validate  check the result is structurally sound and lost nothing
 *   commit    swap the result in, under the memory's lock. What changed in the
 *             live memory meanwhile is merged first wherever the system can
 *             decide alone; only content both sides changed is handed back
 *   rebase    adopt the live memory as the new baseline after such a hand-back
 *
 * The live memory is never touched until commit, so every other execution keeps
 * reading and writing it for the minutes the agent takes. Before the swap, the
 * memory as it stood is kept in `.snapshots/` so any consolidation can be undone.
 */

import { cp, readdir, rename, rm, stat, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { createHash, randomUUID } from 'crypto'
import { dirname, join, relative, resolve, sep } from 'path'
import type { MemoryCadence, MemoryStatus } from '../../../shared/types/memory'
import type { MemoryLayout } from './paths'
import {
  withMemoryLock,
  readMemoryFile,
  atomicWrite,
  linkToArchive,
  getFileSize,
  ensureDir,
  formatTimestamp,
  isNodeError,
} from './file-ops'
import { scanTopics, flattenTopics } from './topics'
import { parseHeadings } from './snapshot'

// ============================================================================
// Types
// ============================================================================

export interface ConsolidationMove {
  /** Topic path before, relative to the topics root */
  from: string
  /** Topic path after; null when the file was removed */
  to: string | null
  /** Where a removed file's knowledge went */
  mergedInto?: string
}

type FileStats = Map<string, { size: number; mtimeMs: number }>

/** The live memory at one moment — what a commit compares against. */
export interface Baseline {
  memory: string | null
  topicStats: FileStats
  /** Content hash per topic file */
  topicHashes: Map<string, string>
}

export interface ConsolidationWorkspace {
  layout: MemoryLayout
  /** The private working folder; the consolidating agent's cwd */
  dir: string
  memoryFile: string
  topicsDir: string
  /** Live content handed to the agent to merge; never committed */
  incomingDir: string
  baseline: Baseline
  /** Topic files every result must account for */
  requiredTopicFiles: Set<string>
  /** Topic bytes a result is measured against for loss */
  requiredTopicBytes: number
  moves: ConsolidationMove[]
}

/** A topic both the agent and another writer touched. */
export interface TopicConflict {
  path: string
  /** What the other writer did to it */
  live: 'added' | 'changed' | 'removed'
  /** Where its live content was put for the agent (absent when removed) */
  incomingPath?: string
}

/** Concurrent changes the agent has to merge itself. */
export interface ConcurrentChanges {
  /** memory.md outside `# History` changed; full live file at `memoryIncomingPath` */
  memory: { added: string[]; removed: string[]; incomingPath: string } | null
  topics: TopicConflict[]
  /** History entries carried into the workspace by the system */
  carriedHistory: number
  /** Topic changes the system merged by itself */
  mergedTopics: number
}

export type ConsolidationCommitResult =
  | {
      status: 'committed'
      archivedPath: string | null
      snapshotDir: string
      carriedHistory: number
      mergedTopics: number
    }
  | { status: 'conflict'; reason: string; changes: ConcurrentChanges; liveBaseline: Baseline }

export type ConsolidationValidation =
  | { ok: true; notes: string[] }
  | { ok: false; reason: string }

export interface ConsolidationAssessment {
  due: boolean
  /** Which thresholds were crossed, for logs */
  reasons: string[]
  sizeBytes: number
  nowBytes: number
  historyEntries: number
  overTotal: boolean
  overNow: boolean
  overHistory: boolean
}

export interface AssessOptions {
  /**
   * The most of `# now` this memory's owner shows a turn. The `# now` threshold
   * never exceeds it, so a `# now` too large to be shown in full is soon
   * consolidated rather than cut every turn.
   */
  nowCapBytes?: number
}

// ============================================================================
// Constants
// ============================================================================

/**
 * When a memory is due, by cadence. Crossing any one is enough: a large
 * `# now` costs every turn, a long History is what consolidation carries into
 * topics, the total bounds the file. `minIntervalMs` spaces automatic
 * consolidations of one memory apart, so a digital human that runs every few
 * minutes is not consolidated a dozen times a day.
 */
export const CADENCE_THRESHOLDS: Record<
  MemoryCadence,
  { totalBytes: number; nowBytes: number; historyEntries: number; minIntervalMs: number }
> = {
  diligent: { totalBytes: 100 * 1024, nowBytes: 8 * 1024, historyEntries: 30, minIntervalMs: 60 * 60_000 },
  balanced: { totalBytes: 200 * 1024, nowBytes: 16 * 1024, historyEntries: 60, minIntervalMs: 4 * 60 * 60_000 },
  economical: { totalBytes: 400 * 1024, nowBytes: 32 * 1024, historyEntries: 120, minIntervalMs: 12 * 60 * 60_000 },
}

/** History entries kept when History is trimmed without the agent. */
export function historyKeepFor(cadence: MemoryCadence): number {
  return Math.max(10, Math.floor(CADENCE_THRESHOLDS[cadence].historyEntries / 3))
}

/** Snapshots kept besides `initial` (the memory before its first consolidation) */
const SNAPSHOTS_KEPT = 3
const INITIAL_SNAPSHOT = 'initial'

/** Topic content may shrink by at most this share in one consolidation */
const MAX_TOPIC_SHRINK = 0.4
/** Below this, topic byte counts are too small for a ratio to mean anything */
const MIN_TOPIC_BYTES_FOR_SHRINK_CHECK = 2048

/**
 * After a failed attempt the memory waits until it has grown by this share,
 * doubled per consecutive failure up to the cap — a failure that repeats on
 * similar content should cost less and less often.
 */
const COOLDOWN_GROWTH = 0.2
const COOLDOWN_MAX_FACTOR = 3

// ============================================================================
// State (.state.json)
// ============================================================================

export interface MemoryState {
  lastConsolidatedAt?: string
  lastAttempt?: MemoryStatus['lastAttempt']
  /** Automatic consolidation waits until memory.md reaches this size */
  cooldownUntilBytes?: number
  /** Attempts that did not commit since the last one that did */
  consecutiveFailures?: number
  /** History last archived without consolidating (automatic consolidation off) */
  lastArchivedAt?: string
  /** Archiving for size alone waits until memory.md reaches this size */
  archiveCooldownUntilBytes?: number
}

export async function readMemoryState(layout: MemoryLayout): Promise<MemoryState> {
  const raw = await readMemoryFile(layout.stateFile)
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as MemoryState
  } catch {
    // Unreadable is handled like missing, below.
  }
  console.warn(`[Memory] Ignoring unreadable state file ${layout.stateFile}`)
  return {}
}

export async function writeMemoryState(layout: MemoryLayout, patch: MemoryState): Promise<void> {
  const next = { ...(await readMemoryState(layout)), ...patch }
  for (const key of Object.keys(next) as Array<keyof MemoryState>) {
    if (next[key] === undefined) delete next[key]
  }
  await atomicWrite(layout.stateFile, JSON.stringify(next, null, 2))
}

/**
 * Record an attempt that did not commit. When the memory is still due, it cools
 * down until it has grown — trying again on the same content would fail the
 * same way and spend the same model calls.
 */
export async function recordFailedAttempt(
  layout: MemoryLayout,
  cadence: MemoryCadence,
  outcome: 'trimmed' | 'failed',
  reason: string,
  opts: AssessOptions = {}
): Promise<{ cooldownUntilBytes?: number }> {
  const [assessment, state] = await Promise.all([assessConsolidation(layout, cadence, opts), readMemoryState(layout)])
  const failures = (state.consecutiveFailures ?? 0) + 1
  const factor = Math.min(COOLDOWN_MAX_FACTOR, 1 + COOLDOWN_GROWTH * 2 ** (failures - 1))
  const cooldownUntilBytes = assessment.due ? Math.ceil(Math.max(assessment.sizeBytes, 1024) * factor) : undefined
  await writeMemoryState(layout, {
    lastAttempt: { at: new Date().toISOString(), outcome, reason },
    cooldownUntilBytes,
    consecutiveFailures: failures,
  })
  return { cooldownUntilBytes }
}

export async function recordCommit(layout: MemoryLayout): Promise<void> {
  const at = new Date().toISOString()
  await writeMemoryState(layout, {
    lastConsolidatedAt: at,
    lastAttempt: { at, outcome: 'committed' },
    cooldownUntilBytes: undefined,
    consecutiveFailures: undefined,
    archiveCooldownUntilBytes: undefined,
  })
}

/**
 * Record History archived with automatic consolidation off. Not an attempt at
 * consolidating: no failure is counted and the next automatic consolidation,
 * once turned back on, is not held back by it. When the file is still over
 * its size limit afterwards, archiving for size waits until it has grown —
 * otherwise every new entry would archive the whole file again.
 */
export async function recordArchive(layout: MemoryLayout, cadence: MemoryCadence): Promise<void> {
  const assessment = await assessConsolidation(layout, cadence)
  await writeMemoryState(layout, {
    lastArchivedAt: new Date().toISOString(),
    archiveCooldownUntilBytes: assessment.overTotal
      ? Math.ceil(assessment.sizeBytes * (1 + COOLDOWN_GROWTH))
      : undefined,
  })
}

/**
 * Whether History should be archived with automatic consolidation off: more
 * entries than the cadence allows, or the file over its size limit and not
 * waiting to grow since the last such archive. `# now` plays no part —
 * archiving History would not shrink it.
 */
export async function isArchiveDue(
  layout: MemoryLayout,
  cadence: MemoryCadence
): Promise<ConsolidationAssessment & { archiveDue: boolean }> {
  const [assessment, state] = await Promise.all([assessConsolidation(layout, cadence), readMemoryState(layout)])
  const sizeWaiting = !!state.archiveCooldownUntilBytes && assessment.sizeBytes < state.archiveCooldownUntilBytes
  return { ...assessment, archiveDue: assessment.overHistory || (assessment.overTotal && !sizeWaiting) }
}

// ============================================================================
// Assess
// ============================================================================

export async function assessConsolidation(
  layout: MemoryLayout,
  cadence: MemoryCadence,
  opts: AssessOptions = {}
): Promise<ConsolidationAssessment> {
  const limits = CADENCE_THRESHOLDS[cadence]
  const nowLimit = Math.min(limits.nowBytes, opts.nowCapBytes ?? Infinity)
  const content = await readMemoryFile(layout.file)
  if (content === null) {
    return {
      due: false, reasons: [], sizeBytes: 0, nowBytes: 0, historyEntries: 0,
      overTotal: false, overNow: false, overHistory: false,
    }
  }

  const sizeBytes = Buffer.byteLength(content, 'utf-8')
  const nowBytes = Buffer.byteLength(nowSection(content), 'utf-8')
  const historyEntries = splitHistory(content)?.entries.length ?? 0
  const overTotal = sizeBytes > limits.totalBytes
  const overNow = nowBytes > nowLimit
  const overHistory = historyEntries > limits.historyEntries
  const reasons: string[] = []
  if (overTotal) reasons.push(`size ${sizeBytes}B > ${limits.totalBytes}B`)
  if (overNow) reasons.push(`# now ${nowBytes}B > ${nowLimit}B`)
  if (overHistory) reasons.push(`History ${historyEntries} > ${limits.historyEntries} entries`)
  return { due: reasons.length > 0, reasons, sizeBytes, nowBytes, historyEntries, overTotal, overNow, overHistory }
}

/**
 * Whether automatic consolidation should run now: due, not cooling down after a
 * failure, and not within the cadence's minimum interval since the last attempt.
 */
export async function isConsolidationDue(
  layout: MemoryLayout,
  cadence: MemoryCadence,
  opts: AssessOptions & { now?: number } = {}
): Promise<ConsolidationAssessment & { coolingDown: boolean; tooSoon: boolean }> {
  const [assessment, state] = await Promise.all([assessConsolidation(layout, cadence, opts), readMemoryState(layout)])
  const coolingDown = !!state.cooldownUntilBytes && assessment.sizeBytes < state.cooldownUntilBytes
  const lastAt = state.lastAttempt?.at ? Date.parse(state.lastAttempt.at) : NaN
  const tooSoon = Number.isFinite(lastAt) && (opts.now ?? Date.now()) - lastAt < CADENCE_THRESHOLDS[cadence].minIntervalMs
  return { ...assessment, coolingDown, tooSoon, due: assessment.due && !coolingDown && !tooSoon }
}

function nowSection(content: string): string {
  const lines = content.split('\n')
  const heading = parseHeadings(lines).find(h => h.level === 1 && /^#\s+now\s*$/.test(h.heading))
  if (!heading) return ''
  return lines.slice(heading.line - 1, heading.line - 1 + heading.lineCount).join('\n')
}

/** What a settings screen shows, minus whether a consolidation is running. */
export async function readMemoryStatus(layout: MemoryLayout): Promise<Omit<MemoryStatus, 'consolidating'>> {
  const [memoryBytes, topics, state] = await Promise.all([
    getFileSize(layout.file),
    listTopicFiles(layout.topicsDir),
    readMemoryState(layout),
  ])
  const topicBytes = [...topics.values()].reduce((n, s) => n + s.size, 0)
  return {
    exists: existsSync(layout.file),
    totalBytes: memoryBytes + topicBytes,
    topicCount: [...topics.keys()].filter(p => p.endsWith('.md') && !p.endsWith('/index.md')).length,
    lastConsolidatedAt: state.lastConsolidatedAt ?? null,
    lastAttempt: state.lastAttempt ?? null,
  }
}

// ============================================================================
// Fingerprints
// ============================================================================

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * Files below `root` as `relPath` → stats. Hidden entries are skipped: they are
 * not knowledge (an editor's settings folder, a `.gitkeep`), and are carried
 * across a commit as they are rather than through the agent.
 */
async function listTopicFiles(root: string): Promise<FileStats> {
  const out: FileStats = new Map()
  async function walk(dir: string, rel: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') return
      throw err
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const abs = join(dir, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await walk(abs, r)
      else if (e.isFile()) {
        const s = await stat(abs)
        out.set(r, { size: s.size, mtimeMs: s.mtimeMs })
      }
    }
  }
  await walk(root, '')
  return out
}

function sumBytes(files: FileStats): number {
  return [...files.values()].reduce((n, s) => n + s.size, 0)
}

async function hashFile(path: string): Promise<string | undefined> {
  const content = await readMemoryFile(path)
  return content === null ? undefined : hash(content)
}

/**
 * Read the live memory's baseline. Caller holds the lock. Files whose stats did
 * not change since `previous` keep their hash rather than being read again.
 */
async function readBaseline(layout: MemoryLayout, previous?: Baseline): Promise<Baseline> {
  const memory = await readMemoryFile(layout.file)
  const topicStats = await listTopicFiles(layout.topicsDir)
  const topicHashes = new Map<string, string>()
  for (const [path, s] of topicStats) {
    const old = previous?.topicStats.get(path)
    const oldHash = previous?.topicHashes.get(path)
    if (old && oldHash && old.size === s.size && old.mtimeMs === s.mtimeMs) {
      topicHashes.set(path, oldHash)
      continue
    }
    const h = await hashFile(join(layout.topicsDir, path))
    if (h !== undefined) topicHashes.set(path, h)
  }
  return { memory, topicStats, topicHashes }
}

// ============================================================================
// Prepare
// ============================================================================

/**
 * Copy the memory into a fresh working folder. Taken under the lock so the copy
 * and the baseline describe one consistent moment.
 */
export async function prepareConsolidation(layout: MemoryLayout): Promise<ConsolidationWorkspace> {
  const dir = join(layout.consolidationDir, `${formatTimestamp(new Date())}-${randomUUID().slice(0, 8)}`)

  return withMemoryLock(layout.file, async () => {
    await recoverInterruptedSwap(layout)
    // Leftovers of a run that died mid-way; only one consolidation of a memory
    // runs at a time in this process, so anything here is abandoned.
    await rm(layout.consolidationDir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })

    const baseline = await readBaseline(layout)
    const memoryFile = join(dir, 'memory.md')
    const topicsDir = join(dir, 'topics')
    if (baseline.memory !== null) await atomicWrite(memoryFile, baseline.memory)
    await mkdir(topicsDir, { recursive: true })
    for (const rel of baseline.topicStats.keys()) {
      await ensureDir(dirname(join(topicsDir, rel)))
      await cp(join(layout.topicsDir, rel), join(topicsDir, rel))
    }

    return {
      layout,
      dir,
      memoryFile,
      topicsDir,
      incomingDir: join(dir, '.incoming'),
      baseline,
      requiredTopicFiles: new Set(baseline.topicStats.keys()),
      requiredTopicBytes: sumBytes(baseline.topicStats),
      moves: [],
    }
  })
}

/**
 * A process that died between the two renames of a swap left topics/ absent
 * and the old tree as `topics.retired` inside its working folder. Put it back
 * before that folder is cleared. Caller holds the lock.
 */
async function recoverInterruptedSwap(layout: MemoryLayout): Promise<void> {
  if (existsSync(layout.topicsDir) || !existsSync(layout.consolidationDir)) return
  for (const entry of await readdir(layout.consolidationDir, { withFileTypes: true })) {
    const retired = join(layout.consolidationDir, entry.name, 'topics.retired')
    if (entry.isDirectory() && existsSync(retired)) {
      await rename(retired, layout.topicsDir)
      console.warn(`[Memory] Restored topics/ left mid-swap by an interrupted consolidation (${retired})`)
      return
    }
  }
}

// ============================================================================
// Moves (the consolidating agent's only way to move or remove a topic)
// ============================================================================

function resolveInTopics(ws: ConsolidationWorkspace, relPath: string): string {
  const abs = resolve(ws.topicsDir, relPath)
  if (abs !== ws.topicsDir && !abs.startsWith(ws.topicsDir + sep)) {
    throw new Error(`Path "${relPath}" is outside the topics folder`)
  }
  return abs
}

/**
 * Move or remove a topic file or category folder inside the workspace, and
 * record it so validation can account for every original topic.
 *
 * @param to         - New path, relative to the topics folder; null removes
 * @param mergedInto - Required when removing: the topic that absorbed it
 */
export async function moveWithinWorkspace(
  ws: ConsolidationWorkspace,
  from: string,
  to: string | null,
  mergedInto?: string
): Promise<string> {
  const src = resolveInTopics(ws, from)
  if (!existsSync(src)) throw new Error(`"${from}" does not exist`)
  const srcRel = relative(ws.topicsDir, src).split(sep).join('/')
  const isDir = (await stat(src)).isDirectory()
  const files = isDir
    ? [...(await listTopicFiles(src)).keys()].map(f => `${srcRel}/${f}`)
    : [srcRel]

  if (to === null) {
    if (!mergedInto) throw new Error('Removing a topic requires merged_into: the topic that now holds its knowledge')
    const target = resolveInTopics(ws, mergedInto)
    if (!existsSync(target)) throw new Error(`merged_into "${mergedInto}" does not exist`)
    const targetRel = relative(ws.topicsDir, target).split(sep).join('/')
    await rm(src, { recursive: true, force: true })
    for (const f of files) ws.moves.push({ from: f, to: null, mergedInto: targetRel })
    return `Removed ${srcRel}${isDir ? `/ (${files.length} files)` : ''}; knowledge recorded as merged into ${targetRel}`
  }

  const dest = resolveInTopics(ws, to)
  if (existsSync(dest)) throw new Error(`"${to}" already exists — merge the content with Edit, then remove the source`)
  const destRel = relative(ws.topicsDir, dest).split(sep).join('/')
  await ensureDir(dirname(dest))
  await rename(src, dest)
  for (const f of files) {
    ws.moves.push({ from: f, to: isDir ? destRel + f.slice(srcRel.length) : destRel })
  }
  return `Moved ${srcRel} → ${destRel}`
}

// ============================================================================
// Validate
// ============================================================================

function h1Titles(content: string): string[] {
  return parseHeadings(content.split('\n'))
    .filter(h => h.level === 1)
    .map(h => h.heading.replace(/^#\s+/, '').trim())
}

/**
 * Check the workspace before it may replace the live memory. The reason of a
 * failure is written for the agent: it is handed back so the agent can fix it.
 *
 * A History still above the cadence's entry limit afterwards is trimmed here,
 * so a consolidation that reorganised well but left History long still counts.
 */
export async function validateConsolidation(
  ws: ConsolidationWorkspace,
  cadence: MemoryCadence = 'diligent'
): Promise<ConsolidationValidation> {
  const notes: string[] = []
  const content = await readMemoryFile(ws.memoryFile)
  if (content === null) return { ok: false, reason: 'memory.md is missing — recreate it with `# now` and `# History`.' }

  const h1 = h1Titles(content)
  if (!h1.includes('now') || !h1.includes('History')) {
    return {
      ok: false,
      reason: `memory.md must keep "# now" and "# History" as H1 headings (found: ${h1.join(', ') || 'none'}).`,
    }
  }
  if (h1.some(t => /^topics\b/i.test(t))) {
    return { ok: false, reason: 'memory.md must not hold a list of topics — the index is generated. Remove that section.' }
  }

  const tree = await scanTopics(ws.topicsDir)
  const undescribed = flattenTopics(tree.children).filter(t => !t.description).map(t => t.relPath)
  if (undescribed.length > 0) {
    return {
      ok: false,
      reason: `These topic files have no \`description\` front matter: ${undescribed.join(', ')}. Add one to each.`,
    }
  }

  const present = await listTopicFiles(ws.topicsDir)
  for (const required of ws.requiredTopicFiles) {
    if (!followMoves(required, ws.moves, present)) {
      return {
        ok: false,
        reason:
          `Topic file "${required}" disappeared without memory_move. Restore it, or remove it with ` +
          `memory_move naming the topic that now holds its content (merged_into).`,
      }
    }
  }

  const newTopicBytes = sumBytes(present)
  if (
    ws.requiredTopicBytes >= MIN_TOPIC_BYTES_FOR_SHRINK_CHECK &&
    newTopicBytes < ws.requiredTopicBytes * (1 - MAX_TOPIC_SHRINK)
  ) {
    return {
      ok: false,
      reason:
        `Topic content shrank from ${ws.requiredTopicBytes}B to ${newTopicBytes}B — knowledge would be lost. ` +
        `Topics may be tightened, not emptied; restore what was cut.`,
    }
  }

  if ((splitHistory(content)?.entries.length ?? 0) > CADENCE_THRESHOLDS[cadence].historyEntries) {
    const trimmed = trimHistoryContent(content, historyKeepFor(cadence))
    if (trimmed !== content) {
      await atomicWrite(ws.memoryFile, trimmed)
      notes.push('History trimmed after consolidation left it above the limit')
    }
  }

  return { ok: true, notes }
}

/** Where a required topic ended up; null when it vanished unaccounted. */
function followMoves(path: string, moves: ConsolidationMove[], present: FileStats): string | null {
  let current = path
  for (let hop = 0; hop < 32; hop++) {
    if (present.has(current)) return current
    const move = [...moves].reverse().find(m => m.from === current)
    if (!move) return null
    current = move.to ?? move.mergedInto ?? ''
    if (!current) return null
  }
  return null
}

// ============================================================================
// Commit
// ============================================================================

/**
 * Swap the workspace in, under the lock.
 *
 * First, everything the live memory gained meanwhile that the system can place
 * by itself goes into the workspace: History entries (whatever else changed),
 * topics added, changed or removed that the agent left untouched. What remains
 * — memory.md outside History changed, or a topic both sides changed — is a
 * conflict: the live memory is untouched, its current content is put in
 * `.incoming/` in full, and the result says what to merge (see rebaseWorkspace).
 */
export async function commitConsolidation(ws: ConsolidationWorkspace): Promise<ConsolidationCommitResult> {
  const { layout } = ws
  return withMemoryLock(layout.file, async () => {
    const live = await readBaseline(layout, ws.baseline)

    const wsMemory = (await readMemoryFile(ws.memoryFile)) ?? ''
    const history = carryHistory(ws.baseline.memory ?? '', live.memory ?? '', wsMemory)
    if (history && history.carried > 0) await atomicWrite(ws.memoryFile, history.content)
    const carriedHistory = history?.carried ?? 0

    const topics = await mergeTopics(ws, live)
    const memoryChanged = outsideHistory(ws.baseline.memory ?? '') !== outsideHistory(live.memory ?? '')

    if (memoryChanged || topics.conflicts.length > 0) {
      // Written over, never cleared: an earlier conflict the agent has not merged
      // yet is still handed over, and so is its live content.
      let memory: ConcurrentChanges['memory'] = null
      if (memoryChanged) {
        const incomingPath = join(ws.incomingDir, 'memory.md')
        await atomicWrite(incomingPath, live.memory ?? '')
        memory = { ...lineDiff(outsideHistory(ws.baseline.memory ?? ''), outsideHistory(live.memory ?? '')), incomingPath }
      }
      for (const conflict of topics.conflicts) {
        if (conflict.live === 'removed') continue
        const incomingPath = join(ws.incomingDir, 'topics', conflict.path)
        await ensureDir(dirname(incomingPath))
        await cp(join(layout.topicsDir, conflict.path), incomingPath)
        conflict.incomingPath = incomingPath
      }
      return {
        status: 'conflict',
        reason: [
          memoryChanged ? 'memory.md outside # History changed' : '',
          topics.conflicts.length ? `${topics.conflicts.length} topic(s) changed on both sides` : '',
        ].filter(Boolean).join('; ') + ' while consolidating',
        changes: { memory, topics: topics.conflicts, carriedHistory, mergedTopics: topics.merged },
        liveBaseline: live,
      }
    }

    const snapshotDir = await takeSnapshot(layout)
    const result = (await readMemoryFile(ws.memoryFile)) ?? ''

    // Topics first, memory.md last: a failure in between must not leave a
    // memory.md whose `# now` points at topics that never arrived.
    const retired = join(ws.dir, 'topics.retired')
    const hadTopics = existsSync(layout.topicsDir)
    if (hadTopics) await rename(layout.topicsDir, retired)
    try {
      await ensureDir(dirname(layout.topicsDir))
      await rename(ws.topicsDir, layout.topicsDir)
    } catch (err) {
      if (hadTopics && !existsSync(layout.topicsDir)) await rename(retired, layout.topicsDir)
      throw err
    }

    let archivedPath: string | null = null
    try {
      archivedPath = live.memory !== null ? await linkToArchive(layout.file, layout.archiveDir) : null
      await atomicWrite(layout.file, result)
    } catch (err) {
      await rename(layout.topicsDir, ws.topicsDir).catch(() => {})
      if (hadTopics) await rename(retired, layout.topicsDir).catch(() => {})
      throw err
    }

    if (hadTopics) await carryHiddenEntries(retired, layout.topicsDir)
    await rm(ws.dir, { recursive: true, force: true })
    return { status: 'committed', archivedPath, snapshotDir, carriedHistory, mergedTopics: topics.merged }
  })
}

/**
 * Bring into the workspace every topic change the live memory made since the
 * baseline that the agent did not also touch. The workspace copy counts as
 * untouched when it still has the baseline content at the same path.
 */
async function mergeTopics(
  ws: ConsolidationWorkspace,
  live: Baseline
): Promise<{ merged: number; conflicts: TopicConflict[] }> {
  const base = ws.baseline.topicHashes
  const paths = new Set([...base.keys(), ...live.topicHashes.keys()])
  const conflicts: TopicConflict[] = []
  let merged = 0

  for (const path of [...paths].sort()) {
    const before = base.get(path)
    const now = live.topicHashes.get(path)
    if (before === now) continue
    const wsPath = join(ws.topicsDir, path)
    const mine = await hashFile(wsPath)

    if (now === undefined) {
      // Removed live. Gone from the workspace too (the agent merged it away)
      // is the same outcome on both sides.
      if (mine === before) {
        await rm(wsPath, { force: true })
        merged++
      } else if (mine !== undefined) {
        conflicts.push({ path, live: 'removed' })
      }
    } else if (mine === now) {
      // The agent arrived at the same content.
    } else if (before === undefined ? mine === undefined : mine === before) {
      // Added live where the agent put nothing, or changed live where the agent left it as it was.
      await ensureDir(dirname(wsPath))
      await cp(join(ws.layout.topicsDir, path), wsPath)
      merged++
    } else {
      conflicts.push({ path, live: before === undefined ? 'added' : 'changed' })
    }
  }
  return { merged, conflicts }
}

/**
 * What a conflict asks the agent to change, as `memory.md` and `topics/<path>`.
 * A topic removed live is left out: keeping it can be the right answer.
 */
export function mergeTargets(changes: ConcurrentChanges): string[] {
  return [
    ...(changes.memory ? ['memory.md'] : []),
    ...changes.topics.filter(t => t.live !== 'removed').map(t => `topics/${t.path}`),
  ]
}

/**
 * The workspace's current content of each merge target (see mergeTargets):
 * memory.md outside `# History` — the system itself carries History in — and
 * each topic file, '' when it is gone. Equal before and after a round means
 * the agent did not touch it, so a merge asked for there cannot have happened.
 */
export async function fingerprintMergeTargets(
  ws: ConsolidationWorkspace,
  targets: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const target of targets) {
    if (target === 'memory.md') {
      out.set(target, hash(outsideHistory((await readMemoryFile(ws.memoryFile)) ?? '')))
    } else {
      out.set(target, (await hashFile(join(ws.topicsDir, target.slice('topics/'.length)))) ?? '')
    }
  }
  return out
}

/**
 * Adopt the live memory as the workspace's new baseline once the agent has
 * merged what changed. Topics that appeared meanwhile become required; topics
 * someone removed meanwhile no longer are.
 */
export function rebaseWorkspace(ws: ConsolidationWorkspace, live: Baseline): void {
  for (const path of live.topicStats.keys()) {
    if (!ws.baseline.topicStats.has(path)) ws.requiredTopicFiles.add(path)
  }
  for (const path of ws.baseline.topicStats.keys()) {
    if (!live.topicStats.has(path)) ws.requiredTopicFiles.delete(path)
  }
  ws.requiredTopicBytes = sumBytes(live.topicStats)
  ws.baseline = live
}

function lineDiff(before: string, after: string): { added: string[]; removed: string[] } {
  const beforeLines = new Set(before.split('\n'))
  const afterLines = new Set(after.split('\n'))
  return {
    added: [...afterLines].filter(l => l.trim() && !beforeLines.has(l)),
    removed: [...beforeLines].filter(l => l.trim() && !afterLines.has(l)),
  }
}

/** Hidden files and folders of the old tree, put back where they were. */
async function carryHiddenEntries(fromRoot: string, toRoot: string): Promise<void> {
  async function walk(dir: string, rel: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const r = rel ? join(rel, e.name) : e.name
      if (e.name.startsWith('.')) {
        const dest = join(toRoot, r)
        if (existsSync(dest)) continue
        await ensureDir(dirname(dest))
        await cp(join(dir, e.name), dest, { recursive: true }).catch(err => {
          console.warn(`[Memory] Could not carry hidden entry ${r} across consolidation:`, err)
        })
      } else if (e.isDirectory()) {
        await walk(join(dir, e.name), r)
      }
    }
  }
  await walk(fromRoot, '')
}

export async function discardConsolidation(ws: ConsolidationWorkspace): Promise<void> {
  await rm(ws.dir, { recursive: true, force: true })
}

/**
 * Copy memory.md + topics/ into `.snapshots/`. The first ever snapshot is kept
 * as `initial` for good; the rest rotate. Caller holds the lock.
 */
async function takeSnapshot(layout: MemoryLayout): Promise<string> {
  await ensureDir(layout.snapshotsDir)
  const initial = join(layout.snapshotsDir, INITIAL_SNAPSHOT)
  const dest = existsSync(initial)
    ? join(layout.snapshotsDir, `${formatTimestamp(new Date())}-${Date.now().toString(36)}`)
    : initial
  await mkdir(dest, { recursive: true })
  if (existsSync(layout.file)) await cp(layout.file, join(dest, 'memory.md'))
  if (existsSync(layout.topicsDir)) await cp(layout.topicsDir, join(dest, 'topics'), { recursive: true })

  const rotating = (await readdir(layout.snapshotsDir, { withFileTypes: true }))
    .filter(e => e.isDirectory() && e.name !== INITIAL_SNAPSHOT)
    .map(e => e.name)
    .sort()
  for (const name of rotating.slice(0, Math.max(0, rotating.length - SNAPSHOTS_KEPT))) {
    await rm(join(layout.snapshotsDir, name), { recursive: true, force: true })
  }
  return dest
}

// ============================================================================
// History
// ============================================================================

interface HistorySplit {
  before: string[]
  preamble: string[]
  entries: string[][]
  after: string[]
}

/** Split memory.md around `# History`; null when there is none. */
export function splitHistory(content: string): HistorySplit | null {
  const lines = content.split('\n')
  const headings = parseHeadings(lines)
  const history = headings.find(h => h.level === 1 && /^#\s+History\s*$/.test(h.heading))
  if (!history) return null

  const start = history.line - 1
  const end = start + history.lineCount
  const body = lines.slice(start + 1, end)
  const entryStarts = headings
    .filter(h => h.level === 2 && h.line - 1 > start && h.line - 1 < end)
    .map(h => h.line - 1 - (start + 1))

  const entries: string[][] = []
  for (let i = 0; i < entryStarts.length; i++) {
    entries.push(body.slice(entryStarts[i], entryStarts[i + 1] ?? body.length))
  }
  return {
    before: lines.slice(0, start + 1),
    preamble: body.slice(0, entryStarts[0] ?? body.length),
    entries,
    after: lines.slice(end),
  }
}

function joinHistory(split: HistorySplit): string {
  return [...split.before, ...split.preamble, ...split.entries.flat(), ...split.after].join('\n')
}

/** memory.md with its History body left out: what a conflict is judged on. */
function outsideHistory(content: string): string {
  const split = splitHistory(content)
  return split ? [...split.before, ...split.after].join('\n') : content
}

/** Keep the newest `keep` History entries; everything else is untouched. */
export function trimHistoryContent(content: string, keep: number): string {
  const split = splitHistory(content)
  if (!split || split.entries.length <= keep) return content
  return joinHistory({ ...split, entries: split.entries.slice(0, keep) })
}

/** An entry's text, whatever blank lines separate it from the next. */
const entryText = (entry: string[]) => entry.join('\n').trimEnd()

/** `## <timestamp> ... [by: x]` → identity of the entry regardless of its summary. */
function entryKey(entry: string[]): string {
  const heading = entry[0] ?? ''
  const by = heading.match(/\[by:\s*([^\]]+)\]/)?.[1]?.trim() ?? ''
  return `${entryStamp(entry) ?? heading}|${by}`
}

/** The `YYYY-MM-DD-HHmm` an entry heading starts with, if it has one. */
function entryStamp(entry: string[]): string | null {
  return (entry[0] ?? '').match(/^##\s+(\d{4}-\d{2}-\d{2}\S*)/)?.[1] ?? null
}

/**
 * History entries the live memory gained or changed since `original`, merged
 * into `consolidated`'s History. An entry the live memory rewrote replaces its
 * old text where that text still stands, matched in full — two entries
 * sharing a minute and author stay two entries. Everything else goes in by its
 * timestamp (newest first), at the top when it has none. Independent of
 * anything else in the file changing.
 *
 * @returns null when either side has no History to merge into or from
 */
export function carryHistory(
  original: string,
  current: string,
  consolidated: string
): { content: string; carried: number } | null {
  const o = splitHistory(original)
  const c = splitHistory(current)
  const r = splitHistory(consolidated)
  if (!c || !r) return null

  const originalTexts = new Set((o?.entries ?? []).map(entryText))
  const currentTexts = new Set(c.entries.map(entryText))
  const changed = c.entries.filter(e => !originalTexts.has(entryText(e)))
  if (changed.length === 0) return { content: consolidated, carried: 0 }

  // Rewritten live: gone from live, with a changed entry of the same identity.
  const gone = (o?.entries ?? []).filter(e => !currentTexts.has(entryText(e)))
  // Entries run into each other without a separator line otherwise.
  const withGap = (e: string[]) => (e[e.length - 1] === '' ? e : [...e, ''])
  const entries = [...r.entries]

  for (const entry of changed) {
    const previous = gone.findIndex(g => entryKey(g) === entryKey(entry))
    if (previous >= 0) {
      const text = entryText(gone[previous])
      gone.splice(previous, 1)
      const at = entries.findIndex(e => entryText(e) === text)
      if (at >= 0) {
        entries[at] = withGap(entry)
        continue
      }
    }
    const stamp = entryStamp(entry)
    const at = stamp === null ? 0 : entries.findIndex(e => (entryStamp(e) ?? '') < stamp)
    entries.splice(at < 0 ? entries.length : at, 0, withGap(entry))
  }
  return { content: joinHistory({ ...r, entries }), carried: changed.length }
}

/**
 * Archive memory.md and trim `# History` to its newest `keep` entries, without
 * the agent. `# now` and topics are left alone, so this bounds History only.
 *
 * @returns Whether anything was trimmed
 */
export async function trimHistoryFallback(layout: MemoryLayout, keep: number): Promise<boolean> {
  return withMemoryLock(layout.file, async () => {
    const content = await readMemoryFile(layout.file)
    if (content === null) return false
    const trimmed = trimHistoryContent(content, keep)
    if (trimmed === content) return false
    await linkToArchive(layout.file, layout.archiveDir)
    await atomicWrite(layout.file, trimmed)
    return true
  })
}
