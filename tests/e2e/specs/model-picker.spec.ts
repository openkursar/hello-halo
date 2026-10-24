/**
 * The composer model picker with a vendor that reports offers, multipliers and
 * an enterprise section, in a real window at desktop and phone width: the
 * current-model card, the list, and the line that explains a replaced or
 * withdrawn model.
 */

import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import {
  getAppEntryPath,
  createTestConfigDir,
  cleanupTestConfigDir,
  launchElectronApp,
} from '../fixtures/electron'
import { navigateToChat } from '../fixtures/helpers'

const SCREENSHOTS = process.env.HALO_E2E_SCREENSHOT_DIR

function seedVendorSource(testConfigDir: string, over: Record<string, unknown>): void {
  const file = path.join(testConfigDir, '.halo', 'config.json')
  const config = JSON.parse(fs.readFileSync(file, 'utf-8'))
  const now = new Date().toISOString()
  const source = {
    id: 'vendor', name: 'Vendor', provider: 'custom', authType: 'api-key',
    apiUrl: 'http://127.0.0.1:9/v1/chat/completions', apiKey: 'sk-e2e',
    model: 'glm-5.2',
    availableModels: [
      { id: 'auto', name: 'Auto' },
      { id: 'hy4', name: 'Hy4 preview', badge: { label: 'Free tonight', detail: 'Free from 23:00 to 08:00' }, costMultiplier: 0.29 },
      { id: 'hy3', name: 'Hy3', badge: { label: 'Free this month' }, costMultiplier: 0 },
      { id: 'glm-5.2', name: 'GLM-5.2', badge: { label: 'Night offer', detail: 'Fewer credits from 23:00 to 08:00' }, costMultiplier: 0.5, regularCostMultiplier: 0.79 },
      { id: 'kimi-k3-2', name: 'Kimi-K3 with a name long enough to need truncating', costMultiplier: 1.62 },
      { id: 'custom:maas', name: 'glm-5.3-maas-team', group: 'enterprise' }
    ],
    withdrawnModels: [{ id: 'kimi-k3-1', name: 'Kimi-K3 (2025)', at: now }],
    modelReplacement: { from: 'minimax-m3', fromName: 'MiniMax-M3', to: 'glm-5.2', at: now },
    createdAt: now, updatedAt: now,
    ...over
  }
  config.aiSources = { version: 2, currentId: 'vendor', sources: [source] }
  fs.writeFileSync(file, JSON.stringify(config, null, 2))
}

async function shoot(window: Page, name: string): Promise<void> {
  if (SCREENSHOTS) await window.screenshot({ path: path.join(SCREENSHOTS, `${name}.png`) })
}

async function setViewport(window: Page, width: number, height: number, mobile: boolean): Promise<void> {
  const cdp = await window.context().newCDPSession(window)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile })
  await window.waitForTimeout(400)
}

async function withApp(over: Record<string, unknown>, run: (window: Page) => Promise<void>): Promise<void> {
  const appEntryPath = getAppEntryPath()
  const testConfigDir = createTestConfigDir(appEntryPath)
  seedVendorSource(testConfigDir, over)
  const app = await launchElectronApp(appEntryPath, testConfigDir)
  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await navigateToChat(window)
    await run(window)
  } finally {
    await app.close()
    cleanupTestConfigDir(testConfigDir)
  }
}

test('model picker — offers, multipliers, enterprise section and a replaced model', async () => {
  test.setTimeout(120000)
  await withApp({}, async window => {
    await setViewport(window, 1280, 800, false)
    await window.getByRole('button', { name: 'GLM-5.2', exact: true }).click()

    const card = window.locator('div.shadow-pop').filter({ hasText: 'Credits per use' })
    await expect(card).toContainText('Night offer')
    await expect(card).toContainText('0.79x')
    await expect(card).toContainText('0.5x')
    await expect(card).toContainText('MiniMax-M3 is no longer offered, so this account now uses GLM-5.2.')
    await expect(card).toContainText('Fewer credits from 23:00 to 08:00')
    await shoot(window, 'desktop-card')

    await window.getByTitle('Switch model').click()
    const list = window.locator('div.shadow-pop').filter({ hasText: 'Enterprise models' })
    await expect(list.getByRole('button', { name: /Hy3/ })).toContainText('Free this month')
    await expect(list.getByRole('button', { name: /Hy3/ })).toContainText('0x')
    await expect(list.getByRole('button', { name: /glm-5\.3-maas-team/ })).toBeVisible()
    await shoot(window, 'desktop-list')

    await window.keyboard.press('Escape')
    await setViewport(window, 390, 844, true)
    await window.getByRole('button', { name: 'GLM-5.2', exact: true }).click()
    await expect(window.getByText('Enterprise models')).toBeVisible()
    // Hover text cannot be read on a phone: the sheet writes out cost and offer.
    await expect(window.getByText('Credits per use')).toBeVisible()
    await expect(window.getByText('Fewer credits from 23:00 to 08:00')).toBeVisible()
    // The sheet slides in; let it settle before the picture.
    await window.waitForTimeout(500)
    await shoot(window, 'mobile-sheet')
  })
})

test('model picker — a model the vendor withdrew', async () => {
  test.setTimeout(120000)
  await withApp({ model: 'kimi-k3-1', modelReplacement: undefined }, async window => {
    await setViewport(window, 1280, 800, false)
    await window.getByRole('button', { name: 'Kimi-K3 (2025)', exact: true }).click()
    await expect(window.getByText('Kimi-K3 (2025) is no longer offered by Vendor. Choose another model.')).toBeVisible()
    await shoot(window, 'desktop-withdrawn')
  })
})
