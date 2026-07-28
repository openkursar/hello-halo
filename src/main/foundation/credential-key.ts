/**
 * Static product key for credential-at-rest encryption (v2) — foundation tier.
 *
 * The v2 envelope (`crypto-envelope.ts`) derives its SM4/HMAC keys from a
 * single, build-deterministic key material returned here. This is the core of
 * the "must not fail" invariant: the key is a pure function of the build, with
 * zero dependency on machine state, network, OS keychain, or an external
 * mutable file. Whatever a given build encrypts, the same build can always
 * decrypt — across restarts, hardware changes, VPNs, and roaming profiles.
 *
 * Two sources, in priority order:
 *   1. `security.credentialStaticKey` in product.json (hex, 32 bytes). Only
 *      enterprise builds carry it; the open-source repo never ships it.
 *   2. Deterministic fallback: HKDF-SHA-256 over a fixed in-source pepper,
 *      salted with the data folder name. Guarantees a stable key is ALWAYS
 *      available, so the encrypt path never has to silently degrade.
 *
 * Threat model (intentional, not a compromise): product.json and config.json
 * are readable by the same OS user, so this is compliance-grade
 * encryption-at-rest ("must not store credentials in plaintext"; defeats a
 * config file copied on its own). It is NOT a defense against an attacker who
 * already holds that user's filesystem access — that would require an OS
 * keychain / TPM and is out of scope. The fallback pepper living in source is
 * therefore acceptable: it raises the bar to obfuscation level, which is all
 * the threat model requires. On open-source builds `credentialAtRestSafe` is
 * off, so this module is never consulted.
 */

import { hkdfSync } from 'crypto'
import { loadProductConfig, getDataFolderName } from './product-config'

const STATIC_KEY_LEN = 32

/** Exactly 64 hex chars (32 bytes). A malformed product key is rejected (not
 * silently truncated) so a typo can never yield a wrong-but-valid key. */
const STATIC_KEY_HEX = /^[0-9a-f]{64}$/i

/**
 * Fixed in-source pepper for the deterministic fallback. Not a secret (see the
 * threat model in the file header) — it only has to be stable and identical
 * across all installs of the same product line so the derived key is portable.
 */
const FALLBACK_PEPPER = 'halo.credential.static.v2.pepper.4f3c1a9e8b7d6052'

const FALLBACK_INFO = 'halo:cred:static:v2'

let cachedStaticKey: Buffer | undefined
let warnedFallback = false

function readProductStaticKey(): Buffer | null {
  const security = loadProductConfig().security as { credentialStaticKey?: unknown } | undefined
  const raw = security?.credentialStaticKey
  if (typeof raw !== 'string' || raw.length === 0) return null
  if (!STATIC_KEY_HEX.test(raw)) {
    console.error(
      '[Auth] product.json security.credentialStaticKey is malformed ' +
        '(expected 64 hex chars); falling back to derived static key.',
    )
    return null
  }
  return Buffer.from(raw, 'hex')
}

function deriveFallbackStaticKey(): Buffer {
  // Reaching the fallback means at-rest encryption is active (this is only
  // called on encrypt/v2-decode paths) but the build shipped no explicit
  // security.credentialStaticKey. The derived key is stable, but it is bound to
  // the data folder name: renaming dataFolderName would change the key. Warn
  // once so operators know to pin an explicit key for long-lived deployments.
  if (!warnedFallback) {
    warnedFallback = true
    console.warn(
      '[Auth] credentialAtRestSafe is on but product.json has no ' +
        'security.credentialStaticKey; deriving the at-rest key from the data ' +
        `folder name ("${getDataFolderName()}"). Set an explicit static key to ` +
        'decouple credentials from the data folder name.',
    )
  }
  // Salt with the data folder name so distinct product variants that omit an
  // explicit key still get distinct (but each internally stable) keys.
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(FALLBACK_PEPPER, 'utf8'),
      Buffer.from(getDataFolderName(), 'utf8'),
      Buffer.from(FALLBACK_INFO, 'utf8'),
      STATIC_KEY_LEN,
    ),
  )
}

/**
 * Return the build-deterministic key material for v2 credential encryption.
 * Never null: a configured product key wins, otherwise the derived fallback is
 * used. The result is cached for the process lifetime.
 */
export function getStaticProductKey(): Buffer {
  if (cachedStaticKey) return cachedStaticKey
  cachedStaticKey = readProductStaticKey() ?? deriveFallbackStaticKey()
  return cachedStaticKey
}

/**
 * Test-only: clear the cached key so the next call re-reads product.json.
 */
export function __resetStaticKeyCacheForTests(): void {
  cachedStaticKey = undefined
  warnedFallback = false
}
