/**
 * At-rest envelope for sensitive persisted credentials.
 *
 * - Open-source (`credentialAtRestSafe` off): credential stored as plain
 *   string. `encodeForStorage` and `decodeFromStorage` are identity.
 * - Enterprise (`credentialAtRestSafe` on): SM4-CBC + HMAC-SM3 under a KEK
 *   derived via HKDF-SHA-256 from a persisted random master key.
 *   Encrypt-then-MAC.
 *
 * Storage marker is `gmcred:v1:` followed by base64. Anything else is
 * treated as legacy plaintext on read, which gives existing installs a
 * seamless silent migration on the next save.
 */

import { hkdfSync, randomBytes, timingSafeEqual } from 'crypto'
import { hostname, platform, networkInterfaces } from 'os'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import smCrypto from 'sm-crypto'
const { sm3, sm4 } = smCrypto

import { isCredentialAtRestSafe } from './credential-safety'

const MARKER = 'gmcred:v1:'
const SALT_LEN = 16
const IV_LEN = 16 // SM4 block size
const HMAC_LEN = 32 // SM3 output
const SM4_KEY_LEN = 16
const HMAC_KEY_LEN = 32

// --------------------------------------------------------------------------
// Key material
//
// Two sources, tried in priority order on decrypt:
//   1. Persisted random master key (userData/cred.key) — STABLE across
//      restarts, network changes, and hardware reconfiguration. All NEW
//      ciphertext is written under this key.
//   2. Legacy machine-derived seed — kept ONLY to decrypt ciphertext written
//      by older builds that derived the KEK from hostname + first MAC.
//      Reading such a value triggers re-encryption under the master key (see
//      needsKeyMigration / migrateCredentialEncryption).
//
// Why the change: the legacy seed mixed in the first non-internal MAC and the
// hostname. Both are unstable in real deployments (dock/undock, VPN, virtual
// adapters, DHCP renames), so the derived KEK changed between runs, the MAC
// check failed, and the stored API key was wiped — surfacing as "No AI source
// configured". A persisted random key removes every volatile input.
//
// Threat boundary: cred.key (userData) and config.json (~/.<dataFolder>) are
// readable by the same OS user, so this is encryption-at-rest for compliance,
// not a defense against an attacker who already has that user's filesystem
// access. It only defeats a config file copied without its cred.key. Real key
// isolation would need an OS keychain / TPM (out of scope).
// --------------------------------------------------------------------------

const MASTER_KEY_FILE = 'cred.key'
const MASTER_KEY_LEN = 32

// Tri-state: undefined = unloaded, null = unavailable, Buffer = loaded key.
let cachedMasterKey: Buffer | null | undefined = undefined

function getMasterKeyPath(): string {
  return join(app.getPath('userData'), MASTER_KEY_FILE)
}

// Stored as exactly 64 lowercase/uppercase hex chars (32 bytes). The strict
// pattern rejects a truncated/partial file: Buffer.from(_, 'hex') silently
// stops at the first non-hex char and could otherwise yield a wrong-but-
// 32-byte key from a corrupted file.
const MASTER_KEY_HEX = /^[0-9a-f]{64}$/i

/**
 * Load the persisted master key, generating it once on first run. Two
 * non-obvious invariants:
 *   - A malformed existing file is NEVER regenerated (a fresh key would orphan
 *     credentials encrypted under the previous key); cache null so the legacy
 *     fallback takes over until an operator repairs/removes the file.
 *   - A transient read/create failure is NOT cached, so a momentary blip can
 *     recover on the next call instead of degrading the process until restart.
 */
function loadMasterKey(): Buffer | null {
  if (cachedMasterKey !== undefined) return cachedMasterKey

  const keyPath = getMasterKeyPath()

  if (existsSync(keyPath)) {
    let raw: string
    try {
      raw = readFileSync(keyPath, 'utf8').trim()
    } catch (err) {
      // Transient — do not cache, allow retry.
      console.error('[Auth] cred.key read failed (will retry):', (err as Error).message)
      return null
    }
    if (!MASTER_KEY_HEX.test(raw)) {
      console.error(
        '[Auth] cred.key is malformed; refusing to regenerate (would orphan ' +
          'stored credentials). Falling back to legacy key derivation until repaired.',
      )
      cachedMasterKey = null
      return null
    }
    cachedMasterKey = Buffer.from(raw, 'hex')
    return cachedMasterKey
  }

  // First run: generate once. Write to a temp file then rename so a crash
  // mid-write can never leave a truncated cred.key (which would be read as
  // malformed and permanently disable the master key). rename(2) is atomic on
  // POSIX and Windows. Concurrent generation is prevented by Electron's
  // single-instance lock.
  try {
    const key = randomBytes(MASTER_KEY_LEN)
    const tmpPath = `${keyPath}.${process.pid}.tmp`
    writeFileSync(tmpPath, key.toString('hex'), { mode: 0o600 })
    renameSync(tmpPath, keyPath)
    cachedMasterKey = key
    return key
  } catch (err) {
    // Transient — do not cache, allow retry on the next call.
    console.error('[Auth] cred.key create failed (will retry):', (err as Error).message)
    return null
  }
}

let cachedLegacySeed: Buffer | null = null

/**
 * Legacy machine-derived seed. Retained ONLY to decrypt credentials written
 * by builds that predate the persisted master key, and used to encrypt new
 * data only when the master key cannot be established (so behavior is never
 * worse than the old scheme).
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

function keyMaterialCandidates(): Buffer[] {
  const candidates: Buffer[] = []
  const master = loadMasterKey()
  if (master) candidates.push(master)
  candidates.push(getLegacyMachineSeed())
  return candidates
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
 * SM4-CBC + HMAC-SM3 (encrypt-then-MAC) under an explicit key material.
 * Pure: no caching, no policy gate. The wrappers below choose the key.
 */
function encryptCredential(plaintext: string, keyMaterial: Buffer): string {
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
  return MARKER + payload.toString('base64')
}

/**
 * Inverse of {@link encryptCredential}. Returns null when the key material
 * does not match (MAC mismatch) or the payload is malformed — never throws.
 * A null return is how the caller distinguishes "wrong key, try the next
 * candidate" from a successful decrypt.
 */
function decryptCredential(encoded: string, keyMaterial: Buffer): string | null {
  try {
    const payload = Buffer.from(encoded.slice(MARKER.length), 'base64')
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

let warnedLegacyEncrypt = false

function encryptGm(plaintext: string): string {
  // Fall back to the legacy seed only if the master key can't be established,
  // so behavior is never worse than the old scheme.
  const master = loadMasterKey()
  if (!master && !warnedLegacyEncrypt) {
    warnedLegacyEncrypt = true // warn once, not per credential
    console.error(
      '[Auth] Master key unavailable; encrypting new credentials under the ' +
        'legacy machine seed. At-rest protection is degraded until cred.key ' +
        'can be created.',
    )
  }
  return encryptCredential(plaintext, master ?? getLegacyMachineSeed())
}

function decryptGm(encoded: string): string | null {
  for (const keyMaterial of keyMaterialCandidates()) {
    const plaintext = decryptCredential(encoded, keyMaterial)
    if (plaintext !== null) return plaintext
  }
  return null
}

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

/**
 * Returns the value to persist into config. When the GM policy is on the
 * credential is wrapped; otherwise it is returned verbatim.
 */
export function encodeForStorage(plaintext: string): string {
  if (!plaintext) return plaintext
  return isCredentialAtRestSafe() ? encryptGm(plaintext) : plaintext
}

/**
 * Decode a stored credential. Plain values pass through. Encoded values
 * are unwrapped; on integrity / decrypt failure the function returns an
 * empty string so the caller can fall back to regenerating.
 */
export function decodeFromStorage(stored: string): string {
  if (!stored) return ''
  if (!stored.startsWith(MARKER)) {
    // Legacy plaintext — accepted in both modes so existing installs keep
    // working. Re-encoding to ciphertext happens the next time the token
    // is saved (regeneratePassword / setCustomPassword).
    return stored
  }
  return decryptGm(stored) ?? ''
}

/**
 * True when a stored value should be rewritten under the master key: plaintext
 * (no marker), or GM-encoded but not decryptable with the master key (i.e.
 * legacy-seed ciphertext). Returns false when the master key is unavailable —
 * there is nothing to migrate onto, and returning true would re-trigger the
 * migration on every startup.
 */
export function needsKeyMigration(stored: string): boolean {
  if (!stored) return false
  if (!stored.startsWith(MARKER)) return true
  const master = loadMasterKey()
  if (!master) return false
  return decryptCredential(stored, master) === null
}

/**
 * Test-only: clear cached key material so the next call re-loads/regenerates.
 * Lets unit tests simulate a fresh process / changed key file.
 */
export function __resetKeyCacheForTests(): void {
  cachedMasterKey = undefined
  cachedLegacySeed = null
  warnedLegacyEncrypt = false
}
