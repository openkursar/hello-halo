/**
 * Time formatting shared across the renderer.
 *
 * `t` is injected rather than imported so these stay plain functions and never
 * pin a language at module load.
 */

type Translate = (key: string, options?: Record<string, unknown>) => string

/**
 * A future timestamp reads as "just now": clocks across the machines in one
 * office are never exactly aligned, so a member's event can legitimately carry a
 * stamp ahead of this one.
 */
export function formatTimeAgo(timestamp: number, t: Translate): string {
  const diff = Date.now() - timestamp
  if (diff <= 0) return t('just now')
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return t('just now')
  if (mins < 60) return t('{{count}}m ago', { count: mins })
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return t('{{count}}h ago', { count: hrs })
  const days = Math.floor(hrs / 24)
  return t('{{count}}d ago', { count: days })
}
