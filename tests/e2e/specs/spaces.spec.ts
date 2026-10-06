import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import { test, expect } from '../fixtures/electron'
import { navigateToChat, navigateToWorkspaces } from '../fixtures/helpers'

async function createWorkspace(window: Page, name: string) {
  await navigateToWorkspaces(window)
  await window.getByRole('button', { name: 'New Workspace', exact: true }).first().click()
  const heading = window.getByRole('heading', { name: 'Create Dedicated Workspace', exact: true })
  await expect(heading).toBeVisible()
  await window.getByPlaceholder('e.g. Payment Refactor', { exact: true }).fill(name)
  await window.getByRole('button', { name: 'Create', exact: true }).click()

  await expect(heading).toHaveCount(0)
  await expect(window.locator('textarea')).toBeVisible()
  await expect(window.getByTitle(`Current workspace: ${name} — click to switch`, { exact: true })).toBeVisible()
}

async function conversationIds(window: Page) {
  const result = await window.evaluate(async () => {
    return (globalThis.window as unknown as { halo: HaloAPI }).halo.listConversations('halo-temp')
  })
  expect(result.success).toBe(true)
  return (result.data as Array<{ id: string }>).map(conversation => conversation.id)
}

test.describe('Workspace Management', () => {
  test.setTimeout(30000)

  test('can create a dedicated workspace and find it in workspace management', async ({ window }) => {
    await createWorkspace(window, 'E2E Test Space')
    await navigateToWorkspaces(window)

    await expect(window.getByRole('heading', { name: 'E2E Test Space', exact: true, level: 3 })).toBeVisible()
    await window.screenshot({ path: 'tests/e2e/results/spaces-created.png' })
  })

  test('can reopen a dedicated workspace from its card and see chat', async ({ window }) => {
    await createWorkspace(window, 'E2E Enter Space')
    await navigateToWorkspaces(window)

    const spaceCard = window.locator('[role="button"]:not([aria-roledescription="sortable"])').filter({
      has: window.getByRole('heading', { name: 'E2E Enter Space', exact: true, level: 3 }),
    })
    await expect(spaceCard).toBeVisible()
    await spaceCard.click()

    await expect(window.locator('textarea')).toBeVisible()
    await expect(window.getByTitle('Current workspace: E2E Enter Space — click to switch', { exact: true })).toBeVisible()
    await window.screenshot({ path: 'tests/e2e/results/spaces-entered.png' })
  })

  test('can create a new persisted conversation in the Halo workspace', async ({ window }) => {
    await navigateToChat(window)
    const before = await conversationIds(window)
    await window.getByRole('button', { name: 'New', exact: true }).first().click()

    await expect.poll(async () => (await conversationIds(window)).some(id => !before.includes(id))).toBe(true)
    await expect(window.locator('textarea')).toBeVisible()
    await expect(window.locator('textarea')).toHaveValue('')
    await window.screenshot({ path: 'tests/e2e/results/spaces-new-conv.png' })
  })

  test('cancelling workspace creation leaves the workspace list unchanged', async ({ window }) => {
    await navigateToWorkspaces(window)
    await expect(window.getByRole('heading', { name: 'Halo Workspace', exact: true, level: 3 })).toBeVisible()
    const cards = window.getByRole('heading', { level: 3 })
    const before = await cards.allTextContents()
    await window.getByRole('button', { name: 'New Workspace', exact: true }).first().click()
    const heading = window.getByRole('heading', { name: 'Create Dedicated Workspace', exact: true })
    await expect(heading).toBeVisible()
    await window.getByPlaceholder('e.g. Payment Refactor', { exact: true }).fill('Cancelled workspace')
    await window.getByRole('button', { name: 'Cancel', exact: true }).click()

    await expect(heading).toHaveCount(0)
    await expect(window.getByRole('heading', { name: 'Workspace', exact: true, level: 1 })).toBeVisible()
    await expect.poll(() => cards.allTextContents()).toEqual(before)
    await expect(window.getByRole('heading', { name: 'Cancelled workspace', exact: true })).toHaveCount(0)
  })
})
