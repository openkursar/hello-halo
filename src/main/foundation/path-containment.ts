/**
 * Path containment: where a path argument points, and whether that is inside a
 * folder. The one comparison form for every file boundary Halo draws around an
 * agent — the memory write guard, a consolidation's private workspace, and a
 * restricted turn's file access — so no two of them can disagree.
 *
 * Pure path logic on top of `fs.realpath`; no knowledge of who asks or why.
 */

import { realpathSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join, resolve, sep } from 'path'

const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32'

/**
 * A path argument of a file tool, resolved the way the agent engines resolve it
 * when they run the tool: trimmed, `~` and `~/…` expanded to the home folder
 * (the Claude engine does this; the Halo engine takes `~` literally, which only
 * ever lands inside `cwd`, so expanding is the stricter reading), `/c/…` read
 * as a drive on Windows, anything else relative to `cwd`. Neither engine
 * expands environment variables, so `$HOME` stays a literal folder name.
 */
export function resolveToolPath(raw: string, cwd: string): string {
  const p = raw.trim()
  if (!p) return resolve(cwd).normalize('NFC')
  if (p === '~') return homedir().normalize('NFC')
  if (p.startsWith('~/') || (process.platform === 'win32' && p.startsWith('~\\'))) {
    return join(homedir(), p.slice(2)).normalize('NFC')
  }
  let q = p
  if (process.platform === 'win32' && /^\/[a-z]\//i.test(p)) q = `${p[1].toUpperCase()}:\\${p.slice(3)}`
  return resolve(cwd, q).normalize('NFC')
}

/**
 * A path as the filesystem sees it, lowercased where the filesystem ignores
 * case: the comparison form. See {@link physicalPath}.
 */
export function canonicalPath(p: string): string {
  const abs = physicalPath(p)
  return CASE_INSENSITIVE_FS ? abs.toLowerCase() : abs
}

/**
 * A path with its links resolved, spelled as on disk — the form to hand an
 * engine so it runs, and prints, the very path that was judged. A path not
 * created yet resolves through its nearest existing ancestor, so a link higher
 * up cannot smuggle it out.
 */
export function physicalPath(p: string): string {
  let head = resolve(p)
  let tail = ''
  for (;;) {
    try {
      head = realpathSync.native(head)
      break
    } catch {
      const parent = dirname(head)
      if (parent === head) break
      tail = tail ? join(basename(head), tail) : basename(head)
      head = parent
    }
  }
  return tail ? join(head, tail) : head
}

/** Whether `target` is `root` or below it. Both are canonicalised. */
export function isPathWithin(target: string, root: string): boolean {
  return isCanonicalWithin(canonicalPath(target), canonicalPath(root))
}

/** The same test for paths already passed through {@link canonicalPath}. */
export function isCanonicalWithin(target: string, root: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * The directory a glob pattern can reach: its fixed prefix up to the last
 * separator before the first wildcard, resolved against `base`. `a/b*` reaches
 * all of `a/`, not only names starting with `a/b` — cutting at the wildcard
 * itself would let `memory*` slip past a check on `memory/`.
 */
export function globSearchRoot(pattern: string, base: string): string {
  const firstWildcard = pattern.search(/[*?[{]/)
  const fixed = firstWildcard === -1 ? pattern : pattern.slice(0, firstWildcard)
  const lastSep = Math.max(fixed.lastIndexOf('/'), fixed.lastIndexOf('\\'))
  const dir = firstWildcard === -1 ? fixed : lastSep === -1 ? '' : fixed.slice(0, lastSep + 1)
  return resolveToolPath(dir || '.', base)
}
