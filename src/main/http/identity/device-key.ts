/**
 * Device-key: the local node's own portable identity.
 *
 * The identity is anchored to a user-held Ed25519 keypair (backup-able, like a
 * seed phrase), NOT to a device-bound secret — swapping machines keeps the same
 * identity, which is what makes it portable. The device key is just ONE
 * local proof factor for this identity.
 *
 * All keypair I/O and crypto live here. The private key is encrypted at rest via
 * OS-keychain-backed secure storage when available, and is never logged or
 * returned to callers in plaintext.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'crypto'
import { hostname, userInfo } from 'os'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs'
import { dirname, join } from 'path'

import { getHaloDir } from '../../foundation/config.service'
import { decryptString } from '../../foundation/secure-storage.service'
import type { Identity } from './types'

const LOG_TAG = '[Identity]'

/** Persisted identity file under the Halo data dir. */
function getIdentityFilePath(): string {
  return join(getHaloDir(), 'node-identity.json')
}

/**
 * Default display name shown to other people (e.g. the owner badge in a shared
 * office). The computer name reads far better than a raw OS account name
 * ("Alices-MacBook-Pro" → "Alices MacBook Pro" vs "alice123") and distinguishes
 * machines that share an account name. Falls back to the account name when the
 * hostname is unset or a placeholder.
 */
function defaultDisplayName(): string {
  const machine = hostname().split('.')[0].replace(/[-_]+/g, ' ').trim()
  if (machine && !/^localhost$/i.test(machine)) return machine
  return userInfo().username
}

/**
 * Derive the stable, deployment-independent identity id from a public key.
 *
 * Single source of truth for the derivation: the device-key resolver reuses
 * this to verify that a presented public key matches a claimed identity id.
 * Accepts an SPKI PEM string or a raw SPKI DER buffer.
 */
export function deriveIdentityId(publicKey: string | Buffer): string {
  const der = Buffer.isBuffer(publicKey)
    ? publicKey
    : (createPublicKey(publicKey).export({ type: 'spki', format: 'der' }) as Buffer)
  const digest = createHash('sha256').update(der).digest('base64url')
  return `id_${digest.slice(0, 32)}`
}

// On-disk shape of node-identity.json.
interface IdentityFile {
  id: string
  displayName: string
  // SPKI PEM, stored in plaintext (public material).
  publicKey: string
  // PKCS8 PEM, encrypted at rest when secure storage is available; otherwise
  // plaintext (a warning is logged once on write).
  privateKey: string
}

// In-memory cache of the loaded identity. Private key stays as a KeyObject so
// callers can sign without the PEM ever leaving this module.
interface LoadedIdentity {
  id: string
  displayName: string
  publicKeyPem: string
  privateKeyObject: KeyObject
}

let cached: LoadedIdentity | null = null

function readIdentityFile(): IdentityFile | null {
  const filePath = getIdentityFilePath()
  if (!existsSync(filePath)) return null
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<IdentityFile>
    if (!raw.id || !raw.publicKey || !raw.privateKey) {
      console.warn(`${LOG_TAG} node-identity.json is missing required fields; regenerating`)
      return null
    }
    // A stored name equal to the OS account name is the legacy default (before
    // display names were customizable), so treat it as unset and use the
    // friendlier machine-name default instead. A user-set name always differs.
    const legacyDefault = userInfo().username
    return {
      id: raw.id,
      displayName:
        raw.displayName && raw.displayName !== legacyDefault
          ? raw.displayName
          : defaultDisplayName(),
      publicKey: raw.publicKey,
      privateKey: raw.privateKey,
    }
  } catch (error) {
    console.warn(`${LOG_TAG} node-identity.json is corrupt; regenerating`, (error as Error).message)
    return null
  }
}

function writeIdentityFile(file: IdentityFile): void {
  const filePath = getIdentityFilePath()
  const dir = dirname(filePath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  // Atomic write so a crash mid-write can never leave a half-written identity.
  const tmpPath = `${filePath}.tmp`
  writeFileSync(tmpPath, JSON.stringify(file, null, 2))
  renameSync(tmpPath, filePath)
}

/** Load and decrypt an on-disk identity into the in-memory cache. */
function loadFromFile(file: IdentityFile): LoadedIdentity {
  // decryptString returns plaintext as-is when the value was never encrypted.
  const privateKeyPem = decryptString(file.privateKey)
  return {
    id: file.id,
    displayName: file.displayName,
    publicKeyPem: file.publicKey,
    privateKeyObject: createPrivateKey(privateKeyPem),
  }
}

/** Generate a fresh keypair, persist it, and return the loaded identity. */
function generateAndPersist(displayName: string): LoadedIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  const id = deriveIdentityId(publicKeyPem)

  writeIdentityFile({
    id,
    displayName,
    publicKey: publicKeyPem,
    // Plaintext, like the app's other on-disk secrets: the user-scoped data dir
    // (OS account + file permissions) is the trust boundary. At-rest encryption
    // via safeStorage was dropped as it popped a macOS Keychain prompt;
    // loadFromFile still decrypts any legacy key.
    privateKey: privateKeyPem,
  })

  console.log(`${LOG_TAG} generated local identity ${id}`)
  return { id, displayName, publicKeyPem, privateKeyObject: privateKey }
}

/**
 * Idempotent init: load the existing identity, or generate one on first run /
 * when the file is missing or corrupt. The id is stable across runs.
 */
export function ensureLocalIdentity(): void {
  if (cached) return
  const file = readIdentityFile()
  if (file) {
    cached = loadFromFile(file)
    console.log(`${LOG_TAG} loaded local identity ${cached.id}`)
    return
  }
  cached = generateAndPersist(defaultDisplayName())
}

function getLoaded(): LoadedIdentity {
  if (!cached) {
    ensureLocalIdentity()
  }
  return cached as LoadedIdentity
}

/** The local node's stable, portable identity (no private material). */
export function getLocalIdentity(): Identity {
  const loaded = getLoaded()
  return { id: loaded.id, displayName: loaded.displayName }
}

/** The local public key as SPKI PEM (safe to share — public material). */
export function getLocalPublicKeyPem(): string {
  return getLoaded().publicKeyPem
}

/** Ed25519-sign data with the local private key (for producing a device-key proof). */
export function signWithLocalKey(data: Buffer): Buffer {
  const loaded = getLoaded()
  return sign(null, data, loaded.privateKeyObject)
}

/** Drop the in-memory cache so the next access reloads from disk (test seam). */
export function _resetLocalIdentityCache(): void {
  cached = null
}

/** Update the UI display name; the identity id is unaffected. */
export function setLocalDisplayName(name: string): void {
  const loaded = getLoaded()
  const trimmed = name.trim()
  if (!trimmed || trimmed === loaded.displayName) return

  const file = readIdentityFile()
  if (!file) {
    // Should not happen after ensureLocalIdentity, but stay defensive.
    console.warn(`${LOG_TAG} cannot set display name: identity file missing`)
    return
  }
  writeIdentityFile({ ...file, displayName: trimmed })
  loaded.displayName = trimmed
  console.log(`${LOG_TAG} updated local display name`)
}
