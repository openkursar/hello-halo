import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/acceptance-skill-server'
import type { ModelRequest } from '../fixtures/acceptance-model'
import { navigateToChat } from '../fixtures/helpers'

test.describe.configure({ retries: 0 })
test.use({ useScriptedModel: true })
test.setTimeout(90000)

function binding(id: string) {
  return { annotation: { type: 'acceptance', description: JSON.stringify({ caseId: `capabilities.library-keyboard.${id}`, evidence: 'app-e2e', mode: 'scripted', variant: {} }) } }
}

async function openLibrary(page: Page, section: 'Skills' | 'MCP connections' = 'Skills') {
  await page.locator('nav').getByRole('button', { name: 'Digital Humans', exact: true }).click()
  await page.getByRole('button', { name: 'Capability library', exact: true }).click()
  await page.getByRole('button', { name: section, exact: true }).click()
  if (section === 'Skills') await page.getByRole('combobox', { name: 'Workspace', exact: true }).selectOption('')
}

test('using a skill preserves the draft through keyboard completion and sends it once', binding('skill-draft'), async ({ skillServer: server }) => {
  const record = server.records.find(item => item.kind === 'active')!
  const page = server.page
  const requests: ModelRequest[] = []
  const answer = 'The existing draft arrived intact.'
  server.model!.respond(request => { requests.push(request); return { text: answer } })
  await navigateToChat(page)
  const composer = page.locator('textarea').first()
  const draft = 'summarize the quarterly evidence'
  await composer.fill(draft)
  await openLibrary(page)
  await page.getByRole('heading', { name: record.name, exact: true, level: 3 }).click()
  await page.getByRole('button', { name: 'Use', exact: true }).click()
  const message = `/${record.name} ${draft}`
  await expect(composer).toHaveValue(message)
  await composer.press('Enter')
  await expect(composer).toHaveValue(message)
  await expect(page.locator('.message-user')).toHaveCount(0)
  expect(requests).toHaveLength(0)
  const sent = page.waitForRequest(request => new URL(request.url()).pathname === '/api/agent/message')
  await composer.press('Enter')
  const turn = (await sent).postDataJSON() as { spaceId: string; conversationId: string; message: string }
  expect(turn.message).toBe(message)
  await expect(page.locator('.message-assistant').last()).toContainText(answer)
  expect(requests).toHaveLength(1)
  expect(requests[0].lastUserText).toContain(record.body)
  const saved = await server.request<{ messages: Array<{ role: string; content: string }> }>(`/api/spaces/${turn.spaceId}/conversations/${turn.conversationId}`)
  expect(saved.messages.filter(item => item.role === 'user').map(item => item.content)).toEqual([message])
})

test('a legacy delete confirmation remains reachable and Escape preserves its parent dialog', binding('nested-confirmation'), async ({ skillServer: server }) => {
  const page = server.page
  const record = server.records.find(item => item.kind === 'uninstalled')!
  const before = server.rows()
  await openLibrary(page)
  await page.locator('summary').filter({ hasText: 'Previously removed skills' }).click()
  const removed = page.getByText(record.name, { exact: true }).locator('..')
  await removed.getByRole('button', { name: 'View removed skill', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Recover legacy skill content', exact: true })
  const confirmation = dialog.getByRole('alertdialog', { name: 'Delete legacy skill content?', exact: true })
  for (const decline of ['Escape', 'Cancel']) {
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(confirmation).toBeVisible()
    if (decline === 'Escape') await page.keyboard.press('Escape')
    else await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(confirmation).toHaveCount(0)
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Delete', exact: true })).toBeEnabled()
    expect(server.rows()).toEqual(before)
  }
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
  await confirmation.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(confirmation).toHaveCount(0)
  await expect.poll(async () => (await server.list()).legacyRemoved.some(item => item.appId === record.id)).toBe(false)
  expect(server.rows().filter(row => row.id !== record.id)).toEqual(before.filter(row => row.id !== record.id))
  await server.restart()
  expect((await server.list()).legacyRemoved.some(item => item.appId === record.id)).toBe(false)
})

test('Enter in the MCP tag editor saves the tag without opening the detail page', binding('mcp-tags'), async ({ skillServer: server }) => {
  const app = await server.request<{ appId: string }>('/api/apps/install', { spec: {
    spec_version: '1.0', type: 'mcp', name: 'Keyboard tag example', version: '1.0.0', author: 'Acceptance fixture',
    description: 'An isolated connection for keyboard interaction.', mcp_server: { transport: 'streamable-http', command: 'http://127.0.0.1:9/mcp' },
  }, spaceId: null })
  const page = server.page
  await openLibrary(page, 'MCP connections')
  const card = page.locator('[role="button"]').filter({ has: page.getByRole('heading', { name: 'Keyboard tag example', exact: true, level: 3 }) })
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 900 })
    const search = page.getByPlaceholder('Search MCP servers or tools', { exact: true })
    await expect(search).toBeVisible()
    const searchWidth = await search.evaluate(input => input.getBoundingClientRect().width)
    expect(searchWidth).toBeGreaterThan(150)
    await card.hover()
    await card.getByTitle('More', { exact: true }).click()
    await card.getByRole('button', { name: 'Tags…', exact: true }).click()
    const input = card.getByRole('textbox', { name: 'Add a tag', exact: true })
    await input.fill(`Review-${width}`)
    await input.press('Enter')
    await expect(card).toBeVisible()
    await expect(card.getByTitle(`Show items tagged Review-${width}`, { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Back to capability library', exact: true })).toHaveCount(0)
    const saved = await server.request<{ userOverrides: { tags: string[] } }>(`/api/apps/${app.appId}`)
    expect(saved.userOverrides.tags).toContain(`Review-${width}`)
    await page.getByPlaceholder('Search MCP servers or tools', { exact: true }).click()
  }
  await page.setViewportSize({ width: 1280, height: 900 })
  await server.restart()
  const saved = await server.request<{ userOverrides: { tags: string[] } }>(`/api/apps/${app.appId}`)
  expect(saved.userOverrides.tags).toEqual(['Review-1280', 'Review-375'])
})
