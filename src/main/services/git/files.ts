/**
 * Facts about changed files that git does not print: line counts of untracked
 * files, binary detection, and the `linguist-generated` attribute.
 */

import { lstat, open, readFile } from 'fs/promises'
import { join } from 'path'
import type { GitChangedFile } from '../../../shared/types/git'
import { readText, type RepoContext } from './context'
import { isAttributeSet, parseCheckAttr } from './parse'

/** Same sniff window git uses to call a file binary. */
const BINARY_SNIFF_BYTES = 8_000
/** Untracked files larger than this are not line-counted. */
const COUNT_FILE_MAX_BYTES = 1024 * 1024
/** Bytes read for line counts in one listing, so a folder of generated files costs a bounded read. */
const COUNT_BUDGET_BYTES = 16 * 1024 * 1024
const READ_CONCURRENCY = 8

export function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)
}

/** Lines as git counts them: a last line without a newline still counts. */
export function countLines(buffer: Buffer): number {
  if (buffer.length === 0) return 0
  let lines = 0
  for (let i = buffer.indexOf(10); i !== -1; i = buffer.indexOf(10, i + 1)) lines++
  return buffer[buffer.length - 1] === 10 ? lines : lines + 1
}

async function readHead(file: string, bytes: number): Promise<Buffer> {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

export interface UntrackedMeasure {
  additions: number | null
  binary: boolean
}

/**
 * Line counts and binary flags of untracked files, read from the working tree.
 * Files over the per-file size or past the listing budget keep a null count.
 */
export async function measureUntracked(root: string, paths: string[]): Promise<Map<string, UntrackedMeasure>> {
  const result = new Map<string, UntrackedMeasure>()
  let budget = COUNT_BUDGET_BYTES
  let unreadable = 0

  const measure = async (path: string): Promise<UntrackedMeasure> => {
    const file = join(root, ...path.split('/'))
    try {
      const info = await lstat(file)
      // git stores a symlink as its target text: one line, no newline.
      if (info.isSymbolicLink()) return { additions: 1, binary: false }
      if (!info.isFile()) return { additions: null, binary: false }
      if (info.size === 0) return { additions: 0, binary: false }
      if (info.size > COUNT_FILE_MAX_BYTES || info.size > budget) {
        return { additions: null, binary: isBinary(await readHead(file, BINARY_SNIFF_BYTES)) }
      }
      budget -= info.size
      const content = await readFile(file)
      return isBinary(content) ? { additions: null, binary: true } : { additions: countLines(content), binary: false }
    } catch {
      unreadable++
      return { additions: null, binary: false }
    }
  }

  for (let i = 0; i < paths.length; i += READ_CONCURRENCY) {
    const batch = paths.slice(i, i + READ_CONCURRENCY)
    const measures = await Promise.all(batch.map(measure))
    batch.forEach((path, j) => result.set(path, measures[j]))
  }
  if (unreadable > 0) console.warn(`[Git] ${unreadable} untracked file(s) in ${root} could not be read for line counts`)
  return result
}

/** An untracked entry for a file git listed but did not count. */
export function untrackedFile(path: string, measure: UntrackedMeasure | undefined): GitChangedFile {
  return {
    path,
    state: 'untracked',
    additions: measure?.additions ?? null,
    deletions: measure?.additions === null || measure === undefined ? null : 0,
    binary: measure?.binary ?? false,
  }
}

/**
 * Untracked entries ending in `/` are nested repositories git will not look
 * into. They are not files of this repository: the space lists them as
 * repositories of their own, and acting on one (discard!) would hit a whole
 * project.
 */
export function isNestedRepositoryEntry(path: string): boolean {
  return path.endsWith('/')
}

/** Flag files `.gitattributes` marks `linguist-generated`. A failed lookup leaves them unflagged. */
export async function markGenerated(ctx: RepoContext, files: GitChangedFile[]): Promise<void> {
  if (files.length === 0) return
  const paths = [...new Set(files.map((file) => file.path))]
  try {
    const output = await readText(ctx, ['check-attr', '-z', '--stdin', 'linguist-generated'], { stdin: `${paths.join('\0')}\0` })
    const values = parseCheckAttr(output)
    for (const file of files) {
      if (isAttributeSet(values.get(file.path))) file.generated = true
    }
  } catch (error) {
    console.warn(`[Git] Could not read linguist-generated attributes in ${ctx.root}: ${(error as Error).message.split('\n')[0]}`)
  }
}
