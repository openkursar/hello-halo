import type { Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import type { HaloAPI } from '../../../src/preload'
import { test, expect } from '../fixtures/electron'
import { navigateToChat, navigateToWorkspaces } from '../fixtures/helpers'
import { clickArtifactByName, openFromHeaderMenu } from '../../perf/lib/open-artifact'

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

async function switchWorkspace(window: Page, from: string, to: string) {
  await window.getByTitle(`Current workspace: ${from} — click to switch`, { exact: true }).click()
  await window.locator('[role="button"]').filter({ has: window.getByText(to, { exact: true }) }).first().click()
  await expect(window.getByTitle(`Current workspace: ${to} — click to switch`, { exact: true })).toBeVisible()
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

  test('can create a dedicated workspace and find it in workspace management', { annotation: { type: 'acceptance', description: '{"caseId":"workspaces.manage.create","evidence":"app-e2e","mode":"none","variant":{}}' } }, async ({ window }) => {
    await createWorkspace(window, 'E2E Test Space')
    await navigateToWorkspaces(window)

    await expect(window.getByRole('heading', { name: 'E2E Test Space', exact: true, level: 3 })).toBeVisible()
    await window.screenshot({ path: 'tests/e2e/results/spaces-created.png' })
  })

  test('can reopen a dedicated workspace from its card and see chat', { annotation: { type: 'acceptance', description: '{"caseId":"workspaces.manage.reopen","evidence":"app-e2e","mode":"none","variant":{}}' } }, async ({ window }) => {
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

  test('a workspace keeps its open files and unsaved edits while another one is in use', { annotation: { type: 'acceptance', description: '{"caseId":"workspaces.context.keep-edit","evidence":"app-e2e","mode":"none","variant":{}}' } }, async ({ electronApp, window }) => {
    const dataDirectory = await electronApp.evaluate(() => process.env.HALO_DATA_DIR!)
    const file = path.join(dataDirectory, 'temp', 'artifacts', 'kept-across-switch.ts')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'export const kept = 1\n')

    await navigateToChat(window)
    await clickArtifactByName(window, path.basename(file))
    const tab = window.locator('.canvas-tab', { hasText: path.basename(file) })
    await expect(tab).toBeVisible()
    await window.getByTitle('Edit file', { exact: true }).click()
    await window.locator('.cm-content').first().click()
    await window.keyboard.type('// unsaved edit ')
    await expect(tab.locator('.canvas-tab-dirty')).toBeVisible()

    await createWorkspace(window, 'E2E Second Space')
    await expect(window.locator('.canvas-tab')).toHaveCount(0)

    await switchWorkspace(window, 'E2E Second Space', 'Halo Workspace')
    await expect(tab).toBeVisible()
    await expect(tab.locator('.canvas-tab-dirty')).toBeVisible()
    await expect(window.locator('.cm-content').first()).toContainText('// unsaved edit')
    await window.screenshot({ path: 'tests/e2e/results/spaces-tabs-kept.png' })
    expect(fs.readFileSync(file, 'utf8')).toBe('export const kept = 1\n')

    await switchWorkspace(window, 'Halo Workspace', 'E2E Second Space')
    await expect(window.locator('.canvas-tab')).toHaveCount(0)
  })

  test('a workspace\'s own terminal keeps running while another one is in use', { annotation: { type: 'acceptance', description: "{\"caseId\":\"workspaces.context.terminal-session\",\"evidence\":\"app-e2e\",\"mode\":\"none\",\"variant\":{}}" } }, async ({ window }) => {
    test.skip(process.platform === 'linux', 'terminals are not available on Linux')
    const terminals = () => window.evaluate(async () => {
      const result = await (globalThis.window as unknown as { halo: HaloAPI }).halo.listTerminals()
      return result.data as Array<{ id: string; state: string }>
    })

    await navigateToChat(window)
    await openFromHeaderMenu(window, 'Open terminal')
    await expect(window.locator('.xterm')).toBeVisible()
    await expect.poll(async () => (await terminals()).length).toBe(1)
    const [{ id }] = await terminals()

    await createWorkspace(window, 'E2E Terminal Space')
    await expect(window.locator('.canvas-tab')).toHaveCount(0)
    expect(await terminals()).toEqual([expect.objectContaining({ id, state: 'running' })])

    await switchWorkspace(window, 'E2E Terminal Space', 'Halo Workspace')
    await expect(window.locator('.canvas-tab')).toHaveCount(1)
    await expect(window.locator('.xterm')).toBeVisible()
    await window.evaluate(sessionId => (globalThis.window as unknown as { halo: HaloAPI }).halo.terminalInput({ sessionId, data: "printf 'STILL_RUNNING_%s\\n' ok\r" }), id)
    await expect.poll(() => window.evaluate(async sessionId => {
      const result = await (globalThis.window as unknown as { halo: HaloAPI }).halo.getTerminalReplay({ sessionId })
      return JSON.stringify(result.data)
    }, id)).toContain('STILL_RUNNING_ok')
    await window.evaluate(sessionId => (globalThis.window as unknown as { halo: HaloAPI }).halo.killTerminal({ sessionId }), id)
  })

  test('can create a new persisted conversation in the Halo workspace', { annotation: { type: 'acceptance', description: "{\"caseId\":\"conversations.organize.persisted-new\",\"evidence\":\"app-e2e\",\"mode\":\"none\",\"variant\":{}}" } }, async ({ window }) => {
    await navigateToChat(window)
    const before = await conversationIds(window)
    await window.getByRole('button', { name: 'New', exact: true }).first().click()

    await expect.poll(async () => (await conversationIds(window)).some(id => !before.includes(id))).toBe(true)
    await expect(window.locator('textarea')).toBeVisible()
    await expect(window.locator('textarea')).toHaveValue('')
    await window.screenshot({ path: 'tests/e2e/results/spaces-new-conv.png' })
  })

  test('cancelling workspace creation leaves the workspace list unchanged', { annotation: { type: 'acceptance', description: '{"caseId":"workspaces.manage.cancel","evidence":"app-e2e","mode":"none","variant":{}}' } }, async ({ window }) => {
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
