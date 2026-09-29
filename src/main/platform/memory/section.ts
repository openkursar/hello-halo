/**
 * platform/memory -- Memory Section
 *
 * Renders a snapshot into the `## Memory` block that opens a run or a session.
 * Shared by every owner of a memory — a digital human's runs and chats, and a
 * space's conversations — so an agent meets memory in one shape wherever it
 * works. What differs per owner arrives as options, set by the caller that
 * knows: whose memory it is, how much of `# now` and History to spell out.
 *
 * The block is bounded: `# now` up to a limit, the topic index within one
 * budget shared with any read-only topics, and History as a few recent titles.
 * Everything else is one Read or Grep away, and the block says where.
 */

import type { MemorySnapshot } from './snapshot'
import type { MemoryOwnerKind } from './prompt'
import { renderTopicIndexLines, TOPIC_INDEX_BUDGET_CHARS, formatKB, type TopicsTree } from './topics'

export interface MemorySectionOptions {
  /** Placed above the content; says whose memory this is and how to read it */
  framing?: string
  /** `# now` is cut at a `##` boundary past this many bytes */
  nowLimitBytes?: number
  /** How many of the newest History titles to list */
  recentHistory?: number
  /**
   * Another memory's topics, offered read-only. Listed one level deep after
   * this memory's own, from what is left of the shared index budget.
   */
  readOnlyTopics?: {
    title: string
    note: string
    tree: TopicsTree
  }
}

/**
 * How much of each owner's memory a turn is shown up front. A digital human is
 * one long-lived persona and leans on continuity; a space is many unrelated
 * conversations that need the current facts and the index. The `# now` limit
 * is also the ceiling of that owner's `# now` consolidation threshold, so what
 * is cut here does not stay cut for long.
 */
export const MEMORY_SECTION_LIMITS: Record<MemoryOwnerKind, { nowLimitBytes: number; recentHistory: number }> = {
  'digital-human': { nowLimitBytes: 16 * 1024, recentHistory: 8 },
  space: { nowLimitBytes: 8 * 1024, recentHistory: 3 },
}

const DEFAULT_NOW_LIMIT_BYTES = MEMORY_SECTION_LIMITS['digital-human'].nowLimitBytes
const DEFAULT_RECENT_HISTORY = 5

const TOPICS_HEADING = '### Topics — generated from the files each time; edit the files, never this list'

export function renderMemorySection(snapshot: MemorySnapshot, opts: MemorySectionOptions = {}): string {
  const { layout } = snapshot
  const nowLimit = opts.nowLimitBytes ?? DEFAULT_NOW_LIMIT_BYTES
  const lines: string[] = []
  lines.push('## Memory')
  lines.push('')
  lines.push('Your persistent memory from previous work. Read it to maintain continuity and avoid repeating work.')
  lines.push('')

  // Only where there is content to misread.
  if (opts.framing && (!snapshot.blank || snapshot.topics.topicCount > 0)) {
    lines.push(opts.framing)
    lines.push('')
  }

  lines.push(`**File**: \`${layout.file}\``)

  if (!snapshot.exists) {
    lines.push('')
    lines.push('No memory file exists yet. Create it with Write using the `# now` / `# History` structure')
    lines.push('when there is something worth keeping; `# now` is loaded automatically next time.')
  } else if (snapshot.blank) {
    lines.push('')
    lines.push('Nothing recorded yet: the file has its `# now` and `# History` headings and nothing under them.')
    lines.push('Edit in what is worth keeping; `# now` is loaded automatically next time.')
  } else if (snapshot.fullContent !== null && snapshot.sizeBytes <= nowLimit) {
    lines.push(`**Size**: ${snapshot.totalLines} lines, ${formatKB(snapshot.sizeBytes)}`)
    lines.push('')
    lines.push('### Content (full):')
    lines.push('')
    lines.push(snapshot.fullContent)
  } else {
    lines.push(`**Size**: ${snapshot.totalLines} lines, ${formatKB(snapshot.sizeBytes)}`)
    if (snapshot.firstSection) {
      const { text, truncated } = capAtSection(snapshot.firstSection, nowLimit)
      lines.push('')
      lines.push('### Working Memory (# now, auto-loaded):')
      lines.push('')
      lines.push(text)
      if (truncated) {
        lines.push('')
        lines.push(
          `(# now is ${formatKB(snapshot.nowBytes)}; only its first sections are shown. ` +
          `Read \`${layout.file}\` for the rest before relying on what is missing.)`
        )
      }
    }
    lines.push('')
    lines.push(...renderHistorySummary(snapshot, opts.recentHistory ?? DEFAULT_RECENT_HISTORY))
  }

  lines.push('')
  const own = renderTopicsBlock(TOPICS_HEADING, snapshot.topics, TOPIC_INDEX_BUDGET_CHARS)
  lines.push(...own.lines)

  if (opts.readOnlyTopics && opts.readOnlyTopics.tree.topicCount > 0) {
    lines.push('')
    lines.push(...renderTopicsBlock(
      `### ${opts.readOnlyTopics.title}`,
      opts.readOnlyTopics.tree,
      Math.max(0, TOPIC_INDEX_BUDGET_CHARS - own.usedChars),
      { note: opts.readOnlyTopics.note, topLevelOnly: true },
    ).lines)
  }

  if (snapshot.runTotalCount > 0 || snapshot.archiveCount > 0) {
    lines.push('')
    const parts: string[] = []
    if (snapshot.runTotalCount > 0) parts.push(`${snapshot.runTotalCount} run records in \`${layout.runDir}\``)
    if (snapshot.archiveCount > 0) parts.push(`${snapshot.archiveCount} archived memory.md versions in \`${layout.archiveDir}\``)
    lines.push(`Older detail: ${parts.join('; ')}. Grep them when History is not enough.`)
  }

  return lines.join('\n')
}

/**
 * Cut markdown to `limit` bytes, at the last `##` heading that fits. When that
 * would keep less than half the limit (a huge section right after the first),
 * cut on a line instead so the reader still gets something. A `##` inside a
 * code fence is not a boundary, and a fence left open by the cut is closed.
 */
function capAtSection(text: string, limit: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf-8') <= limit) return { text, truncated: false }
  const lines = text.split('\n')
  let bytes = 0
  let lastBoundary = 0
  let boundaryBytes = 0
  let cut = lines.length
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) inFence = !inFence
    else if (!inFence && i > 0 && /^##\s/.test(lines[i])) {
      lastBoundary = i
      boundaryBytes = bytes
    }
    const next = bytes + Buffer.byteLength(lines[i], 'utf-8') + 1
    if (next > limit) {
      cut = i
      break
    }
    bytes = next
  }
  const end = lastBoundary > 0 && boundaryBytes >= limit / 2 ? lastBoundary : Math.max(1, cut)
  const kept = lines.slice(0, end)
  const fences = kept.filter(l => /^\s*(```|~~~)/.test(l)).length
  if (fences % 2 === 1) kept.push('```')
  return { text: kept.join('\n').trimEnd(), truncated: true }
}

function renderHistorySummary(snapshot: MemorySnapshot, recent: number): string[] {
  const h1 = snapshot.headers.find(h => h.level === 1 && /^#\s+History\s*$/.test(h.heading))
  if (!h1) return []
  const end = h1.line + h1.lineCount
  const entries = snapshot.headers.filter(h => h.level === 2 && h.line > h1.line && h.line < end)
  if (entries.length === 0) {
    return [`### History: no entries yet (under \`# History\` at line ${h1.line}).`]
  }
  const lines = [`### History: ${entries.length} entries, newest first (from line ${h1.line}):`]
  for (const e of entries.slice(0, recent)) lines.push(`  L${e.line}: ${e.heading}`)
  if (entries.length > recent) {
    lines.push(`  … ${entries.length - recent} older — Read from line ${h1.line} or Grep \`${snapshot.layout.file}\`.`)
  }
  return lines
}

function renderTopicsBlock(
  heading: string,
  tree: TopicsTree,
  budget: number,
  opts: { note?: string; topLevelOnly?: boolean } = {}
): { lines: string[]; usedChars: number } {
  const lines: string[] = [heading]
  if (opts.note) lines.push(opts.note)
  lines.push(`Root: \`${tree.root}/\``)

  if (tree.topicCount === 0 && tree.children.length === 0) {
    lines.push('(no topics yet)')
    return { lines, usedChars: 0 }
  }
  if (budget <= 0) {
    lines.push(`${tree.topicCount} topics — \`Grep "^description:" ${tree.root}\` lists what each is for.`)
    return { lines, usedChars: 0 }
  }

  const index = renderTopicIndexLines(tree, budget, { topLevelOnly: opts.topLevelOnly })
  lines.push(...index.lines)
  if (index.folded) {
    lines.push(
      `Not every topic is spelled out here. Enter a category folder, or search: ` +
      `\`Grep "^description:" ${tree.root}\` lists what every page is for.`
    )
  }
  return { lines, usedChars: index.usedChars }
}

/** One log line of the sizes that decide what an agent is handed. */
export function formatMemoryUsage(snapshot: MemorySnapshot): string {
  return (
    `memory=${formatKB(snapshot.sizeBytes)} now=${formatKB(snapshot.nowBytes)} ` +
    `topics=${snapshot.topics.topicCount}(${formatKB(snapshot.topics.totalBytes)}) ` +
    `runs=${snapshot.runTotalCount} archives=${snapshot.archiveCount}`
  )
}
