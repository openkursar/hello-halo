import type { HaloAPI } from '../../../src/preload'
import { createServer } from 'node:http'
import { test, expect } from '../fixtures/people'
import { navigateToApps } from '../fixtures/helpers'
import type { Page } from '@playwright/test'

test.setTimeout(60000)
test.use({ peopleCount: 2 })

async function openCapabilities(page: Page) {
  await navigateToApps(page)
  await page.getByRole('button', { name: 'Analyst 000', exact: true }).click()
  await page.getByRole('button', { name: 'Capabilities and settings', exact: true }).click()
}

test('skill draft survives closing, installation stays in context and workspace inheritance is real', async ({ window }) => {
  await openCapabilities(window)
  await window.getByRole('button', { name: 'New skill', exact: true }).click()
  let dialog = window.getByRole('dialog', { name: 'Add Skill', exact: true })
  await dialog.getByPlaceholder('e.g. Code Review Guidelines').fill('Evidence checklist')
  await dialog.getByPlaceholder('When should the AI use this skill?').fill('Reviewing evidence before publishing')
  await dialog.getByPlaceholder('Write the skill instructions here in Markdown...').fill('Check each factual claim against its original source.')
  await dialog.getByRole('button', { name: 'Close and keep draft', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await window.getByRole('button', { name: 'New skill', exact: true }).click()
  dialog = window.getByRole('dialog', { name: 'Add Skill', exact: true })
  await expect(dialog.getByPlaceholder('e.g. Code Review Guidelines')).toHaveValue('Evidence checklist')
  await expect(dialog.getByPlaceholder('Write the skill instructions here in Markdown...')).toHaveValue('Check each factual claim against its original source.')
  await dialog.getByRole('button', { name: 'Install Skill', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(window.getByRole('button', { name: 'New skill', exact: true })).toBeVisible()
  await expect.poll(async () => window.evaluate(async () => {
    const result = await (globalThis.window as unknown as { halo: HaloAPI }).halo.appListAvailableSkills('person-001')
    return result.data?.some(skill => skill.description === 'Reviewing evidence before publishing') ?? false
  })).toBe(true)
  const inventory = await window.evaluate(async () => (await (globalThis.window as unknown as { halo: HaloAPI }).halo.appGetCapabilityInventory()).data)
  expect(inventory?.entries.find(entry => entry.type === 'skill' && entry.specId === 'evidence-checklist')?.consumers.map(person => person.appId)).toEqual(expect.arrayContaining(['person-000', 'person-001']))
})

test('MCP save, person enablement and live connection checks are independent; shared changes show impact', async ({ window }) => {
  let healthy = false
  const methods: string[] = []
  const server = createServer(async (request, response) => {
    if (!healthy) { response.writeHead(503); response.end('Unavailable for test'); return }
    if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
    let body = ''
    for await (const chunk of request) body += chunk
    const message = JSON.parse(body)
    methods.push(message.method)
    if (message.id === undefined) { response.writeHead(202); response.end(); return }
    const result = message.method === 'initialize'
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'evidence-test-server', version: '1.0' } }
      : { tools: [{ name: 'read_evidence', description: 'Read test evidence', inputSchema: { type: 'object', properties: {} } }] }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  try {
    await openCapabilities(window)
    await window.getByRole('button', { name: 'New connection', exact: true }).click()
    const dialog = window.getByRole('dialog', { name: 'Add connection', exact: true })
    await dialog.getByPlaceholder('e.g. my-mcp-server').fill('evidence-local')
    await dialog.locator('select').filter({ has: window.locator('option[value="streamable-http"]') }).selectOption('streamable-http')
    await dialog.getByPlaceholder('https://...').fill(`http://127.0.0.1:${address.port}/mcp`)
    await dialog.getByRole('button', { name: 'Create and enable for Analyst 000', exact: true }).click()
    await expect(dialog.getByText('Connections saved and enabled for Analyst 000.', { exact: true })).toBeVisible()
    const installed = await window.evaluate(async () => {
      const resources = (await (globalThis.window as unknown as { halo: HaloAPI }).halo.appList({ type: 'mcp' })).data as Array<{ id: string; specId: string; spec: { name: string } }>
      const person = (await (globalThis.window as unknown as { halo: HaloAPI }).halo.appGet('person-000')).data as { spec: { requires: { mcps: Array<{ id: string; enabled?: boolean }> } } }
      return { resource: resources.find(item => item.spec.name === 'evidence-local'), dependencies: person.spec.requires.mcps }
    })
    expect(installed.resource).toBeTruthy()
    expect(installed.dependencies).toContainEqual(expect.objectContaining({ id: installed.resource!.specId }))
    await dialog.getByRole('button', { name: 'Test connection', exact: true }).click()
    await expect(dialog.getByText('Connection failed. Your configuration is saved; check settings and retry.', { exact: true })).toBeVisible()
    healthy = true
    await dialog.getByRole('button', { name: 'Test connection', exact: true }).click()
    await expect(dialog.getByText('Connected', { exact: true })).toBeVisible()
    expect(methods).toEqual(expect.arrayContaining(['initialize', 'tools/list']))
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()
    await window.getByText('evidence-local', { exact: true }).first().click()
    await window.getByRole('button', { name: 'Open MCP detail', exact: true }).click()
    const detail = window.getByRole('dialog', { name: 'Shared connection settings', exact: true })
    await expect(detail.getByText('Shared resource', { exact: true })).toBeVisible()
    await detail.getByRole('switch', { name: 'Disable', exact: true }).click()
    const impact = window.getByRole('dialog', { name: 'Change shared resource availability?', exact: true })
    await expect(impact.getByText('Analyst 001', { exact: true })).toBeVisible()
    await impact.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(detail.getByRole('switch', { name: 'Disable', exact: true })).toHaveAttribute('aria-checked', 'true')
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
