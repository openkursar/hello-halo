/**
 * The electron-updater path.
 *
 * Drives macOS and Linux (which stage a build and relaunch in seconds) and
 * Windows builds that have not been moved onto the staged path. Behaviour here
 * is deliberately unchanged from before the staged path existed: this is what
 * production users are running, and it stays the fallback whenever the staged
 * path declines to act.
 */

import electronUpdater from 'electron-updater'
import type { UpdateConfig } from '../../foundation/product-config'
import type { UpdaterInstallMode } from '../../../shared/types/updater'
import {
  getAnnounced,
  offerManualDownload,
  sendUpdateStatus,
  setAnnounced,
  setAnnouncedPhase,
} from './status'

const { autoUpdater } = electronUpdater
type UpdateInfo = electronUpdater.UpdateInfo

/** Delay before quitAndInstall so windows finish closing first. */
const QUIT_AND_INSTALL_DELAY_MS = 300

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
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

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

/** Between electron-updater announcing a release and it finishing the download. */
let downloading = false

/**
 * Whether electron-updater is mid-download.
 *
 * Tracked regardless of who is driving, because the coordinator uses it to
 * avoid taking over mid-download: the handlers stand down when it does, and
 * the finished download would then never be announced.
 */
export function isLegacyDownloading(): boolean {
  return downloading
}

/** Wire electron-updater's events onto the shared status stream. */
export function installLegacyHandlers(options: {
  downloadPageUrl: (version: string) => string
  shouldHandle: () => boolean
}): void {
  autoUpdater.on('update-available', () => { downloading = true })
  autoUpdater.on('update-not-available', () => { downloading = false })
  autoUpdater.on('update-downloaded', () => { downloading = false })
  autoUpdater.on('error', () => { downloading = false })

  autoUpdater.on('checking-for-update', () => {
    if (!options.shouldHandle()) return
    console.log('[Updater] Checking for updates...')
    sendUpdateStatus('checking')
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    if (!options.shouldHandle()) return
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
    console.log('[Updater] Update downloaded:', info.version)
    const mandatory = isMandatory(info)
    setAnnounced({
      version: info.version,
      releaseNotes: info.releaseNotes ?? null,
      mandatory,
      phase: 'ready',
    })
    sendUpdateStatus('downloaded', {
      version: info.version,
      releaseNotes: info.releaseNotes,
      installMode: LEGACY_INSTALL_MODE,
      mandatory,
    })
  })

  autoUpdater.on('error', (error) => {
    if (!options.shouldHandle()) return
    console.error('[Updater] Error:', error.stack || error.message)

    // An announced update that then fails to download, or fails while being
    // applied, would otherwise leave the user waiting on a toast that never
    // resolves. Hand them the download page so the release is still reachable.
    const version = getAnnounced()?.version
    if (version && offerManualDownload(options.downloadPageUrl(version))) return

    sendUpdateStatus('error', { message: error.message })
  })
}

export async function checkLegacy(): Promise<void> {
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
