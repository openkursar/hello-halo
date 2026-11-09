/**
 * When a provider says a limit will lift.
 *
 * Providers announce it in several dialects: seconds or a date in
 * `retry-after`, milliseconds in `retry-after-ms`, and a reset time that is a
 * timestamp (Anthropic), a duration such as `6m0s` (OpenAI), a number of
 * seconds, or an epoch. Anything unreadable or already past counts as nothing
 * announced.
 */

const DURATION_PART = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g
const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/** Epoch values: above this many ms it is already in milliseconds, above this many seconds in seconds. */
const EPOCH_MS_FLOOR = 1e12
const EPOCH_SECONDS_FLOOR = 1e9

function isResetHeader(name: string): boolean {
  return name === 'ratelimit-reset' || name === 'x-ratelimit-reset' ||
    /^x-ratelimit-reset-/.test(name) || /^x-ratelimit-.+-reset$/.test(name) ||
    /^anthropic-ratelimit-.+-reset$/.test(name)
}

/** A duration like "6m0s" or "1.5s", in ms; null when the text is not one. */
function parseDuration(text: string): number | null {
  const compact = text.replace(/\s+/g, '')
  if (!compact) return null
  let total = 0
  let consumed = 0
  for (const part of compact.matchAll(DURATION_PART)) {
    total += Number(part[1]) * UNIT_MS[part[2]]
    consumed += part[0].length
  }
  return consumed === compact.length ? total : null
}

/** The instant a reset value stands for, in epoch ms. */
function parseReset(value: string, now: number): number | null {
  const text = value.trim()
  if (!text) return null
  if (/^\d+(\.\d+)?$/.test(text)) {
    const n = Number(text)
    if (n >= EPOCH_MS_FLOOR) return n
    if (n >= EPOCH_SECONDS_FLOOR) return n * 1_000
    return now + n * 1_000
  }
  const duration = parseDuration(text)
  if (duration !== null) return now + duration
  const date = Date.parse(text)
  return Number.isFinite(date) ? date : null
}

/** The instant announced by `retry-after`, in epoch ms. */
function parseRetryAfter(value: string, now: number): number | null {
  const text = value.trim()
  if (/^\d+(\.\d+)?$/.test(text)) return now + Number(text) * 1_000
  const date = Date.parse(text)
  return Number.isFinite(date) ? date : null
}

/**
 * The latest instant any header announces, in epoch ms, or null when none does
 * (or all lie in the past). The caller bounds it.
 */
export function parseAnnouncedUntil(headers: Readonly<Record<string, string>>, now: number): number | null {
  let latest: number | null = null
  const consider = (instant: number | null) => {
    if (instant === null || !Number.isFinite(instant) || instant <= now) return
    if (latest === null || instant > latest) latest = instant
  }
  for (const [rawName, value] of Object.entries(headers)) {
    if (typeof value !== 'string') continue
    const name = rawName.toLowerCase()
    if (name === 'retry-after-ms') {
      const ms = Number(value.trim())
      consider(Number.isFinite(ms) && ms >= 0 ? now + ms : null)
    } else if (name === 'retry-after') {
      consider(parseRetryAfter(value, now))
    } else if (isResetHeader(name)) {
      consider(parseReset(value, now))
    }
  }
  return latest
}
