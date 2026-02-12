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
 *   HALO_TEST_PROVIDER  - Provider ID (default: anthropic)
 */

import { test as base, ElectronApplication, Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { fileURLToPath } from 'url'

// ESM compatibility: __dirname is not available in ES modules
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Test configuration from environment variables
const TEST_API_KEY = process.env.HALO_TEST_API_KEY || ''
const TEST_API_URL = process.env.HALO_TEST_API_URL || ''
const TEST_MODEL = process.env.HALO_TEST_MODEL || ''
const TEST_PROVIDER = process.env.HALO_TEST_PROVIDER || ''
const TEST_OAUTH_SOURCE = process.env.HALO_TEST_OAUTH_SOURCE || ''

// Validate: if API key is set, the other three must also be set
if (TEST_API_KEY && (!TEST_API_URL || !TEST_MODEL || !TEST_PROVIDER)) {
  const missing = [
    !TEST_API_URL && 'HALO_TEST_API_URL',
    !TEST_MODEL && 'HALO_TEST_MODEL',
    !TEST_PROVIDER && 'HALO_TEST_PROVIDER'
  ].filter(Boolean)
  throw new Error(
    `HALO_TEST_API_KEY is set but missing: ${missing.join(', ')}. ` +
    'All four env vars must be configured together in .env.local'
  )
}

// Types for the fixture
interface ElectronFixtures {
  electronApp: ElectronApplication
  window: Page
}

/**
 * Get the app entry point path.
 * Requires "npm run build" to produce out/main/index.mjs.
 */
function getAppEntryPath(): string {
  const projectRoot = path.resolve(__dirname, '../../..')
  const appEntryPath = path.join(projectRoot, 'out/main/index.mjs')

  if (!fs.existsSync(appEntryPath)) {
    throw new Error('Built app not found. Run "npm run build" first.')
  }

  return appEntryPath
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

  // Build v2 aiSources config directly (skip legacy migration at startup)
  const sourceId = crypto.randomUUID()
  const now = new Date().toISOString()

  // Build sources array from environment variables
  const sources = []

  // Add API key source if configured
  if (TEST_API_KEY) {
    sources.push({
      id: sourceId,
      name: 'E2E Test Source',
      provider: TEST_PROVIDER,
      authType: 'api-key',
      apiUrl: TEST_API_URL,
      apiKey: TEST_API_KEY,
      model: TEST_MODEL,
      availableModels: [{ id: TEST_MODEL, name: TEST_MODEL }],
      createdAt: now,
      updatedAt: now
    })
  }

  // Add OAuth source if configured
  if (TEST_OAUTH_SOURCE) {
    try {
      const oauthSource = JSON.parse(TEST_OAUTH_SOURCE)
      sources.push(oauthSource)
      console.log(`[E2E] Loaded OAuth source: ${oauthSource.provider}`)
    } catch (err) {
      console.warn('[E2E] Failed to parse HALO_TEST_OAUTH_SOURCE:', err.message)
    }
  }

  // Create config.json with both legacy api field and v2 aiSources format
  const config = {
    // Legacy api field (still required by HaloConfig for backward compatibility)
    api: {
      provider: TEST_PROVIDER || 'anthropic',
      apiKey: TEST_API_KEY,
      apiUrl: TEST_API_URL || 'https://api.anthropic.com',
      model: TEST_MODEL || 'claude-haiku-4-5-20251001'
    },
    // v2 aiSources format (used by actual app logic)
    aiSources: {
      version: 2,
      currentId: sources.length > 0 ? sources[0].id : null,
      sources
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
      autoLaunch: false
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
    const appEntryPath = getAppEntryPath()
    const testConfigDir = createTestConfigDir(appEntryPath)

    console.log(`[E2E] App entry: ${appEntryPath}`)
    console.log(`[E2E] Test config dir: ${testConfigDir}`)

    // Build a clean env without ELECTRON_RUN_AS_NODE.
    // Halo sets ELECTRON_RUN_AS_NODE=1 for its child processes (Claude Agent SDK),
    // which forces Electron into plain Node.js mode. E2E tests inherit this env var,
    // but Playwright needs Electron in full app mode to connect via CDP.
    const { ELECTRON_RUN_AS_NODE: _, ...cleanEnv } = process.env

    const app = await electron.launch({
      args: [appEntryPath],
      env: {
        ...cleanEnv,
        // Use test-specific config directory
        HOME: testConfigDir,
        USERPROFILE: testConfigDir,
        // Point app config to the test .halo dir directly.
        // config.service.ts checks HALO_DATA_DIR first (highest priority),
        // bypassing the .halo vs .halo-dev dev-mode logic.
        HALO_DATA_DIR: path.join(testConfigDir, '.halo'),
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
