/**
 * Halo Auto-Updater Service
 * Handles automatic updates via GitHub Releases
 */

import electronUpdater from 'electron-updater'
const { autoUpdater } = electronUpdater
type UpdateInfo = electronUpdater.UpdateInfo
import { BrowserWindow, ipcMain } from 'electron'
import { is } from '@electron-toolkit/utils'

// Configure logging
autoUpdater.logger = console

// Auto download updates
autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = true

// Disable code signing verification for ad-hoc signed apps (no Apple Developer certificate)
// This allows updates to work without purchasing an Apple Developer account
if (process.platform === 'darwin') {
  autoUpdater.forceDevUpdateConfig = true
}

let mainWindow: BrowserWindow | null = null

/**
 * Initialize auto-updater
 */
export function initAutoUpdater(window: BrowserWindow): void {
  mainWindow = window

  // Skip updates in development
  if (is.dev) {
    console.log('[Updater] Skipping auto-update in development mode')
    return
  }

  // Set up event handlers
  autoUpdater.on('checking-for-update', () => {
    console.log('[Updater] Checking for updates...')
    sendUpdateStatus('checking')
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    console.log('[Updater] Update available:', info.version)

    // On macOS without code signing, skip auto-download and show manual download option
    if (process.platform === 'darwin') {
      console.log('[Updater] macOS: Skipping auto-download, showing manual download option')
      sendUpdateStatus('manual-download', {
        version: info.version,
        releaseDate: info.releaseDate,
        releaseNotes: info.releaseNotes
      })
    } else {
      // Windows/Linux: Proceed with auto-download
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
      releaseNotes: info.releaseNotes
    })
  })

  autoUpdater.on('error', (error) => {
    console.error('[Updater] Error:', error.message)
    // On auto-download failure, show manual download option instead of error
    // User won't see "failed", just "version available for manual download"
    sendUpdateStatus('manual-download', {
      message: 'Version available for manual download'
    })
  })

  // Check for updates on startup (with delay to not block app launch)
  setTimeout(() => {
    checkForUpdates()
  }, 5000)
}

/**
 * Send update status to renderer
 */
function sendUpdateStatus(
  status: 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'manual-download' | 'error',
  data?: Record<string, unknown>
): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater:status', { status, ...data })
  }
}

/**
 * Check for updates
 */
export async function checkForUpdates(): Promise<void> {
  if (is.dev) {
    console.log('[Updater] Skipping update check in development mode')
    return
  }

  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    console.error('[Updater] Failed to check for updates:', error)
  }
}

/**
 * Quit and install update
 */
export function quitAndInstall(): void {
  autoUpdater.quitAndInstall(false, true)
}

/**
 * Register IPC handlers for updater
 */
export function registerUpdaterHandlers(): void {
  ipcMain.handle('updater:check', async () => {
    await checkForUpdates()
  })

  ipcMain.handle('updater:install', () => {
    quitAndInstall()
  })

  ipcMain.handle('updater:get-version', () => {
    const { app } = require('electron')
    return app.getVersion()
  })
}
