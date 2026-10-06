'use strict'

/**
 * Staged Windows update artifacts for an electron-builder run.
 *
 * Wired as electron-builder's `afterAllArtifactBuild`. When the product enables
 * staged Windows updates, this signs the update package and its description
 * (sign-staged-update.mjs) and returns both, so electron-builder publishes them
 * next to the installer. The signer reads the private key from the environment;
 * this file only checks that it is set and belongs to the product's public key.
 *
 * verify-inputs applies the same plan before a release starts, because the
 * release flow packs with `--publish never` and uploads on its own.
 */

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { createPrivateKey, createPublicKey } = require('node:crypto')

const ROOT = path.join(__dirname, '..', '..')
const SIGNER = path.join(__dirname, 'sign-staged-update.mjs')
const KEY_ENV = 'HALO_UPDATE_SIGNING_KEY'

/** Whether this electron-builder run uploads what it builds (`--publish` other than "never"). */
function isPublishing(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    let value
    if (arg === '--publish' || arg === '-p') value = argv[i + 1]
    else if (arg.startsWith('--publish=')) value = arg.slice('--publish='.length)
    else continue
    return value !== undefined && value !== 'never'
  }
  return false
}

/**
 * Clients verify against the public key in product.json. A private key from
 * another pair signs without complaint and yields a release every client
 * rejects, so the pair is checked before anything is packed.
 */
function keyPairProblem(signingKey, publicKey) {
  let derived
  try {
    const privateKey = createPrivateKey({
      key: Buffer.from(signingKey.trim(), 'base64'),
      format: 'der',
      type: 'pkcs8',
    })
    derived = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
  } catch (error) {
    return `${KEY_ENV} is not a usable Ed25519 private key (${error.message})`
  }
  if (!derived.equals(Buffer.from(publicKey.trim(), 'base64'))) {
    return `${KEY_ENV} does not belong to updateConfig.manifestPublicKey — every client would reject the signed description`
  }
  return null
}

/**
 * What this build owes the staged path. Pure, so the release rules can be
 * tested without packing anything.
 */
function planStagedArtifacts({ product, builtWindows, publishing, signingKey, outDir, version }) {
  const update = product.updateConfig ?? {}
  if (!builtWindows) return { action: 'skip' }
  if (update.windowsMode !== 'staged' || !update.manifestPublicKey?.trim()) return { action: 'skip' }

  const channel = update.channel === 'experience' ? 'experience' : 'stable'
  let feedArgs
  if (update.provider === 'github' && update.owner && update.repo) {
    // Clients read GitHub descriptions from the latest release, which is never
    // a prerelease, so a preview build has nothing to sign for.
    if (channel !== 'stable') return { action: 'skip' }
    feedArgs = ['--github', `${update.owner}/${update.repo}`]
  } else if (update.provider === 'generic' && update.url) {
    feedArgs = ['--base-url', update.url]
  } else {
    return { action: 'fail', reason: 'updateConfig enables staged updates but names no usable feed' }
  }

  if (!signingKey?.trim()) {
    if (publishing) {
      return {
        action: 'fail',
        reason:
          `staged Windows updates are enabled but ${KEY_ENV} is not set — refusing to publish ` +
          'a release whose clients would silently stay on the installer path',
      }
    }
    return { action: 'skip', warning: `${KEY_ENV} is not set — this build produces no staged update files` }
  }

  const keyProblem = keyPairProblem(signingKey, update.manifestPublicKey)
  if (keyProblem) return { action: 'fail', reason: keyProblem }

  // The update helper is built for x64 only, so only the x64 tree is packed.
  return {
    action: 'sign',
    args: [
      '--unpacked', path.join(outDir, 'win-unpacked'),
      '--out', outDir,
      '--version', version,
      '--channel', channel,
      '--product-id', product.dataFolderName ?? 'halo',
      ...feedArgs,
    ],
    outputs: [
      path.join(outDir, `halo-${version}-win-x64.tar.zst`),
      path.join(outDir, 'staged-win-x64.json'),
    ],
  }
}

function readAppVersion() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).version
}

/** electron-builder hook bound to the product being built. */
function createStagedArtifactsHook(product) {
  return async function afterAllArtifactBuild(buildResult) {
    const plan = planStagedArtifacts({
      product,
      builtWindows: [...buildResult.platformToTargets.keys()].some((platform) => platform.name === 'windows'),
      publishing: isPublishing(process.argv),
      signingKey: process.env[KEY_ENV],
      outDir: buildResult.outDir,
      version: buildResult.configuration?.extraMetadata?.version ?? readAppVersion(),
    })

    if (plan.action === 'fail') throw new Error(`[staged-artifacts] ${plan.reason}`)
    if (plan.action === 'skip') {
      if (plan.warning) console.warn(`[staged-artifacts] ${plan.warning}`)
      return []
    }

    execFileSync(process.execPath, [SIGNER, ...plan.args], { cwd: ROOT, stdio: 'inherit' })
    for (const file of plan.outputs) {
      if (!fs.existsSync(file)) throw new Error(`[staged-artifacts] signer did not produce ${file}`)
    }
    return plan.outputs
  }
}

module.exports = { createStagedArtifactsHook, planStagedArtifacts, isPublishing }
