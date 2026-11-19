import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect, acceptance } from '../fixtures/acceptance-app'
import { navigateToSettings } from '../fixtures/helpers'
import { startRuntimeRegistry } from '../fixtures/runtime-registry'

const names = { anthropic: 'Claude Code', codex: 'Codex' }
const journeys = ['recommended', 'mirror', 'local-selection', 'cancel-retry', 'offline-reuse', 'panel-reopen', 'latest-intent', 'state-isolation'] as const

test.setTimeout(240000)

async function openSetup(page: Page, engine: keyof typeof names) {
  if (!await page.locator('#advanced').isVisible()) await navigateToSettings(page)
  await page.locator('#advanced').scrollIntoViewIfNeeded()
  const panel = page.getByRole('region', { name: `${names[engine]} setup`, exact: true })
  if (!await panel.isVisible()) await page.getByRole('button', { name: `Set up ${names[engine]}`, exact: true }).click()
  await expect(panel).toBeVisible()
  return panel
}

for (const engine of ['anthropic', 'codex'] as const) {
  for (const journey of journeys) {
    test(`${names[engine]} shared setup ${journey}`, acceptance('models.engines.external-setup', { engine, journey }), async ({ acceptanceApp, window, model }, info) => {
      const registry = await startRuntimeRegistry(engine)
      try {
        const panel = await openSetup(window, engine)
        await expect(panel.getByText(`No ${names[engine]} installations added yet.`, { exact: true })).toBeVisible()
        await panel.getByText(/^Source settings/).click()
        await panel.getByLabel('Download source', { exact: true }).selectOption('custom')
        await panel.getByLabel('Mirror base URL', { exact: true }).fill(registry.baseUrl)
        await panel.getByRole('button', { name: 'Save source', exact: true }).click()
        await expect(panel.getByText('Saved', { exact: true })).toBeVisible()
        expect(registry.requests).toEqual([])
        const configFile = join(acceptanceApp.profile, '.halo', 'config.json')
        const readConfig = () => JSON.parse(readFileSync(configFile, 'utf8'))
        expect(readConfig().agent.sdkEngine).toBe('halo')
        if (journey === 'local-selection') {
          await panel.getByText('Connect local installation', { exact: true }).click()
          await panel.getByText('Enter path manually', { exact: true }).click()
          await panel.getByLabel(`${names[engine]} path`, { exact: true }).fill(registry.receipt.executable)
          await panel.getByRole('button', { name: 'Check path', exact: true }).click()
          const candidate = panel.getByRole('article').filter({ hasText: registry.receipt.version }).last()
          await expect(candidate.getByRole('button', { name: 'Use this version', exact: true })).toBeEnabled()
          await candidate.getByRole('button', { name: 'Use this version', exact: true }).click()
          await expect.poll(() => readConfig().agent.sdkEngine).toBe(engine)
          expect(registry.requests).toEqual([])
          expect(model.exchanges).toHaveLength(0)
          return
        }
        if (journey === 'state-isolation') {
          const other = engine === 'codex' ? 'anthropic' : 'codex'
          const otherPanel = await openSetup(window, other)
          await otherPanel.getByText(/^Source settings/).click()
          await expect(otherPanel.getByLabel('Download source', { exact: true })).not.toHaveValue('custom')
          await expect(otherPanel.getByLabel('Mirror base URL', { exact: true })).toHaveCount(0)
          await expect(otherPanel.getByText(`No ${names[other]} installations added yet.`, { exact: true })).toBeVisible()
          await openSetup(window, engine)
          if (!await panel.getByLabel('Download source', { exact: true }).isVisible()) await panel.getByText(/^Source settings/).click()
          await expect(panel.getByLabel('Download source', { exact: true })).toHaveValue('custom')
          await expect(panel.getByLabel('Mirror base URL', { exact: true })).toHaveValue(registry.baseUrl)
          expect(registry.requests).toEqual([])
          expect(model.exchanges).toHaveLength(0)
          return
        }
        if (['cancel-retry', 'panel-reopen', 'latest-intent'].includes(journey)) registry.pause()
        await panel.getByRole('button', { name: 'Install recommended version', exact: true }).click()
        if (['cancel-retry', 'panel-reopen', 'latest-intent'].includes(journey)) {
          await expect(panel.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
          expect(readConfig().agent.sdkEngine).toBe('halo')
          await info.attach('installation-progress', { body: await window.screenshot(), contentType: 'image/png' })
        }
        if (journey === 'cancel-retry') {
          await panel.getByRole('button', { name: 'Cancel', exact: true }).click()
          await expect(panel.getByRole('button', { name: 'Install recommended version', exact: true })).toBeEnabled()
          expect(readConfig().agent.sdkEngine).toBe('halo')
          registry.resume()
          await panel.getByRole('button', { name: 'Install recommended version', exact: true }).click()
        } else if (journey === 'panel-reopen') {
          await panel.getByRole('button', { name: 'Close', exact: true }).click()
          await expect(panel).toBeHidden()
          await window.getByRole('button', { name: `Set up ${names[engine]}`, exact: true }).click()
          await expect(panel.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
          registry.resume()
        } else if (journey === 'latest-intent') {
          await window.locator('#advanced input[name="sdkEngine"][value="halo"]').click()
          registry.resume()
        }
        const field = engine === 'codex' ? 'codexRuntime' : 'ccRuntime'
        await expect.poll(() => readConfig().agent[field]?.selectedPath, { timeout: 120000 }).toBeTruthy()
        await expect(panel.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0)
        await expect.poll(() => readConfig().agent.sdkEngine).toBe(journey === 'latest-intent' ? 'halo' : engine)
        expect(readConfig().agent[field].selectionOrigin).toBe('user')
        expect(registry.requests.some(url => engine === 'codex' ? url.endsWith('.tgz') : /\/claude(?:\.exe)?$/.test(url))).toBe(true)
        if (journey === 'offline-reuse') {
          registry.setOnline(false)
          const requests = registry.requests.length
          await window.locator('#advanced input[name="sdkEngine"][value="halo"]').check()
          await window.locator(`#advanced input[name="sdkEngine"][value="${engine}"]`).check()
          await expect.poll(() => readConfig().agent.sdkEngine).toBe(engine)
          expect(registry.requests.length).toBe(requests)
        }
        expect(model.exchanges).toHaveLength(0)
        await info.attach('external-runtime-registry', { body: JSON.stringify({ engine, journey, receipt: registry.receipt, requests: registry.requests }), contentType: 'application/json' })
        await info.attach('installed-runtime', { body: await window.screenshot(), contentType: 'image/png' })
      } finally { await registry.close() }
    })
  }
}
