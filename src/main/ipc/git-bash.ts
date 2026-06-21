/**
 * Git Bash IPC Handlers - Windows Git Bash detection and installation
 */

import { ipcMain } from 'electron'
import open from 'open'
import { resolveGitBashAvailability, setGitBashPathEnv } from '../services/git-bash.service'
import { downloadAndInstallGitBash } from '../services/git-bash-installer.service'
import { createMockBash, cleanupMockBash } from '../services/mock-bash.service'
import { getConfig, saveConfig } from '../foundation/config.service'
import { getMainWindow } from '../foundation/window.service'
import { gitBashRpc } from '../../shared/rpc/contracts/git-bash.contract'
import { registerRawRpcHandlers } from './rpc'

/**
 * Register Git Bash IPC handlers
 */
export function registerGitBashHandlers(): void {
  registerRawRpcHandlers(gitBashRpc, {
    // Get Git Bash detection status
    // This should be called by renderer to check if Git Bash is available
    // It considers both saved config and system detection
    // Returns mockMode: true when user skipped and using mock bash
    getGitBashStatus: async () => {
      try {
        // Non-Windows platforms always have bash available
        if (process.platform !== 'win32') {
          return { success: true, data: { found: true, path: '/bin/bash', source: 'system', mockMode: false } }
        }

        const status = resolveGitBashAvailability(getConfig() as any, (gitBash) => {
          saveConfig({ gitBash } as any)
        })

        if (status.path && !status.mockMode) {
          setGitBashPathEnv(status.path)
          cleanupMockBash()
        }

        return {
          success: true,
          data: {
            found: status.available,
            path: status.path,
            source: status.source,
            mockMode: status.mockMode
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        return { success: false, error: msg }
      }
    },

    // Open external URL (for manual download link)
    openExternal: async (url: string) => {
      await open(url)
    },
  })

  // Install Git Bash (download Portable Git)
  // Preload bridge wraps a per-call progress listener, so this stays a raw
  // ipcMain.handle (not a clean 1:1 invoke for the typed-RPC passthrough).
  ipcMain.handle('git-bash:install', async (_event, { progressChannel }) => {
    try {
      const result = await downloadAndInstallGitBash((progress) => {
        // Send progress to renderer via the specified channel
        const window = getMainWindow()
        if (window && !window.isDestroyed()) {
          window.webContents.send(progressChannel, progress)
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

  const status = resolveGitBashAvailability(getConfig() as any, (gitBash) => {
    saveConfig({ gitBash } as any)
  })

  if (status.path && !status.mockMode) {
    setGitBashPathEnv(status.path)
    console.log('[GitBash] Real Git Bash active:', status.path)
    cleanupMockBash()
  }

  if (status.mockMode) {
    const mockPath = createMockBash()
    setGitBashPathEnv(mockPath)
    console.log('[GitBash] Mock mode active (real Git Bash unavailable)')
    return { available: true, needsSetup: false, mockMode: true, path: mockPath }
  }

  if (status.needsSetup) {
    // The CLI exits at startup without a valid bash path, so headless runs that
    // bypass the setup UI still need the mock fallback. Leave config untouched
    // (skipped stays false) so the renderer keeps prompting interactive users.
    const mockPath = createMockBash()
    setGitBashPathEnv(mockPath)
    console.log('[GitBash] Not found, setup required — mock fallback active')
    return {
      available: true,
      needsSetup: true,
      mockMode: true,
      path: mockPath,
      configCleared: status.configUpdated
    }
  }

  return {
    available: status.available,
    needsSetup: status.needsSetup,
    mockMode: false,
    path: status.path,
    configCleared: status.configUpdated
  }
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
