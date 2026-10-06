/**
 * platform/memory -- Memory Snapshot
 *
 * Reads one memory as it stands: memory.md's structure, its `# now` block, the
 * topic tree, and what the archives hold. Rendered into the message that opens
 * a run or session (see section.ts). Later retrieval uses native file tools.
 */

import type { MemoryLayout } from './paths'
import { readMemoryFile, listMemoryFiles, isBlankMemory } from './file-ops'
import { scanTopics, type TopicsTree } from './topics'

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
  runTotalCount: number
  /** memory.md versions kept by consolidations, both locations */
  archiveCount: number
}

// ============================================================================
// Constants
// ============================================================================

/** Files with this many lines or fewer are injected in full */
const SMALL_MEMORY_LINE_THRESHOLD = 30

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
    runTotalCount: runFiles.length,
    archiveCount: archived.length + legacyArchived.length,
  }

  if (content === null) return snapshot

  snapshot.exists = true
  snapshot.blank = isBlankMemory(content)
  snapshot.sizeBytes = Buffer.byteLength(content, 'utf-8')
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
