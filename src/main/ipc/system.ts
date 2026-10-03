/**
 * System IPC Handlers - Auto launch, window controls, logging, and the native
 * file/folder picker
 */

import { app, BrowserWindow, dialog, shell, type OpenDialogOptions } from 'electron'
import { dirname, extname } from 'path'
import { readFile, stat } from 'fs/promises'
import log from 'electron-log/main.js'
import type { PickedLocalEntry } from '../../shared/attached-paths'
import { TITLE_BAR_OVERLAY_HEIGHT } from '../../shared/constants/app-header'
import { setAutoLaunch, getAutoLaunch } from '../foundation/config.service'
import { getMainWindow, onMainWindowChange } from '../foundation/window.service'
import { logFatal } from '../foundation/logging'
import { relaunchApp } from '../services/lifecycle'
import { countPendingCrashDumps } from '../services/perf'
import { systemRpc } from '../../shared/rpc/contracts/system.contract'
import { registerRawRpcHandlers } from './rpc'

let mainWindow: BrowserWindow | null = null

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}
// Matches the composer's own image limit; a larger image is attached by path.
const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024

async function toPickedEntry(path: string): Promise<PickedLocalEntry> {
  const info = await stat(path)
  if (info.isDirectory()) return { path, isDirectory: true }
  const mediaType = IMAGE_MEDIA_TYPES[extname(path).toLowerCase()]
  if (!mediaType || info.size > MAX_INLINE_IMAGE_BYTES) return { path, isDirectory: false }
  const data = (await readFile(path)).toString('base64')
  return { path, isDirectory: false, image: { data, mediaType, size: info.size } }
}

export function registerSystemHandlers(): void {
  // Subscribe to window changes to set up event listeners
  onMainWindowChange((window) => {
    mainWindow = window
    if (window) {
      // Listen for maximize/unmaximize events and notify renderer
      window.on('maximize', () => {
        window.webContents.send('window:maximize-change', true)
      })
      window.on('unmaximize', () => {
        window.webContents.send('window:maximize-change', false)
      })
    }
  })

  registerRawRpcHandlers(systemRpc, {
    // Get auto launch status
    getAutoLaunch: async () => {
      console.log('[Settings] system:get-auto-launch - Getting auto launch status')
      try {
        const enabled = getAutoLaunch()
        console.log('[Settings] system:get-auto-launch - Status:', enabled)
        return { success: true, data: enabled }
      } catch (error) {
        const err = error as Error
        console.error('[Settings] system:get-auto-launch - Failed:', err.message)
        return { success: false, error: err.message }
      }
    },

    // Set auto launch
    setAutoLaunch: async (enabled: boolean) => {
      console.log('[Settings] system:set-auto-launch - Setting to:', enabled)
      try {
        setAutoLaunch(enabled)
        console.log('[Settings] system:set-auto-launch - Set successfully')
        return { success: true, data: enabled }
      } catch (error) {
        const err = error as Error
        console.error('[Settings] system:set-auto-launch - Failed:', err.message)
        return { success: false, error: err.message }
      }
    },

    // Set title bar overlay (Windows/Linux only)
    setTitleBarOverlay: async (options: { color: string; symbolColor: string }) => {
      try {
        // Only works on Windows/Linux with titleBarOverlay enabled
        if (process.platform !== 'darwin' && mainWindow) {
          mainWindow.setTitleBarOverlay({
            color: options.color,
            symbolColor: options.symbolColor,
            height: TITLE_BAR_OVERLAY_HEIGHT
          })
        }
        return { success: true }
      } catch (error) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    },

    // Maximize window
    maximizeWindow: async () => {
      try {
        if (mainWindow) {
          mainWindow.maximize()
        }
        return { success: true }
      } catch (error) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    },

    // Unmaximize window
    unmaximizeWindow: async () => {
      try {
        if (mainWindow) {
          mainWindow.unmaximize()
        }
        return { success: true }
      } catch (error) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    },

    // Check if window is maximized
    isWindowMaximized: async () => {
      try {
        const isMaximized = mainWindow?.isMaximized() ?? false
        return { success: true, data: isMaximized }
      } catch (error) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    },

    // Toggle maximize
    toggleMaximizeWindow: async () => {
      try {
        if (mainWindow) {
          if (mainWindow.isMaximized()) {
            mainWindow.unmaximize()
          } else {
            mainWindow.maximize()
          }
        }
        return { success: true, data: mainWindow?.isMaximized() ?? false }
      } catch (error) {
        const err = error as Error
        return { success: false, error: err.message }
      }
    },

    // Open the crash reports folder (Crashpad minidumps are kept locally, never
    // uploaded) so a user can hand them over for diagnosis.
    openCrashReportsFolder: async () => {
      try {
        const dir = app.getPath('crashDumps')
        const pending = countPendingCrashDumps()
        const error = await shell.openPath(dir)
        if (error) throw new Error(error)
        console.log(`[Settings] system:open-crash-reports-folder - Opened (pending dumps: ${pending})`)
        return { success: true, data: { path: dir, pending } }
      } catch (error) {
        const err = error as Error
        console.error('[Settings] system:open-crash-reports-folder - Failed:', err.message)
        return { success: false, error: err.message }
      }
    },

    // Open log folder in system file manager
    openLogFolder: async () => {
      console.log('[Settings] system:open-log-folder - Opening log folder')
      try {
        const logFile = log.transports.file.getFile()
        const logDir = dirname(logFile.path)
        await shell.openPath(logDir)
        console.log('[Settings] system:open-log-folder - Opened:', logDir)
        return { success: true, data: logDir }
      } catch (error) {
        const err = error as Error
        console.error('[Settings] system:open-log-folder - Failed:', err.message)
        return { success: false, error: err.message }
      }
    },

    // Relaunch the application (used after settings that require restart)
    relaunch: async () => {
      console.log('[Settings] system:relaunch - Relaunching application')
      try {
        // Use setImmediate to allow the IPC response to reach renderer before exiting
        setImmediate(() => {
          try {
            relaunchApp('settings-restart')
          } catch (error) {
            logFatal('[Settings] system:relaunch - Relaunch failed:', (error as Error).message)
            app.exit(1)
          }
        })
        return { success: true }
      } catch (error) {
        const err = error as Error
        console.error('[Settings] system:relaunch - Failed:', err.message)
        return { success: false, error: err.message }
      }
    },

    // Files and folders to attach to a chat message. macOS lets one panel pick
    // both; elsewhere a panel picks one kind, so it offers files.
    pickLocalEntries: async () => {
      try {
        const options: OpenDialogOptions = {
          properties: process.platform === 'darwin'
            ? ['openFile', 'openDirectory', 'multiSelections']
            : ['openFile', 'multiSelections'],
        }
        const result = mainWindow && !mainWindow.isDestroyed()
          ? await dialog.showOpenDialog(mainWindow, options)
          : await dialog.showOpenDialog(options)
        if (result.canceled) return { success: true, data: [] }
        const entries: PickedLocalEntry[] = []
        for (const path of result.filePaths) {
          try {
            entries.push(await toPickedEntry(path))
          } catch (error) {
            console.warn('[System] pick-local-entries - Skipped unreadable entry:', path, (error as Error).message)
          }
        }
        console.log(`[System] pick-local-entries - Picked ${entries.length} entries`)
        return { success: true, data: entries }
      } catch (error) {
        const err = error as Error
        console.error('[System] pick-local-entries - Failed:', err.message)
        return { success: false, error: err.message }
      }
    },
  })

  console.log('[Settings] System handlers registered')
}
