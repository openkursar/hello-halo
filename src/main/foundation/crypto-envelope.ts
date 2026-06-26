/**
 * At-rest envelope for sensitive persisted credentials.
 *
 * - Open-source (`credentialAtRestSafe` off): credential stored as plain
 *   string. `encodeForStorage` and `decodeFromStorage` are identity.
 * - Enterprise (`credentialAtRestSafe` on): SM4-CBC + HMAC-SM3 under a KEK
 *   derived via HKDF-SHA-256 from a build-deterministic static product key
 *   (`credential-key.ts`). Encrypt-then-MAC.
 *
 * Two invariants drive the design:
 *   - must not fail: the at-rest key is a pure function of the build, so
 *     whatever this build writes it can always read back. Restarts, hardware
 *     changes, VPNs and roaming profiles cannot orphan a credential.
 *   - fail without loss: a decrypt failure is reported as such (never a silent
 *     empty string from the crypto layer); the caller keeps the original
 *     ciphertext on disk and surfaces the failure.
 *
 * Storage markers (all 10 chars, `gmcred:vN:` + base64 payload):
 *   - `gmcred:v2:` — static product key. The only format ever written.
 *   - `gmcred:v1:` — persisted master key (cred.key) or machine seed. Read-only;
 *     re-encrypted to v2 on the next save.
 *   - `enc:`       — Electron safeStorage. Migrated in config.service; treated
 *     here as an undecodable failure.
 *   - anything else — plaintext, accepted on read in both modes.
 */

import { hkdfSync, randomBytes, timingSafeEqual } from 'crypto'
import { hostname, platform, networkInterfaces } from 'os'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import smCrypto from 'sm-crypto'
const { sm3, sm4 } = smCrypto

import { isCredentialAtRestSafe } from './credential-safety'
import { getStaticProductKey, __resetStaticKeyCacheForTests } from './credential-key'

const MARKER_V1 = 'gmcred:v1:'
const MARKER_V2 = 'gmcred:v2:'
// Both markers are the same fixed width, so payload extraction is marker-
// agnostic. Asserted once so a future marker rename can't silently desync.
const MARKER_LEN = MARKER_V2.length
if (MARKER_V1.length !== MARKER_LEN) {
  throw new Error('[Auth] credential markers must share a fixed width')
}

const ENC_PREFIX = 'enc:'

const SALT_LEN = 16
const IV_LEN = 16 // SM4 block size
const HMAC_LEN = 32 // SM3 output
const SM4_KEY_LEN = 16
const HMAC_KEY_LEN = 32

// --------------------------------------------------------------------------
// Key material
//
// WRITE path: always the static product key (`gmcred:v2:`), build-deterministic
// and never absent, so there is no fallback that could write undecodable data.
//
// READ path candidates, by marker:
//   - v2 → static product key.
//   - v1 → persisted master key (cred.key), then the machine seed. Both are
//     retained ONLY to decrypt pre-v2 ciphertext; a successful v1 read flags the
//     value for re-encryption to v2 (see needsKeyMigration).
//
// v1 was fragile: the machine seed mixed hostname + first MAC (unstable across
// dock/undock, VPN, DHCP renames), and cred.key could go missing (roaming/AV
// quarantine) and silently degrade to the seed. The static key removes every
// volatile input.
//
// Threat boundary: product.json / cred.key / config.json are readable by the
// same OS user, so this is encryption-at-rest for compliance, not a defense
// against an attacker who already holds that user's filesystem access. Real key
// isolation would need an OS keychain / TPM (out of scope).
// --------------------------------------------------------------------------

const MASTER_KEY_FILE = 'cred.key'
const MASTER_KEY_LEN = 32

// Tri-state: undefined = unloaded, null = unavailable, Buffer = loaded key.
let cachedMasterKey: Buffer | null | undefined = undefined

function getMasterKeyPath(): string {
  return join(app.getPath('userData'), MASTER_KEY_FILE)
}

// Stored as exactly 64 hex chars (32 bytes). The strict pattern rejects a
// truncated/partial file: Buffer.from(_, 'hex') silently stops at the first
// non-hex char and could otherwise yield a wrong-but-32-byte key.
const MASTER_KEY_HEX = /^[0-9a-f]{64}$/i

/**
 * Load the persisted legacy master key if present. NEVER generated anymore —
 * v2 no longer writes under it. A missing file is normal (returns null); a
 * malformed file is not regenerated (would orphan v1 ciphertext) and is cached
 * null. A transient read error is not cached so it can recover next call.
 */
function loadMasterKey(): Buffer | null {
  if (cachedMasterKey !== undefined) return cachedMasterKey

  const keyPath = getMasterKeyPath()
  if (!existsSync(keyPath)) {
    cachedMasterKey = null
    return null
  }

  let raw: string
  try {
    raw = readFileSync(keyPath, 'utf8').trim()
  } catch (err) {
    // Transient — do not cache, allow retry.
    console.error('[Auth] cred.key read failed (will retry):', (err as Error).message)
    return null
  }
  if (!MASTER_KEY_HEX.test(raw)) {
    console.error('[Auth] cred.key is malformed; ignoring for legacy v1 decryption.')
    cachedMasterKey = null
    return null
  }
  cachedMasterKey = Buffer.from(raw, 'hex')
  return cachedMasterKey
}

let cachedLegacySeed: Buffer | null = null

/**
 * Legacy machine-derived seed. Retained ONLY to decrypt v1 credentials written
 * by builds that derived the KEK from hostname + first MAC. Never used to
 * encrypt.
 */
function getLegacyMachineSeed(): Buffer {
  if (cachedLegacySeed) return cachedLegacySeed

  const parts: string[] = [hostname(), platform(), app.getPath('userData')]

  // First physical, non-internal MAC.
  const ifaces = networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    const list = ifaces[name]
    if (!list) continue
    let picked = false
    for (const info of list) {
      if (!info.internal && info.mac && info.mac !== '00:00:00:00:00:00') {
        parts.push(`${name}:${info.mac}`)
        picked = true
        break
      }
    }
    if (picked) break
  }

  cachedLegacySeed = Buffer.from(parts.join('|'), 'utf8')
  return cachedLegacySeed
}

function deriveKeys(salt: Buffer, keyMaterial: Buffer): { encKey: Buffer; macKey: Buffer } {
  // Two distinct labels = two independent keys, no per-purpose splitting risk.
  const enc = Buffer.from(
    hkdfSync('sha256', keyMaterial, salt, Buffer.from('halo:credential:enc:v1'), SM4_KEY_LEN),
  )
  const mac = Buffer.from(
    hkdfSync('sha256', keyMaterial, salt, Buffer.from('halo:credential:mac:v1'), HMAC_KEY_LEN),
  )
  return { encKey: enc, macKey: mac }
}

// --------------------------------------------------------------------------
// SM4-CBC + HMAC-SM3 (encrypt-then-MAC)
// --------------------------------------------------------------------------

function bytesToHex(buf: Buffer): string {
  return buf.toString('hex')
}

/**
 * SM4-CBC + HMAC-SM3 (encrypt-then-MAC) under an explicit key material and
 * storage marker. Pure: no caching, no policy gate.
 */
function encryptCredential(plaintext: string, keyMaterial: Buffer, marker: string): string {
  const salt = randomBytes(SALT_LEN)
  const iv = randomBytes(IV_LEN)
  const { encKey, macKey } = deriveKeys(salt, keyMaterial)

  // sm-crypto accepts hex keys / hex IVs and returns hex by default.
  const ciphertextHex = sm4.encrypt(plaintext, bytesToHex(encKey), {
    mode: 'cbc',
    iv: bytesToHex(iv),
    padding: 'pkcs#7',
  }) as string
  const ciphertext = Buffer.from(ciphertextHex, 'hex')

  // HMAC-SM3 over salt || iv || ciphertext (encrypt-then-MAC).
  const macInput = Buffer.concat([salt, iv, ciphertext])
  const tagHex = sm3(Array.from(macInput), { key: bytesToHex(macKey) }) as string
  const tag = Buffer.from(tagHex, 'hex')

  const payload = Buffer.concat([salt, iv, ciphertext, tag])
  return marker + payload.toString('base64')
}

/**
 * Inverse of {@link encryptCredential}. Returns null when the key material
 * does not match (MAC mismatch) or the payload is malformed — never throws.
 * A null return is how the caller distinguishes "wrong key, try the next
 * candidate" from a successful decrypt.
 */
function decryptCredential(encoded: string, keyMaterial: Buffer): string | null {
  try {
    const payload = Buffer.from(encoded.slice(MARKER_LEN), 'base64')
    if (payload.length < SALT_LEN + IV_LEN + HMAC_LEN) return null

    const salt = payload.subarray(0, SALT_LEN)
    const iv = payload.subarray(SALT_LEN, SALT_LEN + IV_LEN)
    const tag = payload.subarray(payload.length - HMAC_LEN)
    const ciphertext = payload.subarray(SALT_LEN + IV_LEN, payload.length - HMAC_LEN)

    const { encKey, macKey } = deriveKeys(salt, keyMaterial)

    // Verify MAC first (encrypt-then-MAC requires verifying integrity before decrypt).
    const macInput = Buffer.concat([salt, iv, ciphertext])
    const expectedTagHex = sm3(Array.from(macInput), { key: bytesToHex(macKey) }) as string
    const expectedTag = Buffer.from(expectedTagHex, 'hex')
    if (expectedTag.length !== tag.length) return null
    if (!timingSafeEqual(expectedTag, tag)) return null

    const plaintext = sm4.decrypt(bytesToHex(ciphertext), bytesToHex(encKey), {
      mode: 'cbc',
      iv: bytesToHex(iv),
      padding: 'pkcs#7',
    }) as string
    return plaintext
  } catch (err) {
    console.warn('[Auth] Failed to decrypt stored credential:', (err as Error).message)
    return null
  }
}

// --------------------------------------------------------------------------
// Decode outcome
//
// A decode reports both success/failure and which storage format it matched,
// so callers can preserve ciphertext on failure (non-destructive contract).
// --------------------------------------------------------------------------

export type DecodeSource = 'plaintext' | 'v2-static' | 'v1-master' | 'v1-seed'
export type DecodeFailureReason = 'v2-key-mismatch' | 'v1-undecodable' | 'legacy-safestorage' | 'empty'

export type DecodeOutcome =
  | { ok: true; value: string; source: DecodeSource }
  | { ok: false; reason: DecodeFailureReason }

// --------------------------------------------------------------------------
// Encode / decode
// --------------------------------------------------------------------------

function encryptV2(plaintext: string): string {
  return encryptCredential(plaintext, getStaticProductKey(), MARKER_V2)
}

/**
 * Decode a stored value, reporting both success/failure and which format it
 * matched. Never throws and never fabricates an empty string for a real
 * failure — the discriminated result lets the caller preserve the ciphertext.
 */
function decodeDetailed(stored: string): DecodeOutcome {
  if (!stored) return { ok: true, value: '', source: 'plaintext' }

  if (stored.startsWith(MARKER_V2)) {
    const pt = decryptCredential(stored, getStaticProductKey())
    return pt !== null ? { ok: true, value: pt, source: 'v2-static' } : { ok: false, reason: 'v2-key-mismatch' }
  }

  if (stored.startsWith(MARKER_V1)) {
    const master = loadMasterKey()
    if (master) {
      const pt = decryptCredential(stored, master)
      if (pt !== null) return { ok: true, value: pt, source: 'v1-master' }
    }
    const seedPt = decryptCredential(stored, getLegacyMachineSeed())
    if (seedPt !== null) return { ok: true, value: seedPt, source: 'v1-seed' }
    return { ok: false, reason: 'v1-undecodable' }
  }

  if (stored.startsWith(ENC_PREFIX)) {
    // Legacy Electron safeStorage. Decodable values are converted to plaintext
    // by the startup migration in config.service; a value still carrying this
    // prefix at field-decode time means that migration could not decrypt it.
    return { ok: false, reason: 'legacy-safestorage' }
  }

  // No known marker → legacy plaintext, accepted in both modes so existing
  // installs keep working. Re-encoded to v2 on the next save (enterprise only).
  return { ok: true, value: stored, source: 'plaintext' }
}

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

/**
 * Returns the value to persist into config. When the at-rest policy is on the
 * credential is wrapped as v2; otherwise it is returned verbatim.
 */
export function encodeForStorage(plaintext: string): string {
  if (!plaintext) return plaintext
  return isCredentialAtRestSafe() ? encryptV2(plaintext) : plaintext
}

/**
 * Decode a stored credential, reporting success/failure explicitly. This is
 * the non-destructive read path: callers use the discriminated result to keep
 * the original ciphertext on disk when a value cannot be decoded.
 */
export function tryDecodeFromStorage(stored: string): DecodeOutcome {
  return decodeDetailed(stored)
}

/**
 * Decode a stored credential to a plain string. Convenience wrapper over
 * {@link tryDecodeFromStorage} for single-value callers (e.g. the remote-access
 * PIN) that have no per-field failure handling: returns '' on failure.
 */
export function decodeFromStorage(stored: string): string {
  const outcome = decodeDetailed(stored)
  return outcome.ok ? outcome.value : ''
}

/**
 * True when a stored value should be rewritten to the v2 static-key format:
 * any decodable non-v2 value (legacy plaintext, or v1 ciphertext we can still
 * read). Returns false for values already at v2 and for non-v2 values we cannot
 * decode — rewriting an undecodable value is impossible and returning true
 * would re-trigger migration on every startup.
 */
export function needsKeyMigration(stored: string): boolean {
  if (!stored) return false
  if (stored.startsWith(MARKER_V2)) return false
  return decodeDetailed(stored).ok
}

/**
 * Test-only: produce a legacy `gmcred:v1:` ciphertext (under the persisted
 * master key if present, else the machine seed) so tests can exercise the
 * backward-compatible read + migration path that real on-disk data still uses.
 * Production code never writes v1 anymore.
 */
export function __encryptLegacyV1ForTests(plaintext: string): string {
  const master = loadMasterKey()
  return encryptCredential(plaintext, master ?? getLegacyMachineSeed(), MARKER_V1)
}

/**
 * Test-only: clear cached key material so the next call re-loads/regenerates.
 * Lets unit tests simulate a fresh process / changed key file.
 */
export function __resetKeyCacheForTests(): void {
  cachedMasterKey = undefined
  cachedLegacySeed = null
  __resetStaticKeyCacheForTests()
}
