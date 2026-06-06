/**
 * In-memory remote-access credential store.
 *
 * Holds the plaintext credential so the UI can keep showing it and so
 * `validateToken` can run a timing-safe compare against a known value.
 * Persistence is handled by remote.service via {@link encodeForStorage}
 * — this module stays unaware of the config layer.
 */

import { randomInt, timingSafeEqual } from 'crypto'

import { validatePassword } from './password-policy'
import { decodeFromStorage } from '../../foundation/crypto-envelope'

let accessToken: string | null = null

/**
 * Generate a fresh 12-character token that satisfies the same complexity
 * policy as user-chosen passwords (one of each character class). The
 * primary delivery path is QR scan; the few characters added over the
 * legacy 6-digit PIN keep the value still easy to copy/paste.
 *
 * Construction guarantees four-class coverage by reserving one slot per
 * class and then filling the rest from the union; a Fisher-Yates shuffle
 * removes positional bias before the value is exposed.
 */
const TOKEN_LENGTH = 12
const TOKEN_UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ' // no I, O
const TOKEN_LOWER = 'abcdefghijkmnpqrstuvwxyz' // no l, o
const TOKEN_DIGIT = '23456789' // no 0, 1
const TOKEN_SPECIAL = '!@#$%^&*-_=+' // keyboard-easy printable ASCII specials
const TOKEN_ALL = TOKEN_UPPER + TOKEN_LOWER + TOKEN_DIGIT + TOKEN_SPECIAL

function pickFrom(charset: string): string {
  return charset[randomInt(charset.length)]
}

export function generateAccessToken(): string {
  const chars = [
    pickFrom(TOKEN_UPPER),
    pickFrom(TOKEN_LOWER),
    pickFrom(TOKEN_DIGIT),
    pickFrom(TOKEN_SPECIAL),
  ]
  while (chars.length < TOKEN_LENGTH) {
    chars.push(pickFrom(TOKEN_ALL))
  }
  // Fisher-Yates with crypto-grade randomness.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    const tmp = chars[i]
    chars[i] = chars[j]
    chars[j] = tmp
  }
  const token = chars.join('')

  // Defense in depth: assert the construction actually meets the policy
  // before exposing the value. Cheap, catches any future regression in
  // the charset or shuffle code.
  const check = validatePassword(token)
  if (!check.ok) {
    throw new Error(`[Auth] Generated token failed policy check: ${check.error}`)
  }

  accessToken = token
  console.log('[Auth] New access token generated')
  return token
}

/**
 * Restore a previously persisted credential. Accepts the raw value read
 * from config (plain or wrapped). Returns `{ ok: false }` when the value
 * is present but cannot be decoded (e.g. corrupted ciphertext, machine
 * KEK mismatch); the caller is expected to surface this as a hard error
 * rather than silently rotating the PIN, which would invalidate every
 * previously paired device without notifying the user.
 */
export function restoreAccessToken(rawStored: string): { ok: boolean } {
  const plain = decodeFromStorage(rawStored)
  if (!plain) {
    accessToken = null
    console.log('[Auth] Stored credential could not be restored')
    return { ok: false }
  }
  accessToken = plain
  console.log('[Auth] Access token restored from config')
  return { ok: true }
}

/**
 * Raised by `startHttpServer` when a previously persisted credential is
 * present but cannot be decoded. Carries a stable `code` so the IPC /
 * HTTP layer can produce a localized message without depending on the
 * English `message` string.
 */
export class CredentialRestoreError extends Error {
  public readonly code = 'CREDENTIAL_RESTORE_FAILED'
  constructor() {
    super('Stored remote-access credential could not be decoded')
    this.name = 'CredentialRestoreError'
  }
}

/**
 * Set a user-chosen password. Returns the policy error when the password
 * does not meet complexity; on success the in-memory token is updated
 * and the caller is responsible for persisting via remote.service.
 */
export function setCustomAccessToken(token: string): { ok: boolean; error?: string } {
  const result = validatePassword(token)
  if (!result.ok) {
    console.log(`[Auth] Custom token rejected: ${result.error}`)
    return result
  }
  accessToken = token
  console.log('[Auth] Custom access token set')
  return { ok: true }
}

export function getAccessToken(): string | null {
  return accessToken
}

export function clearAccessToken(): void {
  accessToken = null
  console.log('[Auth] Access token cleared')
}

/**
 * Constant-time comparison against the in-memory token. Returns false
 * when no token is configured. Inputs of different lengths still consume
 * a fixed amount of work to avoid leaking length via timing.
 */
export function validateToken(token: string): boolean {
  if (!accessToken) return false
  if (typeof token !== 'string') return false

  const expected = Buffer.from(accessToken, 'utf8')
  const provided = Buffer.from(token, 'utf8')

  if (expected.length !== provided.length) {
    // Still do a constant-work compare against expected to keep timing flat.
    const padded = Buffer.alloc(expected.length)
    provided.copy(padded, 0, 0, Math.min(provided.length, padded.length))
    timingSafeEqual(expected, padded)
    return false
  }
  return timingSafeEqual(expected, provided)
}
