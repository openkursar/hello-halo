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

    const storeTab = await window.$('text=/Marketplace|市场/i')
    expect(storeTab).toBeTruthy()

    await window.screenshot({ path: 'tests/e2e/results/apps-tabs.png' })
  })

  test('capability library exposes skill and MCP categories', async ({ window }) => {
    await navigateToApps(window)
    await window.getByRole('button', { name: /Capability library|能力库/i }).click()
    await expect(window.getByRole('heading', { name: /Skills|技能/i })).toBeVisible()
    await window.getByRole('button', { name: /MCP connections|MCP连接|MCP 连接/i, exact: true }).click()
    await expect(window.getByRole('heading', { name: /MCP connections|MCP连接|MCP 连接/i })).toBeVisible()
    await window.getByRole('button', { name: /Skills|技能/i, exact: true }).click()
    await expect(window.getByRole('heading', { name: /Skills|技能/i })).toBeVisible()
    await window.screenshot({ path: 'tests/e2e/results/apps-capability-library.png' })
  })

  test('can switch to Marketplace tab', async ({ window }) => {
    await navigateToApps(window)

    // Click Marketplace tab (renamed from "App Store")
    const storeTab = await window.waitForSelector(
      'button:has-text("Marketplace"), button:has-text("市场")',
      { timeout: 5000 }
    )
    await storeTab.click()
    await window.waitForTimeout(500)

    // StoreView should render
    await window.screenshot({ path: 'tests/e2e/results/apps-marketplace-tab.png' })
  })

  test('My Digital Humans shows empty state or app list', async ({ window }) => {
    await navigateToApps(window)

    await expect(window.getByRole('textbox', { name: /Search digital humans|搜索数字人/i })).toBeVisible()
    await expect(window.getByRole('button', { name: /Card view|卡片视图/i })).toBeVisible()
    await expect(window.getByRole('button', { name: /List view|列表视图/i })).toBeVisible()

    await window.screenshot({ path: 'tests/e2e/results/apps-digital-humans.png' })
  })

  test('can navigate back from Apps page', async ({ window }) => {
    await navigateToApps(window)

    // Find back button (ChevronLeft + text)
    const backButton = await window.waitForSelector(
      'button:has-text("Back"), button:has-text("返回")',
      { timeout: 5000 }
    )
    await backButton.click()

    // Should return to Home Page
    await window.waitForSelector('[data-onboarding="halo-space"]', { timeout: 10000 })
  })

  test('settings button is accessible from Apps page', async ({ window }) => {
    await navigateToApps(window)

    // Settings button should be in the header (gear icon)
    const settingsButton = await window.waitForSelector(
      'button[title="Settings"], button[title="设置"]',
      { timeout: 5000 }
    ).catch(() => null)

    expect(settingsButton).toBeTruthy()
  })
})

test.describe('Apps Page - Store Tab', () => {
  test.setTimeout(30000)

  test('app store shows content', async ({ window }) => {
    await navigateToApps(window)

    // Switch to Marketplace tab (renamed from "App Store")
    const storeTab = await window.waitForSelector(
      'button:has-text("Marketplace"), button:has-text("市场")',
      { timeout: 5000 }
    )
    await storeTab.click()

    // Wait for store content to load
    await window.waitForTimeout(1000)

    // Store should show some content (cards, grid, or loading state)
    const bodyText = await window.evaluate(() => document.body.innerText)
    expect(bodyText.length).toBeGreaterThan(50)

    await window.screenshot({ path: 'tests/e2e/results/apps-store-content.png' })
  })
})
