import { test, expect } from '../fixtures/electron'
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

  test('has a settings navigation sidebar with working section links', async ({ window }) => {
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

  test('can switch between light and dark themes', async ({ window }) => {
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

  test('the header back button returns to the previous conversation view', async ({ window }) => {
    await navigateToChat(window)
    await navigateToSettings(window)
    await window.locator('header').getByRole('button', { name: 'Settings', exact: true }).click()

    await expect(window.locator('textarea')).toBeVisible()
    await expect(window.locator('#ai-model')).toHaveCount(0)
  })
})
