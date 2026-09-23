/**
 * Halo Auto-Updater
 *
 * Update strategy is unchanged: check 5s after launch, hourly, and on wake
 * from sleep; download in the background; apply on user confirmation.
 *
 * What differs is how "apply" works on Windows. The installer path makes the
 * user wait through extraction and file replacement *after* they click. The
 * staged path does that work while the app is still in use, so the click costs
 * a quit and a relaunch.
 *
 * Which path runs is decided by product.json at build time, never at runtime,
 * and the staged path declines to act — falling back to the installer — on
 * every condition it is not completely sure about. Staying on the current
 * version is always an acceptable outcome; a half-applied update is not.
 *
 * A release can additionally be marked `mandatory: true` in its feed, which
 * the renderer turns into a prompt with no defer and no dismiss.
 */

import { app, ipcMain, powerMonitor } from 'electron'
import { is } from '@electron-toolkit/utils'
import {
  getUpdateChannel,
  getWindowsUpdateMode,
  loadProductConfig,
  type UpdateConfig,
} from '../../foundation/product-config'
import {
  applyLegacy,
  checkLegacy,
  configureLegacyFeed,
  installLegacyHandlers,
  isLegacyDownloading,
  setLegacyInstallOnQuit,
} from './legacy'
import {
  applyStagedUpdate,
  checkForStagedUpdate,
  discardStagedUpdate,
  prepareStagedUpdate,
  reconcileStagedUpdateOnStartup,
  VersionKnownBadError,
  type ReadyStagedUpdate,
} from './staged'
import { getAnnounced, offerManualDownload, sendUpdateStatus, setAnnounced, setAnnouncedPhase } from './status'

/** Delay before the first update check after startup (ms). */
const STARTUP_CHECK_DELAY_MS = 5000

/** Interval between periodic update checks (ms). */
const CHECK_INTERVAL_MS = 60 * 60 * 1000

/** Delay after system resume before checking for updates (ms). */
const RESUME_CHECK_DELAY_MS = 3000

/** Minimum gap between automatic checks, to prevent spam. */
const MIN_CHECK_INTERVAL_MS = 5 * 60 * 1000

let lastCheckTime = 0
let updateConfig: UpdateConfig | undefined
let legacyEnabled = false

/** True once this build has decided it is running the staged Windows path. */
let stagedPathActive = false

/** A staged update that is unpacked and waiting for the user to restart. */
let stagedReady: ReadyStagedUpdate | null = null

/** Guards against two preparations running at once. */
let stagedInFlight: AbortController | null = null

/**
 * Whether electron-updater owns the check currently in flight.
 *
 * Its handlers follow who is driving right now, not whether the staged path is
 * configured: the staged path declines for ordinary reasons (up to date, no
 * package for this platform, helper unavailable) and the check then falls
 * through to electron-updater, whose answer must still reach the UI.
 */
let legacyDriving = process.platform !== 'win32'

/**
 * Whether the staged path owns this platform.
 *
 * Read once at init and cached: the answer is a build-time property, and
 * re-deriving it per event would let a mid-session config reload split one
 * update across two mechanisms.
 */
function resolveStagedPath(): boolean {
  if (process.platform !== 'win32') return false
  if (getWindowsUpdateMode() !== 'staged') return false
  if (updateConfig?.provider !== 'generic' || !updateConfig.url) {
    console.warn('[Updater] Staged updates need a generic feed URL — using installer path')
    return false
  }
  return true
}

/**
 * Download page shown when an update cannot be applied automatically.
 */
function downloadPageUrl(version: string): string {
  if (!updateConfig) return ''
  const { provider, url, owner, repo } = updateConfig
  if (provider === 'generic' && url) return url
  if (provider === 'github' && owner && repo) {
    return `https://github.com/${owner}/${repo}/releases/tag/v${version}`
  }
  return ''
}

/**
 * Initialize the updater.
 *
 * Both paths are wired: the staged path handles Windows builds configured for
 * it, and the legacy path stays available underneath as the fallback for every
 * case the staged path refuses.
 */
export function initAutoUpdater(): void {
  if (is.dev) {
    console.log('[Updater] Skipping auto-update in development mode')
    return
  }

  updateConfig = loadProductConfig().updateConfig
  legacyEnabled = configureLegacyFeed(updateConfig)
  stagedPathActive = resolveStagedPath()
  setLegacyInstallOnQuit(!stagedPathActive)

  console.log(
    `[Updater] channel=${getUpdateChannel()} platform=${process.platform} ` +
      `mode=${stagedPathActive ? 'staged' : 'legacy'}`
  )

  // A build with no usable feed wires nothing up at all — leaving listeners on
  // the electron-updater singleton would be a side effect from a subsystem
  // that just declared itself inactive.
  if (!legacyEnabled && !stagedPathActive) {
    console.log('[Updater] No usable update feed for this build — auto-update disabled')
    return
  }

  if (stagedPathActive) {
    // An update applied last session leaves a record behind; deciding what it
    // means has to happen before anything else touches the install directory.
    reconcileStagedUpdateOnStartup().catch((error) =>
      console.error('[Updater] Startup reconciliation failed:', error)
    )
  }

  // Legacy handlers stand down while the staged path is driving so a single
  // release cannot be announced twice.
  legacyDriving = !stagedPathActive
  installLegacyHandlers({
    downloadPageUrl,
    shouldHandle: () => legacyDriving,
  })

  setTimeout(() => void autoCheckForUpdates(), STARTUP_CHECK_DELAY_MS)
  setInterval(() => void autoCheckForUpdates(), CHECK_INTERVAL_MS)

  powerMonitor.on('resume', () => {
    console.log('[Updater] System resumed from sleep, scheduling update check')
    setTimeout(() => void autoCheckForUpdates(), RESUME_CHECK_DELAY_MS)
  })

  console.log('[Updater] Initialized, check interval:', CHECK_INTERVAL_MS / 1000 / 60, 'minutes')
}

function canCheck(): boolean {
  const now = Date.now()
  if (now - lastCheckTime < MIN_CHECK_INTERVAL_MS) {
    console.log('[Updater] Skipping check, too soon since last check')
    return false
  }
  lastCheckTime = now
  return true
}

/**
 * Run the staged check-and-prepare cycle.
 *
 * Returns false when the staged path declined for any reason, which tells the
 * caller to let electron-updater handle this check instead.
 */
async function runStagedCycle(): Promise<boolean> {
  if (!updateConfig?.url) return false

  // Already prepared and waiting: re-announce rather than fetch again, so a
  // periodic check does not restart work that is finished.
  if (stagedReady) {
    announceStagedReady(stagedReady)
    return true
  }
  if (stagedInFlight) return true

  const manifest = await checkForStagedUpdate(updateConfig.url)
  if (!manifest) {
    console.log('[Updater] Staged path declined this check — falling back to the installer path')
    return false
  }

  setAnnounced({
    version: manifest.version,
    releaseNotes: manifest.releaseNotes ?? null,
    mandatory: manifest.mandatory === true,
    phase: 'downloading',
  })
  sendUpdateStatus('available', {
    version: manifest.version,
    releaseDate: manifest.releaseDate,
    releaseNotes: manifest.releaseNotes ?? null,
  })

  const controller = new AbortController()
  stagedInFlight = controller

  try {
    const ready = await prepareStagedUpdate(
      manifest,
      (progress) =>
        sendUpdateStatus('downloading', {
          percent: progress.percent,
          bytesPerSecond: progress.bytesPerSecond,
          transferred: progress.transferred,
          total: progress.total,
        }),
      controller.signal
    )

    setAnnouncedPhase('staging')
    sendUpdateStatus('staging', { version: manifest.version })

    stagedReady = ready
    announceStagedReady(ready)
    return true
  } catch (error) {
    console.error('[Updater] Could not prepare staged update:', error)
    await discardStagedUpdate()
    // Falling back rather than reporting an error: the installer path can
    // still deliver this release, and the user need not know which mechanism
    // was used.
    setAnnounced(null)
    return false
  } finally {
    stagedInFlight = null
  }
}

function announceStagedReady(ready: ReadyStagedUpdate): void {
  const mandatory = ready.manifest.mandatory === true
  setAnnounced({
    version: ready.manifest.version,
    releaseNotes: ready.manifest.releaseNotes ?? null,
    mandatory,
    phase: 'ready',
  })
  sendUpdateStatus('downloaded', {
    version: ready.manifest.version,
    releaseNotes: ready.manifest.releaseNotes ?? null,
    installMode: 'swap',
    mandatory,
  })
}

/**
 * Background check. Downloads without prompting; the user is asked once the
 * update is ready to apply.
 */
export async function autoCheckForUpdates(): Promise<void> {
  if (is.dev || !canCheck()) return
  await performCheck()
}

/**
 * User-triggered check from Settings. Same outcome as the background check;
 * the difference is only that the throttle is bypassed.
 */
export async function manualCheckForUpdates(): Promise<void> {
  if (is.dev) {
    sendUpdateStatus('not-available', { version: app.getVersion() })
    return
  }
  lastCheckTime = Date.now()
  await performCheck()
}

async function performCheck(): Promise<void> {
  // Taking over mid-download would mute the handlers that announce the
  // finished download, leaving the user without a prompt until a later check.
  if (legacyDriving && isLegacyDownloading()) {
    console.log('[Updater] Installer download still in progress — leaving this check to it')
    return
  }

  if (stagedPathActive) {
    console.log('[Updater] Checking for updates (staged path)...')
    legacyDriving = false
    sendUpdateStatus('checking')
    try {
      if (await runStagedCycle()) return
    } catch (error) {
      if (error instanceof VersionKnownBadError) {
        // The installer would deliver the same release, and that path has no
        // way back. Report "up to date" and wait for a newer one.
        console.warn(`[Updater] Staying on ${app.getVersion()}; ${error.version} cannot start here`)
        sendUpdateStatus('not-available', { version: app.getVersion() })
        return
      }
      console.error('[Updater] Staged check failed, falling back:', error)
    }
    // The staged path had nothing to offer. electron-updater still decides
    // whether a release exists at all, so it also produces the
    // "you are up to date" answer the user is waiting for — which only
    // reaches them if its handlers are listening again.
  }

  if (!legacyEnabled) {
    console.log('[Updater] No installer feed either — reporting up to date')
    sendUpdateStatus('not-available', { version: app.getVersion() })
    return
  }

  legacyDriving = true
  await checkLegacy()
}

/**
 * Apply the prepared update.
 *
 * The staged path quits and hands over to the helper; everything else goes
 * through electron-updater. A staged handover that cannot even be started
 * falls back rather than leaving the user on a dead button.
 */
export function quitAndInstall(): void {
  setAnnouncedPhase('applying')

  if (stagedPathActive && stagedReady) {
    const ready = stagedReady
    applyStagedUpdate(ready).catch((error) => {
      console.error('[Updater] Staged handover failed:', error)
      stagedReady = null
      if (!offerManualDownload(downloadPageUrl(ready.manifest.version))) {
        sendUpdateStatus('error', { message: 'Update could not be started' })
      }
    })
    return
  }

  applyLegacy(downloadPageUrl)
}

export function registerUpdaterHandlers(): void {
  ipcMain.handle('updater:check', async () => {
    await manualCheckForUpdates()
  })

  ipcMain.handle('updater:install', () => {
    quitAndInstall()
  })

  ipcMain.handle('updater:get-version', () => app.getVersion())

  // The renderer shows which feed the build follows; it must come from the
  // same place the updater reads it, not from a second copy in the UI.
  ipcMain.handle('updater:get-channel', () => getUpdateChannel())
}

/** Current announced update, exposed for diagnostics. */
export { getAnnounced }
