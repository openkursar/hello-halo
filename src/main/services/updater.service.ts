/**
 * Halo Auto-Updater Service
 *
 * Update Strategy:
 * - Startup check: 5 seconds after app launch
 * - Periodic check: Every hour via setInterval
 * - Resume check: When system wakes from sleep
 * - Manual check: User-triggered from Settings
 *
 * All platforms download in the background and apply the update on user
 * confirmation. Applying differs by platform (see INSTALL_MODE): Windows runs
 * the NSIS installer, macOS and Linux swap the already-staged build in place.
 *
 * If anything fails after an update was announced, the user is offered the
 * download page instead — a stalled progress toast is never a valid end state.
 */

// Node/Electron imports
import { app, ipcMain, powerMonitor } from 'electron'

// Third-party imports
import electronUpdater from 'electron-updater'
import { is } from '@electron-toolkit/utils'

// Local imports
import { getMainWindow } from '../foundation/window.service'
import { loadProductConfig, UpdateConfig } from '../foundation/product-config'

// Type imports
const { autoUpdater } = electronUpdater
type UpdateInfo = electronUpdater.UpdateInfo

// ============================================================================
// Constants
// ============================================================================

/** Delay before quitAndInstall to ensure windows close properly (ms) */
const QUIT_AND_INSTALL_DELAY_MS = 300

/** Delay before first update check after startup (ms) */
const STARTUP_CHECK_DELAY_MS = 5000

/** Interval between periodic update checks (ms) - 1 hour */
const CHECK_INTERVAL_MS = 60 * 60 * 1000

/** Delay after system resume before checking for updates (ms) */
const RESUME_CHECK_DELAY_MS = 3000

/**
 * How a downloaded update gets applied.
 * - 'installer': Windows quits and runs the NSIS installer, which has its own UI.
 * - 'restart': macOS (Squirrel swaps the staged bundle) and Linux (AppImage
 *   replaces itself) apply in place and relaunch within seconds, no extra UI.
 */
const INSTALL_MODE: 'installer' | 'restart' = process.platform === 'win32' ? 'installer' : 'restart'

// ============================================================================
// State
// ============================================================================

/** Track last check time to avoid duplicate checks */
let lastCheckTime = 0

/** Minimum interval between checks (5 minutes) to prevent spam */
const MIN_CHECK_INTERVAL_MS = 5 * 60 * 1000

/** Cached update config for constructing download URLs */
let cachedUpdateConfig: UpdateConfig | undefined

/** Update announced to the renderer but not yet downloaded, if any. */
let pendingUpdate: { version: string; releaseNotes: UpdateInfo['releaseNotes'] } | null = null

// ============================================================================
// Configuration
// ============================================================================

/**
 * Construct the download page URL based on updateConfig
 * - For 'generic' provider: use the configured URL directly
 * - For 'github' provider: construct GitHub releases URL from owner/repo
 * - Fallback: empty string (no download link)
 */
function getDownloadPageUrl(version: string): string {
  if (!cachedUpdateConfig) {
    return ''
  }

  const { provider, url, owner, repo } = cachedUpdateConfig

  if (provider === 'generic' && url) {
    // Internal server: use the configured URL directly
    return url
  }

  if (provider === 'github') {
    // GitHub: construct releases page URL
    if (owner && repo) {
      return `https://github.com/${owner}/${repo}/releases/tag/v${version}`
    }
  }

  return ''
}

// Configure logging
autoUpdater.logger = console

autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = true

// ============================================================================
// Event Handlers
// ============================================================================

/**
 * Initialize auto-updater event handlers and periodic checks
 */
export function initAutoUpdater(): void {
  // Skip updates in development
  if (is.dev) {
    console.log('[Updater] Skipping auto-update in development mode')
    return
  }

  // ========================================
  // Check updateConfig from product.json
  // ========================================
  const productConfig = loadProductConfig()
  const updateConfig = productConfig.updateConfig

  // Cache updateConfig for constructing download URLs later
  cachedUpdateConfig = updateConfig

  if (!updateConfig) {
    console.log('[Updater] No updateConfig in product.json, using default GitHub provider')
  } else if (updateConfig.provider === 'generic' && !updateConfig.url) {
    // Empty URL means updates are disabled (e.g., internal network version)
    console.log('[Updater] updateConfig.url is empty, auto-update disabled')
    return
  } else if (updateConfig.provider === 'generic' && updateConfig.url) {
    // channel is pinned rather than inherited from the packaged app-update.yml,
    // which electron-builder derives from the version ("rc" for 2.1.13-rc.3).
    // The internal release server generates latest.yml / latest-mac.yml on the
    // fly from whatever the newest published release is and has no per-channel
    // files, so any other channel resolves to its catch-all route. Do not
    // remove this: without it the updater asks for rc.yml and gets a 404.
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: updateConfig.url,
      channel: 'latest'
    })
    console.log('[Updater] Using custom update URL:', updateConfig.url)
  }
  // For 'github' provider, use default configuration from electron-builder.yml

  // Set up event handlers
  autoUpdater.on('checking-for-update', () => {
    console.log('[Updater] Checking for updates...')
    sendUpdateStatus('checking')
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    console.log('[Updater] Update available:', info.version)
    pendingUpdate = { version: info.version, releaseNotes: info.releaseNotes }
    sendUpdateStatus('available', {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes
    })
  })

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    console.log('[Updater] No update available, current version is latest:', info.version)
    pendingUpdate = null
    sendUpdateStatus('not-available', { version: info.version })
  })

  autoUpdater.on('download-progress', (progress) => {
    console.log(`[Updater] Download progress: ${progress.percent.toFixed(1)}%`)
    sendUpdateStatus('downloading', {
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      transferred: progress.transferred,
      total: progress.total
    })
  })

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    console.log('[Updater] Update downloaded:', info.version)
    pendingUpdate = null
    sendUpdateStatus('downloaded', {
      version: info.version,
      releaseNotes: info.releaseNotes,
      installMode: INSTALL_MODE
    })
  })

  autoUpdater.on('error', (error) => {
    console.error('[Updater] Error:', error.stack || error.message)

    // An announced update that then fails to download or stage would otherwise
    // leave the user on a progress toast that never completes. Hand them the
    // download page so the release is still reachable.
    if (pendingUpdate) {
      const { version, releaseNotes } = pendingUpdate
      pendingUpdate = null
      sendUpdateStatus('manual-download', {
        version,
        releaseNotes,
        downloadUrl: getDownloadPageUrl(version)
      })
      return
    }

    sendUpdateStatus('error', { message: error.message })
  })

  // ========================================
  // Update Check Scheduling
  // ========================================

  // 1. Startup check (with delay to not block app launch)
  setTimeout(() => {
    autoCheckForUpdates()
  }, STARTUP_CHECK_DELAY_MS)

  // 2. Periodic check (every hour)
  setInterval(() => {
    autoCheckForUpdates()
  }, CHECK_INTERVAL_MS)

  // 3. Resume check (when system wakes from sleep)
  powerMonitor.on('resume', () => {
    console.log('[Updater] System resumed from sleep, scheduling update check')
    setTimeout(() => {
      autoCheckForUpdates()
    }, RESUME_CHECK_DELAY_MS)
  })

  console.log('[Updater] Initialized with periodic check interval:', CHECK_INTERVAL_MS / 1000 / 60, 'minutes')
}

// ============================================================================
// Update Check Functions
// ============================================================================

/**
 * Send update status to renderer
 */
function sendUpdateStatus(
  status: 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'manual-download' | 'error',
  data?: Record<string, unknown>
): void {
  const mainWindow = getMainWindow()
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater:status', { status, ...data })
  }
}

/**
 * Check if enough time has passed since last check
 */
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
 * Automatic background check for updates.
 * Downloads in the background; the user is prompted once it is ready to apply.
 */
export async function autoCheckForUpdates(): Promise<void> {
  if (is.dev) {
    console.log('[Updater] Skipping update check in development mode')
    return
  }

  if (!canCheck()) {
    return
  }

  // Rejections are already reported through the 'error' event handler.
  await autoUpdater.checkForUpdates().catch(() => undefined)
}

/**
 * Manual check for updates (user-triggered from Settings).
 * Behaves like the background check so the outcome is consistent; the
 * difference is only that the user gets immediate 'checking' feedback.
 */
export async function manualCheckForUpdates(): Promise<void> {
  if (is.dev) {
    console.log('[Updater] Skipping update check in development mode')
    sendUpdateStatus('not-available', { version: app.getVersion() })
    return
  }

  // Manual check bypasses the time throttle
  lastCheckTime = Date.now()

  await autoUpdater.checkForUpdates().catch(() => undefined)
}

// ============================================================================
// Installation
// ============================================================================

/**
 * Apply the downloaded update.
 *
 * The arguments only affect Windows: isSilent=false keeps the NSIS installer
 * visible so a multi-second install does not look like a hang, and
 * isForceRunAfter=true reopens Halo afterwards. macOS and Linux ignore them and
 * relaunch straight from the already-staged build.
 *
 * The delay lets windows finish closing before the installer starts.
 * @see https://github.com/electron-userland/electron-builder/issues/1368
 */
export function quitAndInstall(): void {
  setTimeout(() => {
    try {
      autoUpdater.quitAndInstall(false, true)
    } catch (error) {
      console.error('[Updater] quitAndInstall failed:', error)
    }
  }, QUIT_AND_INSTALL_DELAY_MS)
}

// ============================================================================
// IPC Handlers
// ============================================================================

/**
 * Register IPC handlers for updater
 */
export function registerUpdaterHandlers(): void {
  ipcMain.handle('updater:check', async () => {
    await manualCheckForUpdates()
  })

  ipcMain.handle('updater:install', () => {
    quitAndInstall()
  })

  ipcMain.handle('updater:get-version', () => {
    return app.getVersion()
  })
}
