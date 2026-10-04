/**
 * Paths a client may name inside a repository.
 *
 * A client path is repository-relative with forward slashes, the shape git
 * prints. It never leaves the working tree: no absolute path, no `.` / `..`
 * segment, nothing under `.git` (its config can hold remote credentials), and
 * no route out through a symlinked directory — checked against real paths
 * whenever the file system is touched.
 */

import { realpath } from 'fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'path'
import { GitError } from './errors'

const MAX_PATH_CHARS = 4_096
/** Paths one request may name (stage all, discard all). */
export const MAX_PATHS_PER_REQUEST = 20_000

/** Code points HFS+ ignores in names, so `.g\u200Cit` opens `.git` there. */
const IGNORED_IN_NAMES = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF]/g

function invalid(message: string): GitError {
  return new GitError('GIT_INVALID_ARGUMENT', message)
}

/**
 * Whether a name opens the `.git` directory on some file system: any case;
 * on Windows also with trailing dots or spaces, or as its 8.3 alias GIT~1.
 */
function namesGitDir(segment: string): boolean {
  const name = segment.replace(IGNORED_IN_NAMES, '').toLowerCase()
  if (name === '.git') return true
  if (process.platform !== 'win32') return false
  const trimmed = name.replace(/[. ]+$/, '')
  return trimmed === '.git' || /^git~\d+$/.test(trimmed)
}

/** Validate one repository-relative path; returns it unchanged. */
export function assertRepoPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw invalid('A repository path is required')
  if (value.length > MAX_PATH_CHARS) throw invalid('Path is too long')
  if (value.includes('\0')) throw invalid('Path contains a NUL character')
  if (value.startsWith('/') || isAbsolute(value) || /^[A-Za-z]:/.test(value)) throw invalid(`Not a repository-relative path: ${value}`)
  // Windows reads `\` as a separator and `:` as a stream or drive marker; git never prints either there.
  if (process.platform === 'win32' && /[\\:]/.test(value)) throw invalid(`Not a repository path: ${value}`)
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') throw invalid(`Not a normalized repository path: ${value}`)
    if (namesGitDir(segment)) throw invalid(`Paths inside .git are not served: ${value}`)
  }
  return value
}

/** Validate a list of paths: non-empty, bounded, duplicates dropped. */
export function assertRepoPathList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw invalid('At least one path is required')
  if (value.length > MAX_PATHS_PER_REQUEST) throw invalid(`At most ${MAX_PATHS_PER_REQUEST} paths per request`)
  return [...new Set(value.map(assertRepoPath))]
}

function isInside(base: string, target: string): boolean {
  const rel = relative(base, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Absolute location of a validated path in the working tree. The parent
 * directory is resolved through symlinks and must stay inside the repository;
 * the entry itself is not followed (git stores a symlink as its target text).
 * Returns null when the parent directory does not exist.
 */
export async function resolveWorktreePath(root: string, repoPath: string): Promise<string | null> {
  const absolute = join(root, ...repoPath.split('/'))
  let realParent: string
  try {
    realParent = await realpath(dirname(absolute))
  } catch {
    return null
  }
  if (!isInside(await realpath(root), realParent)) throw invalid(`Path leaves the repository: ${repoPath}`)
  return absolute
}

/** Split paths into argv-sized batches (Windows caps a command line at 32K characters). */
export function chunkPaths(paths: string[], maxChars = 24_000): string[][] {
  const chunks: string[][] = []
  let current: string[] = []
  let length = 0
  for (const path of paths) {
    if (current.length > 0 && length + path.length + 1 > maxChars) {
      chunks.push(current)
      current = []
      length = 0
    }
    current.push(path)
    length += path.length + 1
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}
