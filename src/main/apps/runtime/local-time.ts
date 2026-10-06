/**
 * Local time as `YYYY-MM-DD HH:mm`, for times written into text the model and
 * the person read — run titles, reminders: unambiguous inside an English
 * sentence, whatever the OS locale.
 */
export function formatLocalTime(epochMs: number): string {
  const date = new Date(epochMs)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
