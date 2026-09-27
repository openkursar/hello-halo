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
import { navigateToApps } from '../fixtures/helpers'
import type { Page } from '@playwright/test'

test.setTimeout(60000)
test.use({ peopleCount: 2 })

async function openSettings(page: Page) {
  await navigateToApps(page)
  await page.getByRole('button', { name: 'Analyst 000', exact: true }).click()
  await page.getByRole('button', { name: 'Capabilities and settings', exact: true }).click()
}

test('nav entries address the groups they render, and a jump brings its group into view', async ({ window }) => {
  await openSettings(window)
  const nav = window.locator('nav').filter({ hasText: 'Identity & Instructions' })

  // Which groups exist depends on the digital human (a trigger group only for
  // automation, runtime parameters only with a config schema), so the contract
  // is one entry per rendered group in the same order — not a fixed list.
  const audit = await window.evaluate(() => {
    const groups = Array.from(document.querySelectorAll('[id^="settings-group-"]'))
    return {
      ids: groups.map(node => node.id),
      headings: groups.map(node => node.querySelector('h2')?.textContent?.trim() ?? ''),
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
})

test('an unsaved edit marks its group in the nav and clears when saved', async ({ window }) => {
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

test('the nav collapses to a scrolling strip and the panel stays inside the viewport at 375px', async ({ window }) => {
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
