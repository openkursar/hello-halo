import { test, expect } from '../fixtures/people'
import { navigateToApps } from '../fixtures/helpers'

test.setTimeout(60000)

test('directory search, bounded pages, return state and coordinator separation use real persisted data', async ({ window }) => {
  await navigateToApps(window)
  const search = window.getByRole('textbox', { name: 'Search digital humans' })
  await expect(search).toBeVisible()
  await expect(window.locator('article')).toHaveCount(24)
  await expect(window.getByRole('button', { name: 'System coordinator', exact: true })).toHaveCount(0)
  await search.fill('Evidence team')
  await expect(window.locator('article')).toHaveCount(1)
  await window.getByRole('button', { name: 'List view', exact: true }).click()
  await window.getByRole('button', { name: 'Analyst 000', exact: true }).click()
  await expect(window.getByRole('button', { name: 'Run once', exact: true })).toBeEnabled()
  await window.getByRole('button', { name: 'All digital humans', exact: true }).click()
  await expect(search).toHaveValue('Evidence team')
  await expect(window.getByRole('button', { name: 'List view', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await search.fill('')
  await window.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(window.locator('article')).toHaveCount(24)
  await window.screenshot({ path: 'tests/e2e/results/people-directory-list.png' })
})

test('inbox includes hidden coordinators, pages requests, and retains unsent decision drafts', async ({ window }) => {
  await navigateToApps(window)
  await window.getByRole('button', { name: 'Needs my attention', exact: true }).first().click()
  await expect(window.locator('article')).toHaveCount(30)
  await window.getByRole('button', { name: 'Load more requests', exact: true }).click()
  await expect(window.locator('article')).toHaveCount(34)
  await expect(window.getByRole('button', { name: 'System coordinator', exact: true })).toBeVisible()
  const first = window.locator('article').first()
  await first.getByRole('button', { name: 'Review and answer', exact: true }).click()
  const draft = first.getByRole('textbox')
  await draft.fill('Preserve this decision draft')
  await first.getByRole('button', { name: 'Analyst 000', exact: true }).click()
  await expect(window.getByRole('textbox').filter({ hasText: 'Preserve this decision draft' })).toHaveCount(1)
  await window.getByRole('button', { name: 'Return to requests', exact: true }).click()
  await window.locator('article').first().getByRole('button', { name: 'Review and answer', exact: true }).click()
  await expect(window.locator('article').first().getByRole('textbox')).toHaveValue('Preserve this decision draft')
})

test.describe('large directory and responsive detail', () => {
  test.use({ peopleCount: 200 })
  test('200 people and 34 requests remain bounded across themes and 320/375px', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', error => errors.push(error.message))
    await navigateToApps(window)
    for (const width of [1440, 375, 320]) {
      await window.setViewportSize({ width, height: width < 640 ? 812 : 1000 })
      for (const theme of ['light', 'dark']) {
        await window.evaluate(value => { document.documentElement.classList.remove('light', 'dark'); document.documentElement.classList.add(value) }, theme)
        await expect(window.locator('article')).toHaveCount(24)
        const size = await window.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }))
        expect(size.content).toBeLessThanOrEqual(size.viewport + 1)
        await window.screenshot({ path: `tests/e2e/results/people-directory-${width}-${theme}.png` })
      }
    }
    await window.getByRole('textbox', { name: 'Search digital humans' }).fill('Analyst 000')
    await window.getByRole('button', { name: 'Analyst 000', exact: true }).click()
    await expect(window.getByRole('button', { name: 'Run once', exact: true })).toBeEnabled()
    const size = await window.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }))
    expect(size.content).toBeLessThanOrEqual(size.viewport + 1)
    await window.screenshot({ path: 'tests/e2e/results/people-detail-320-dark.png' })
    expect(errors).toEqual([])
  })
})
