import { test as base, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'
import { createRequire } from 'module'
import { buildSync } from 'esbuild'
import { getAppEntryPath, createTestConfigDir, cleanupTestConfigDir, launchElectronApp } from './electron'

const folder = dirname(fileURLToPath(import.meta.url))
const electronPath: string = createRequire(import.meta.url)('electron')
export const test = base.extend<{ peopleCount: number; electronApp: ElectronApplication; window: Page }>({
  peopleCount: [50, { option: true }],
  electronApp: async ({ peopleCount }, use) => {
    const entry = getAppEntryPath()
    const directory = createTestConfigDir(entry)
    const output = join(folder, '.e2e-seed-tmp', 'people-worker.cjs')
    mkdirSync(dirname(output), { recursive: true })
    buildSync({ entryPoints: [join(folder, 'people-seed-worker.ts')], outfile: output, platform: 'node', format: 'cjs', bundle: true, external: ['better-sqlite3'], logLevel: 'silent' })
    execFileSync(electronPath, [output, JSON.stringify({ directory, count: peopleCount })], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'pipe' })
    const app = await launchElectronApp(entry, directory)
    try { await use(app) } finally { await app.close(); cleanupTestConfigDir(directory) }
  },
  window: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('halo-locale', 'en'))
    await page.reload()
    await use(page)
  },
})
export { expect } from '@playwright/test'
