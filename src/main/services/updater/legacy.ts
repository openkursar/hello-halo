/**
 * The electron-updater path.
 *
 * Drives macOS and Linux (which stage a build and relaunch in seconds) and
 * Windows builds that have not been moved onto the staged path. This is what
 * production users are running, and it stays the fallback whenever the staged
 * path declines to act.
 */

import { autoUpdater as nativeUpdater } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateConfig } from '../../foundation/product-config'
import type { UpdaterInstallMode } from '../../../shared/types/updater'
import {
  getAnnounced,
  offerManualDownload,
  sendUpdateStatus,
  setAnnounced,
  setAnnouncedPhase,
  type AnnouncedUpdate,
} from './status'

const { autoUpdater } = electronUpdater
type UpdateInfo = electronUpdater.UpdateInfo

/** Delay before quitAndInstall so windows finish closing first. */
const QUIT_AND_INSTALL_DELAY_MS = 300

/**
 * Whether a downloaded update still has to pass Squirrel.Mac before it can be
 * installed.
 *
 * On macOS electron-updater's "downloaded" only means its own download is
 * done. It then hands the zip to Squirrel.Mac, which unpacks it and requires
 * its code signature to match the running app's. Until Squirrel accepts it a
 * restart installs nothing, so the prompt waits for Squirrel's own
 * "update-downloaded", and a failure before that counts as an update that
 * never arrived. Squirrel starts on its own only because autoInstallOnAppQuit
 * is on, which it always is on macOS.
 */
const SQUIRREL_VERIFIES = process.platform === 'darwin'

/**
 * How this platform applies a downloaded update when electron-updater owns it.
 *
 * Windows runs the NSIS installer, which has its own visible progress;
 * macOS and Linux replace an already-staged build and relaunch.
 */
export const LEGACY_INSTALL_MODE: UpdaterInstallMode =
  process.platform === 'win32' ? 'installer' : 'restart'

/**
 * Whether the feed marks this release as one the user may not defer.
 *
 * `mandatory` is not part of electron-updater's UpdateInfo: the provider
 * returns the parsed channel yml as-is, so a field added at publish time
 * arrives here untouched and starts working without a client release. Only a
 * literal `true` counts — a malformed feed must never be able to trap users
 * behind a prompt they cannot close.
 */
function isMandatory(info: UpdateInfo): boolean {
  return (info as UpdateInfo & { mandatory?: unknown }).mandatory === true
}

/**
 * Point electron-updater at the configured feed.
 *
 * @returns false when this build has no usable feed and updates are disabled.
 */
export function configureLegacyFeed(updateConfig: UpdateConfig | undefined): boolean {
  autoUpdater.logger = console
  autoUpdater.autoDownload = updateConfig?.provider !== 'disabled'
  autoUpdater.autoInstallOnAppQuit = updateConfig?.provider !== 'disabled'

  if (updateConfig?.provider === 'disabled') {
    console.log('[Updater] Updates disabled by product configuration')
    return false
  }

  if (!updateConfig) {
    console.log('[Updater] No updateConfig in product.json, using default GitHub provider')
    return true
  }

  if (updateConfig.provider === 'generic') {
    if (!updateConfig.url) {
      console.log('[Updater] updateConfig.url is empty, auto-update disabled')
      return false
    }
    // channel is pinned rather than inherited from the packaged app-update.yml,
    // which electron-builder derives from the version ("rc" for 2.1.13-rc.3).
    // The internal release server generates latest.yml / latest-mac.yml on the
    // fly from whatever the newest published release is and has no per-channel
    // files, so any other channel resolves to its catch-all route. Do not
    // remove this: without it the updater asks for rc.yml and gets a 404.
    autoUpdater.setFeedURL({ provider: 'generic', url: updateConfig.url, channel: 'latest' })
    console.log('[Updater] Using custom update URL:', updateConfig.url)
  }

  return true
}

/**
 * Whether quitting the app runs a downloaded installer on its own.
 *
 * Off wherever the staged path is active. There the installer is only ever a
 * fallback, and letting a quit trigger it means the quit that hands over to the
 * swap helper would also start a silent NSIS install — two writers in one
 * install directory. With it off, what gets applied is decided only by the
 * user's click, and applyLegacy still installs explicitly.
 */
export function setLegacyInstallOnQuit(enabled: boolean): void {
  autoUpdater.autoInstallOnAppQuit = enabled
}

/**
 * Between electron-updater announcing a release and that release being ready
 * to apply — on macOS, until Squirrel.Mac has accepted it.
 */
let preparing = false

/**
 * Whether an announced release is still being downloaded or verified.
 *
 * Tracked regardless of who is driving, because the coordinator uses it to
 * avoid taking over mid-download: the handlers stand down when it does, and
 * the finished download would then never be announced. On macOS it also keeps
 * a second check from starting a second Squirrel job, which breaks the first
 * one mid-unpack.
 */
export function isLegacyPreparing(): boolean {
  return preparing
}

/** macOS: the update Squirrel.Mac has verified and holds until the user restarts. */
function heldBySquirrel(): AnnouncedUpdate | null {
  const announced = getAnnounced()
  return SQUIRREL_VERIFIES && announced?.phase === 'ready' ? announced : null
}

function announceReady(update: Pick<AnnouncedUpdate, 'version' | 'releaseNotes' | 'mandatory'>): void {
  setAnnounced({ ...update, phase: 'ready' })
  sendUpdateStatus('downloaded', {
    version: update.version,
    releaseNotes: update.releaseNotes,
    installMode: LEGACY_INSTALL_MODE,
    mandatory: update.mandatory,
  })
}

/** Wire electron-updater's events onto the shared status stream. */
export function installLegacyHandlers(options: {
  downloadPageUrl: (version: string) => string
  shouldHandle: () => boolean
}): void {
  // No download starts for the release macOS already holds (see checkLegacy).
  autoUpdater.on('update-available', (info: UpdateInfo) => {
    preparing = heldBySquirrel()?.version !== info.version
  })
  autoUpdater.on('update-not-available', () => { preparing = false })
  autoUpdater.on('update-downloaded', () => { if (!SQUIRREL_VERIFIES) preparing = false })
  autoUpdater.on('error', () => { preparing = false })
  if (SQUIRREL_VERIFIES) nativeUpdater.on('update-downloaded', () => { preparing = false })

  autoUpdater.on('checking-for-update', () => {
    if (!options.shouldHandle()) return
    console.log('[Updater] Checking for updates...')
    sendUpdateStatus('checking')
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    if (!options.shouldHandle()) return

    const held = heldBySquirrel()
    if (held?.version === info.version) {
      console.log(`[Updater] ${info.version} is already verified by macOS — repeating the restart prompt`)
      // Taken from the feed again: a release can be marked mandatory after
      // the user has deferred it.
      announceReady({ ...held, mandatory: isMandatory(info) })
      return
    }

    console.log('[Updater] Update available:', info.version)
    setAnnounced({
      version: info.version,
      // The feed omits the field entirely when a release carries no notes;
      // "no notes" has one spelling here so the renderer never sees two.
      releaseNotes: info.releaseNotes ?? null,
      mandatory: isMandatory(info),
      phase: 'downloading',
    })
    sendUpdateStatus('available', {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes,
    })

    // checkLegacy turned automatic download off for the held release; a newer
    // one replaces it. Failures arrive through the 'error' event.
    if (held) autoUpdater.downloadUpdate().catch(() => undefined)
  })

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    if (!options.shouldHandle()) return
    console.log('[Updater] No update available, current version is latest:', info.version)
    setAnnounced(null)
    sendUpdateStatus('not-available', { version: info.version })
  })

  autoUpdater.on('download-progress', (progress) => {
    if (!options.shouldHandle()) return
    sendUpdateStatus('downloading', {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total,
    })
  })

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    if (!options.shouldHandle()) return
    const update = {
      version: info.version,
      releaseNotes: info.releaseNotes ?? null,
      mandatory: isMandatory(info),
    }
    if (SQUIRREL_VERIFIES) {
      console.log(`[Updater] Update downloaded: ${info.version} — waiting for macOS to verify it`)
      setAnnounced({ ...update, phase: 'staging' })
      sendUpdateStatus('staging', { version: info.version })
      return
    }
    console.log('[Updater] Update downloaded:', info.version)
    announceReady(update)
  })

  if (SQUIRREL_VERIFIES) {
    nativeUpdater.on('update-downloaded', () => {
      if (!options.shouldHandle()) return
      const announced = getAnnounced()
      if (announced?.phase !== 'staging') {
        console.log(`[Updater] macOS finished verifying an update at phase=${announced?.phase ?? 'none'} — no prompt`)
        return
      }
      console.log(`[Updater] macOS verified ${announced.version} — ready to restart`)
      announceReady(announced)
    })
  }

  autoUpdater.on('error', (error) => {
    if (!options.shouldHandle()) return
    console.error('[Updater] Error:', error.stack || error.message)

    // An announced update that then fails to download, to pass macOS's check,
    // or to apply, would otherwise leave the user waiting on a toast that never
    // resolves. Hand them the download page so the release is still reachable.
    const version = getAnnounced()?.version
    if (version && offerManualDownload(options.downloadPageUrl(version))) {
      console.warn(`[Updater] ${version} cannot be applied automatically — offered the download page`)
      return
    }

    sendUpdateStatus('error', { message: error.message })
  })
}

/**
 * Check the feed, downloading a new release in the background.
 *
 * On macOS a release Squirrel.Mac already holds is not downloaded again: that
 * would hand the same zip back to Squirrel, which unpacks and verifies it all
 * over, and a restart clicked during that second pass races it. The feed is
 * still read, so a later `mandatory` flag or a newer release still arrives.
 */
export async function checkLegacy(): Promise<void> {
  autoUpdater.autoDownload = heldBySquirrel() === null
  await autoUpdater.checkForUpdates().catch(() => undefined)
}

/**
 * Apply via electron-updater.
 *
 * isSilent=false keeps the NSIS installer visible so a multi-second install
 * does not look like a hang, and isForceRunAfter=true reopens the app
 * afterwards. macOS and Linux ignore both and relaunch from the staged build.
 */
export function applyLegacy(downloadPageUrl: (version: string) => string): void {
  setAnnouncedPhase('applying')

  setTimeout(() => {
    try {
      autoUpdater.quitAndInstall(false, true)
    } catch (error) {
      console.error('[Updater] quitAndInstall failed:', error)
      // Squirrel reports most staging failures asynchronously through the
      // 'error' event; a synchronous throw never reaches it, so report here.
      const version = getAnnounced()?.version
      if (version) offerManualDownload(downloadPageUrl(version))
    }
  }, QUIT_AND_INSTALL_DELAY_MS)
}
