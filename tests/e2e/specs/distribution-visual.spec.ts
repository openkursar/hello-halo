import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { test, expect } from '../fixtures/acceptance-app'
import { navigateToSettings } from '../fixtures/helpers'
import { startRuntimeRegistry } from '../fixtures/runtime-registry'

const output = resolve(process.env.HALO_DISTRIBUTION_VISUAL_OUTPUT || 'tests/acceptance/output/distribution-visual/v2')
const names = { anthropic: 'Claude Code', codex: 'Codex' }
test.setTimeout(240000)

async function capture(page: Page, panel: Locator, prefix: string) {
  await mkdir(output, { recursive: true })
  for (const theme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await page.evaluate(value => {
      document.documentElement.classList.toggle('light', value === 'light')
      document.documentElement.classList.toggle('theme-dark', value === 'dark')
      document.documentElement.style.colorScheme = value
    }, theme)
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport)
      expect(await page.evaluate(() => window.innerWidth)).toBe(viewport.width)
      expect(await page.evaluate(() => window.matchMedia('(min-width: 640px)').matches)).toBe(viewport.width >= 640)
      const responsiveRow = panel.locator('div.flex.flex-col[class*="sm:flex-row"]').first()
      await expect(responsiveRow).toHaveCSS('flex-direction', viewport.width < 640 ? 'column' : 'row')
      const heading = panel.getByRole('heading', { level: 3 })
      await heading.evaluate(element => element.scrollIntoView({ block: 'center' }))
      await expect(heading).toBeInViewport()
      await expect(panel).toBeVisible()
      const overflow = await panel.evaluate(element => element.scrollWidth > element.clientWidth + 1)
      expect(overflow, `${prefix}/${theme}/${viewport.width} panel horizontal overflow`).toBe(false)
      await page.screenshot({ path: resolve(output, `${prefix}-${theme}-${viewport.width}x${viewport.height}.png`) })
      if (viewport.width < 640) {
        await panel.getByText('Connect local installation', { exact: true }).evaluate(element => element.scrollIntoView({ block: 'center' }))
        await page.screenshot({ path: resolve(output, `${prefix}-${theme}-${viewport.width}x${viewport.height}-bottom.png`) })
      }
    }
  }
}

for (const engine of ['anthropic', 'codex'] as const) {
  test(`${names[engine]} real settings diagnostic screenshots`, async ({ window, model }) => {
    const registry = await startRuntimeRegistry(engine, { pausePrefixBytes: 256 * 1024 })
    try {
      await navigateToSettings(window)
      await window.locator('#advanced').scrollIntoViewIfNeeded()
      await window.getByRole('button', { name: `Set up ${names[engine]}`, exact: true }).click()
      const panel = window.getByRole('region', { name: `${names[engine]} setup`, exact: true })
      await expect(panel.getByText(`No ${names[engine]} installations added yet.`, { exact: true })).toBeVisible()
      await capture(window, panel, `${engine}-uninstalled`)
      await panel.getByText(/^Source settings/).click()
      await panel.getByLabel('Download source', { exact: true }).selectOption('custom')
      await panel.getByLabel('Mirror base URL', { exact: true }).fill(registry.baseUrl)
      await panel.getByRole('button', { name: 'Save source', exact: true }).click()
      await expect(panel.getByText('Saved', { exact: true })).toBeVisible()
      registry.pause()
      await panel.getByRole('button', { name: 'Install recommended version', exact: true }).click()
      await expect.poll(() => registry.requests.some(url => engine === 'codex' ? url.endsWith('.tgz') : /\/claude(?:\.exe)?$/.test(url)), { timeout: 45000 }).toBe(true)
      await expect(panel.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled()
      await expect(panel.getByText(/^Downloading:/)).toBeVisible({ timeout: 15000 })
      await capture(window, panel, `${engine}-progress`)
      await panel.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(panel.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0)
      registry.resume()
      registry.setOnline(false)
      await panel.getByRole('button', { name: 'Install recommended version', exact: true }).click()
      await expect(panel.getByRole('alert').first()).toBeVisible({ timeout: 45000 })
      await capture(window, panel, `${engine}-networkfailure`)
      if (engine === 'anthropic') {
        registry.setOnline(true)
        await panel.getByRole('button', { name: 'Install recommended version', exact: true }).click()
        await expect(panel.getByText('Installed versions', { exact: true })).toBeVisible({ timeout: 120000 })
        await expect(panel.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0)
        await capture(window, panel, `${engine}-installed`)
      }
      expect(model.exchanges).toHaveLength(0)
    } finally { await registry.close() }
  })
}
