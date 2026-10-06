import { test, expect } from '../fixtures/electron'
import {
  waitForHomePage,
  navigateToChat,
  navigateToSettings,
  navigateToApps,
  navigateToWorkspaces,
} from '../fixtures/helpers'

test.describe('App shell', () => {
  test('renders the persistent navigation destinations', async ({ window }) => {
    await waitForHomePage(window)

    for (const name of ['Conversation', 'Digital Humans', 'Knowledge Base', 'Store', 'Tasks', 'Settings']) {
      await expect(window.getByRole('button', { name, exact: true }).first()).toBeVisible()
    }

    await window.screenshot({ path: 'tests/e2e/results/nav-shell.png' })
  })

  test('settings is accessible from the navigation rail', async ({ window }) => {
    await waitForHomePage(window)
    await window.getByRole('button', { name: 'Settings', exact: true }).first().click()
    await expect(window.locator('#ai-model').getByRole('heading', { name: 'AI Model', exact: true })).toBeVisible()
  })
})

test.describe('Page Navigation', () => {
  test.setTimeout(30000)

  test('can navigate to the Halo workspace and see chat', async ({ window }) => {
    await navigateToChat(window)

    await expect(window.locator('textarea')).toBeVisible()
    await expect(window.locator('[data-onboarding="send-button"]')).toBeVisible()
    await expect(window.getByRole('button', { name: 'Conversation', exact: true }).first()).toHaveAttribute('aria-current', 'page')

    await window.screenshot({ path: 'tests/e2e/results/nav-halo-space.png' })
  })

  test('can navigate to Settings', async ({ window }) => {
    await navigateToSettings(window)
    await expect(window.locator('#ai-model').getByRole('heading', { name: 'AI Model', exact: true })).toBeVisible()
    await expect(window.getByRole('button', { name: 'Settings', exact: true }).first()).toHaveAttribute('aria-current', 'page')

    await window.screenshot({ path: 'tests/e2e/results/nav-settings.png' })
  })

  test('can navigate to Digital Humans and its capability library', async ({ window }) => {
    await navigateToApps(window)

    for (const name of ['My Digital Humans', 'Teams', 'Capability library']) {
      await expect(window.getByRole('button', { name, exact: true })).toBeVisible()
    }
    await expect(window.getByRole('button', { name: 'Digital Humans', exact: true }).first()).toHaveAttribute('aria-current', 'page')

    await window.screenshot({ path: 'tests/e2e/results/nav-apps-page.png' })
  })

  test('can open workspace management and return to the Halo workspace', async ({ window }) => {
    await navigateToChat(window)
    await navigateToWorkspaces(window)

    const haloCard = window.getByRole('button').filter({
      has: window.getByRole('heading', { name: 'Halo Workspace', exact: true, level: 3 }),
    })
    await expect(haloCard).toBeVisible()
    await haloCard.click()
    await expect(window.locator('textarea')).toBeVisible()
    await expect(window.getByTitle('Current workspace: Halo Workspace — click to switch', { exact: true })).toBeVisible()

    await window.screenshot({ path: 'tests/e2e/results/nav-back-to-chat.png' })
  })

  test('can navigate back from Settings to the previous conversation view', async ({ window }) => {
    await navigateToChat(window)
    await navigateToSettings(window)
    await window.locator('header').getByRole('button', { name: 'Settings', exact: true }).click()

    await expect(window.locator('textarea')).toBeVisible()
    await expect(window.locator('#ai-model')).toHaveCount(0)
  })
})
