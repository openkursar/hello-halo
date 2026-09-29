/**
 * platform/memory -- Memory Snapshot
 *
 * Reads one memory as it stands: memory.md's structure, its `# now` block, the
 * topic tree, and what the archives hold. Used in two places:
 *
 * 1. **Turn start** — the snapshot is rendered into the message that opens a
 *    run or session (see section.ts), so the agent starts with its memory in
 *    context rather than spending a tool call on it.
 *
 * 2. **`memory_status` tool** — the same structural facts without content, so
 *    the agent can re-check the layout mid-turn after its own edits.
 */

import { stat } from 'fs/promises'
import { z } from 'zod'
import { tool, createSdkMcpServer } from './sdk'
import type { MemoryLayout } from './paths'
import { readMemoryFile, listMemoryFiles, isBlankMemory } from './file-ops'
import { scanTopics, renderTopicIndexLines, formatKB, type TopicsTree } from './topics'
import { TOPIC_GUIDE } from './prompt'

// ============================================================================
// Types
// ============================================================================

/** Parsed heading entry with position and size info */
export interface HeadingEntry {
  /** 1-based line number where this heading starts */
  line: number
  /** The full heading text (e.g. "## State") */
  heading: string
  /** Heading depth (number of # characters) */
  level: number
  /** Number of lines in this section (until next same-or-higher-level heading) */
  lineCount: number
}

export interface MemorySnapshot {
  layout: MemoryLayout
  /** Whether memory.md exists on disk */
  exists: boolean
  /** memory.md records nothing yet: absent, blank, or only its skeleton */
  blank: boolean
  totalLines: number
  sizeBytes: number
  /** The first top-level section with everything under it — `# now` */
  firstSection: string | null
  /** Bytes of `firstSection` */
  nowBytes: number
  headers: HeadingEntry[]
  /** Full file content when the file is small enough to inject whole */
  fullContent: string | null
  topics: TopicsTree
  /** Most recent run records in run/ (up to 5) */
  runFiles: string[]
  runTotalCount: number
  /** memory.md versions kept by consolidations, both locations */
  archiveCount: number
  /** Last-modified time of memory.md (ISO), or null */
  lastModified: string | null
}

// ============================================================================
// Constants
// ============================================================================

/** Files with this many lines or fewer are injected in full */
const SMALL_MEMORY_LINE_THRESHOLD = 30

const MAX_RUN_FILES_IN_SNAPSHOT = 5

// ============================================================================
// Snapshot Builder
// ============================================================================

/** Pure read; no side effects. */
export async function buildMemorySnapshot(layout: MemoryLayout): Promise<MemorySnapshot> {
  const [content, topics, runFiles, archived, legacyArchived] = await Promise.all([
    readMemoryFile(layout.file),
    scanTopics(layout.topicsDir),
    listMemoryFiles(layout.runDir),
    listMemoryFiles(layout.archiveDir),
    // Compaction archives written before archive/ existed.
    listMemoryFiles(layout.dataDir),
  ])

  const snapshot: MemorySnapshot = {
    layout,
    exists: false,
    blank: true,
    totalLines: 0,
    sizeBytes: 0,
    firstSection: null,
    nowBytes: 0,
    headers: [],
    fullContent: null,
    topics,
    runFiles: runFiles.slice(0, MAX_RUN_FILES_IN_SNAPSHOT),
    runTotalCount: runFiles.length,
    archiveCount: archived.length + legacyArchived.length,
    lastModified: null,
  }

  if (content === null) return snapshot

  snapshot.exists = true
  snapshot.blank = isBlankMemory(content)
  snapshot.sizeBytes = Buffer.byteLength(content, 'utf-8')
  try {
    snapshot.lastModified = (await stat(layout.file)).mtime.toISOString()
  } catch {
    // Removed between the two reads; the content we hold is still valid.
  }

  const lines = content.split('\n')
  snapshot.totalLines = lines.length
  snapshot.headers = parseHeadings(lines)

  // For `# now` (level 1) the span runs to `# History`, so this is exactly the
  // working memory block.
  if (snapshot.headers.length > 0) {
    const first = snapshot.headers[0]
    const startIdx = first.line - 1
    snapshot.firstSection = lines.slice(startIdx, startIdx + first.lineCount).join('\n')
    snapshot.nowBytes = Buffer.byteLength(snapshot.firstSection, 'utf-8')
  }

  if (snapshot.totalLines <= SMALL_MEMORY_LINE_THRESHOLD) {
    snapshot.fullContent = content
  }

  return snapshot
}

// ============================================================================
// Heading Parser
// ============================================================================

/**
 * Parse all markdown headings, computing each section's line count: from its
 * heading to the line before the next heading of equal or higher level.
 * Headings inside fenced code blocks are not headings.
 */
export function parseHeadings(lines: string[]): HeadingEntry[] {
  const raw: Array<{ line: number; heading: string; level: number }> = []

  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const match = lines[i].match(/^(#{1,6})\s+(.*)/)
    if (match) {
      raw.push({ line: i + 1, heading: lines[i], level: match[1].length })
    }
  }

  return raw.map((h, idx) => {
    let endLine: number | undefined
    for (let next = idx + 1; next < raw.length; next++) {
      if (raw[next].level <= h.level) {
        endLine = raw[next].line - 1
        break
      }
    }
    endLine ??= lines.length
    return { ...h, lineCount: endLine - h.line + 1 }
  })
}

// ============================================================================
// memory_status MCP Tool
// ============================================================================

/**
 * An MCP server with the `memory_status` tool: structure only, no content, so
 * the agent uses its own Read/Edit/Write for content.
 */
export function createMemoryStatusMcpServer(layout: MemoryLayout) {
  const memory_status = tool(
    'memory_status',
    `Get structural metadata about your memory: memory.md's sections with line numbers ` +
    `and sizes, the topic index, archive info, and how to write a topic page (with examples). ` +
    `Does NOT return memory content — use Read for that.`,
    {
      // The SDK requires at least one field.
      _: z.string().optional().describe('Unused — this tool takes no parameters.'),
    },
    async () => {
      try {
        const snapshot = await buildMemorySnapshot(layout)
        return { content: [{ type: 'text' as const, text: formatStatusResponse(snapshot) }] }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to read memory status: ${(err as Error).message}` }],
          isError: true,
        }
      }
    }
  )

  return createSdkMcpServer({
    name: 'halo-memory',
    version: '1.0.0',
    tools: [memory_status],
  })
}

function formatStatusResponse(snapshot: MemorySnapshot): string {
  const { layout } = snapshot
  const lines: string[] = []

  if (!snapshot.exists) {
    lines.push(`File: ${layout.file}`)
    lines.push('Status: No memory file exists yet. Create it with Write when you have state to persist.')
  } else {
    lines.push(`File: ${layout.file} (${snapshot.totalLines} lines, ${formatKB(snapshot.sizeBytes)}; # now ${formatKB(snapshot.nowBytes)})`)
    if (snapshot.lastModified) lines.push(`Last modified: ${snapshot.lastModified}`)
    lines.push('')
    if (snapshot.headers.length > 0) {
      lines.push('Sections:')
      for (const h of snapshot.headers) {
        lines.push(`  ${'  '.repeat(h.level - 1)}L${h.line}: ${h.heading} (${h.lineCount} lines)`)
      }
    } else {
      lines.push('Sections: (no markdown headings found)')
    }
  }

  lines.push('')
  lines.push(`Topics: ${layout.topicsDir} (${snapshot.topics.topicCount} topics, ${formatKB(snapshot.topics.totalBytes)})`)
  lines.push(...renderTopicIndexLines(snapshot.topics).lines.map(l => `  ${l}`))

  lines.push('')
  lines.push(`Run records: ${layout.runDir} (${snapshot.runTotalCount} files)`)
  for (const f of snapshot.runFiles) lines.push(`  - ${f}`)
  if (snapshot.archiveCount > 0) {
    lines.push(`Archived memory.md versions: ${layout.archiveDir} (${snapshot.archiveCount} files)`)
  }

  lines.push('')
  lines.push('## Writing topics')
  lines.push('')
  lines.push(TOPIC_GUIDE)

  return lines.join('\n')
}
