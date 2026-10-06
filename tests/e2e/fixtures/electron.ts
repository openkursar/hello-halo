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
 *   HALO_TEST_SDK_ENGINE - SDK engine selected in the isolated profile
 */

import { test as base, ElectronApplication, Page } from '@playwright/test'
import { _electron as electron } from 'playwright'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { fileURLToPath, pathToFileURL } from 'url'
import type { RegistrySource } from '../../../src/shared/store/store-types'

// ESM compatibility: __dirname is not available in ES modules
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Test configuration from environment variables
const TEST_API_KEY = process.env.HALO_TEST_API_KEY || ''
const TEST_API_URL = process.env.HALO_TEST_API_URL || ''
const TEST_MODEL = process.env.HALO_TEST_MODEL || ''
const TEST_PROVIDER = process.env.HALO_TEST_PROVIDER || ''
const TEST_OAUTH_SOURCE = process.env.HALO_TEST_OAUTH_SOURCE || ''
const TEST_SDK_ENGINE = process.env.HALO_TEST_SDK_ENGINE || ''

if (TEST_SDK_ENGINE && !['anthropic', 'halo', 'codex', 'dsh'].includes(TEST_SDK_ENGINE)) {
  throw new Error('HALO_TEST_SDK_ENGINE must name a supported SDK engine')
}

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
  appStoreRegistries: RegistrySource[] | undefined
  electronApp: ElectronApplication
  window: Page
}

/**
 * Get the app entry point path.
 *
 * Read from package.json's `main` rather than hard-coded: the bundle's module
 * format is a build setting (electron.vite.config.ts) and the app's own entry
 * field is the only thing that must agree with the launcher.
 */
export function getAppEntryPath(): string {
  if (process.env.HALO_E2E_PACKAGED_APP) {
    if (process.env.PERF_CONTENT_IDENTITY_RUN) throw new Error('Frozen performance runtime identity requires the declared production output entry')
    const executable = path.resolve(process.env.HALO_E2E_PACKAGED_APP)
    if (!fs.existsSync(executable)) throw new Error(`Packaged app missing: ${executable}`)
    return executable
  }
  const projectRoot = path.resolve(__dirname, '../../..')
  const main = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8')).main as string
  const appEntryPath = path.resolve(projectRoot, main)

  if (!fs.existsSync(appEntryPath)) {
    throw new Error(`Built app not found at ${appEntryPath}. Run "npm run build" first.`)
  }

  // Ensure product.json exists in out/main/ so auth-loader can find providers.
  // In E2E, app.getAppPath() returns out/main/, not project root.
  ensureProductJson(projectRoot)

  return appEntryPath
}

/**
 * Copy product.json to out/main/ with absolute provider paths.
 * This is needed because app.getAppPath() returns out/main/ in E2E,
 * and auth-loader resolves provider paths relative to product.json location.
 */
function ensureProductJson(projectRoot: string): void {
  const srcProductJson = path.join(projectRoot, 'product.json')
  const destDir = path.join(projectRoot, 'out/main')
  const destProductJson = path.join(destDir, 'product.json')

  if (!fs.existsSync(srcProductJson)) return

  try {
    const product = JSON.parse(fs.readFileSync(srcProductJson, 'utf-8'))

    // Rewrite provider paths to be relative to out/main/ (where product.json will live)
    // auth-loader resolves paths via: join(dirname(productJsonPath), cleanPath)
    if (product.authProviders) {
      for (const provider of product.authProviders) {
        if (provider.path && provider.path.startsWith('./')) {
          // Original path is relative to project root, e.g. "./halo-local/dist/..."
          // We need it relative to out/main/, e.g. "../../halo-local/dist/..."
          const absolutePath = path.resolve(projectRoot, provider.path)
          provider.path = path.relative(destDir, absolutePath)
        }
      }
    }

    fs.writeFileSync(destProductJson, JSON.stringify(product, null, 2))
    console.log(`[E2E] Wrote product.json to out/main/ with adjusted provider paths`)
  } catch (err) {
    console.warn('[E2E] Failed to copy product.json:', err)
  }
}

/**
 * Create a fresh test config directory with pre-configured API settings
 * This ensures tests don't interfere with each other or user data
 *
 * IMPORTANT: Also creates the headless-electron symlink required by Claude Agent SDK.
 * Without this symlink, SDK child processes fail with EPIPE error.
 *
 * Exported so other fixtures (e.g. electron-with-app.ts) can seed data into
 * `{testConfigDir}/.halo/` between this call and launchElectronApp() —
 * anything written to the SQLite/config files before the app opens them is
 * picked up on boot exactly like a real prior install.
 */
export function createTestConfigDir(appPath: string, registries?: RegistrySource[]): string {
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
      console.warn('[E2E] Failed to parse HALO_TEST_OAUTH_SOURCE:', err instanceof Error ? err.message : String(err))
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
    ...(TEST_SDK_ENGINE ? { agent: { sdkEngine: TEST_SDK_ENGINE } } : {}),
    ...(registries ? { appStore: { registries, cacheTtlMs: 3600000, autoCheckUpdates: true } } : {}),
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
export function cleanupTestConfigDir(testDir: string): void {
  try {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  } catch (error) {
    console.warn('Failed to cleanup test directory:', error)
  }
}

/**
 * Launch the built app against an already-prepared test config directory.
 *
 * Split out from the `electronApp` fixture so other fixtures (e.g.
 * electron-with-app.ts) can seed data into `{testConfigDir}/.halo/` between
 * `createTestConfigDir()` and this call, then reuse the exact same launch
 * behavior (env vars, GPU/accel flags) instead of duplicating it.
 */
export async function launchElectronApp(appEntryPath: string, testConfigDir: string): Promise<ElectronApplication> {
  console.log(`[E2E] App entry: ${appEntryPath}`)
  console.log(`[E2E] Test config dir: ${testConfigDir}`)

  // Build a clean env without ELECTRON_RUN_AS_NODE.
  // Halo sets ELECTRON_RUN_AS_NODE=1 for its child processes (Claude Agent SDK),
  // which forces Electron into plain Node.js mode. E2E tests inherit this env var,
  // but Playwright needs Electron in full app mode to connect via CDP.
  const { ELECTRON_RUN_AS_NODE: _, ...cleanEnv } = process.env

  if (process.env.HALO_E2E_PACKAGED_APP) {
    return electron.launch({
      executablePath: appEntryPath,
      args: ['--lang=en-US', ...(process.env.HALO_E2E_NO_SANDBOX === '1' ? ['--no-sandbox'] : [])],
      env: { ...cleanEnv, HALO_DATA_DIR: path.join(testConfigDir, '.halo'), HALO_E2E_TEST: '1', ELECTRON_DISABLE_GPU: '1' },
    })
  }

  const bootstrap = path.join(path.dirname(appEntryPath), `.e2e-bootstrap-${crypto.randomUUID()}.cjs`)
  const appData = path.join(testConfigDir, 'electron-data')
  const userData = path.join(appData, 'user')
  fs.mkdirSync(userData, { recursive: true })
  // macOS resolves appData independently of HOME. Isolate browser storage before main imports.
  // Selectors are English UI labels, so the renderer must not follow the OS language.
  fs.writeFileSync(bootstrap, `const { app } = require('electron');\napp.commandLine.appendSwitch('lang', 'en-US');\napp.setPath('appData',${JSON.stringify(appData)});\napp.setPath('userData', ${JSON.stringify(userData)});\nimport(${JSON.stringify(pathToFileURL(appEntryPath).href)});\n`)
  const identityModule = process.env.PERF_CONTENT_IDENTITY_RUN ? await import('../../perf/build-identity/index.mjs') : undefined
  const launchArgs = [...(process.env.HALO_E2E_NO_SANDBOX === '1' ? ['--no-sandbox'] : []), bootstrap]
  let identityFile: string | undefined
  if (identityModule) {
    try {
      const projectRoot = path.resolve(__dirname, '../../..')
      const productionMain = path.resolve(projectRoot, JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).main)
      identityFile = await identityModule.prepareLaunch(process.env.PERF_CONTENT_IDENTITY_RUN!, { productionMain, entryPath: appEntryPath, bootstrap, launchArgs })
    } catch (error) { fs.rmSync(bootstrap, { force: true }); throw error }
  }
  const instance = await electron.launch({
    args: launchArgs,
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
  }).catch(error => {
    if (identityModule && identityFile) identityModule.failLaunch(identityFile, error)
    fs.rmSync(bootstrap, { force: true }); throw error
  })
  instance.once('close', () => fs.rmSync(bootstrap, { force: true }))
  if (identityModule && identityFile) {
    try {
      const observed = await instance.evaluate(({ app }) => ({
        electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node,
        execPath: process.execPath, pid: process.pid, appPath: app.getAppPath(), appVersion: app.getVersion(),
        appData: app.getPath('appData'), userData: app.getPath('userData'),
      }))
      const processInfo = instance.process()
      identityModule.observeLaunch(identityFile, observed, processInfo.spawnfile, processInfo.spawnargs)
      instance.once('close', () => {
        try { identityModule.closeLaunch(identityFile!) }
        catch (error) { console.error(`[PerfIdentity] Owned runtime close could not be authenticated: ${identityFile}: ${error instanceof Error ? error.message : String(error)}`) }
      })
    } catch (error) {
      identityModule.failLaunch(identityFile, error)
      await instance.close()
      throw error
    }
  }
  return instance
}

/**
 * Extended test fixture with Electron support
 */
export const test = base.extend<ElectronFixtures>({
  appStoreRegistries: [undefined, { option: true }],
  // Electron application instance
  electronApp: async ({ appStoreRegistries }, use, testInfo) => {
    const appEntryPath = getAppEntryPath()
    const testConfigDir = createTestConfigDir(appEntryPath, appStoreRegistries)
    const app = await launchElectronApp(appEntryPath, testConfigDir)

    // Use the app in tests
    await use(app)

    if (testInfo.status !== testInfo.expectedStatus) {
      const log = path.join(testConfigDir, '.halo', 'logs', 'main.log')
      if (fs.existsSync(log)) await testInfo.attach('electron-main-log', { body: fs.readFileSync(log).subarray(-500000), contentType: 'text/plain' })
    }

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
