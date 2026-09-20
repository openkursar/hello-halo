/**
 * Shared relative-time / elapsed-time formatters for anything showing "when
 * did this last run" or "how long has this been running" — the automation
 * detail header, its card-wall equivalent, the overview tab, and the task
 * panel's running items all need the identical wording/format.
 */

/**
 * "just now" / "{{count}}m ago" / "{{count}}h ago" / "{{count}}d ago".
 *
 * A future timestamp reads as "just now": clocks across the machines in one
 * office are never exactly aligned, so a member's event can legitimately carry
 * a stamp ahead of this one.
 */
export function formatTimeAgo(timestamp: number, t: (s: string, opts?: Record<string, unknown>) => string): string {
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

/** mm:ss for under an hour, h:mm:ss past that — running tasks rarely run long. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}
