/**
 * Deferral of the update prompt, remembered per version.
 *
 * A deferral lapses after a fixed span rather than at a calendar boundary, so
 * the hourly re-check brings the prompt back the same working day. It never
 * outranks the user: a check they start themselves clears it first.
 */

const STORAGE_KEY = 'halo-update-snooze'

export const UPDATE_SNOOZE_DURATION_MS = 6 * 60 * 60 * 1000

/**
 * Whether the prompt for `version` is currently deferred.
 *
 * Anything unreadable counts as not deferred — a stale or malformed record
 * (including the earlier date-based format) must never hide an update. An
 * expiry further out than one full span means the clock moved backwards, and
 * is treated the same way.
 */
export function isUpdateSnoozed(version: string, now: number = Date.now()): boolean {
  let raw: string | null
  try {
    raw = localStorage.getItem(STORAGE_KEY)
  } catch {
    return false
  }
  if (!raw) return false

  const separator = raw.lastIndexOf('|')
  if (separator <= 0 || raw.slice(0, separator) !== version) return false

  const expiresAt = Number(raw.slice(separator + 1))
  if (!Number.isFinite(expiresAt)) return false

  const remaining = expiresAt - now
  return remaining > 0 && remaining <= UPDATE_SNOOZE_DURATION_MS
}

export function snoozeUpdate(version: string, now: number = Date.now()): void {
  try {
    localStorage.setItem(STORAGE_KEY, `${version}|${now + UPDATE_SNOOZE_DURATION_MS}`)
  } catch {
    /* private mode or quota — deferral just does not persist */
  }
}

export function clearUpdateSnooze(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* storage unavailable — nothing was persisted to clear */
  }
}
