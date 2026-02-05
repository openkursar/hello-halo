/**
 * Halo Auto-Updater Service
 * Handles automatic updates via GitHub Releases
 *
 * Update Strategy:
 * - Startup check: 5 seconds after app launch
 * - Periodic check: Every hour via setInterval
 * - Resume check: When system wakes from sleep
 * - Manual check: User-triggered from Settings or menu (notify only, no auto-download)
 *
 * Platform Behavior:
 * - macOS: Never auto-download (no code signing), always show manual download option
 * - Windows/Linux: Auto-download in background, notify when ready to install
 */

// Node/Electron imports
import { app, ipcMain, powerMonitor } from 'electron'

// Third-party imports
import electronUpdater from 'electron-updater'
import { is } from '@electron-toolkit/utils'

// Local imports
import { getMainWindow } from './window.service'
import { loadProductConfig, UpdateConfig } from './ai-sources/auth-loader'

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

// ============================================================================
// State
// ============================================================================

/** Track if we're in manual check mode (no auto-download) */
let isManualCheck = false

/** Track last check time to avoid duplicate checks */
let lastCheckTime = 0

/** Minimum interval between checks (5 minutes) to prevent spam */
const MIN_CHECK_INTERVAL_MS = 5 * 60 * 1000

/** Cached update config for constructing download URLs */
let cachedUpdateConfig: UpdateConfig | undefined

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

// Platform-specific auto-download configuration
// macOS: Disable auto-download (no code signing, download is useless)
// Windows/Linux: Enable auto-download for seamless updates
if (process.platform === 'darwin') {
  autoUpdater.autoDownload = false
  autoUpdater.forceDevUpdateConfig = true
} else {
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
}

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
    // Set custom update server URL
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: updateConfig.url
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

    // Manual check or macOS: Always show manual download option (no auto-download)
    if (isManualCheck || process.platform === 'darwin') {
      console.log('[Updater] Showing manual download option')
      sendUpdateStatus('manual-download', {
        version: info.version,
        releaseDate: info.releaseDate,
        releaseNotes: info.releaseNotes,
        downloadUrl: getDownloadPageUrl(info.version)
      })
    } else {
      // Windows/Linux background check: Proceed with auto-download
      sendUpdateStatus('available', {
        version: info.version,
        releaseDate: info.releaseDate,
        releaseNotes: info.releaseNotes
      })
    }
  })

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    console.log('[Updater] No update available, current version is latest:', info.version)
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
    sendUpdateStatus('downloaded', {
      version: info.version,
      releaseNotes: info.releaseNotes,
      downloadUrl: getDownloadPageUrl(info.version)
    })
  })

  autoUpdater.on('error', (error) => {
    console.error('[Updater] Error:', error.message)
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
 * Automatic background check for updates
 * - Windows/Linux: Will auto-download if update available
 * - macOS: Will show manual download option
 */
export async function autoCheckForUpdates(): Promise<void> {
  if (is.dev) {
    console.log('[Updater] Skipping update check in development mode')
    return
  }

  if (!canCheck()) {
    return
  }

  try {
    isManualCheck = false
    await autoUpdater.checkForUpdates()
  } catch (error) {
    console.error('[Updater] Failed to check for updates:', error)
  }
}

/**
 * Manual check for updates (user-triggered)
 * - Never auto-downloads, only notifies user of available updates
 * - User can then choose to download/install
 */
export async function manualCheckForUpdates(): Promise<void> {
  if (is.dev) {
    console.log('[Updater] Skipping update check in development mode')
    sendUpdateStatus('not-available', { version: app.getVersion() })
    return
  }

  // Manual check bypasses the time throttle
  lastCheckTime = Date.now()

  // Save original autoDownload setting and disable it for manual check
  const originalAutoDownload = autoUpdater.autoDownload
  try {
    isManualCheck = true
    autoUpdater.autoDownload = false
    await autoUpdater.checkForUpdates()
  } catch (error) {
    console.error('[Updater] Failed to check for updates:', error)
    sendUpdateStatus('error', { message: 'Failed to check for updates' })
  } finally {
    isManualCheck = false
    autoUpdater.autoDownload = originalAutoDownload
  }
}

/**
 * Legacy function for backward compatibility
 * Now calls autoCheckForUpdates
 * @deprecated Use autoCheckForUpdates or manualCheckForUpdates instead
 */
export async function checkForUpdates(): Promise<void> {
  return autoCheckForUpdates()
}

// ============================================================================
// Installation
// ============================================================================

/**
 * Quit and install update
 *
 * Important timing considerations for Windows NSIS:
 * 1. Add delay to ensure app fully closes before installer starts
 * 2. Use isSilent=false to show installer UI, isForceRunAfter=true to restart after install
 *
 * @see https://github.com/electron-userland/electron-builder/issues/1368
 */
export function quitAndInstall(): void {
  // Delay to ensure all windows close before installer launches
  setTimeout(() => {
    try {
      // isSilent=false: show installer UI for user feedback
      // isForceRunAfter=true: restart app after install completes
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
  // Manual check - user triggered, no auto-download
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
