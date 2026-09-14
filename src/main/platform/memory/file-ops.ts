/**
 * platform/memory -- File Operations
 *
 * Low-level filesystem operations for memory files.
 * All functions are async and operate on absolute paths.
 * Path resolution and permission checks happen in the calling layer.
 */

import { readFile, writeFile, appendFile, mkdir, readdir, rename, stat, link, copyFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'

// ============================================================================
// Write serialization
// ============================================================================

/**
 * One memory file is shared by every execution of the same digital human —
 * scheduled runs, chat threads, IM threads, team turns — all in this process.
 * Several of the writes below are read-modify-write, so without serialization
 * two overlapping executions interleave and the later write silently drops the
 * earlier one. Tail of the pending chain per absolute path.
 *
 * Not covered: the agent's own Read/Edit/Write reach the file through its
 * sandbox rather than this module, so they cannot be serialized from here.
 */
const writeQueues = new Map<string, Promise<void>>()

async function withMemoryFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(filePath) ?? Promise.resolve()

  let release: () => void = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  const queued = previous.then(() => held)
  writeQueues.set(filePath, queued)

  await previous

  try {
    return await fn()
  } finally {
    release()
    // Only the last waiter clears the entry, so the map does not grow per file.
    if (writeQueues.get(filePath) === queued) {
      writeQueues.delete(filePath)
    }
  }
}

/**
 * Write-then-rename, so a reader never observes a partially written file.
 *
 * The lock keeps two writers in this process off the same temp name; the pid
 * keeps two Halo instances sharing a machine off it too.
 */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  await ensureDir(dirname(filePath))

  const tmpPath = `${filePath}.${process.pid}.tmp`
  await writeFile(tmpPath, content, 'utf-8')
  await rename(tmpPath, filePath)
}

// ============================================================================
// Read
// ============================================================================

/**
 * Read a memory file.
 *
 * @param filePath - Absolute path to the file
 * @returns File content as string, or null if file does not exist
 */
export async function readMemoryFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8')
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return null
    }
    throw err
  }
}

/**
 * Extract all markdown headings from a memory file.
 *
 * Returns heading lines prefixed with their line numbers, e.g.:
 *   L1:  # State
 *   L15: ## Tracked Items
 *   L30: ## Patterns
 *
 * @param filePath - Absolute path to the file
 * @returns Heading lines with line numbers, or null if file does not exist
 */
export async function readMemoryHeadings(filePath: string): Promise<string | null> {
  const content = await readMemoryFile(filePath)
  if (content === null) return null

  const lines = content.split('\n')
  const headings: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^#{1,6}\s/.test(line)) {
      headings.push(`L${i + 1}: ${line}`)
    }
  }

  if (headings.length === 0) {
    return '(No markdown headings found in memory file)'
  }

  return headings.join('\n')
}

/**
 * Extract a specific section from a memory file by heading text.
 *
 * A section starts at the matched heading line and ends at the next heading
 * of equal or higher level, or at the end of the file.
 *
 * Matching is case-insensitive substring: section="tracked" matches "## Tracked Items".
 *
 * @param filePath - Absolute path to the file
 * @param heading  - Heading text to match (case-insensitive substring)
 * @returns Section content including the heading line, or null if file/section not found
 */
export async function readMemorySection(filePath: string, heading: string): Promise<string | null> {
  const content = await readMemoryFile(filePath)
  if (content === null) return null

  const lines = content.split('\n')
  const needle = heading.toLowerCase()

  // Find the first heading line that matches
  let startIdx = -1
  let startLevel = 0

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.*)/)
    if (match && match[2].toLowerCase().includes(needle)) {
      startIdx = i
      startLevel = match[1].length
      break
    }
  }

  if (startIdx === -1) {
    return null // Section not found
  }

  // Find the end: next heading at same or higher level (fewer or equal #)
  let endIdx = lines.length
  for (let i = startIdx + 1; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s/)
    if (match && match[1].length <= startLevel) {
      endIdx = i
      break
    }
  }

  return lines.slice(startIdx, endIdx).join('\n')
}

/**
 * Read the last N lines of a memory file.
 *
 * @param filePath - Absolute path to the file
 * @param limit    - Number of lines to return (default: 50)
 * @returns Last N lines as string, or null if file does not exist
 */
export async function readMemoryTail(filePath: string, limit: number = 50): Promise<string | null> {
  const content = await readMemoryFile(filePath)
  if (content === null) return null

  const lines = content.split('\n')
  const startLine = Math.max(0, lines.length - limit)
  const tailLines = lines.slice(startLine)

  if (startLine > 0) {
    return `... (showing last ${limit} of ${lines.length} lines)\n` + tailLines.join('\n')
  }

  return tailLines.join('\n')
}

// ============================================================================
// Write
// ============================================================================

/**
 * Append content to a memory file.
 *
 * Ensures the parent directory exists. Prepends a metadata comment
 * with timestamp and source identifier for audit trail.
 *
 * @param filePath - Absolute path to the file
 * @param content  - Content to append
 * @param source   - Identifier of the writer (e.g., 'user', 'app:my-app')
 */
export async function appendToMemoryFile(
  filePath: string,
  content: string,
  source: string
): Promise<void> {
  await withMemoryFileLock(filePath, async () => {
    await ensureDir(dirname(filePath))

    const timestamp = new Date().toISOString()
    const header = `\n<!-- ${timestamp} by ${source} -->\n`
    const payload = header + content.trimEnd() + '\n'

    await appendFile(filePath, payload, 'utf-8')
  })
}

/**
 * Replace the entire content of a memory file.
 *
 * Uses atomic write pattern: write to temp file, then rename.
 * Ensures the parent directory exists.
 *
 * @param filePath - Absolute path to the file
 * @param content  - New content
 */
export async function replaceMemoryFile(
  filePath: string,
  content: string
): Promise<void> {
  await withMemoryFileLock(filePath, () => atomicWrite(filePath, content))
}

/**
 * Open a `# History` entry for a turn that is about to start, so the agent has
 * a heading to fill in rather than having to place one itself.
 *
 * The heading goes directly under the `# History` H1 (newest first), so this is
 * a read-modify-write, not an append. The file is read inside the lock: a
 * caller's earlier snapshot may already be stale by the time it gets here, and
 * writing that back would undo whatever landed in between.
 *
 * @param filePath  - Absolute path to memory.md
 * @param timestamp - Heading timestamp, `YYYY-MM-DD-HHmm`
 * @param byLabel   - Rendered signature of the writing execution, appended as
 *                    a trailing `[by: ...]` tag. Omitted when unattributed.
 */
export async function insertHistoryHeading(
  filePath: string,
  timestamp: string,
  byLabel?: string
): Promise<void> {
  await withMemoryFileLock(filePath, async () => {
    const heading = byLabel ? `## ${timestamp}  [by: ${byLabel}]` : `## ${timestamp}`

    // A file that exists but holds nothing still needs the whole skeleton:
    // appending only `# History` would leave a memory.md with no `# now`, which
    // is the section every reader of this file expects to find.
    const content = await readMemoryFile(filePath)
    if (content === null || content.trim() === '') {
      await atomicWrite(filePath, `# now\n\n## State\n\n# History\n\n${heading}\n`)
      return
    }

    // Anchored to the heading line alone. Letting the match run past the line
    // end moves the insertion point down by whatever blank lines follow, so
    // every run leaves the gap under `# History` one line taller and the entries
    // themselves unseparated.
    const historyMatch = content.match(/^# History[^\S\r\n]*$/m)
    if (historyMatch && historyMatch.index !== undefined) {
      const insertPos = historyMatch.index + historyMatch[0].length
      const rest = content.slice(insertPos).replace(/^\r?\n/, '')
      await atomicWrite(filePath, `${content.slice(0, insertPos)}\n\n${heading}\n${rest}`)
    } else {
      await atomicWrite(filePath, content.trimEnd() + `\n\n# History\n\n${heading}\n`)
    }
  })
}

/**
 * Move the current memory file into the archive and put `content` in its place,
 * as one step.
 *
 * The summary that becomes `content` takes a minute or more to generate, and the
 * file must stay readable for all of it: an execution starting meanwhile reads
 * real memory rather than an empty slot, and its own writes land in the file
 * that is about to be archived — so they are preserved there rather than lost.
 * The trade is that such writes are in the archive but not in the summary, which
 * is why generation reads the file and this call does not.
 *
 * @param filePath   - Path to the current memory.md
 * @param archiveDir - Path to the memory/ archive directory
 * @param content    - What memory.md holds afterwards
 * @returns Path to the archived file
 */
export async function archiveAndReplaceMemoryFile(
  filePath: string,
  archiveDir: string,
  content: string
): Promise<string> {
  return withMemoryFileLock(filePath, async () => {
    const archivePath = await copyToArchive(filePath, archiveDir)
    await atomicWrite(filePath, content)
    return archivePath
  })
}

// ============================================================================
// List
// ============================================================================

/**
 * List files in a memory archive directory.
 *
 * @param dirPath - Absolute path to the directory
 * @returns Array of filenames (not full paths), sorted newest first
 */
export async function listMemoryFiles(dirPath: string): Promise<string[]> {
  if (!existsSync(dirPath)) {
    return []
  }

  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    const files = entries
      .filter(e => e.isFile() && e.name.endsWith('.md'))
      .map(e => e.name)

    // Sort newest first (lexicographic descending works for YYYY-MM-DD format)
    files.sort((a, b) => b.localeCompare(a))
    return files
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return []
    }
    throw err
  }
}

// ============================================================================
// Archive (for compaction)
// ============================================================================

/**
 * Give the current memory file a second name under the archive, WITHOUT
 * removing it from its own. Caller must hold the file's write lock.
 *
 * A move would be the obvious thing and is wrong here. The write lock orders
 * this module's writers against each other; it does not reach readers, and
 * `buildMemorySnapshot` reads lock-free at the start of every turn. Between an
 * unlink and the replacing write there are several awaited syscalls — long
 * enough, in practice, for most reads landing in that span to see no file at
 * all. What a reader concludes from that is the damage: the trigger message
 * tells it no memory exists and to Write one, and that Write does not come
 * through this module and cannot be stopped. A path that is never absent
 * cannot be misread that way.
 *
 * A hard link keeps both names on one inode, so the archive is the file rather
 * than a copy of it and cannot be caught half-written. Filesystems that refuse
 * links fall back to a copy.
 */
async function copyToArchive(filePath: string, archiveDir: string): Promise<string> {
  await ensureDir(archiveDir)

  const now = new Date()
  const slug = formatTimestamp(now)
  const archivePath = join(archiveDir, `${slug}.md`)

  // Handle name collision (very unlikely -- same minute)
  let finalPath = archivePath
  if (existsSync(archivePath)) {
    const deduped = `${slug}-${now.getSeconds().toString().padStart(2, '0')}.md`
    finalPath = join(archiveDir, deduped)
  }

  try {
    await link(filePath, finalPath)
  } catch {
    await copyFile(filePath, finalPath)
  }
  return finalPath
}

/**
 * Get the size of a file in bytes.
 *
 * @returns File size in bytes, or 0 if file does not exist
 */
export async function getFileSize(filePath: string): Promise<number> {
  try {
    const stats = await stat(filePath)
    return stats.size
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return 0
    }
    throw err
  }
}

// ============================================================================
// Helpers
// ============================================================================

async function ensureDir(dirPath: string): Promise<void> {
  if (!existsSync(dirPath)) {
    await mkdir(dirPath, { recursive: true })
  }
}

function formatTimestamp(date: Date): string {
  const y = date.getFullYear()
  const m = (date.getMonth() + 1).toString().padStart(2, '0')
  const d = date.getDate().toString().padStart(2, '0')
  const h = date.getHours().toString().padStart(2, '0')
  const min = date.getMinutes().toString().padStart(2, '0')
  return `${y}-${m}-${d}-${h}${min}`
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err
}
