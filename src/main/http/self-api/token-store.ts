/**
 * In-memory credentials for the self-API loopback listener. Deliberately
 * separate from `http/auth/token-store.ts` (the remote-access credential):
 * the two must never accept each other's token, so keeping them as
 * independent modules with independent state makes that a structural
 * property instead of a rule someone could accidentally violate.
 *
 * Each token carries the spaceId it was issued for. That is a **default
 * scope, not a trust boundary**: it lets the auth middleware fill in "this
 * session's own space" for a request that names none, so the agent reads and
 * lists the space it is actually working in. It confines nothing by itself —
 * most exposed routes address a resource by a global id and never consult a
 * space at all. What actually bounds a session is which routes `scope.json`
 * exposes; do not build an isolation guarantee on top of this field.
 *
 * Never persisted — there is nothing to pair with and nothing to survive a
 * restart for.
 */

import { randomBytes, timingSafeEqual } from 'crypto'

interface TokenEntry {
  token: string
  spaceId: string
}

const tokens: TokenEntry[] = []

/**
 * One token per space, reused for the life of the process.
 *
 * Reuse rather than a fresh token per call because a token carries nothing but
 * its spaceId: two sessions in the same space resolve to identical authority,
 * so minting a second one adds no distinction — only another permanently valid
 * credential and another entry on the auth path's linear scan. Callers hit this
 * on every message and every session warm-up, so per-call issuance grew the
 * store with conversation volume.
 *
 * Reuse is also what makes the store bounded without eviction: a warm session
 * holds its token inside an already-spawned process env, and handing it back
 * the same value keeps it valid, which naive expiry would not.
 */
export function issueSelfApiToken(spaceId: string): string {
  const existing = tokens.find((entry) => entry.spaceId === spaceId)
  if (existing) return existing.token

  const token = randomBytes(32).toString('hex')
  tokens.push({ token, spaceId })
  return token
}

/** Test-only: drop every issued token so isolation tests don't leak state across cases. */
export function resetSelfApiTokens(): void {
  tokens.length = 0
}

/**
 * Constant-time lookup: a plain `Map.get(candidate)` would resolve in time
 * proportional to how much of a guess matches a real token's hash bucket,
 * which is exactly the timing side-channel `timingSafeEqual` exists to
 * close. Comparing against every issued token keeps each comparison
 * constant-time.
 *
 * The scan is linear, which is only acceptable because issuance is bounded to
 * one entry per space (see `issueSelfApiToken`). It was once one per call —
 * i.e. per message — which made this grow with conversation volume.
 */
export function resolveSelfApiToken(candidate: string): { spaceId: string } | null {
  if (typeof candidate !== 'string') return null
  const provided = Buffer.from(candidate, 'utf8')

  for (const entry of tokens) {
    const expected = Buffer.from(entry.token, 'utf8')
    if (expected.length !== provided.length) {
      const padded = Buffer.alloc(expected.length)
      provided.copy(padded, 0, 0, Math.min(provided.length, padded.length))
      timingSafeEqual(expected, padded)
      continue
    }
    if (timingSafeEqual(expected, provided)) {
      return { spaceId: entry.spaceId }
    }
  }
  return null
}
