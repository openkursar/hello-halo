/**
 * platform/memory -- Memory Snapshot
 *
 * Builds a structural snapshot of an app's memory.md and archive directory.
 * Used in two contexts:
 *
 * 1. **Trigger-time injection**: The automation runtime calls buildMemorySnapshot()
 *    before each run and injects the result into the initial user message,
 *    giving the AI immediate memory context without a tool call.
 *
 * 2. **Runtime `memory_status` tool**: A lightweight MCP tool that returns the
 *    same structural metadata (no content), so the AI can re-check the memory
 *    map mid-run after edits.
 */

import { stat } from 'fs/promises'
import { z } from 'zod'
import { tool, createSdkMcpServer } from './sdk'
import type { MemoryCallerScope } from './types'
import { getMemoryFilePath, getMemoryArchiveDir } from './paths'
import { readMemoryFile, listMemoryFiles, getFileSize } from './file-ops'
import { join } from 'path'

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
  /** Number of content lines in this section (until next same-or-higher-level heading) */
  lineCount: number
}

/** Structural snapshot of an app's memory */
export interface MemorySnapshot {
  /** Whether memory.md exists on disk */
  exists: boolean
  /** Total line count of memory.md */
  totalLines: number
  /** File size in bytes */
  sizeBytes: number
  /** Full text of the first top-level section (including all sub-headings until next same-or-higher-level heading) */
  firstSection: string | null
  /** All headings with line numbers and section sizes */
  headers: HeadingEntry[]
  /** Full file content when totalLines <= threshold, otherwise null */
  fullContent: string | null
  /** Most recent run file names from memory/run/ (up to 5) */
  archiveFiles: string[]
  /** Total number of files in memory/run/ */
  archiveTotalCount: number
  /** Number of compaction archives in memory/ root */
  compactionArchiveCount: number
  /** Absolute path to memory.md */
  memoryFilePath: string
  /** Absolute path to the memory/run/ directory */
  memoryArchiveDir: string
  /** Last-modified timestamp of memory.md (ISO string), or null if file doesn't exist */
  lastModified: string | null
  /**
   * Raw file content of memory.md, or null if file doesn't exist.
   *
   * Always populated when `exists` is true. Used internally by the runtime
   * to pass pre-read content to downstream file operations (e.g. heading
   * insertion) and avoid redundant I/O. Not included in MCP tool responses.
   */
  rawContent: string | null
}

// ============================================================================
// Constants
// ============================================================================

/** Files with this many lines or fewer are considered "small" and injected in full */
const SMALL_MEMORY_LINE_THRESHOLD = 30

/** Maximum number of archive files to include in the snapshot */
const MAX_ARCHIVE_FILES_IN_SNAPSHOT = 5

// ============================================================================
// Snapshot Builder
// ============================================================================

/**
 * Build a structural snapshot of an app's memory.
 *
 * This is a pure read operation with no side effects. It reads the memory.md
 * file and archive directory, then returns a structured snapshot that can be
 * used for trigger-message injection or the memory_status tool response.
 *
 * @param caller - Identity of the caller (must have appId for app scope)
 * @returns A complete MemorySnapshot
 */
export async function buildMemorySnapshot(caller: MemoryCallerScope): Promise<MemorySnapshot> {
  const memoryFilePath = getMemoryFilePath(caller, 'app')
  const memoryArchiveDir = getMemoryArchiveDir(caller, 'app')

  // Base snapshot for non-existent file
  const snapshot: MemorySnapshot = {
    exists: false,
    totalLines: 0,
    sizeBytes: 0,
    firstSection: null,
    headers: [],
    fullContent: null,
    archiveFiles: [],
    archiveTotalCount: 0,
    compactionArchiveCount: 0,
    memoryFilePath,
    memoryArchiveDir: join(memoryArchiveDir, 'run'),
    lastModified: null,
    rawContent: null,
  }

  // ── Read memory.md ─────────────────────────────────────────────────────
  const content = await readMemoryFile(memoryFilePath)

  if (content !== null) {
    snapshot.exists = true
    snapshot.rawContent = content
    snapshot.sizeBytes = await getFileSize(memoryFilePath)

    // Last-modified time
    try {
      const stats = await stat(memoryFilePath)
      snapshot.lastModified = stats.mtime.toISOString()
    } catch {
      // Ignore — file may have been deleted between reads
    }

    const lines = content.split('\n')
    snapshot.totalLines = lines.length

    // ── Parse all headings ─────────────────────────────────────────────
    snapshot.headers = parseHeadings(lines)

    // ── Extract first section ──────────────────────────────────────────
    //    Uses lineCount from parseHeadings() which already computes the span
    //    up to the next same-or-higher-level heading. For `# now` (level 1),
    //    this includes all sub-headings (## State, ## Patterns, etc.) up to
    //    `# History` — exactly the working memory block we want to auto-load.
    if (snapshot.headers.length > 0) {
      const first = snapshot.headers[0]
      const startIdx = first.line - 1 // Convert to 0-based
      snapshot.firstSection = lines.slice(startIdx, startIdx + first.lineCount).join('\n')
    }

    // ── Full content for small files ───────────────────────────────────
    if (snapshot.totalLines <= SMALL_MEMORY_LINE_THRESHOLD) {
      snapshot.fullContent = content
    }
  }

  // ── Read archive directory (run/ subfolder for session summaries) ──────
  const runDir = join(memoryArchiveDir, 'run')
  const allArchiveFiles = await listMemoryFiles(runDir)
  snapshot.archiveTotalCount = allArchiveFiles.length
  snapshot.archiveFiles = allArchiveFiles.slice(0, MAX_ARCHIVE_FILES_IN_SNAPSHOT)

  // ── Count compaction archives in memory/ root ───────────────────────────
  const compactionFiles = await listMemoryFiles(memoryArchiveDir)
  // Filter out the 'run' directory entry — listMemoryFiles only returns .md files so this is safe
  snapshot.compactionArchiveCount = compactionFiles.length

  return snapshot
}

// ============================================================================
// Heading Parser
// ============================================================================

/**
 * Parse all markdown headings from lines, computing each section's line count.
 *
 * A section runs from its heading line to the line before the next heading
 * of equal or higher level (fewer or equal # characters), or to the end
 * of the file.
 */
function parseHeadings(lines: string[]): HeadingEntry[] {
  const raw: Array<{ line: number; heading: string; level: number }> = []

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.*)/)
    if (match) {
      raw.push({
        line: i + 1, // 1-based
        heading: lines[i],
        level: match[1].length,
      })
    }
  }

  // Compute lineCount for each heading: distance to next same-or-higher-level heading
  const entries: HeadingEntry[] = raw.map((h, idx) => {
    let endLine: number
    // Find next heading at same or higher level
    let nextIdx = idx + 1
    while (nextIdx < raw.length) {
      if (raw[nextIdx].level <= h.level) {
        endLine = raw[nextIdx].line - 1
        break
      }
      nextIdx++
    }
    // If no same-or-higher-level heading found, section extends to EOF
    endLine ??= lines.length

    return {
      ...h,
      lineCount: endLine - h.line + 1,
    }
  })

  return entries
}

// ============================================================================
// memory_status MCP Tool
// ============================================================================

/**
 * Create an MCP server with the `memory_status` tool.
 *
 * Returns structural metadata (file path, sections, sizes) — no content —
 * so the AI uses native Read/Edit/Write for content operations.
 *
 * @param caller - Caller identity (must have appId for app scope)
 * @returns An SDK MCP server instance with a single `memory_status` tool
 */
export function createMemoryStatusMcpServer(caller: MemoryCallerScope) {
  const memory_status = tool(
    'memory_status',
    `Get structural metadata about your memory file (memory.md).\n` +
    `Returns: file path, size, line count, section headings with line numbers and sizes, ` +
    `and archive directory info. Does NOT return file content — use Read for that.\n` +
    `No parameters needed — always operates on your app memory.`,
    {
      // Empty schema — the tool takes no parameters.
      // We use a dummy optional field because the SDK requires at least one field.
      _: z.string().optional().describe('Unused — this tool takes no parameters.'),
    },
    async () => {
      try {
        const snapshot = await buildMemorySnapshot(caller)
        return {
          content: [{ type: 'text' as const, text: formatStatusResponse(snapshot) }],
        }
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

/**
 * Format a MemorySnapshot into a human-readable status string.
 */
function formatStatusResponse(snapshot: MemorySnapshot): string {
  const lines: string[] = []

  if (!snapshot.exists) {
    lines.push(`File: ${snapshot.memoryFilePath}`)
    lines.push('Status: No memory file exists yet.')
    lines.push('Create it with Write when you have state to persist.')
  } else {
    const sizeKB = (snapshot.sizeBytes / 1024).toFixed(1)
    lines.push(`File: ${snapshot.memoryFilePath} (${snapshot.totalLines} lines, ${sizeKB}KB)`)

    if (snapshot.lastModified) {
      lines.push(`Last modified: ${snapshot.lastModified}`)
    }

    if (snapshot.headers.length > 0) {
      lines.push('')
      lines.push('Sections:')
      for (const h of snapshot.headers) {
        // Indent sub-headings for readability
        const indent = '  '.repeat(h.level - 1)
        lines.push(`  ${indent}L${h.line}: ${h.heading} (${h.lineCount} lines)`)
      }
    } else {
      lines.push('Sections: (no markdown headings found)')
    }
  }

  // Archive info
  lines.push('')
  if (snapshot.archiveTotalCount > 0) {
    lines.push(`Run History: ${snapshot.memoryArchiveDir} (${snapshot.archiveTotalCount} files)`)
    for (const f of snapshot.archiveFiles) {
      lines.push(`  - ${f}`)
    }
    if (snapshot.archiveTotalCount > snapshot.archiveFiles.length) {
      lines.push(`  ... and ${snapshot.archiveTotalCount - snapshot.archiveFiles.length} more`)
    }
  } else {
    lines.push(`Run History: ${snapshot.memoryArchiveDir} (empty)`)
  }

  if (snapshot.compactionArchiveCount > 0) {
    const compactDir = snapshot.memoryArchiveDir.replace(/\/run$/, '')
    lines.push(`Compaction Archives: ${compactDir} (${snapshot.compactionArchiveCount} files)`)
  }

  return lines.join('\n')
}
