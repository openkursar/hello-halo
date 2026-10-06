/**
 * Apps / Digital Humans E2E Tests
 *
 * Tests the Apps page (digital humans, apps, app store)
 * including tab navigation, list rendering, and basic interactions.
 */

import { test, expect } from '../fixtures/electron'
import { navigateToApps } from '../fixtures/helpers'

test.describe('Apps Page', () => {
  test.setTimeout(30000)

  test('renders with correct tab bar', async ({ window }) => {
    await navigateToApps(window)

    await expect(window.getByRole('button', { name: /My Digital Humans|我的数字人/i }).first()).toBeVisible()
    await expect(window.getByRole('button', { name: /Capability library|能力库/i })).toBeVisible()

    await expect(window.getByRole('button', { name: 'Teams', exact: true })).toBeVisible()
    await expect(window.getByRole('button', { name: 'Store', exact: true })).toBeVisible()

    await window.screenshot({ path: 'tests/e2e/results/apps-tabs.png' })
  })

  test('capability library exposes skill and MCP categories', async ({ window }) => {
    await navigateToApps(window)
    await window.getByRole('button', { name: /Capability library|能力库/i }).click()
    const skills = window.getByRole('button', { name: 'Skills', exact: true })
    const mcp = window.getByRole('button', { name: 'MCP connections', exact: true })
    await expect(skills).toBeVisible()
    await expect(skills).toHaveAttribute('aria-pressed', 'true')
    await expect(window.getByRole('button', { name: 'Manual Add Skill', exact: true })).toBeVisible()
    await mcp.click()
    await expect(mcp).toHaveAttribute('aria-pressed', 'true')
    await expect(window.getByRole('button', { name: 'Manual Add MCP', exact: true })).toBeVisible()
    await skills.click()
    await expect(skills).toHaveAttribute('aria-pressed', 'true')
    await expect(window.getByRole('button', { name: 'Manual Add Skill', exact: true })).toBeVisible()
    await window.screenshot({ path: 'tests/e2e/results/apps-capability-library.png' })
  })

  test('can open Store from Apps page', async ({ window }) => {
    await navigateToApps(window)

    const store = window.getByRole('button', { name: 'Store', exact: true })
    await store.click()
    await expect(store).toHaveAttribute('aria-current', 'page')
    await expect(window.getByRole('heading', { name: 'Explore · Store', exact: true, level: 1 })).toBeVisible()

    await window.screenshot({ path: 'tests/e2e/results/apps-marketplace-tab.png' })
  })

  test('My Digital Humans shows empty state or app list', async ({ window }) => {
    await navigateToApps(window)

    await expect(window.getByRole('textbox', { name: /Search digital humans|搜索数字人/i })).toBeVisible()

    await window.screenshot({ path: 'tests/e2e/results/apps-digital-humans.png' })
  })

  test('can navigate back from Apps page', async ({ window }) => {
    await navigateToApps(window)

    await window.getByRole('button', { name: 'Conversation', exact: true }).click()
    await expect(window.locator('textarea')).toBeVisible()
    await expect(window.getByRole('textbox', { name: 'Search digital humans', exact: true })).toHaveCount(0)
  })

  test('settings button is accessible from Apps page', async ({ window }) => {
    await navigateToApps(window)

    const settings = window.getByRole('button', { name: 'Settings', exact: true })
    await expect(settings).toBeVisible()
    await settings.click()
    await expect(window.locator('#ai-model').getByRole('heading', { name: 'AI Model', exact: true })).toBeVisible()
  })
})

test.describe('Apps Page - Store navigation', () => {
  test.setTimeout(30000)

  test('app store shows content', async ({ window }) => {
    await navigateToApps(window)

    await window.getByRole('button', { name: 'Store', exact: true }).click()
    await expect(window.getByRole('heading', { name: 'Explore · Store', exact: true, level: 1 })).toBeVisible()

    // Store should show some content (cards, grid, or loading state)
    const bodyText = await window.evaluate(() => document.body.innerText)
    expect(bodyText.length).toBeGreaterThan(50)

    await window.screenshot({ path: 'tests/e2e/results/apps-store-content.png' })
  })
})
