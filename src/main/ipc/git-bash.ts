/**
 * Git Bash IPC Handlers - Windows Git Bash detection and installation
 */

import { ipcMain, shell, BrowserWindow } from 'electron'
import { detectGitBash, setGitBashPathEnv } from '../services/git-bash.service'
import { downloadAndInstallGitBash } from '../services/git-bash-installer.service'
import { createMockBash, cleanupMockBash } from '../services/mock-bash.service'
import { getConfig, saveConfig } from '../services/config.service'

let mainWindow: BrowserWindow | null = null

/**
 * Register Git Bash IPC handlers
 */
export function registerGitBashHandlers(window: BrowserWindow | null): void {
  mainWindow = window

  // Get Git Bash detection status
  // This should be called by renderer to check if Git Bash is available
  // It considers both saved config and system detection
  // Returns mockMode: true when user skipped and using mock bash
  ipcMain.handle('git-bash:status', async () => {
    try {
      // Non-Windows platforms always have bash available
      if (process.platform !== 'win32') {
        return { success: true, data: { found: true, path: '/bin/bash', source: 'system', mockMode: false } }
      }

      // Check config first - if user previously skipped, return mock mode
      const config = getConfig() as any
      if (config.gitBash?.skipped) {
        // User previously skipped - indicate found but in mock mode
        return { success: true, data: { found: true, path: null, source: 'mock', mockMode: true } }
      }

      // Check if already configured with valid path
      if (config.gitBash?.installed && config.gitBash?.path) {
        return { success: true, data: { found: true, path: config.gitBash.path, source: 'app-local', mockMode: false } }
      }

      // Run fresh detection
      const result = detectGitBash()
      return { success: true, data: { ...result, mockMode: false } }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { success: false, error: msg }
    }
  })

  // Install Git Bash (download Portable Git)
  ipcMain.handle('git-bash:install', async (_event, { progressChannel }) => {
    try {
      const result = await downloadAndInstallGitBash((progress) => {
        // Send progress to renderer via the specified channel
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(progressChannel, progress)
        }
      })

      if (result.success && result.path) {
        // Set the Git Bash path for Claude Code SDK
        setGitBashPathEnv(result.path)

        // Save to config (clear skipped flag)
        saveConfig({
          gitBash: {
            installed: true,
            path: result.path,
            skipped: false
          }
        } as any)

        // Clean up mock bash files if they exist
        cleanupMockBash()

        console.log('[GitBash] Installation completed, path saved to config')
      }

      return result
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return { success: false, error: msg }
    }
  })

  // Open external URL (for manual download link)
  ipcMain.handle('shell:open-external', async (_event, url: string) => {
    await shell.openExternal(url)
  })
}

/**
 * Initialize Git Bash on app startup (Windows only)
 *
 * This runs ASYNC after startup to avoid blocking.
 * It validates saved config paths and handles edge cases like Git Bash being deleted.
 *
 * Returns whether Git Bash is available (either installed or mock mode).
 */
export async function initializeGitBashOnStartup(): Promise<{
  available: boolean
  needsSetup: boolean
  mockMode: boolean
  path: string | null
  configCleared?: boolean  // True if stale config was cleared
}> {
  // Non-Windows platforms always have bash available
  if (process.platform !== 'win32') {
    return { available: true, needsSetup: false, mockMode: false, path: '/bin/bash' }
  }

  const { existsSync } = require('fs')
  const config = getConfig() as any

  // Case 1: Config says installed with a specific path - VALIDATE it still exists
  if (config.gitBash?.installed && config.gitBash?.path) {
    const savedPath = config.gitBash.path

    if (existsSync(savedPath)) {
      // Saved path is valid, use it
      setGitBashPathEnv(savedPath)
      console.log('[GitBash] Using saved path:', savedPath)
      return { available: true, needsSetup: false, mockMode: false, path: savedPath }
    } else {
      // Saved path is STALE (Git Bash was deleted)
      console.log('[GitBash] Saved path no longer exists:', savedPath)

      // Clear the stale config
      saveConfig({
        gitBash: {
          installed: false,
          path: null,
          skipped: false
        }
      } as any)

      console.log('[GitBash] Cleared stale config, will re-detect')

      // Fall through to fresh detection below
    }
  }

  // Case 2: User previously skipped - use mock mode
  if (config.gitBash?.skipped) {
    const mockPath = createMockBash()
    setGitBashPathEnv(mockPath)
    console.log('[GitBash] Mock mode active (user skipped)')
    return { available: true, needsSetup: false, mockMode: true, path: mockPath }
  }

  // Case 3: Fresh detection - try to find Git Bash on system
  const detection = detectGitBash()

  if (detection.found && detection.path) {
    // Git Bash found on system, save and use it
    setGitBashPathEnv(detection.path)

    saveConfig({
      gitBash: {
        installed: true,
        path: detection.path,
        skipped: false
      }
    } as any)

    console.log('[GitBash] Detected system Git Bash:', detection.path)
    return { available: true, needsSetup: false, mockMode: false, path: detection.path }
  }

  // Case 4: Git Bash not found anywhere - needs setup
  console.log('[GitBash] Not found, setup required')
  return { available: false, needsSetup: true, mockMode: false, path: null, configCleared: true }
}

/**
 * Set Git Bash as skipped (user chose to skip installation)
 */
export function setGitBashSkipped(): void {
  const mockPath = createMockBash()
  setGitBashPathEnv(mockPath)

  saveConfig({
    gitBash: {
      installed: false,
      path: null,
      skipped: true
    }
  } as any)

  console.log('[GitBash] User skipped installation, using mock mode')
}
