/**
 * Numbers, sizes, times and durations as the changes view shows them, in the
 * UI language through Intl.
 */

export function formatCount(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value)
}

/** Token counts read better rounded: 38,412 → "38K". */
export function formatCompact(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

const BYTE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const

export function formatBytes(bytes: number, locale: string): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit++
  }
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: BYTE_UNITS[unit],
    unitDisplay: 'short',
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value)
}

/** A clock time today, or a date and time otherwise. */
export function formatTime(timestamp: number, locale: string, now = Date.now()): string {
  const date = new Date(timestamp)
  const today = new Date(now)
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate()
  return new Intl.DateTimeFormat(locale, sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}

/** 102,000 ms → "1 min 42 sec" in the locale's own unit words. */
export function formatDuration(ms: number, locale: string): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const unit = (value: number, name: 'hour' | 'minute' | 'second') =>
    new Intl.NumberFormat(locale, { style: 'unit', unit: name, unitDisplay: 'short' }).format(value)
  if (hours > 0) return `${unit(hours, 'hour')} ${unit(minutes, 'minute')}`
  if (minutes > 0) return seconds > 0 ? `${unit(minutes, 'minute')} ${unit(seconds, 'second')}` : unit(minutes, 'minute')
  return unit(seconds, 'second')
}
