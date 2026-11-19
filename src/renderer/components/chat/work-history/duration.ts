/** How long a reply worked, in the unit a person would say it in. Undefined under a second. */
export function formatWorkDuration(
  seconds: number | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 1) return undefined
  if (seconds < 60) return t('{{count}} sec', { count: Math.round(seconds) })
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t('{{count}} min', { count: minutes })
  return t('{{hours}} h {{minutes}} min', { hours: Math.floor(minutes / 60), minutes: minutes % 60 })
}
