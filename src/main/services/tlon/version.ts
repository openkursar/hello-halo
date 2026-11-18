/**
 * Content version of a watched folder.
 *
 * A folder published by a sync job can say which version it holds, so the
 * document map and citations can name it. Read, in order, from:
 *   1. `<folder>/VERSION.md` — its first non-empty line (heading marks stripped);
 *   2. the git repository enclosing the folder — the short commit of HEAD.
 * Undefined when neither is found. Plain file reads; no git binary.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'fs'
import { dirname, isAbsolute, join, resolve } from 'path'

const VERSION_FILE = 'VERSION.md'
const VERSION_MAX_LEN = 80
const SHORT_SHA_LEN = 12

export function resolveFolderVersion(folder: string): string | undefined {
  let dir: string
  try {
    dir = realpathSync(folder)
  } catch {
    return undefined
  }
  return readVersionFile(dir) ?? readGitHead(dir)
}

function readVersionFile(dir: string): string | undefined {
  const file = join(dir, VERSION_FILE)
  if (!existsSync(file)) return undefined
  try {
    for (const raw of readFileSync(file, 'utf-8').split('\n')) {
      const line = raw.replace(/^#+\s*/, '').trim()
      if (line) return line.length > VERSION_MAX_LEN ? line.slice(0, VERSION_MAX_LEN) : line
    }
  } catch { /* unreadable: fall through to git */ }
  return undefined
}

/** Walk up from `dir` to the first `.git`, then resolve HEAD to a short commit. */
function readGitHead(dir: string): string | undefined {
  let cur = dir
  for (;;) {
    const gitDir = resolveGitDir(join(cur, '.git'))
    if (gitDir) return headSha(gitDir)
    const parent = dirname(cur)
    if (parent === cur) return undefined
    cur = parent
  }
}

/** `.git` is a directory, or (worktree / submodule) a file holding `gitdir: <path>`. */
function resolveGitDir(dotGit: string): string | undefined {
  try {
    const st = statSync(dotGit)
    if (st.isDirectory()) return dotGit
    if (st.isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf-8'))
      if (!m) return undefined
      const target = m[1].trim()
      return isAbsolute(target) ? target : resolve(dirname(dotGit), target)
    }
  } catch { /* not there */ }
  return undefined
}

function headSha(gitDir: string): string | undefined {
  let head: string
  try {
    head = readFileSync(join(gitDir, 'HEAD'), 'utf-8').trim()
  } catch {
    return undefined
  }
  const ref = /^ref:\s*(.+)$/.exec(head)
  if (!ref) return isSha(head) ? head.slice(0, SHORT_SHA_LEN) : undefined
  const refName = ref[1].trim()
  if (!/^refs\/[\w./-]+$/.test(refName) || refName.split('/').includes('..')) return undefined
  const sha = readRef(gitDir, refName)
  return sha ? sha.slice(0, SHORT_SHA_LEN) : undefined
}

/** A ref is loose under the git dir or in packed-refs; a worktree's shared refs live in its commondir. */
function readRef(gitDir: string, refName: string): string | undefined {
  const dirs = [gitDir]
  try {
    const common = readFileSync(join(gitDir, 'commondir'), 'utf-8').trim()
    if (common) dirs.push(isAbsolute(common) ? common : resolve(gitDir, common))
  } catch { /* not a linked worktree */ }
  for (const d of dirs) {
    try {
      const sha = readFileSync(join(d, refName), 'utf-8').trim()
      if (isSha(sha)) return sha
    } catch { /* not loose here */ }
    try {
      for (const line of readFileSync(join(d, 'packed-refs'), 'utf-8').split('\n')) {
        const [sha, name] = line.trim().split(/\s+/)
        if (name === refName && isSha(sha)) return sha
      }
    } catch { /* no packed-refs */ }
  }
  return undefined
}

function isSha(s: string | undefined): s is string {
  return !!s && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(s)
}
