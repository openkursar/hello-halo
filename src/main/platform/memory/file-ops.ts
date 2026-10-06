/**
 * platform/memory -- File Operations
 *
 * Low-level filesystem operations for memory files, and the one lock every
 * writer of a memory takes — this module's own writers and, through the write
 * guard, the agent's file tools.
 */

import { readFile, writeFile, mkdir, readdir, rename, stat, link, copyFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname } from 'path'
import type { MemoryLayout } from './paths'
import type { MemoryOwnerKind } from './prompt'

// ============================================================================
// Write serialization
// ============================================================================

/**
 * One memory is shared by every execution writing to it — scheduled runs,
 * chats, IM threads, team turns, a consolidation — all in this process. Several
 * writes are read-modify-write, so without serialization two overlapping
 * writers interleave and the later write silently drops the earlier one.
 *
 * Keyed by the memory's memory.md path: one lock covers that file and its whole
 * data directory, because a consolidation replaces both at once.
 */
const writeQueues = new Map<string, Promise<void>>()

/**
 * Take the lock for one memory.
 *
 * Returns the release function, or null when `timeoutMs` elapsed first. A
 * timed-out waiter gives up its place without breaking the order of the ones
 * behind it. `leaseMs` releases the lock on its own if the holder never does —
 * for holders whose release depends on a callback that may not arrive.
 */
export async function acquireMemoryLock(
  key: string,
  opts: { timeoutMs?: number; leaseMs?: number } = {}
): Promise<(() => void) | null> {
  const previous = writeQueues.get(key) ?? Promise.resolve()

  let resolveHeld: () => void = () => {}
  const held = new Promise<void>(resolve => { resolveHeld = resolve })
  const queued = previous.then(() => held)
  writeQueues.set(key, queued)

  let released = false
  let leaseTimer: ReturnType<typeof setTimeout> | undefined
  const release = (): void => {
    if (released) return
    released = true
    if (leaseTimer) clearTimeout(leaseTimer)
    resolveHeld()
    // Cleared only once everything ahead has released too. A waiter that timed
    // out releases while its predecessor still holds the lock; deleting the
    // entry then would hand the next caller a free lock beside that holder.
    void queued.then(() => {
      if (writeQueues.get(key) === queued) writeQueues.delete(key)
    })
  }

  if (opts.timeoutMs === undefined) {
    await previous
  } else {
    let timer: ReturnType<typeof setTimeout> | undefined
    const acquired = await Promise.race([
      previous.then(() => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), opts.timeoutMs) }),
    ])
    if (timer) clearTimeout(timer)
    if (!acquired) {
      release()
      return null
    }
  }

  if (opts.leaseMs !== undefined) {
    leaseTimer = setTimeout(() => {
      if (released) return
      console.warn(`[Memory] Lock on ${key} not released within ${opts.leaseMs}ms — releasing it`)
      release()
    }, opts.leaseMs)
    leaseTimer.unref?.()
  }

  return release
}

/** Run `fn` while holding the lock for one memory. */
export async function withMemoryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const release = (await acquireMemoryLock(key))!
  try {
    return await fn()
  } finally {
    release()
  }
}

/**
 * Write-then-rename, so a reader never observes a partially written file.
 *
 * The lock keeps two writers in this process off the same temp name; the pid
 * keeps two Halo instances sharing a machine off it too.
 */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  await ensureDir(dirname(filePath))

  const tmpPath = `${filePath}.${process.pid}.tmp`
  await writeFile(tmpPath, content, 'utf-8')
  await rename(tmpPath, filePath)
}

// ============================================================================
// Read
// ============================================================================

/** @returns File content, or null if the file does not exist */
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

// ============================================================================
// Skeleton
// ============================================================================

/**
 * The file a memory starts as: its sections in place and nothing in them, so
 * the agent's first write is an Edit like every later one — never a Write that
 * could land on top of another conversation's. No sample lines: anything here
 * would be read as something remembered.
 */
const MEMORY_SKELETON: Record<MemoryOwnerKind, string> = {
  'digital-human': '# now\n\n## State\n\n# History\n',
  space: '# now\n\n## State\n\n# History\n',
}

/** A skeleton line: a section heading with nothing after it. */
const SKELETON_LINE = /^(?:#\s+now|#\s+History|##\s+State(?:\s*\|)?)$/

/** Larger than this, a file holds more than a skeleton; no need to read it. */
const SKELETON_MAX_BYTES = 256

/** Whether memory.md content records nothing: absent, blank, or only the skeleton. */
export function isBlankMemory(content: string | null): boolean {
  if (content === null) return true
  return content.split('\n').every(line => line.trim() === '' || SKELETON_LINE.test(line.trim()))
}

/**
 * Give a memory its skeleton if memory.md is missing or blank. Never touches a
 * file that holds anything.
 *
 * @returns Whether the skeleton was written
 */
export async function ensureMemoryFile(layout: MemoryLayout, owner: MemoryOwnerKind): Promise<boolean> {
  if ((await getFileSize(layout.file)) > SKELETON_MAX_BYTES) return false
  return withMemoryLock(layout.file, async () => {
    const content = await readMemoryFile(layout.file)
    if (content !== null && content.trim() !== '') return false
    await atomicWrite(layout.file, MEMORY_SKELETON[owner])
    return true
  })
}

// ============================================================================
// Write
// ============================================================================

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
  await withMemoryLock(filePath, async () => {
    const heading = byLabel ? `## ${timestamp}  [by: ${byLabel}]` : `## ${timestamp}`

    // A file that exists but holds nothing still needs the whole skeleton:
    // appending only `# History` would leave a memory.md with no `# now`, which
    // is the section every reader of this file expects to find.
    const content = await readMemoryFile(filePath)
    if (content === null || content.trim() === '') {
      await atomicWrite(filePath, `${MEMORY_SKELETON['digital-human']}\n${heading}\n`)
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

// ============================================================================
// List
// ============================================================================

/**
 * List the markdown files directly inside a directory.
 *
 * @returns File names, newest first (names are timestamp-prefixed)
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
// Archive
// ============================================================================

/**
 * Give the current memory file a second name under the archive, WITHOUT
 * removing it from its own. Caller must hold the memory's lock.
 *
 * A move would be the obvious thing and is wrong here. The lock orders writers;
 * it does not reach readers, and the snapshot at every turn start reads
 * lock-free. A reader that finds no memory.md is told to create one with Write,
 * which replaces the memory with a blank file. A path that is never absent
 * cannot be misread that way.
 *
 * A hard link keeps both names on one inode, so the archive is the file rather
 * than a copy of it and cannot be caught half-written. Filesystems that refuse
 * links fall back to a copy.
 */
export async function linkToArchive(filePath: string, archiveDir: string): Promise<string> {
  await ensureDir(archiveDir)

  const now = new Date()
  const slug = formatTimestamp(now)
  let finalPath = join(archiveDir, `${slug}.md`)
  if (existsSync(finalPath)) {
    finalPath = join(archiveDir, `${slug}-${now.getSeconds().toString().padStart(2, '0')}-${now.getMilliseconds()}.md`)
  }

  try {
    await link(filePath, finalPath)
  } catch {
    await copyFile(filePath, finalPath)
  }
  return finalPath
}

/** @returns File size in bytes, or 0 if the file does not exist */
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

export async function ensureDir(dirPath: string): Promise<void> {
  if (!existsSync(dirPath)) {
    await mkdir(dirPath, { recursive: true })
  }
}

/** Unified memory timestamp: `YYYY-MM-DD-HHmm`, local time. */
export function formatTimestamp(date: Date): string {
  const y = date.getFullYear()
  const m = (date.getMonth() + 1).toString().padStart(2, '0')
  const d = date.getDate().toString().padStart(2, '0')
  const h = date.getHours().toString().padStart(2, '0')
  const min = date.getMinutes().toString().padStart(2, '0')
  return `${y}-${m}-${d}-${h}${min}`
}

export function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err
}
