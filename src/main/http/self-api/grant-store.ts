import { createHash, randomBytes } from 'crypto'

export interface SelfApiGrantRequest {
  method: string
  path: string
  /** Checked on each matching request; a denial or exception permanently revokes the grant. */
  validate?: () => string | undefined
}

export interface SelfApiGrant {
  token: string
  /** Unix time in milliseconds. */
  expiresAt: number
}

interface GrantEntry extends SelfApiGrantRequest {
  expiresAt: number
}

export type GrantResolution =
  | { decision: 'allowed' }
  | { decision: 'unavailable' | 'mismatch' }
  | { decision: 'invalid'; reason?: string }

export const SELF_API_GRANT_PREFIX = 'halo-grant-'
const GRANT_TTL_MS = 24 * 60 * 60 * 1000
const MAX_GRANTS = 2048

// Hash keys avoid indexing the map by any attacker-controlled token prefix.
// Insertion order provides oldest-issued eviction, never extended by use.
const grants = new Map<string, GrantEntry>()

function grantKey(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function isLiteralApiPath(path: string): boolean {
  if (!path.startsWith('/api/')) return false
  try {
    return path.slice(5).split('/').every((segment) => {
      const decoded = decodeURIComponent(segment)
      return decoded.length > 0 && decoded !== '.' && !decoded.includes('..') &&
        !/[\\/?#%:*()[\]{}\s\u0000-\u001f\u007f]/u.test(decoded) &&
        encodeURIComponent(decoded) === segment
    })
  } catch {
    return false
  }
}

function makeRoom(now: number): void {
  if (grants.size < MAX_GRANTS) return

  let expired = 0
  let evicted = 0
  for (const [key, entry] of grants) {
    if (now >= entry.expiresAt) {
      grants.delete(key)
      expired++
    }
  }
  while (grants.size >= MAX_GRANTS) {
    grants.delete(grants.keys().next().value!)
    evicted++
  }
  console.warn('[SelfApi] grant-prune: discarded temporary grants', { expired, evicted, remaining: grants.size })
}

/** Issues memory-only, multi-use access to one literal action for at most 24 hours. */
export function issueSelfApiGrant(request: SelfApiGrantRequest): SelfApiGrant {
  const { method, path, validate } = request
  if (typeof method !== 'string' || !method || /[^A-Z]/.test(method) ||
      typeof path !== 'string' || !isLiteralApiPath(path) ||
      (validate !== undefined && typeof validate !== 'function')) {
    console.warn('[SelfApi] grant-issue: refused a non-literal method/path or invalid validator')
    throw new Error('A self-API grant requires an uppercase method, a canonical literal /api/ path without query or fragment, and an optional synchronous validator.')
  }

  const now = Date.now()
  makeRoom(now)
  const token = SELF_API_GRANT_PREFIX + randomBytes(32).toString('hex')
  const expiresAt = now + GRANT_TTL_MS
  grants.set(grantKey(token), { method, path, validate, expiresAt })
  return { token, expiresAt }
}

export function resolveSelfApiGrant(token: string, method: string, path: string): GrantResolution {
  const key = grantKey(token)
  const entry = grants.get(key)
  if (!entry) {
    console.warn('[SelfApi] grant-auth: refused an unknown or revoked temporary grant')
    return { decision: 'unavailable' }
  }
  if (Date.now() >= entry.expiresAt) {
    grants.delete(key)
    console.warn('[SelfApi] grant-expiry: revoked expired grant', { method: entry.method, path: entry.path })
    return { decision: 'unavailable' }
  }
  if (entry.method !== method || entry.path !== path) {
    console.warn('[SelfApi] grant-auth: refused a request outside the invited action', { method: entry.method, path: entry.path })
    return { decision: 'mismatch' }
  }

  let reason: unknown
  try {
    reason = entry.validate?.()
  } catch {
    grants.delete(key)
    // Callback errors can contain credentials or action payloads; log only the stage and target.
    console.warn('[SelfApi] grant-validate: validator threw; revoked grant', { method: entry.method, path: entry.path })
    return { decision: 'invalid' }
  }
  if (reason !== undefined) {
    grants.delete(key)
    console.warn('[SelfApi] grant-validate: validator denied or returned an invalid result; revoked grant', { method: entry.method, path: entry.path })
    // An invalid async validator must not leave an unhandled rejection after revocation.
    if (reason instanceof Promise) void reason.catch(() => {})
    return { decision: 'invalid', ...(typeof reason === 'string' ? { reason } : {}) }
  }
  return { decision: 'allowed' }
}

/** Test-only: simulates losing all grants on process restart. */
export function resetSelfApiGrants(): void {
  grants.clear()
}
