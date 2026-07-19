/**
 * Dot-segment version comparison shared by the publish pre-check (renderer)
 * and any main-process callers. Must stay in sync with the registry server's
 * version-monotonicity rule: segments compare numerically when both are
 * numeric ("1.0" == "1.0.0"), otherwise fall back to string comparison.
 */

const NUMERIC_RE = /^\d+$/

/** Returns <0 / 0 / >0 like a comparator. */
export function compareDotVersions(a: string, b: string): number {
  const as = a.trim().split('.')
  const bs = b.trim().split('.')
  const len = Math.max(as.length, bs.length)
  for (let i = 0; i < len; i++) {
    const sa = as[i] ?? '0'
    const sb = bs[i] ?? '0'
    if (NUMERIC_RE.test(sa) && NUMERIC_RE.test(sb)) {
      const diff = parseInt(sa, 10) - parseInt(sb, 10)
      if (diff !== 0) return diff
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1
    }
  }
  return 0
}

/** Suggest the next publishable version: bump the last segment by 1. */
export function suggestNextVersion(current: string): string {
  const segments = current.trim().split('.')
  const last = segments[segments.length - 1]
  if (!NUMERIC_RE.test(last)) return `${current.trim()}.1`
  segments[segments.length - 1] = String(parseInt(last, 10) + 1)
  return segments.join('.')
}
