/** Invalid timestamps stay unknown; they must not acquire a fabricated date. */
export function taskTime(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !value.trim()) return null
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : null
}

export function compareTaskTimes(left: unknown, right: unknown, descending = false): number {
  const a = taskTime(left)
  const b = taskTime(right)
  if (a === null) return b === null ? 0 : 1
  return b === null ? -1 : descending ? b - a : a - b
}
