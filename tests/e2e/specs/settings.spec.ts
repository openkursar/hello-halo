import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '../fixtures/electron'
import type { HaloAPI } from '../../../src/preload'
import { navigateToChat, navigateToSettings } from '../fixtures/helpers'

test.describe('Settings Page', () => {
  test.setTimeout(30000)

  test('renders with the AI Model section', async ({ window }) => {
    await navigateToSettings(window)
    await expect(window.locator('#ai-model').getByRole('heading', { name: 'AI Model', exact: true })).toBeVisible()

    await window.screenshot({ path: 'tests/e2e/results/settings-ai-section.png' })
  })

  test('Appearance navigation brings its section into view', async ({ window }) => {
    await navigateToSettings(window)
    await window.locator('nav').getByRole('button', { name: 'Appearance', exact: true }).click()

    const heading = window.locator('#appearance').getByRole('heading', { name: 'Appearance', exact: true })
    await expect(heading).toBeVisible()
    await expect(heading).toBeInViewport()
  })

  test('About navigation shows the app version', async ({ window }) => {
    await navigateToSettings(window)
    await window.locator('nav').getByRole('button', { name: 'About', exact: true }).click()

    const about = window.locator('#about')
    await expect(about.getByRole('heading', { name: 'About', exact: true })).toBeInViewport()
    await expect(about.getByText('Version', { exact: true })).toBeVisible()
    await expect(about.getByText(/^\d+\.\d+\.\d+/)).toBeVisible()
    await window.screenshot({ path: 'tests/e2e/results/settings-about.png' })
  })

  test('has a settings navigation sidebar with working section links', { annotation: { type: 'acceptance', description: "{\"caseId\":\"startup.navigation.settings-groups\",\"evidence\":\"ui\",\"mode\":\"none\",\"variant\":{}}" } }, async ({ window }) => {
    await navigateToSettings(window)
    const nav = window.locator('nav').filter({ has: window.getByRole('button', { name: 'AI Model', exact: true }) })

    await expect(nav).toBeVisible()
    for (const name of ['AI Model', 'Appearance', 'About']) {
      await expect(nav.getByRole('button', { name, exact: true })).toBeVisible()
    }
    await nav.getByRole('button', { name: 'Appearance', exact: true }).click()
    await expect(window.locator('#appearance').getByRole('heading', { name: 'Appearance', exact: true })).toBeInViewport()
    await nav.getByRole('button', { name: 'AI Model', exact: true }).click()
    await expect(window.locator('#ai-model').getByRole('heading', { name: 'AI Model', exact: true })).toBeInViewport()
  })

  test('can switch between light and dark themes', { annotation: { type: 'acceptance', description: "{\"caseId\":\"settings.preferences.theme-toggle\",\"evidence\":\"ui\",\"mode\":\"none\",\"variant\":{}}" } }, async ({ window }) => {
    await navigateToSettings(window)
    await window.locator('nav').getByRole('button', { name: 'Appearance', exact: true }).click()
    const appearance = window.locator('#appearance')
    const html = window.locator('html')

    await expect(html).not.toHaveClass(/\blight\b/)
    await appearance.getByRole('button', { name: 'Light', exact: true }).click()
    await expect(html).toHaveClass(/\blight\b/)
    await appearance.getByRole('button', { name: 'Dark', exact: true }).click()
    await expect(html).not.toHaveClass(/\blight\b/)
    await expect.poll(() => window.evaluate(() => localStorage.getItem('halo-theme'))).toBe('dark')

    await window.screenshot({ path: 'tests/e2e/results/settings-theme.png' })
  })

  for (const width of [1280, 375]) {
    test(`the built-in federation gateway is visible without becoming a user override at ${width}px`, { annotation: { type: 'acceptance', description: JSON.stringify({ caseId: 'offices.routing.default-display', evidence: 'ui', mode: 'none', variant: { width: String(width) } }) } }, async ({ window, electronApp }) => {
      await navigateToChat(window)
      const response = await window.evaluate(async () => {
        return (globalThis.window as unknown as { halo: HaloAPI }).halo.getConfig()
      })
      expect(response.success).toBe(true)
      expect(response.productDefaults?.federation).toHaveProperty('gatewayUrl')
      const dataDir = await electronApp.evaluate(() => process.env.HALO_DATA_DIR!)
      const configFile = join(dataDir, 'config.json')
      const before = readFileSync(configFile, 'utf8')
      const defaultUrl = 'https://relay.example.test/'
      await electronApp.evaluate(({ ipcMain }, data) => {
        ipcMain.removeHandler('config:get')
        ipcMain.handle('config:get', () => ({
          ...data.response,
          productDefaults: { federation: { gatewayUrl: data.defaultUrl } },
        }))
      }, { response, defaultUrl })
      const cdp = await window.context().newCDPSession(window)
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })

      await navigateToSettings(window)
      const section = window.locator('#remote')
      const gateway = section.getByRole('textbox', { name: 'Federation Gateway', exact: true })
      await gateway.scrollIntoViewIfNeeded()
      await expect(gateway).toHaveValue('')
      await expect(gateway).toHaveAttribute('placeholder', defaultUrl)
      await expect(section.getByText('Using the built-in gateway:', { exact: false })).toBeVisible()
      await expect(section.getByText('Leave empty to use the built-in gateway.', { exact: true })).toBeVisible()
      await expect(section.getByText('Leave empty for LAN-only teams.', { exact: true })).toHaveCount(0)
      const box = await gateway.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(width)
      expect(await gateway.evaluate(element => element.parentElement!.scrollWidth <= element.parentElement!.clientWidth)).toBe(true)
      expect(readFileSync(configFile, 'utf8')).toBe(before)
      await window.screenshot({ path: `tests/e2e/results/federation-gateway-${width}.png` })
    })
  }

  test('the header back button returns to the previous conversation view', { annotation: { type: 'acceptance', description: "{\"caseId\":\"startup.navigation.header-back\",\"evidence\":\"ui\",\"mode\":\"none\",\"variant\":{}}" } }, async ({ window }) => {
    await navigateToChat(window)
    await navigateToSettings(window)
    await window.locator('header').getByRole('button', { name: 'Settings', exact: true }).click()

    await expect(window.locator('textarea')).toBeVisible()
    await expect(window.locator('#ai-model')).toHaveCount(0)
  })
})
