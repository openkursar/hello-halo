/**
 * Electron App Fixture
 *
 * Provides a reusable fixture for launching and interacting with
 * the Halo Electron application in E2E tests.
 *
 * Environment Variables:
 *   HALO_TEST_API_KEY   - API key for testing (required for chat tests)
 *   HALO_TEST_API_URL   - API URL (default: https://api.anthropic.com)
 *   HALO_TEST_MODEL     - Model to use (default: claude-haiku-4-5-20251001)
 */

import { test as base, ElectronApplication, Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

// ESM compatibility: __dirname is not available in ES modules
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Test configuration from environment variables
const TEST_API_KEY = process.env.HALO_TEST_API_KEY || ''
const TEST_API_URL = process.env.HALO_TEST_API_URL || 'https://api.anthropic.com'
const TEST_MODEL = process.env.HALO_TEST_MODEL || 'claude-haiku-4-5-20251001'

// Types for the fixture
interface ElectronFixtures {
  electronApp: ElectronApplication
  window: Page
}

/**
 * Get the path to the built application
 */
function getAppPath(): string {
  const projectRoot = path.resolve(__dirname, '../../..')

  if (process.platform === 'darwin') {
    // macOS: Check for arm64 first
    const arm64Path = path.join(projectRoot, 'dist/mac-arm64/Halo.app/Contents/MacOS/Halo')
    const x64Path = path.join(projectRoot, 'dist/mac/Halo.app/Contents/MacOS/Halo')

    if (fs.existsSync(arm64Path)) {
      return arm64Path
    }
    if (fs.existsSync(x64Path)) {
      return x64Path
    }

    throw new Error('Built app not found. Run "npm run build && npm run build:mac" first.')
  } else if (process.platform === 'win32') {
    const winPath = path.join(projectRoot, 'dist/win-unpacked/Halo.exe')
    if (fs.existsSync(winPath)) {
      return winPath
    }
    throw new Error('Built app not found. Run "npm run build && npm run build:win" first.')
  } else {
    const linuxPath = path.join(projectRoot, 'dist/linux-unpacked/halo')
    if (fs.existsSync(linuxPath)) {
      return linuxPath
    }
    throw new Error('Built app not found. Run "npm run build && npm run build:linux" first.')
  }
}

/**
 * Create a fresh test config directory with pre-configured API settings
 * This ensures tests don't interfere with each other or user data
 *
 * IMPORTANT: Also creates the headless-electron symlink required by Claude Agent SDK.
 * Without this symlink, SDK child processes fail with EPIPE error.
 */
function createTestConfigDir(appPath: string): string {
  const testDir = path.join(
    process.env.TMPDIR || '/tmp',
    `halo-e2e-test-${Date.now()}`
  )

  // Create directory structure
  const haloDir = path.join(testDir, '.halo')
  const tempDir = path.join(haloDir, 'temp')
  const spacesDir = path.join(haloDir, 'spaces')

  fs.mkdirSync(testDir, { recursive: true })
  fs.mkdirSync(haloDir, { recursive: true })
  fs.mkdirSync(tempDir, { recursive: true })
  fs.mkdirSync(spacesDir, { recursive: true })
  fs.mkdirSync(path.join(tempDir, 'artifacts'), { recursive: true })
  fs.mkdirSync(path.join(tempDir, 'conversations'), { recursive: true })

  // Create config.json with API credentials from environment variables
  const config = {
    api: {
      provider: 'anthropic',
      apiKey: TEST_API_KEY,
      apiUrl: TEST_API_URL,
      model: TEST_MODEL
    },
    permissions: {
      fileAccess: 'allow',
      commandExecution: 'allow',
      networkAccess: 'allow',
      trustMode: true
    },
    appearance: {
      theme: 'dark'
    },
    system: {
      autoLaunch: false,
      minimizeToTray: false
    },
    remoteAccess: {
      enabled: false,
      port: 3456
    },
    onboarding: {
      completed: true  // Skip onboarding in tests
    },
    mcpServers: {},
    isFirstLaunch: false  // Skip first launch flow
  }

  fs.writeFileSync(
    path.join(haloDir, 'config.json'),
    JSON.stringify(config, null, 2)
  )

  // Create headless-electron symlink for Claude Agent SDK
  // SDK uses this to spawn child processes without Dock icon on macOS
  // Path: ~/Library/Application Support/Halo/headless-electron/electron-node
  if (process.platform === 'darwin') {
    const userDataDir = path.join(testDir, 'Library', 'Application Support', 'Halo')
    const headlessDir = path.join(userDataDir, 'headless-electron')

    fs.mkdirSync(headlessDir, { recursive: true })

    const symlinkPath = path.join(headlessDir, 'electron-node')
    try {
      fs.symlinkSync(appPath, symlinkPath)
      console.log(`[E2E] Created SDK symlink: ${symlinkPath} -> ${appPath}`)
    } catch (error) {
      console.warn('[E2E] Failed to create SDK symlink:', error)
    }
  }

  return testDir
}

/**
 * Clean up test config directory
 */
function cleanupTestConfigDir(testDir: string): void {
  try {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  } catch (error) {
    console.warn('Failed to cleanup test directory:', error)
  }
}

/**
 * Extended test fixture with Electron support
 */
export const test = base.extend<ElectronFixtures>({
  // Electron application instance
  electronApp: async ({}, use) => {
    const appPath = getAppPath()
    const testConfigDir = createTestConfigDir(appPath)

    console.log(`[E2E] Launching app: ${appPath}`)
    console.log(`[E2E] Test config dir: ${testConfigDir}`)

    // Launch Electron app with test environment
    const app = await electron.launch({
      executablePath: appPath,
      args: [],
      env: {
        ...process.env,
        // Use test-specific config directory
        HOME: testConfigDir,
        USERPROFILE: testConfigDir,
        // Disable hardware acceleration for CI
        ELECTRON_DISABLE_GPU: '1',
        // Mark as E2E test
        HALO_E2E_TEST: '1'
      }
    })

    // Use the app in tests
    await use(app)

    // Cleanup after tests
    await app.close()
    cleanupTestConfigDir(testConfigDir)
  },

  // Main window instance
  window: async ({ electronApp }, use) => {
    // Wait for the first window to open
    const window = await electronApp.firstWindow()

    // Wait for the window to be ready
    await window.waitForLoadState('domcontentloaded')

    // Use the window in tests
    await use(window)
  }
})

// Re-export expect for convenience
export { expect } from '@playwright/test'

// Export helper to check if API is configured
export const hasApiKey = () => !!TEST_API_KEY

// Export test configuration for reference
export const testConfig = {
  apiKey: TEST_API_KEY,
  apiUrl: TEST_API_URL,
  model: TEST_MODEL
}
