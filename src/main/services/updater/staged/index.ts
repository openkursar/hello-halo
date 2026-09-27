/**
 * The Windows staged update path.
 *
 * Replaces "download an installer, run it when the user clicks" with
 * "download and unpack while the app is in use, then swap directories on
 * exit". The expensive work moves off the moment the user is waiting.
 *
 * Everything here is written so that the worst outcome is *staying on the
 * current version*. The current install is never modified until the new one is
 * fully unpacked and verified beside it, and the swap is reversible until the
 * new version has proven it can start.
 */

import { app } from 'electron'
import { mkdir, readFile, readdir, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import {
  getUpdateChannel,
  getUpdateManifestPublicKey,
  loadProductConfig,
} from '../../../foundation/product-config'
import { downloadPackage, type DownloadProgress } from './download'
import {
  EXPECTED_HELPER_VERSION,
  launchApply,
  launchRollback,
  readHelperVersion,
  stagePackage,
} from './helper'
import { hasFailedBefore } from './failed-versions'
import { confirmFileFor, hasRoomToStage, HELPER_RUN_PREFIX, resolveLayout, type StagedLayout } from './layout'
import { readStagedManifest, type StagedUpdateManifest } from './manifest'

/**
 * Raised when the only update on offer is one that already failed here.
 *
 * Distinct from "no update", because the caller must also skip the installer
 * fallback: pushing the same release through the other mechanism would leave
 * the user on a version that cannot start, with no swap to roll back.
 */
export class VersionKnownBadError extends Error {
  readonly version: string
  constructor(version: string) {
    super(`update ${version} already failed to start on this machine`)
    this.name = 'VersionKnownBadError'
    this.version = version
  }
}

/** How long the helper waits for the new version to report that it started. */
const CONFIRM_TIMEOUT_SECONDS = 60

/** Shape the helper writes; only the fields this side must reason about. */
interface HelperState {
  phase?: string
  version?: string
  /** The helper running the apply; absent in states written before it was recorded. */
  helperPid?: number
}

/**
 * Rollback attempts before startup stops trying on its own.
 *
 * Each attempt quits and relaunches the app, so a rollback that can never
 * succeed would otherwise turn every start into a restart loop.
 */
const MAX_ROLLBACK_ATTEMPTS = 3

/** Counts rollback attempts across restarts; cleared once no update is in flight. */
function rollbackAttemptsFile(layout: StagedLayout): string {
  return join(layout.workDir, 'rollback-attempts')
}

async function readRollbackAttempts(layout: StagedLayout): Promise<number> {
  try {
    const n = Number.parseInt(await readFile(rollbackAttemptsFile(layout), 'utf8'), 10)
    return Number.isInteger(n) && n > 0 ? n : 0
  } catch {
    return 0
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means it exists but belongs to someone else — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** A package that is unpacked and waiting for the user to restart. */
export interface ReadyStagedUpdate {
  manifest: StagedUpdateManifest
  layout: StagedLayout
}

/**
 * Identity this build expects an update description to be addressed to.
 *
 * `dataFolderName` doubles as the product identity because it is the one field
 * the stable and preview builds deliberately share — an update signed for a
 * different product cannot be aimed at this one by relabelling.
 */
function expectedIdentity() {
  const product = loadProductConfig()
  return {
    channel: getUpdateChannel(),
    productId: product.dataFolderName ?? 'halo',
    platform: 'win',
    arch: process.arch === 'arm64' ? 'arm64' : 'x64',
    currentVersion: app.getVersion(),
    helperVersion: EXPECTED_HELPER_VERSION,
  }
}

/** URL of the signed description for this build's platform. */
function manifestUrl(feedUrl: string): string {
  const identity = expectedIdentity()
  return `${feedUrl.replace(/\/+$/, '')}/staged/${identity.platform}-${identity.arch}.json`
}

/**
 * Ask the feed whether a staged update exists, and whether we trust it.
 *
 * Returns null for every "no update" case — including every failure. A staged
 * update that cannot be verified is not an error the user needs to see; it is
 * a reason to leave this build exactly as it is.
 */
export async function checkForStagedUpdate(feedUrl: string): Promise<StagedUpdateManifest | null> {
  const publicKey = getUpdateManifestPublicKey()
  if (!publicKey) {
    console.error('[Updater] No manifest signing key in product.json — staged updates unavailable')
    return null
  }

  const helperVersion = await readHelperVersion()
  if (helperVersion === null) {
    console.warn('[Updater] Update helper is missing or unusable — staged updates unavailable')
    return null
  }
  if (helperVersion < EXPECTED_HELPER_VERSION) {
    console.warn(
      `[Updater] Bundled helper speaks v${helperVersion}, this build needs v${EXPECTED_HELPER_VERSION}`
    )
    return null
  }

  const url = manifestUrl(feedUrl)
  let body: string
  try {
    const response = await fetch(url)
    if (response.status === 404) {
      console.log(`[Updater] No staged update published for this target (${url})`)
      return null
    }
    if (!response.ok) {
      console.warn(`[Updater] Staged description request returned HTTP ${response.status}`)
      return null
    }
    // A release server that predates staged updates answers every unknown path
    // with its HTML download page, at HTTP 200. Without this check that page
    // reaches the verifier and is reported as a failed signature — a security
    // alarm on every check, raised by a server that is merely older than the
    // client. Absence of the feature is not tampering.
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.toLowerCase().includes('json')) {
      console.log('[Updater] Update server does not serve staged descriptions yet')
      return null
    }
    body = await response.text()
  } catch (error) {
    console.warn(`[Updater] Could not reach staged description at ${url}:`, error)
    return null
  }

  try {
    const manifest = readStagedManifest(body, publicKey, expectedIdentity())
    if (hasFailedBefore(resolveLayout().workDir, manifest.version)) {
      // Offering it again — by either mechanism — would restart the loop this
      // record exists to break. A newer release is the way out.
      console.warn(
        `[Updater] ${manifest.version} already failed to start on this machine — not offering it again`
      )
      throw new VersionKnownBadError(manifest.version)
    }
    console.log(`[Updater] Staged update available: ${manifest.version} (${manifest.package.size} bytes)`)
    return manifest
  } catch (error) {
    if (error instanceof VersionKnownBadError) throw error
    // A description that fails verification is the case this whole mechanism
    // exists to catch, so it is logged loudly even though it is not fatal.
    console.error(`[Updater] Rejected staged update description: ${String(error)}`)
    return null
  }
}

/**
 * Download and unpack an update beside the running one.
 *
 * On any failure the staging directory is removed, so a later attempt starts
 * clean and a half-unpacked tree can never be swapped into place.
 */
export async function prepareStagedUpdate(
  manifest: StagedUpdateManifest,
  onProgress: (progress: DownloadProgress) => void,
  signal: AbortSignal
): Promise<ReadyStagedUpdate> {
  const layout = resolveLayout()

  if (!hasRoomToStage(layout, manifest.package.size, manifest.package.unpackedSize)) {
    throw new Error(
      `not enough free disk space on ${layout.installDir} to prepare ${manifest.version} ` +
        `(needs ~${Math.round((manifest.package.size + manifest.package.unpackedSize) / 1e6)} MB)`
    )
  }

  await mkdir(layout.downloadDir, { recursive: true })
  const archivePath = join(layout.downloadDir, `${manifest.version}.tar.zst`)

  try {
    console.log(`[Updater] Downloading ${manifest.version} from ${manifest.package.url}`)
    const startedAt = Date.now()
    await downloadPackage(manifest.package.url, archivePath, manifest.package.size, onProgress, signal)
    console.log(`[Updater] Downloaded ${manifest.version} in ${Math.round((Date.now() - startedAt) / 1000)}s`)
    // The helper re-checks the digest before it unpacks; this side never
    // decides that bytes are trustworthy.
    await stagePackage(layout, archivePath, manifest.package.sha512, manifest.version)
  } catch (error) {
    await rm(layout.stagedDir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  } finally {
    // The archive has served its purpose either way and is the largest thing
    // we wrote; leaving it behind doubles the update's disk cost.
    await rm(archivePath, { force: true }).catch(() => undefined)
  }

  return { manifest, layout }
}

/**
 * Quit and let the helper swap in the prepared version.
 *
 * Returns only if the handover could not be started — in that case nothing has
 * been touched and the caller should fall back to the installer.
 */
export async function applyStagedUpdate(ready: ReadyStagedUpdate): Promise<void> {
  const confirmFile = confirmFileFor(ready.layout, ready.manifest.version)
  await rm(confirmFile, { force: true }).catch(() => undefined)

  await launchApply(ready.layout, ready.manifest.version, confirmFile, CONFIRM_TIMEOUT_SECONDS)

  // The helper is waiting on this process to exit before it moves anything.
  console.log(`[Updater] Quitting to apply ${ready.manifest.version}`)
  app.quit()
}

/** Read the helper's state file, or null when there is no update in flight. */
async function readHelperState(layout: StagedLayout): Promise<HelperState | null> {
  if (!existsSync(layout.stateFile)) return null
  try {
    return JSON.parse(await readFile(layout.stateFile, 'utf8')) as HelperState
  } catch (error) {
    console.error('[Updater] Update state file is unreadable:', error)
    return null
  }
}

/**
 * Decide what an update left behind at startup means, and act on it.
 *
 * Three situations produce a state file, and telling them apart is the whole
 * job — rolling back the successful case would undo every update on its first
 * launch.
 */
export async function reconcileStagedUpdateOnStartup(): Promise<void> {
  const layout = resolveLayout()
  const state = await readHelperState(layout)
  if (!state) {
    await pruneLeftovers(layout)
    return
  }

  // A helper still running owns the install directory: it is mid-swap, or
  // waiting for a confirmation it will act on either way. Touching the
  // directory now would race it — and this start may be the user relaunching
  // by hand while the swap is in progress.
  if (typeof state.helperPid === 'number' && state.helperPid > 0 && isProcessAlive(state.helperPid)) {
    console.log(`[Updater] Update helper (pid ${state.helperPid}) is still working — leaving the install directory to it`)
    return
  }

  const ourVersion = app.getVersion()

  if (state.phase === 'awaiting-confirm' && state.version === ourVersion) {
    // The swap worked and we are the version it installed. Saying so is what
    // lets the helper drop the backup and finish.
    const confirmFile = confirmFileFor(layout, ourVersion)
    try {
      await mkdir(layout.workDir, { recursive: true })
      await writeFile(confirmFile, new Date().toISOString(), 'utf8')
      console.log(`[Updater] Confirmed healthy start on ${ourVersion}`)
    } catch (error) {
      // Failing to confirm is not fatal here: the helper will time out and put
      // the previous version back, which is the safe direction.
      console.error('[Updater] Could not write update confirmation:', error)
    }
    return
  }

  // Either the swap was interrupted midway, or it finished but the version
  // that came up is not the one it installed. Both mean: go back.
  const attempts = await readRollbackAttempts(layout)
  if (attempts >= MAX_ROLLBACK_ATTEMPTS) {
    console.error(
      `[Updater] Interrupted update still not rolled back after ${attempts} attempts — ` +
        `not retrying; a reinstall may be required (see ${layout.helperLog})`
    )
    return
  }
  console.warn(
    `[Updater] Recovering interrupted update (phase=${String(state.phase)}, ` +
      `target=${String(state.version)}, running=${ourVersion}, attempt ${attempts + 1})`
  )
  try {
    await mkdir(layout.workDir, { recursive: true })
    await writeFile(rollbackAttemptsFile(layout), String(attempts + 1), 'utf8')
    await launchRollback(layout)
  } catch (error) {
    // Nothing moved; the next start tries again, up to the cap.
    console.error('[Updater] Could not start the rollback helper:', error)
    return
  }
  console.log('[Updater] Quitting so the helper can restore the previous version')
  app.quit()
}

/**
 * Remove what finished updates leave in the work directory.
 *
 * Confirmation files accumulate one per update, and a stale one matching a
 * future version would let a swap confirm itself. Helper copies are left
 * behind by every apply and rollback because a running executable cannot
 * delete itself. The attempts counter belongs to a recovery that is over.
 * Only called with no update in flight, so no helper is using any of them.
 */
async function pruneLeftovers(layout: StagedLayout): Promise<void> {
  if (!existsSync(layout.workDir)) return
  try {
    const entries = await readdir(layout.workDir)
    await Promise.all(
      entries
        .filter((name) =>
          (name.startsWith('confirmed-') && name.endsWith('.ok')) ||
          (name.startsWith(HELPER_RUN_PREFIX) && name.endsWith('.exe')) ||
          name === 'rollback-attempts'
        )
        .map((name) => rm(join(layout.workDir, name), { force: true }).catch(() => undefined))
    )
  } catch (error) {
    console.warn('[Updater] Could not tidy the update work directory:', error)
  }
}

/** Discard a prepared update that is no longer wanted. */
export async function discardStagedUpdate(): Promise<void> {
  const layout = resolveLayout()
  await rm(layout.stagedDir, { recursive: true, force: true }).catch(() => undefined)
  await rm(layout.downloadDir, { recursive: true, force: true }).catch(() => undefined)
}
