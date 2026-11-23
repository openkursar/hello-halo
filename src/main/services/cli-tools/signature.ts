/**
 * Catalog signatures: an administrator signs each approved version, and the
 * build ships the public keys it trusts. See DESIGN.md "Signatures".
 *
 * Signed bytes (UTF-8):
 *   "halo.cli.sig/1\n" + id + "\n" + version + "\n" + archiveSha256 + "\n" + integrity + "\n"
 *
 * An administrator's guide override of a version is signed on its own, so it
 * can change after the package was approved:
 *   "halo.cli.guide/1\n" + id + "\n" + version + "\n" + revision + "\n" + sha256 of the text + "\n"
 *
 * Trust file `trusted-keys.json` (next to the preset packages):
 *   {"schema":"halo.cli.trust/1","keys":[{"keyId":"…","alg":"ed25519","publicKey":"<base64 raw 32 bytes>"}]}
 *
 * Policy: no trust file, or one with an empty key list → verification is off.
 * A file that lists keys → every catalog install must carry a valid signature
 * from one of them. A file that cannot be read or parsed fails closed.
 * Node's built-in crypto only.
 */

import { createPublicKey, verify, type KeyObject } from 'crypto'
import { promises as fsp } from 'fs'
import { CliToolError } from './errors'

export const TRUST_SCHEMA = 'halo.cli.trust/1'
export const SIGNATURE_DOMAIN = 'halo.cli.sig/1'
export const GUIDE_SIGNATURE_DOMAIN = 'halo.cli.guide/1'
export const TRUSTED_KEYS_FILE = 'trusted-keys.json'

export interface CatalogSignature {
  alg: 'ed25519'
  keyId: string
  /** base64 Ed25519 signature (64 bytes). */
  value: string
}

export interface SignedFields {
  id: string
  version: string
  /** Lowercase hex. */
  archiveSha256: string
  integrity: string
}

/**
 * - `off`: no trust file (or no keys) — catalog packages are installed on digest checks alone.
 * - `on`: at least one key — a valid signature is required.
 * - `broken`: the trust file exists but cannot be used — every catalog install is refused.
 */
export type TrustMode = 'off' | 'on' | 'broken'

export interface TrustStore {
  mode: TrustMode
  keys: Map<string, KeyObject>
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

export function signedBytes(fields: SignedFields): Buffer {
  return Buffer.from(
    `${SIGNATURE_DOMAIN}\n${fields.id}\n${fields.version}\n${fields.archiveSha256.toLowerCase()}\n${fields.integrity}\n`,
    'utf-8',
  )
}

export interface GuideSignedFields {
  id: string
  version: string
  /** Positive integer; every administrator edit or reset increments it. */
  revision: number
  /** Lowercase hex sha256 of the guide's UTF-8 text. */
  sha256: string
}

export function signedGuideBytes(fields: GuideSignedFields): Buffer {
  return Buffer.from(
    `${GUIDE_SIGNATURE_DOMAIN}\n${fields.id}\n${fields.version}\n${fields.revision}\n${fields.sha256.toLowerCase()}\n`,
    'utf-8',
  )
}

function publicKeyFromRaw(raw: Buffer): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') }, format: 'jwk' })
}

/** Parse trust-file text. Keys with a wrong algorithm or length are skipped. */
export function parseTrustStore(text: string): TrustStore {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { mode: 'broken', keys: new Map() }
  }
  const b = body as { schema?: unknown; keys?: unknown }
  if (!b || typeof b !== 'object' || b.schema !== TRUST_SCHEMA || !Array.isArray(b.keys)) {
    return { mode: 'broken', keys: new Map() }
  }
  if (b.keys.length === 0) return { mode: 'off', keys: new Map() }
  const keys = new Map<string, KeyObject>()
  for (const item of b.keys as Array<Record<string, unknown>>) {
    if (!item || item.alg !== 'ed25519' || typeof item.keyId !== 'string' || !item.keyId) continue
    if (typeof item.publicKey !== 'string' || !BASE64.test(item.publicKey)) continue
    const raw = Buffer.from(item.publicKey, 'base64')
    if (raw.length !== 32) continue
    try {
      keys.set(item.keyId, publicKeyFromRaw(raw))
    } catch {
      // Not a usable Ed25519 key; it simply does not count.
    }
  }
  // Keys were listed but none is usable: checking is meant to be on, so refuse rather than skip.
  return { mode: keys.size > 0 ? 'on' : 'broken', keys }
}

/** Read the trust file; absent means verification is off. */
export async function loadTrustStore(file: string | null): Promise<TrustStore> {
  if (!file) return { mode: 'off', keys: new Map() }
  let text: string
  try {
    text = await fsp.readFile(file, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { mode: 'off', keys: new Map() }
    return { mode: 'broken', keys: new Map() }
  }
  return parseTrustStore(text)
}

/** Shape check of a catalog `signature` value; null for anything else. */
export function parseCatalogSignature(raw: unknown): CatalogSignature | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  if (s.alg !== 'ed25519') return null
  if (typeof s.keyId !== 'string' || s.keyId.length === 0 || s.keyId.length > 128) return null
  if (typeof s.value !== 'string' || s.value.length > 256 || !BASE64.test(s.value)) return null
  return { alg: 'ed25519', keyId: s.keyId, value: s.value }
}

/**
 * Enforce the policy for one catalog version. Returns normally when the
 * version may be installed; throws SIGNATURE_MISSING or SIGNATURE_INVALID.
 * `signature` is whatever the catalog carried (null/undefined when none).
 */
export function assertCatalogSignature(
  trust: TrustStore,
  fields: SignedFields,
  signature: CatalogSignature | null | undefined,
): void {
  if (trust.mode === 'off') return
  if (trust.mode === 'broken') {
    throw new CliToolError('SIGNATURE_INVALID', 'the trusted key file cannot be used; catalog installs are refused')
  }
  if (!signature) throw new CliToolError('SIGNATURE_MISSING', `${fields.id}@${fields.version} carries no signature`)
  const key = trust.keys.get(signature.keyId)
  if (!key) throw new CliToolError('SIGNATURE_INVALID', `signature key "${signature.keyId}" is not trusted`)
  const value = Buffer.from(signature.value, 'base64')
  let ok = false
  try {
    ok = value.length === 64 && verify(null, signedBytes(fields), key, value)
  } catch {
    ok = false
  }
  if (!ok) throw new CliToolError('SIGNATURE_INVALID', `signature of ${fields.id}@${fields.version} does not verify`)
}

/**
 * The same policy for an administrator's guide override, as a verdict rather
 * than an error: a guide that fails is ignored and the installed guide stays.
 */
export function guideSignatureAccepted(
  trust: TrustStore,
  fields: GuideSignedFields,
  signature: CatalogSignature | null | undefined,
): boolean {
  if (trust.mode === 'off') return true
  if (trust.mode === 'broken' || !signature) return false
  const key = trust.keys.get(signature.keyId)
  if (!key) return false
  const value = Buffer.from(signature.value, 'base64')
  try {
    return value.length === 64 && verify(null, signedGuideBytes(fields), key, value)
  } catch {
    return false
  }
}
