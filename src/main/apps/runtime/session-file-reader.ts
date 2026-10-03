/**
 * Reading append-only JSONL session files without loading them whole.
 *
 * - `scanJsonlLines` walks a byte range in fixed-size chunks and hands back
 *   complete lines with their physical line numbers (message ids derive from
 *   them, so numbering counts blank and malformed lines too). Memory stays
 *   proportional to one chunk plus one line, whatever the file size.
 * - `LineIndex` maps line numbers to byte offsets through sparse checkpoints,
 *   so a reader can start at any line of a huge file. It is extended only by
 *   the bytes appended since it was last built and persisted next to the file,
 *   so a restart does not rescan the whole file either.
 */

import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, writeFileSync } from 'fs'

const CHUNK_BYTES = 1024 * 1024
const NEWLINE = 0x0a
/** Distance between index checkpoints. */
export const CHECKPOINT_BYTES = 1024 * 1024
/** Persist the index again once this many new bytes are indexed. */
const PERSIST_EVERY_BYTES = 4 * 1024 * 1024

export interface ScanResult {
  /** Byte offset just past the last complete (newline-terminated) line. */
  endByte: number
  /** Line number of the first line not consumed. */
  nextLine: number
  /** Unterminated final line (a write in progress), when the range reaches EOF. */
  trailing: { text: string; line: number } | null
}

/**
 * Call `onLine` for each complete line in [start, end) of `fd`, `start` being
 * the beginning of line `startLine`.
 */
export function scanJsonlLines(
  fd: number,
  start: number,
  end: number,
  startLine: number,
  onLine: (text: string, line: number) => void,
): ScanResult {
  const chunk = Buffer.allocUnsafe(CHUNK_BYTES)
  let carry: Buffer | null = null
  let position = start
  let line = startLine
  let consumed = start
  while (position < end) {
    const want = Math.min(CHUNK_BYTES, end - position)
    const read = readSync(fd, chunk, 0, want, position)
    if (read <= 0) break
    const data: Buffer = carry ? Buffer.concat([carry, chunk.subarray(0, read)]) : chunk.subarray(0, read)
    const dataStart = position - (carry?.length ?? 0)
    position += read
    let from = 0
    for (let nl = data.indexOf(NEWLINE, from); nl !== -1; nl = data.indexOf(NEWLINE, from)) {
      onLine(data.toString('utf8', from, nl), line)
      line += 1
      from = nl + 1
    }
    consumed = dataStart + from
    carry = from < data.length ? Buffer.from(data.subarray(from)) : null
  }
  const trailing = carry && carry.length > 0 ? { text: carry.toString('utf8'), line } : null
  return { endByte: consumed, nextLine: line, trailing }
}

/** Count newlines in [start, end), noting a checkpoint every CHECKPOINT_BYTES. */
function countLines(
  fd: number,
  start: number,
  end: number,
  startLine: number,
  checkpoints: Array<[number, number]>,
): { endByte: number; nextLine: number } {
  const chunk = Buffer.allocUnsafe(CHUNK_BYTES)
  let position = start
  let line = startLine
  let lastLineStart = start
  let lastCheckpoint = checkpoints.length > 0 ? checkpoints[checkpoints.length - 1][0] : 0
  while (position < end) {
    const read = readSync(fd, chunk, 0, Math.min(CHUNK_BYTES, end - position), position)
    if (read <= 0) break
    for (let nl = chunk.indexOf(NEWLINE, 0); nl !== -1 && nl < read; nl = chunk.indexOf(NEWLINE, nl + 1)) {
      line += 1
      lastLineStart = position + nl + 1
      if (lastLineStart - lastCheckpoint >= CHECKPOINT_BYTES) {
        checkpoints.push([lastLineStart, line])
        lastCheckpoint = lastLineStart
      }
    }
    position += read
  }
  return { endByte: lastLineStart, nextLine: line }
}

interface LineIndexData {
  ino: number
  /** Leading bytes of the file (base64): a recreated file that got the same inode back does not match. */
  head: string
  /** Bytes indexed, always at a line start. */
  size: number
  /** Line number starting at `size`. */
  nextLine: number
  /** [byte offset of a line start, its line number], ascending. */
  checkpoints: Array<[number, number]>
}

const HEAD_BYTES = 256

function readHead(fd: number, size: number): string {
  const buffer = Buffer.alloc(Math.min(HEAD_BYTES, size))
  if (buffer.length > 0) readSync(fd, buffer, 0, buffer.length, 0)
  return buffer.toString('base64')
}

export class LineIndex {
  private data: LineIndexData
  private persistedSize: number

  private constructor(private readonly sidecarPath: string, data: LineIndexData) {
    this.data = data
    this.persistedSize = data.size
  }

  /** Load the persisted index for `fd` (or start empty) and extend it to the file's end. */
  static open(sidecarPath: string, fd: number): LineIndex {
    const stat = fstatSync(fd)
    const head = readHead(fd, stat.size)
    let data: LineIndexData = { ino: stat.ino, head, size: 0, nextLine: 1, checkpoints: [[0, 1]] }
    try {
      if (existsSync(sidecarPath)) {
        const stored = JSON.parse(readFileSync(sidecarPath, 'utf8')) as LineIndexData
        // Append-only: an index is reusable while it describes a prefix of this same file.
        if (stored.ino === stat.ino && stored.head === head && stored.size <= stat.size && Array.isArray(stored.checkpoints)) data = stored
      }
    } catch {
      // Unreadable sidecar: rebuild it.
    }
    const index = new LineIndex(sidecarPath, data)
    index.extend(fd, stat.size)
    return index
  }

  get indexedBytes(): number {
    return this.data.size
  }

  get ino(): number {
    return this.data.ino
  }

  /** Index bytes appended since the last extend, up to `fileSize`. */
  extend(fd: number, fileSize: number): void {
    if (fileSize <= this.data.size) return
    const { endByte, nextLine } = countLines(fd, this.data.size, fileSize, this.data.nextLine, this.data.checkpoints)
    this.data.size = endByte
    this.data.nextLine = nextLine
    if (this.data.size - this.persistedSize >= PERSIST_EVERY_BYTES) this.persist()
  }

  persist(): void {
    try {
      writeFileSync(this.sidecarPath, JSON.stringify(this.data))
      this.persistedSize = this.data.size
    } catch (error) {
      console.warn(`[SessionStore] Could not persist line index ${this.sidecarPath}:`, (error as Error).message)
    }
  }

  /** Byte offset where `line` starts, or null past the indexed end. */
  offsetOfLine(fd: number, line: number): number | null {
    if (line >= this.data.nextLine) return line === this.data.nextLine ? this.data.size : null
    const [byte, startLine] = this.checkpointAtOrBefore((cp) => cp[1] <= line)
    if (startLine === line) return byte
    let found: number | null = null
    let current = startLine
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES)
    let position = byte
    while (found === null && position < this.data.size) {
      const read = readSync(fd, chunk, 0, Math.min(CHUNK_BYTES, this.data.size - position), position)
      if (read <= 0) break
      for (let nl = chunk.indexOf(NEWLINE, 0); nl !== -1 && nl < read; nl = chunk.indexOf(NEWLINE, nl + 1)) {
        current += 1
        if (current === line) {
          found = position + nl + 1
          break
        }
      }
      position += read
    }
    return found
  }

  /** Line number of the first line starting at or after `offset`, and that line's start byte. */
  lineStartingAtOrAfter(fd: number, offset: number): { byte: number; line: number } {
    if (offset <= 0) return { byte: 0, line: 1 }
    if (offset >= this.data.size) return { byte: this.data.size, line: this.data.nextLine }
    const [byte, startLine] = this.checkpointAtOrBefore((cp) => cp[0] <= offset)
    if (byte === offset) return { byte, line: startLine }
    const { endByte, nextLine } = countLines(fd, byte, offset, startLine, [])
    // countLines stops at the last line start inside [byte, offset); walk on to the next one.
    if (endByte === offset) return { byte: endByte, line: nextLine }
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES)
    let position = offset
    while (position < this.data.size) {
      const read = readSync(fd, chunk, 0, Math.min(CHUNK_BYTES, this.data.size - position), position)
      if (read <= 0) break
      const nl = chunk.indexOf(NEWLINE, 0)
      if (nl !== -1 && nl < read) return { byte: position + nl + 1, line: nextLine + 1 }
      position += read
    }
    return { byte: this.data.size, line: this.data.nextLine }
  }

  private checkpointAtOrBefore(match: (cp: [number, number]) => boolean): [number, number] {
    const cps = this.data.checkpoints
    let lo = 0
    let hi = cps.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (match(cps[mid])) lo = mid
      else hi = mid - 1
    }
    return cps[lo]
  }
}

/** Open `path` read-only for the duration of `fn`. */
export function withFileDescriptor<T>(path: string, fn: (fd: number) => T): T {
  const fd = openSync(path, 'r')
  try {
    return fn(fd)
  } finally {
    closeSync(fd)
  }
}
