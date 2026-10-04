/**
 * Matching repository paths against what the user types in the file panel
 * filter, and against the generated-file patterns.
 *
 * A query with `*` or `?` is a glob: `**` crosses directories, `*` and `?` do
 * not. A glob without a slash matches the file name at any depth (`*.md`), one
 * with a slash matches the whole path (`src/**`). Anything else is a
 * case-insensitive substring of the path.
 */

import { baseName } from './paths'

const regexCache = new Map<string, RegExp>()
const MAX_CACHED_PATTERNS = 64

export function isGlob(pattern: string): boolean {
  return /[*?]/.test(pattern)
}

/** Anchored regular expression for a glob over forward-slashed paths. */
export function globToRegExp(glob: string): RegExp {
  const cached = regexCache.get(glob)
  if (cached) return cached
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++
        // `**/` also matches no directory at all: `src/**/x.ts` matches `src/x.ts`.
        if (glob[i + 1] === '/') {
          i++
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
    } else if (ch === '?') {
      source += '[^/]'
    } else {
      source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  const regex = new RegExp(`^${source}$`)
  if (regexCache.size >= MAX_CACHED_PATTERNS) regexCache.clear()
  regexCache.set(glob, regex)
  return regex
}

/** Whether `path` (repository-relative) matches the glob `pattern`. */
export function matchesGlob(path: string, pattern: string): boolean {
  const glob = pattern.startsWith('/') ? pattern.slice(1) : pattern
  if (!glob.includes('/')) return globToRegExp(glob).test(baseName(path))
  // A trailing slash names a directory: everything under it.
  return globToRegExp(glob.endsWith('/') ? `${glob}**` : glob).test(path)
}

/** Whether `path` passes the panel filter `query`. */
export function matchesFilter(path: string, query: string): boolean {
  const q = query.trim()
  if (!q) return true
  if (isGlob(q)) return matchesGlob(path, q)
  return path.toLowerCase().includes(q.toLowerCase())
}
