/**
 * The signed description of a staged update.
 *
 * A staged update unpacks an archive into the install directory and then runs
 * it, so everything that names that archive has to be provably ours. The
 * internal feed is plain HTTP and authenticates nobody, and Windows builds
 * carry no code signature — this signature is the only thing standing between
 * "the server said so" and "we execute it".
 *
 * The signature covers an opaque byte string rather than a JSON object, and
 * the bytes are transported base64-encoded. JSON canonicalization is a
 * well-known source of signature bypasses; not needing it is worth the
 * slightly awkward envelope.
 *
 * Signing happens on the build machine, never on the server: a server that
 * could sign would be able to mint updates, which is precisely what this is
 * designed to prevent.
 */

import { createPublicKey, verify as verifySignature } from 'crypto'
import type { UpdaterChannel } from '../../../../shared/types/updater'
import { isUpgrade, parseVersion } from '../version'

/** Wire format served by the release server, byte-for-byte as the build produced it. */
interface SignedEnvelope {
  payload: string
  signature: string
  keyId?: string
}

/** What a verified description actually promises. */
export interface StagedUpdateManifest {
  schema: number
  channel: UpdaterChannel
  /** Guards against a description signed for a different product with the same key. */
  productId: string
  version: string
  platform: string
  arch: string
  package: {
    url: string
    size: number
    /** Base64 of the raw 64-byte SHA-512 digest. */
    sha512: string
    format: 'tar.zst'
    /**
     * Size of the tree once unpacked.
     *
     * Carried rather than inferred from a compression ratio because it decides
     * whether staging can finish at all, and guessing low turns a clean
     * "not enough space" into a half-written update.
     */
    unpackedSize: number
  }
  /** Lowest helper protocol version that can apply this package. */
  minHelperVersion: number
  releaseDate?: string
  releaseNotes?: string
  mandatory?: boolean
}

/** Only this schema is understood; anything else is a newer server talking past us. */
const SUPPORTED_SCHEMA = 1

/** SHA-512 digests are 64 bytes, so their base64 form is a fixed length. */
const SHA512_BASE64_LENGTH = 88

/** Refuse absurd sizes outright rather than discovering them mid-download. */
const MAX_PACKAGE_BYTES = 4 * 1024 * 1024 * 1024

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Check the signature and return the bytes it covers.
 *
 * @param body Raw response body from the feed.
 * @param publicKeyBase64 Base64 SPKI DER Ed25519 key shipped in product.json.
 * @throws When the envelope is malformed or the signature does not verify.
 */
function openEnvelope(body: string, publicKeyBase64: string): Buffer {
  let envelope: unknown
  try {
    envelope = JSON.parse(body)
  } catch {
    throw new Error('update description is not JSON')
  }
  if (!isPlainObject(envelope)) throw new Error('update description is not an object')

  const { payload, signature } = envelope as Partial<SignedEnvelope>
  if (typeof payload !== 'string' || typeof signature !== 'string') {
    throw new Error('update description is missing payload or signature')
  }

  const payloadBytes = Buffer.from(payload, 'base64')
  const signatureBytes = Buffer.from(signature, 'base64')
  if (payloadBytes.length === 0) throw new Error('update description payload is empty')

  let key
  try {
    key = createPublicKey({
      key: Buffer.from(publicKeyBase64, 'base64'),
      format: 'der',
      type: 'spki',
    })
  } catch {
    throw new Error('configured update signing key is not a usable public key')
  }

  // Ed25519 takes the message directly; passing an algorithm here would throw.
  if (!verifySignature(null, payloadBytes, key, signatureBytes)) {
    throw new Error('update description signature does not verify')
  }

  return payloadBytes
}

/**
 * Validate a verified payload against what this build is willing to install.
 *
 * Everything here is checked even though the bytes are signed. A valid
 * signature proves the description came from our build machine; it does not
 * prove the server handed us the *current* one, nor that it belongs to this
 * product, channel or platform. Those are the mistakes a signature cannot
 * catch, so they are caught explicitly.
 */
function validate(
  raw: unknown,
  expected: { channel: UpdaterChannel; productId: string; platform: string; arch: string; currentVersion: string; helperVersion: number }
): StagedUpdateManifest {
  if (!isPlainObject(raw)) throw new Error('update description payload is not an object')

  const schema = raw.schema
  if (schema !== SUPPORTED_SCHEMA) {
    throw new Error(`unsupported update description schema ${String(schema)}`)
  }

  const { channel, productId, version, platform, arch, minHelperVersion } = raw
  if (channel !== expected.channel) {
    throw new Error(`update description is for channel "${String(channel)}", this build is "${expected.channel}"`)
  }
  if (productId !== expected.productId) {
    throw new Error(`update description is for product "${String(productId)}"`)
  }
  if (platform !== expected.platform || arch !== expected.arch) {
    throw new Error(`update description is for ${String(platform)}-${String(arch)}`)
  }
  if (typeof version !== 'string' || !parseVersion(version)) {
    throw new Error(`update description has an unreadable version ${JSON.stringify(version)}`)
  }
  // A correctly-signed but stale description is how a server walks a client
  // backwards onto a version with a known problem.
  if (!isUpgrade(version, expected.currentVersion)) {
    throw new Error(`update description version ${version} is not newer than ${expected.currentVersion}`)
  }

  if (typeof minHelperVersion !== 'number' || !Number.isInteger(minHelperVersion)) {
    throw new Error('update description has no usable minHelperVersion')
  }
  if (minHelperVersion > expected.helperVersion) {
    throw new Error(
      `update needs helper protocol v${minHelperVersion}, this build ships v${expected.helperVersion}`
    )
  }

  const pkg = raw.package
  if (!isPlainObject(pkg)) throw new Error('update description has no package')
  if (pkg.format !== 'tar.zst') throw new Error(`unsupported package format ${String(pkg.format)}`)

  if (typeof pkg.url !== 'string') throw new Error('package url is missing')
  let parsedUrl: URL
  try {
    parsedUrl = new URL(pkg.url)
  } catch {
    throw new Error('package url is not absolute')
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(`package url uses unsupported scheme ${parsedUrl.protocol}`)
  }

  if (typeof pkg.size !== 'number' || !Number.isInteger(pkg.size) || pkg.size <= 0 || pkg.size > MAX_PACKAGE_BYTES) {
    throw new Error('package size is missing or implausible')
  }
  if (typeof pkg.sha512 !== 'string' || pkg.sha512.length !== SHA512_BASE64_LENGTH) {
    throw new Error('package sha512 is missing or malformed')
  }
  if (Buffer.from(pkg.sha512, 'base64').length !== 64) {
    throw new Error('package sha512 does not decode to 64 bytes')
  }
  // Only sanity-bounded, deliberately not compared against the archive size:
  // a tree of already-compressed content packs larger than it unpacks, so
  // "unpacked must exceed packed" would reject perfectly good releases.
  if (
    typeof pkg.unpackedSize !== 'number' ||
    !Number.isInteger(pkg.unpackedSize) ||
    pkg.unpackedSize <= 0 ||
    pkg.unpackedSize > MAX_PACKAGE_BYTES
  ) {
    throw new Error('package unpackedSize is missing or implausible')
  }

  return {
    schema,
    // Equal to `channel` by the guard above; taken from `expected` because that
    // side is the typed one.
    channel: expected.channel,
    productId,
    version,
    platform,
    arch,
    package: {
      url: pkg.url,
      size: pkg.size,
      sha512: pkg.sha512,
      format: 'tar.zst',
      unpackedSize: pkg.unpackedSize,
    },
    minHelperVersion,
    releaseDate: typeof raw.releaseDate === 'string' ? raw.releaseDate : undefined,
    releaseNotes: typeof raw.releaseNotes === 'string' ? raw.releaseNotes : undefined,
    mandatory: raw.mandatory === true,
  }
}

/**
 * Verify and interpret a staged update description.
 *
 * Throws with a human-readable reason on any failure; callers treat every
 * throw the same way — stay on the current version and fall back to the
 * installer path.
 */
export function readStagedManifest(
  body: string,
  publicKeyBase64: string,
  expected: {
    channel: UpdaterChannel
    productId: string
    platform: string
    arch: string
    currentVersion: string
    helperVersion: number
  }
): StagedUpdateManifest {
  const payloadBytes = openEnvelope(body, publicKeyBase64)

  let parsed: unknown
  try {
    parsed = JSON.parse(payloadBytes.toString('utf8'))
  } catch {
    throw new Error('signed update payload is not JSON')
  }

  return validate(parsed, expected)
}
