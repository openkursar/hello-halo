/**
 * The digital human's settings panel: grouped navigation, its status marks, and
 * how the same panel holds up at mobile width.
 *
 * The nav is the panel's only map — if a group id and its nav entry drift, or
 * the column stops collapsing into a strip below 640px, the panel is still
 * rendered but no longer usable on a phone.
 */

import type { HaloAPI } from '../../../src/preload'
import { test, expect } from '../fixtures/people'
import { navigateToApps, navigateToSettings } from '../fixtures/helpers'
import type { Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

test.setTimeout(60000)
test.use({ peopleCount: 2 })

async function openSettings(page: Page) {
  await navigateToApps(page)
  await page.getByRole('button', { name: 'Analyst 000', exact: true }).click()
  await page.getByRole('button', { name: 'Capabilities and settings', exact: true }).click()
}

async function digitalHumanEngine(page: Page) {
  const result = await page.evaluate(async () => (globalThis.window as unknown as { halo: HaloAPI }).halo.appGet('person-000'))
  expect(result.success).toBe(true)
  return (result.data as { userOverrides: { engineId?: string } }).userOverrides.engineId
}

test('digital human engine confirmation preserves the choice until approved and fits 375px', async ({ window }, testInfo) => {
  await window.setViewportSize({ width: 375, height: 900 })
  await openSettings(window)
  const advanced = window.locator('#settings-group-advanced')
  await advanced.getByRole('button', { name: 'Advanced', exact: true }).click()
  const engine = advanced.getByRole('combobox', { name: 'Digital human engine', exact: true })
  await expect(engine).toBeEnabled()
  await expect(engine).toHaveValue('')
  await engine.selectOption('halo')
  const confirmation = window.getByRole('alertdialog', { name: 'Change this digital human’s engine?', exact: true })
  await expect(confirmation).toBeVisible()
  expect(await digitalHumanEngine(window)).toBeUndefined()
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(engine).toHaveValue('')
  await engine.selectOption('halo')
  await expect(confirmation).toBeVisible()
  expect(await confirmation.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await window.screenshot({ path: testInfo.outputPath('digital-human-engine-confirm-mobile.png') })
  await confirmation.getByRole('button', { name: 'Change engine', exact: true }).click()
  await expect.poll(() => digitalHumanEngine(window)).toBe('halo')
  await expect(engine).toHaveValue('halo')
  await engine.selectOption('')
  await expect(confirmation).toContainText('Existing conversations keep their current engine')
  await confirmation.getByRole('button', { name: 'Change engine', exact: true }).click()
  await expect.poll(() => digitalHumanEngine(window)).toBeUndefined()
  expect(await advanced.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await engine.scrollIntoViewIfNeeded()
  await window.screenshot({ path: testInfo.outputPath('digital-human-engine-mobile.png') })
})

test('digital human engine can use local CC while the application default stays Halo', async ({ window }, testInfo) => {
  const nativePath = process.env.HALO_E2E_CC_PATH ? resolve(process.env.HALO_E2E_CC_PATH) : ''
  test.skip(!nativePath || !existsSync(nativePath), 'Requires a real local Claude Code installation')
  const configured = await window.evaluate(async path => {
    const halo = (globalThis.window as unknown as { halo: HaloAPI }).halo
    const selected = await halo.ccRuntimeSelect(path)
    if (!selected.success) return selected
    return halo.setConfig({ agent: { sdkEngine: 'halo' } })
  }, nativePath)
  expect(configured.success).toBe(true)
  await openSettings(window)
  const advanced = window.locator('#settings-group-advanced')
  await advanced.getByRole('button', { name: 'Advanced', exact: true }).click()
  const engine = advanced.getByRole('combobox', { name: 'Digital human engine', exact: true })
  await expect(engine).toBeEnabled()
  await engine.selectOption('anthropic')
  await window.getByRole('alertdialog', { name: 'Change this digital human’s engine?', exact: true }).getByRole('button', { name: 'Change engine', exact: true }).click()
  await expect.poll(() => digitalHumanEngine(window)).toBe('anthropic')
  const saved = await window.evaluate(async () => {
    const result = await (globalThis.window as unknown as { halo: HaloAPI }).halo.getConfig()
    return (result.data as { agent?: { sdkEngine?: string } }).agent?.sdkEngine
  })
  expect(saved).toBe('halo')
  await expect(window.getByRole('button', { name: 'Restart Now', exact: true })).toHaveCount(0)
  await engine.scrollIntoViewIfNeeded()
  await window.screenshot({ path: testInfo.outputPath('digital-human-cc-with-halo-default.png') })
})

test('digital human engine rejects an incompatible Codex account without changing the saved choice', async ({ window }) => {
  const configured = await window.evaluate(async () => {
    const halo = (globalThis.window as unknown as { halo: HaloAPI }).halo
    return halo.setConfig({ aiSources: {
      version: 2, currentId: 'engine-compat-account', sources: [{
        id: 'engine-compat-account', name: 'Fixture Claude API', provider: 'anthropic', authType: 'api-key',
        apiUrl: 'https://example.invalid', apiKey: 'fixture-not-a-real-key', model: 'claude-test', availableModels: [], createdAt: '', updatedAt: '',
      }],
    } })
  })
  expect(configured.success).toBe(true)
  await window.reload()
  await openSettings(window)
  const advanced = window.locator('#settings-group-advanced')
  await advanced.getByRole('button', { name: 'Advanced', exact: true }).click()
  const engine = advanced.getByRole('combobox', { name: 'Digital human engine', exact: true })
  await expect(engine).toBeEnabled()
  await expect(engine.locator('option[value="codex"]')).toBeDisabled()
  const result = await window.evaluate(async () => (globalThis.window as unknown as { halo: HaloAPI }).halo.appUpdateOverrides({ appId: 'person-000', overrides: { engineId: 'codex' } }))
  expect(result.success).toBe(false)
  expect(result.error).toContain('Codex supports OpenAI-compatible')
  expect(await digitalHumanEngine(window)).toBeUndefined()
  await expect(engine).toHaveValue('')
})

test('nav entries address the groups they render, and a jump brings its group into view', { annotation: { type: 'acceptance', description: "{\"caseId\":\"people.settings.group-navigation\",\"evidence\":\"app-e2e\",\"mode\":\"none\",\"variant\":{}}" } }, async ({ window }) => {
  await openSettings(window)
  const nav = window.locator('nav').filter({ hasText: 'Identity & Instructions' })

  // Which groups exist depends on the digital human (a trigger group only for
  // automation, runtime parameters only with a config schema), so the contract
  // is one entry per rendered group in the same order — not a fixed list.
  const audit = await window.evaluate(() => {
    const groups = Array.from(document.querySelectorAll('[id^="settings-group-"]'))
    return {
      ids: groups.map(node => node.id),
      headings: groups.map(node => (node.querySelector('h2') ?? node.querySelector(':scope > button[aria-expanded] > span'))?.textContent?.trim() ?? ''),
      entries: Array.from(document.querySelectorAll('nav button span.truncate')).map(node => node.textContent?.trim() ?? ''),
    }
  })
  expect(audit.ids.length).toBeGreaterThan(0)
  expect(new Set(audit.ids).size).toBe(audit.ids.length)
  expect(audit.headings).toEqual(audit.entries)

  const advanced = window.locator('#settings-group-advanced')
  await expect(advanced).not.toBeInViewport()
  await nav.getByRole('button', { name: 'Advanced', exact: true }).click()
  await expect(advanced).toBeInViewport()
  const disclosure = advanced.getByRole('button', { name: 'Advanced', exact: true })
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
  await disclosure.click()
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
  await expect(advanced.getByRole('heading', { name: 'App Spec', exact: true })).toBeVisible()
})

test('an unsaved edit marks its group in the nav and clears when saved', { annotation: { type: 'acceptance', description: "{\"caseId\":\"people.settings.save-identity\",\"evidence\":\"app-e2e\",\"mode\":\"none\",\"variant\":{}}" } }, async ({ window }) => {
  await openSettings(window)
  const nav = window.locator('nav').filter({ hasText: 'Identity & Instructions' })
  const identityEntry = nav.getByRole('button', { name: 'Identity & Instructions', exact: true })
  const dirtyMark = identityEntry.locator('span.bg-halo-warning')
  await expect(dirtyMark).toHaveCount(0)

  const name = window.locator('#settings-group-identity input[type="text"]').first()
  await name.fill('Analyst 000 renamed')
  await expect(dirtyMark).toHaveCount(1)

  // Saving persists through the app's own API, so a fresh list read shows it.
  await window.locator('#settings-group-identity').getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dirtyMark).toHaveCount(0)
  await expect.poll(async () => window.evaluate(async () => {
    const result = await (globalThis.window as unknown as { halo: HaloAPI }).halo.appGet('person-000')
    return (result.data as { spec?: { name?: string } } | undefined)?.spec?.name
  })).toBe('Analyst 000 renamed')
})

test('the messages group hosts the bound-bot card that opens a bot’s session browser', async ({ window }) => {
  await openSettings(window)
  const group = window.locator('#settings-group-notifications')
  // No IM channel is bound to the seeded person, so the card shows its
  // unbound state — its presence here is what places the card in this group.
  await expect(group.getByText('No bot bound — configure in Settings')).toBeVisible()
})

test('the work activity tab opens on the compact run summary band', async ({ window }) => {
  await navigateToApps(window)
  await window.getByRole('button', { name: 'Analyst 000', exact: true }).click()

  const runs = await window.evaluate(async () => {
    const result = await (globalThis.window as unknown as { halo: HaloAPI }).halo.appGetRuns({ appId: 'person-000', options: { limit: 7 } })
    return (result.data ?? []) as { status: string }[]
  })
  expect(runs.length).toBeGreaterThan(0)

  const band = window.getByRole('region', { name: 'Reliability' })
  await expect(band).toBeVisible()
  const succeeded = runs.filter(run => run.status === 'ok').length
  await expect(band).toContainText(`${Math.round((succeeded / runs.length) * 100)}%`)
  await expect(band).toContainText(`succeeded in the last ${runs.length} runs`)
})

async function seedBots(page: Page) {
  const result = await page.evaluate(async () => {
    const halo = (globalThis.window as unknown as { halo: HaloAPI }).halo
    const instances = [
      { id: 'bot-sales', type: 'wecom-bot', appId: 'person-001' },
      { id: 'bot-unbound', type: 'wecom-bot', appId: '' },
      { id: 'bot-current', type: 'wecom-bot', appId: 'person-000' },
      { id: 'bot-feishu', type: 'feishu-bot', appId: 'person-001' },
    ].map(instance => ({ ...instance, enabled: false, config: {} }))
    const saved = await halo.setConfig({ imChannels: { instances } })
    if (!saved.success) return saved
    return halo.imChannelsReload()
  })
  expect(result.success).toBe(true)
}

async function botStatuses(page: Page) {
  return page.evaluate(async () => {
    const result = await (globalThis.window as unknown as { halo: HaloAPI }).halo.imChannelsStatus()
    return (result.data ?? []) as Array<{ id: string; appId: string; appName?: string; ordinal: number }>
  })
}

for (const width of [1280, 375]) {
  test(`the scan menu dismisses outside, on Escape, and before opening a scan dialog at ${width}px`, { annotation: { type: 'acceptance', description: JSON.stringify({ caseId: "channels.connect.scan-navigation", evidence: "ui", mode: "none", variant: { width: String(width) } }) } }, async ({ window, electronApp }) => {
    await window.setViewportSize({ width, height: 900 })
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('wecom-bot:scan-auth:start')
      ipcMain.handle('wecom-bot:scan-auth:start', () => ({ success: false, error: 'Scan unavailable in test' }))
    })
    await seedBots(window)
    await openSettings(window)
    const section = window.getByRole('region', { name: 'Bot Access', exact: true })
    const trigger = section.getByRole('button', { name: 'Scan to add a bot', exact: true })
    await trigger.click()
    const menu = window.getByRole('dialog').filter({ has: window.getByRole('button', { name: 'WeCom bot', exact: true }) })
    await expect(menu).toBeVisible()
    await section.getByRole('button', { name: 'Bind an existing bot', exact: true }).click()
    await expect(menu).toHaveCount(0)
    await trigger.click()
    await window.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await trigger.focus()
    await window.keyboard.press('Enter')
    await expect(menu).toBeVisible()
    const box = await menu.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(width)
    await menu.getByRole('button', { name: 'WeCom bot', exact: true }).click()
    await expect(menu).toHaveCount(0)
    const scan = window.getByRole('dialog').filter({ hasText: 'Scan to add WeCom Bot' })
    await expect(scan).toBeVisible()
    await scan.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(scan).toHaveCount(0)
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  })

  test(`bot numbers and current owners stay consistent, and transfer requires confirmation at ${width}px`, { annotation: { type: 'acceptance', description: JSON.stringify({ caseId: "channels.connect.person-transfer", evidence: "app-e2e", mode: "none", variant: { width: String(width) } }) } }, async ({ window }) => {
    await window.setViewportSize({ width, height: 900 })
    await seedBots(window)
    await openSettings(window)
    const section = window.getByRole('region', { name: 'Bot Access', exact: true })
    await expect(section.getByText('WeCom bot 3', { exact: true })).toBeVisible()
    await section.getByRole('button', { name: 'Bind an existing bot', exact: true }).click()
    const row = section.getByRole('button', { name: 'WeCom bot 1 now bound to Analyst 001', exact: true })
    await expect(row).toBeVisible()
    await expect(section.getByRole('button', { name: 'WeCom bot 2 Not bound', exact: true })).toBeVisible()
    await window.screenshot({ path: `tests/e2e/results/bot-picker-${width}.png`, animations: 'disabled' })
    await row.click()
    const confirmation = window.getByRole('alertdialog')
    await expect(confirmation).toContainText('WeCom bot 1')
    await expect(confirmation).toContainText('Analyst 001')
    await expect(confirmation).toContainText('Analyst 000')
    await window.screenshot({ path: `tests/e2e/results/bot-confirm-${width}.png`, animations: 'disabled' })
    await expect(confirmation.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
    expect((await botStatuses(window)).find(bot => bot.id === 'bot-sales')?.appId).toBe('person-001')
    await window.keyboard.press('Escape')
    await expect(confirmation).toHaveCount(0)
    await expect(row).toBeEnabled()
    await row.click()
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(row).toBeEnabled()
    await row.click()
    await confirmation.getByRole('button', { name: 'Rebind', exact: true }).click()
    await expect.poll(async () => (await botStatuses(window)).find(bot => bot.id === 'bot-sales')?.appName).toBe('Analyst 000')
    await expect(section.getByText('WeCom bot 1', { exact: true })).toBeVisible()
    await expect(section.getByText('WeCom bot 3', { exact: true })).toBeVisible()
    await section.getByRole('button', { name: 'Bind an existing bot', exact: true }).click()
    await section.getByRole('button', { name: 'WeCom bot 2 Not bound', exact: true }).click()
    await expect(confirmation).toHaveCount(0)
    await expect.poll(async () => (await botStatuses(window)).find(bot => bot.id === 'bot-unbound')?.appId).toBe('person-000')
    await window.screenshot({ path: `tests/e2e/results/bot-binding-${width}.png`, animations: 'disabled' })
    const dimensions = await window.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }))
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1)
  })

  test(`long digital human names wrap in the picker and confirmation at ${width}px`, { annotation: { type: 'acceptance', description: JSON.stringify({ caseId: "people.settings.long-names", evidence: "app-e2e", mode: "none", variant: { width: String(width) } }) } }, async ({ window }) => {
    await window.setViewportSize({ width, height: 900 })
    await seedBots(window)
    const name = 'CustomerSupport'.repeat(14)
    const renamed = await window.evaluate(async name => (globalThis.window as unknown as { halo: HaloAPI }).halo.appUpdateSpec({ appId: 'person-001', specPatch: { name } }), name)
    expect(renamed.success).toBe(true)
    await openSettings(window)
    const section = window.getByRole('region', { name: 'Bot Access', exact: true })
    await section.getByRole('button', { name: 'Bind an existing bot', exact: true }).click()
    const row = section.getByRole('button', { name: `WeCom bot 1 now bound to ${name}`, exact: true })
    await expect(row).toBeVisible()
    expect(await row.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
    await row.click()
    const confirmation = window.getByRole('alertdialog')
    await expect(confirmation).toContainText(name)
    expect(await confirmation.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true)
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
  })

  test(`an outdated transfer confirmation cannot take over a bot rebound elsewhere at ${width}px`, { annotation: { type: 'acceptance', description: JSON.stringify({ caseId: "channels.connect.stale-transfer", evidence: "app-e2e", mode: "none", variant: { width: String(width) } }) } }, async ({ window }) => {
    await window.setViewportSize({ width, height: 900 })
    await seedBots(window)
    await openSettings(window)
    const section = window.getByRole('region', { name: 'Bot Access', exact: true })
    await section.getByRole('button', { name: 'Bind an existing bot', exact: true }).click()
    await section.getByRole('button', { name: 'WeCom bot 1 now bound to Analyst 001', exact: true }).click()
    const confirmation = window.getByRole('alertdialog')
    await expect(confirmation).toBeVisible()
    const changed = await window.evaluate(async () => (globalThis.window as unknown as { halo: HaloAPI }).halo.imChannelsUnbindInstance('bot-sales'))
    expect(changed.success).toBe(true)
    await confirmation.getByRole('button', { name: 'Rebind', exact: true }).click()
    await expect(section.getByText('The bot binding changed. Refresh and confirm again.', { exact: true })).toBeVisible()
    expect((await botStatuses(window)).find(bot => bot.id === 'bot-sales')?.appId).toBe('')
    await expect(section.getByRole('button', { name: 'WeCom bot 1 Not bound', exact: true })).toBeEnabled()
  })

  test(`global connection settings also confirm before transferring a bot at ${width}px`, { annotation: { type: 'acceptance', description: JSON.stringify({ caseId: "channels.connect.global-transfer", evidence: "app-e2e", mode: "none", variant: { width: String(width) } }) } }, async ({ window }) => {
    await window.setViewportSize({ width, height: 900 })
    await seedBots(window)
    await window.reload()
    await navigateToSettings(window)
    const section = window.locator('#message-channels')
    await section.getByRole('button', { name: /WeCom Intelligent Bot/ }).click()
    await section.getByRole('button', { name: /Analyst 001.*WeCom bot 1/ }).click()
    const picker = section.locator('select').filter({ has: window.locator('option[value="app:person-001"]') }).first()
    await picker.selectOption('app:person-000')
    const confirmation = window.getByRole('alertdialog')
    await expect(confirmation).toContainText('Analyst 001')
    await expect(confirmation).toContainText('Analyst 000')
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(picker).toHaveValue('app:person-001')
    expect((await botStatuses(window)).find(bot => bot.id === 'bot-sales')?.appId).toBe('person-001')
    await picker.selectOption('app:person-000')
    await confirmation.getByRole('button', { name: 'Rebind', exact: true }).click()
    await expect(picker).toHaveValue('app:person-000')
    await expect.poll(async () => (await botStatuses(window)).find(bot => bot.id === 'bot-sales')?.appId).toBe('person-000')
  })

  test(`a working-days switch stays reversible outside China at ${width}px`, { annotation: { type: 'acceptance', description: JSON.stringify({ caseId: "automation.schedule.calendar-toggle", evidence: "app-e2e", mode: "none", variant: { width: String(width) } }) } }, async ({ window }) => {
    const cdp = await window.context().newCDPSession(window)
    await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'Europe/Berlin' })
    await window.setViewportSize({ width, height: 900 })
    await navigateToApps(window)
    const seeded = await window.evaluate(async () => (globalThis.window as unknown as { halo: HaloAPI }).halo.appUpdateSpec({
      appId: 'person-000',
      specPatch: { subscriptions: [{ id: 'daily', source: { type: 'schedule', config: { cron: '0 9 * * *', workday_calendar: true } } }] },
    }))
    expect(seeded.success).toBe(true)
    await window.reload()
    await openSettings(window)

    const label = window.getByText('Only on mainland China working days', { exact: true })
    const control = label.locator('../..').getByRole('switch')
    const saved = async () => window.evaluate(async () => {
      const result = await (globalThis.window as unknown as { halo: HaloAPI }).halo.appGet('person-000')
      const app = result.data as { spec: { subscriptions: Array<{ source: { config: { workday_calendar?: boolean } } }> } }
      return app.spec.subscriptions[0].source.config.workday_calendar === true
    })
    await expect(control).toHaveAttribute('aria-checked', 'true')
    await control.click()
    await expect.poll(saved).toBe(false)
    await expect(control).toHaveAttribute('aria-checked', 'false')
    await expect(label).toBeVisible()
    await control.click()
    await expect.poll(saved).toBe(true)
    await expect(control).toHaveAttribute('aria-checked', 'true')
    await control.click()
    await expect.poll(saved).toBe(false)
    await expect(control).toHaveAttribute('aria-checked', 'false')
    const dimensions = await window.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }))
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1)
    await expect(control).toHaveClass(/bg-muted/)
    await window.screenshot({ path: `tests/e2e/results/workday-reversible-${width}.png`, animations: 'disabled' })

    await window.reload()
    await openSettings(window)
    await expect(window.locator('#settings-group-trigger')).toBeVisible()
    await expect(label).toHaveCount(0)
  })
}

test('the nav collapses to a scrolling strip and the panel stays inside the viewport at 375px', { annotation: { type: 'acceptance', description: "{\"caseId\":\"people.settings.narrow-groups\",\"evidence\":\"app-e2e\",\"mode\":\"none\",\"variant\":{}}" } }, async ({ window }) => {
  await openSettings(window)
  const nav = window.locator('nav').filter({ hasText: 'Identity & Instructions' })
  const strip = nav.locator('> div')

  await window.setViewportSize({ width: 1440, height: 1000 })
  await expect.poll(async () => strip.evaluate(node => getComputedStyle(node).flexDirection)).toBe('column')

  await window.setViewportSize({ width: 375, height: 812 })
  await expect.poll(async () => strip.evaluate(node => getComputedStyle(node).flexDirection)).toBe('row')
  // A strip that neither wraps nor scrolls would clip the last entries.
  expect(await strip.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true)

  const width = await window.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }))
  expect(width.content).toBeLessThanOrEqual(width.viewport + 1)

  // Every group is still reachable by tapping a strip entry at this width.
  const advanced = window.locator('#settings-group-advanced')
  await nav.getByRole('button', { name: 'Advanced', exact: true }).click()
  await expect(advanced).toBeInViewport()
  await window.screenshot({ path: 'tests/e2e/results/people-settings-375.png' })
})
