/**
 * Electron fixture variant that boots with one digital human pre-installed.
 *
 * Regular `electronApp` (electron.ts) always starts from an empty profile, so
 * every "live run" scenario in automation-run.spec.ts gates on "a digital
 * human happens to exist" and skips in a fresh E2E environment. Seeding one
 * directly into the SQLite file the app opens on boot (see seed-app.ts) makes
 * the live path — trigger, chat, notification, MCP — deterministically
 * reachable without going through the AI-driven creation wizard.
 *
 * Per-test seed options: `test.use({ seedOptions: { notificationLevel: 'all' } })`.
 */

import { test as base, ElectronApplication, Page } from '@playwright/test'
import {
  getAppEntryPath,
  createTestConfigDir,
  cleanupTestConfigDir,
  launchElectronApp,
} from './electron'
import { seedAutomationApp, type SeedAppOptions, type SeededApp } from './seed-app'

interface Fixtures {
  seedOptions: SeedAppOptions
  seededApp: SeededApp
  electronApp: ElectronApplication
  window: Page
}

export const test = base.extend<Fixtures>({
  // Option fixture — override per test/describe via test.use({ seedOptions: {...} }).
  seedOptions: [{}, { option: true }],

  seededApp: async ({ seedOptions }, use) => {
    const appEntryPath = getAppEntryPath()
    const testConfigDir = createTestConfigDir(appEntryPath)
    const seeded = seedAutomationApp(testConfigDir, seedOptions)
    console.log(`[E2E] Seeded digital human: ${seeded.name} (${seeded.appId})`)
    await use(seeded)
  },

  electronApp: async ({ seededApp }, use) => {
    const appEntryPath = getAppEntryPath()
    const app = await launchElectronApp(appEntryPath, seededApp.testConfigDir)

    await use(app)

    await app.close()
    cleanupTestConfigDir(seededApp.testConfigDir)
  },

  window: async ({ electronApp }, use) => {
    const window = await electronApp.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await use(window)
  },
})

export { expect } from '@playwright/test'
export { hasApiKey } from './electron'
