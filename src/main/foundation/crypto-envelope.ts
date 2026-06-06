/**
 * At-rest envelope for the remote-access credential.
 *
 * - Open-source (`credentialAtRestSafe` off): credential stored as plain
 *   string. `encodeForStorage` and `decodeFromStorage` are identity.
 * - Enterprise (`credentialAtRestSafe` on): SM4-CBC + HMAC-SM3 under a
 *   machine-bound KEK derived via HKDF-SHA-256. Encrypt-then-MAC.
 *
 * Storage marker is `gmcred:v1:` followed by base64. Anything else is
 * treated as legacy plaintext on read, which gives existing installs a
 * seamless silent migration on the next save.
 */

import { hkdfSync, randomBytes, timingSafeEqual } from 'crypto'
import { hostname, platform, networkInterfaces } from 'os'
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
// Machine-bound seed (stable across restarts on one machine, opaque to a
// stolen config alone).
// --------------------------------------------------------------------------

let cachedSeed: Buffer | null = null

function getMachineSeed(): Buffer {
  if (cachedSeed) return cachedSeed

  const parts: string[] = [hostname(), platform(), app.getPath('userData')]

  // First physical, non-internal MAC. Stable per hardware.
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

  cachedSeed = Buffer.from(parts.join('|'), 'utf8')
  return cachedSeed
}

function deriveKeys(salt: Buffer): { encKey: Buffer; macKey: Buffer } {
  // Two distinct labels = two independent keys, no per-purpose splitting risk.
  const enc = Buffer.from(
    hkdfSync('sha256', getMachineSeed(), salt, Buffer.from('halo:credential:enc:v1'), SM4_KEY_LEN),
  )
  const mac = Buffer.from(
    hkdfSync('sha256', getMachineSeed(), salt, Buffer.from('halo:credential:mac:v1'), HMAC_KEY_LEN),
  )
  return { encKey: enc, macKey: mac }
}

// --------------------------------------------------------------------------
// SM4-CBC + HMAC-SM3 (encrypt-then-MAC)
// --------------------------------------------------------------------------

function bytesToHex(buf: Buffer): string {
  return buf.toString('hex')
}

function encryptGm(plaintext: string): string {
  const salt = randomBytes(SALT_LEN)
  const iv = randomBytes(IV_LEN)
  const { encKey, macKey } = deriveKeys(salt)

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

function decryptGm(encoded: string): string | null {
  try {
    const payload = Buffer.from(encoded.slice(MARKER.length), 'base64')
    if (payload.length < SALT_LEN + IV_LEN + HMAC_LEN) return null

    const salt = payload.subarray(0, SALT_LEN)
    const iv = payload.subarray(SALT_LEN, SALT_LEN + IV_LEN)
    const tag = payload.subarray(payload.length - HMAC_LEN)
    const ciphertext = payload.subarray(SALT_LEN + IV_LEN, payload.length - HMAC_LEN)

    const { encKey, macKey } = deriveKeys(salt)

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
