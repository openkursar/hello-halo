#!/usr/bin/env node
// ============================================================================
// sign-staged-update — produce the update package and its signed description
//
// Windows builds that use the staged update path fetch a signed description of
// the release instead of the electron-updater yml. This is where that
// description is created and signed.
//
// Signing happens here, on the build machine, and never on the release server.
// A server that could sign could mint updates, and the whole point of the
// signature is that compromising the distribution host is not enough to make a
// client run arbitrary code. The private key is read from the environment and
// is never written to disk, logged, or embedded in an artifact.
//
// Usage:
//   node scripts/release/sign-staged-update.mjs
//     --unpacked dist/win-unpacked --out dist --version 2.1.17
//     --channel experience --product-id halo-example
//     [--packer win-update-helper/bin/halo-update-packer]
//     [--base-url http://host:18080]
//
// Environment:
//   HALO_UPDATE_SIGNING_KEY  base64 PKCS#8 DER Ed25519 private key (required)
//   HALO_UPDATE_KEY_ID       identifier recorded in the envelope (optional)
//
// Generate a key pair with: node scripts/release/sign-staged-update.mjs --keygen
//
// Exit codes: 0 ok · 1 failure
// ============================================================================

import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

/** Description format version; the client refuses anything it does not know. */
const SCHEMA = 1

/** Lowest helper protocol able to apply packages produced by this script. */
const MIN_HELPER_VERSION = 1

function fail(message) {
  console.error(`[sign-staged-update] ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const args = {}
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i]
    if (flag === '--keygen') {
      args.keygen = true
      continue
    }
    if (!flag.startsWith('--')) fail(`unexpected argument: ${flag}`)
    args[flag.slice(2)] = argv[++i]
  }
  return args
}

/**
 * Print a fresh key pair and exit.
 *
 * The public half goes into a product variant's `updateConfig.manifestPublicKey`;
 * the private half goes into the release engineer's environment and nowhere
 * else. Losing the private key means shipping a client update to rotate it, so
 * it is worth storing like a signing certificate.
 */
function keygen() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  console.log('Public key  (product.json updateConfig.manifestPublicKey):')
  console.log(publicKey.export({ type: 'spki', format: 'der' }).toString('base64'))
  console.log('')
  console.log('Private key (HALO_UPDATE_SIGNING_KEY — keep secret, do not commit):')
  console.log(privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'))
}

function loadSigningKey() {
  const raw = process.env.HALO_UPDATE_SIGNING_KEY?.trim()
  if (!raw) fail('HALO_UPDATE_SIGNING_KEY is not set — cannot sign the update description')
  try {
    return createPrivateKey({ key: Buffer.from(raw, 'base64'), format: 'der', type: 'pkcs8' })
  } catch (error) {
    fail(`HALO_UPDATE_SIGNING_KEY is not a usable Ed25519 private key: ${error.message}`)
  }
}

/**
 * Build the archive and read back the measurements the description must carry.
 *
 * The packer is the same program that unpacks on the user's machine, so the
 * format cannot drift between the two sides.
 */
function pack(packerPath, unpackedDir, archivePath) {
  if (!existsSync(packerPath)) {
    fail(`packer not found at ${packerPath} — build it with: (cd win-update-helper && go build -o bin/ ./cmd/...)`)
  }
  console.log(`[sign-staged-update] packing ${unpackedDir} -> ${archivePath}`)
  const stdout = execFileSync(packerPath, ['--source', unpackedDir, '--out', archivePath], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  })

  let measured
  try {
    measured = JSON.parse(stdout.trim().split('\n').pop())
  } catch {
    fail(`packer did not report measurements as JSON: ${stdout}`)
  }
  for (const field of ['size', 'sha512', 'unpackedSize']) {
    if (measured[field] === undefined) fail(`packer omitted "${field}"`)
  }
  // The client enforces both of these; catching it here means a bad release
  // fails on the build machine instead of silently never updating anyone.
  if (measured.sha512.length !== 88 || Buffer.from(measured.sha512, 'base64').length !== 64) {
    fail('packer reported a digest that is not base64 SHA-512')
  }
  return measured
}

function main() {
  const args = parseArgs(process.argv)
  if (args.keygen) {
    keygen()
    return
  }

  for (const required of ['unpacked', 'out', 'version', 'channel', 'product-id', 'base-url']) {
    if (!args[required]) fail(`required: --${required}`)
  }
  if (args.channel !== 'stable' && args.channel !== 'experience') {
    fail(`--channel must be "stable" or "experience", got "${args.channel}"`)
  }

  const unpackedDir = resolve(args.unpacked)
  if (!statSync(unpackedDir, { throwIfNoEntry: false })?.isDirectory()) {
    fail(`--unpacked is not a directory: ${unpackedDir}`)
  }

  const outDir = resolve(args.out)
  mkdirSync(outDir, { recursive: true })

  const arch = args.arch ?? 'x64'
  const platform = args.platform ?? 'win'
  const archiveName = `halo-${args.version}-${platform}-${arch}.tar.zst`
  const archivePath = join(outDir, archiveName)

  const packerPath = resolve(
    args.packer ?? join('win-update-helper', 'bin', 'halo-update-packer')
  )
  const measured = pack(packerPath, unpackedDir, archivePath)

  const payload = {
    schema: SCHEMA,
    channel: args.channel,
    productId: args['product-id'],
    version: args.version,
    platform,
    arch,
    package: {
      url: `${args['base-url'].replace(/\/+$/, '')}/download/${archiveName}`,
      size: measured.size,
      sha512: measured.sha512,
      format: 'tar.zst',
      unpackedSize: measured.unpackedSize,
    },
    minHelperVersion: MIN_HELPER_VERSION,
    releaseDate: new Date().toISOString(),
  }
  if (args.notes) payload.releaseNotes = args.notes
  if (args.mandatory === 'true') payload.mandatory = true

  // The signature covers these exact bytes, and the client verifies against
  // the same bytes rather than a re-serialized object. Canonical-JSON schemes
  // are a well-known source of signature bypasses; transporting the payload
  // base64-encoded removes the question entirely.
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8')
  const envelope = {
    payload: payloadBytes.toString('base64'),
    signature: sign(null, payloadBytes, loadSigningKey()).toString('base64'),
    keyId: process.env.HALO_UPDATE_KEY_ID ?? 'default',
  }

  const descriptionPath = join(outDir, `staged-${platform}-${arch}.json`)
  writeFileSync(descriptionPath, JSON.stringify(envelope), 'utf8')

  console.log('')
  console.log(`  package     ${archiveName}`)
  console.log(`  size        ${(measured.size / 1024 / 1024).toFixed(1)} MiB`)
  console.log(`  unpacked    ${(measured.unpackedSize / 1024 / 1024).toFixed(1)} MiB`)
  console.log(`  description ${basename(descriptionPath)}`)
  console.log(`  channel     ${args.channel}`)
  console.log(`  version     ${args.version}`)
  console.log('')
  console.log('Upload BOTH files to the release, alongside the installer.')
}

main()
