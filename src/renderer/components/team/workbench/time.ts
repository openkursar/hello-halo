/** Invalid timestamps stay unknown; they must not acquire a fabricated date. */
export function taskTime(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !value.trim()) return null
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : null
}

/** A length of time in whole minutes, hours and days, the way people say it. */
export function formatSpan(ms: number, t: (key: string, options?: Record<string, unknown>) => string): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return t('under a minute')
  if (minutes < 60) return t('{{count}} min', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? t('{{hours}} h {{minutes}} min', { hours, minutes: minutes % 60 }) : t('{{count}} h', { count: hours })
  const days = Math.floor(hours / 24)
  return hours % 24 ? t('{{days}} d {{hours}} h', { days, hours: hours % 24 }) : t('{{count}} d', { count: days })
}

export function compareTaskTimes(left: unknown, right: unknown, descending = false): number {
  const a = taskTime(left)
  const b = taskTime(right)
  if (a === null) return b === null ? 0 : 1
  return b === null ? -1 : descending ? b - a : a - b
}
