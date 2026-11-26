/**
 * Delivery bundle signatures: the Registry signs each `halo.cli.bundle/1`
 * revision, and the build ships the public keys it trusts. See DESIGN.md
 * "Signatures".
 *
 * Signed bytes: "halo.cli.bundle/1\n" followed by the raw bytes of the
 * bundle's `bundle.json`.
 *
 * Trust file `trusted-keys.json` (next to the preset bundles):
 *   {"schema":"halo.cli.trust/1","keys":[{"keyId":"…","alg":"ed25519","publicKey":"<base64 raw 32 bytes>"}]}
 *
 * Policy: no trust file, or one with an empty key list → verification is off
 * and a bundle's `bundle.sig` is ignored. A file that lists keys → every
 * bundle must carry a valid signature from one of them. A file that cannot be
 * read or parsed fails closed. Node's built-in crypto only.
 */

import { createPublicKey, verify, type KeyObject } from 'crypto'
import { promises as fsp } from 'fs'
import { CliToolError } from './errors'

export const TRUST_SCHEMA = 'halo.cli.trust/1'
export const BUNDLE_SIGNATURE_DOMAIN = 'halo.cli.bundle/1'
export const TRUSTED_KEYS_FILE = 'trusted-keys.json'

export interface BundleSignature {
  alg: 'ed25519'
  keyId: string
  /** base64 Ed25519 signature (64 bytes). */
  value: string
}

/**
 * - `off`: no trust file (or no keys) — bundles are installed on digest checks alone.
 * - `on`: at least one key — a valid signature is required.
 * - `broken`: the trust file exists but cannot be used — every bundle is refused.
 */
export type TrustMode = 'off' | 'on' | 'broken'

export interface TrustStore {
  mode: TrustMode
  keys: Map<string, KeyObject>
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

export function signedBundleBytes(bundleJson: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(`${BUNDLE_SIGNATURE_DOMAIN}\n`, 'utf-8'), bundleJson])
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

/** Strict shape check of `bundle.sig`; null for anything else. */
export function parseBundleSignature(raw: unknown): BundleSignature | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const s = raw as Record<string, unknown>
  if (Object.keys(s).some(key => key !== 'alg' && key !== 'keyId' && key !== 'value')) return null
  if (s.alg !== 'ed25519') return null
  if (typeof s.keyId !== 'string' || s.keyId.length === 0 || s.keyId.length > 128) return null
  if (typeof s.value !== 'string' || s.value.length > 256 || !BASE64.test(s.value)) return null
  return { alg: 'ed25519', keyId: s.keyId, value: s.value }
}

/**
 * Enforce the policy for one bundle. Returns normally when it may be
 * installed; throws SIGNATURE_MISSING or SIGNATURE_INVALID. `signature` is the
 * parsed `bundle.sig` (null when absent or malformed), and is not consulted
 * while verification is off.
 */
export function assertBundleSignature(
  trust: TrustStore,
  bundleJson: Uint8Array,
  signature: BundleSignature | null,
  label: string,
): void {
  if (trust.mode === 'off') return
  if (trust.mode === 'broken') {
    throw new CliToolError('SIGNATURE_INVALID', 'the trusted key file cannot be used; bundles are refused')
  }
  if (!signature) throw new CliToolError('SIGNATURE_MISSING', `${label} carries no valid bundle signature`)
  const key = trust.keys.get(signature.keyId)
  if (!key) throw new CliToolError('SIGNATURE_INVALID', `signature key "${signature.keyId}" is not trusted`)
  const value = Buffer.from(signature.value, 'base64')
  let ok = false
  try {
    ok = value.length === 64 && verify(null, signedBundleBytes(bundleJson), key, value)
  } catch {
    ok = false
  }
  if (!ok) throw new CliToolError('SIGNATURE_INVALID', `bundle signature of ${label} does not verify`)
}
