/**
 * Matching and ranking of workspace paths against a typed file query (the @
 * menu). Runs where the path index lives — the file-watcher worker — so the
 * renderer only ever receives the top few results.
 *
 * Pure string logic: no Node or Electron imports (shared-module constraint).
 */

export function normalizePathLike(value: string): string {
  return value.replace(/\\/g, '/').trim().toLowerCase()
}

/**
 * Whether a path matches the query: a substring of the whole path, or each
 * query segment a prefix of the corresponding leading path segment
 * (`sr/co` matches `src/components/...`). Both arguments must be normalized.
 */
export function matchesNormalizedPath(normalizedPath: string, normalizedQuery: string): boolean {
  return matchesQuery(normalizedPath, normalizedQuery, querySegments(normalizedQuery))
}

function querySegments(normalizedQuery: string): string[] {
  return normalizedQuery.split('/').filter(Boolean)
}

// Hot loop over every indexed path: no per-path allocation.
function matchesQuery(normalizedPath: string, normalizedQuery: string, segments: string[]): boolean {
  if (!normalizedQuery) return true
  if (normalizedPath.includes(normalizedQuery)) return true
  if (segments.length === 0) return true
  let at = 0
  for (const segment of segments) {
    while (normalizedPath.charCodeAt(at) === 47 /* '/' */) at++
    if (at >= normalizedPath.length || !normalizedPath.startsWith(segment, at)) return false
    const next = normalizedPath.indexOf('/', at)
    at = next === -1 ? normalizedPath.length : next
  }
  return true
}

/** Lower is better. Both arguments must be normalized. */
export function scorePathMatch(
  normalizedPath: string,
  normalizedName: string,
  isFolder: boolean,
  normalizedQuery: string
): number {
  if (!normalizedQuery) return isFolder ? 0 : 1
  if (normalizedPath === normalizedQuery || normalizedName === normalizedQuery) return 0
  if (normalizedPath.startsWith(normalizedQuery)) return 1
  if (normalizedName.startsWith(normalizedQuery)) return 2
  if (normalizedPath.includes(normalizedQuery)) return 3
  return 10
}

export interface RankablePath {
  /** Path relative to the workspace root, as displayed and inserted. */
  relativePath: string
  /** `normalizePathLike(relativePath)`, precomputed once per entry. */
  normalized: string
  isFolder: boolean
}

function nameOf(normalized: string): string {
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

// Same order as String#localeCompare with the default locale, without its
// per-call setup cost.
const collator = new Intl.Collator()

interface Ranked<T> {
  entry: T
  score: number
  /** Arrival order: equal keys keep the first-seen entry. */
  seq: number
}

/** Negative when `a` ranks before `b`. */
function compareRanked<T extends RankablePath>(a: Ranked<T>, b: Ranked<T>): number {
  if (a.score !== b.score) return a.score - b.score
  if (a.entry.isFolder !== b.entry.isFolder) return a.entry.isFolder ? -1 : 1
  return collator.compare(a.entry.relativePath, b.entry.relativePath) || a.seq - b.seq
}

/**
 * The best `limit` matches, ordered by score, then folders first, then path.
 * A bounded heap keeps the worst kept match on top, so the cost is
 * O(n log limit) and the final sort touches only what is returned.
 */
export function rankPaths<T extends RankablePath>(entries: Iterable<T>, query: string, limit: number): T[] {
  if (limit <= 0) return []
  const normalizedQuery = normalizePathLike(query)
  const segments = querySegments(normalizedQuery)
  // Max-heap by rank: heap[0] is the worst match kept so far.
  const heap: Array<Ranked<T>> = []
  const worse = (i: number, j: number): boolean => compareRanked(heap[i], heap[j]) > 0
  const swap = (i: number, j: number): void => { const t = heap[i]; heap[i] = heap[j]; heap[j] = t }
  const siftDown = (i: number): void => {
    for (;;) {
      const l = 2 * i + 1
      const r = l + 1
      let top = i
      if (l < heap.length && worse(l, top)) top = l
      if (r < heap.length && worse(r, top)) top = r
      if (top === i) return
      swap(i, top)
      i = top
    }
  }

  let seq = 0
  for (const entry of entries) {
    if (!matchesQuery(entry.normalized, normalizedQuery, segments)) continue
    const candidate: Ranked<T> = {
      entry,
      score: scorePathMatch(entry.normalized, nameOf(entry.normalized), entry.isFolder, normalizedQuery),
      seq: seq++,
    }
    if (heap.length < limit) {
      heap.push(candidate)
      let i = heap.length - 1
      while (i > 0) {
        const parent = (i - 1) >> 1
        if (!worse(i, parent)) break
        swap(i, parent)
        i = parent
      }
    } else if (compareRanked(candidate, heap[0]) < 0) {
      heap[0] = candidate
      siftDown(0)
    }
  }
  return heap.sort(compareRanked).map(item => item.entry)
}
