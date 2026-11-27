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

const TIME_OPTIONS = { hour: '2-digit', minute: '2-digit' } as const
const DAY_OPTIONS = { month: '2-digit', day: '2-digit' } as const

interface DayTimeFormat { time: Intl.DateTimeFormat; day: Intl.DateTimeFormat }

/**
 * A formatter keeps the time zone it was built in. Reading the system's zone
 * costs as much as building a formatter, so the rows of one render share a
 * check, and a change of zone applies within this long.
 */
const ZONE_RECHECK_MS = 1_000
let zoneCheckedAt = Number.NEGATIVE_INFINITY
let builtForZone: string | undefined
const formatsByLocale = new Map<string | undefined, DayTimeFormat>()

/** Building a formatter costs far more than using one, and a list formats a time per row. */
function dayTimeFormat(locale: string | undefined): DayTimeFormat {
  const checkAt = Date.now()
  // A clock set back would otherwise postpone the next check by as much.
  if (checkAt - zoneCheckedAt >= ZONE_RECHECK_MS || checkAt < zoneCheckedAt) {
    zoneCheckedAt = checkAt
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone
    if (zone !== builtForZone) {
      formatsByLocale.clear()
      builtForZone = zone
    }
  }
  let format = formatsByLocale.get(locale)
  if (!format) {
    format = { time: new Intl.DateTimeFormat(locale, TIME_OPTIONS), day: new Intl.DateTimeFormat(locale, DAY_OPTIONS) }
    formatsByLocale.set(locale, format)
  }
  return format
}

/**
 * When a run started or a message arrived, the one way every list says it: the
 * time alone for today, the month and day before it otherwise. `locale`
 * defaults to the system's.
 */
export function formatRunStart(timestamp: number, now = Date.now(), locale?: string): string {
  const date = new Date(timestamp)
  // A formatter throws on an unreadable time, which reads "Invalid Date" as it always has.
  const format = Number.isNaN(date.getTime()) ? null : dayTimeFormat(locale)
  const time = format ? format.time.format(date) : date.toLocaleTimeString(locale, TIME_OPTIONS)
  if (new Date(now).toDateString() === date.toDateString()) return time
  return `${format ? format.day.format(date) : date.toLocaleDateString(locale, DAY_OPTIONS)} ${time}`
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
