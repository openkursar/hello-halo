import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import type { InstalledApp } from '../../../src/shared/apps/app-types'
import type { Thought } from '../../../src/shared/types/transcript'
import { expect, readAcceptanceConversation } from './acceptance-app'
import type { AcceptanceModel, ModelRequest } from './acceptance-model'
import { navigateToApps } from './helpers'

export async function mcpConnections(window: Page): Promise<InstalledApp[]> {
  return window.evaluate(async () => {
    const result = await (globalThis as unknown as { halo: HaloAPI }).halo.appList({ type: 'mcp' })
    if (!result.success || !Array.isArray(result.data)) throw new Error('Could not read installed MCP connections')
    return result.data as InstalledApp[]
  })
}

export async function openMcpLibrary(window: Page) {
  await navigateToApps(window)
  await window.getByRole('button', { name: 'Capability library', exact: true }).click()
  await window.getByRole('button', { name: 'MCP connections', exact: true }).click()
}

export async function installMcpConnection(window: Page, name: string, url: string) {
  await openMcpLibrary(window)
  await window.getByRole('button', { name: 'Manual Add MCP', exact: true }).click()
  const dialog = window.getByRole('dialog', { name: 'Add connection', exact: true })
  await dialog.getByPlaceholder('e.g. my-mcp-server', { exact: true }).fill(name)
  await dialog.locator('select:has(option[value="streamable-http"])').selectOption('streamable-http')
  await dialog.getByPlaceholder('https://...', { exact: true }).fill(url)
  await dialog.getByRole('button', { name: 'Create connection', exact: true }).click()
  await expect(dialog.getByText('Connections saved.', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Test connection', exact: true }).click()
  await expect(dialog.getByRole('status')).toHaveText('Connected')
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  const connections = (await mcpConnections(window)).filter(app => app.spec.type === 'mcp' && app.spec.mcp_server.command === url)
  expect(connections).toHaveLength(1)
  expect(connections[0].status).toBe('active')
  return connections[0]
}

export async function changeMcpUrl(window: Page, name: string, url: string) {
  await openMcpLibrary(window)
  await window.getByRole('heading', { name, level: 3, exact: true }).click()
  const configuration = window.getByRole('heading', { name: 'Configuration', exact: true }).locator('..')
  await configuration.getByRole('button', { name: 'Edit', exact: true }).click()
  await window.getByPlaceholder('https://...', { exact: true }).fill(url)
  await window.getByRole('button', { name: 'Save', exact: true }).click()
  const confirmation = window.getByRole('dialog', { name: 'Save shared resource changes?', exact: true })
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole('button', { name: 'Confirm change', exact: true }).click()
  await expect(confirmation).toHaveCount(0)
  await expect(window.getByPlaceholder('https://...', { exact: true })).toHaveCount(0)
  await expect(window.getByText(url, { exact: true })).toBeVisible()
}

export function scriptMcpTurn(model: AcceptanceModel, label: string) {
  const token = randomUUID()
  const value = `${label}-${token}`
  const id = `mcp-${token}`
  const question = `Use the connection for ${value}.`
  const answer = `Connection turn finished: ${value}.`
  const requests: ModelRequest[] = []
  const missingTools: string[][] = []
  model.respond(request => {
    requests.push(request)
    if (request.toolResults.some(result => result.id === id)) return { text: answer }
    const tools = request.tools.filter(name => name === 'echo_acceptance' || name.endsWith('__echo_acceptance'))
    if (tools.length !== 1) {
      missingTools.push(tools)
      return { text: answer }
    }
    return { tools: [{ id, name: tools[0], input: { value } }] }
  })
  return { id, question, answer, value, requests, missingTools }
}

export type McpTurn = ReturnType<typeof scriptMcpTurn>

export function assertMcpModelResult(script: McpTurn, success: boolean) {
  expect(script.missingTools).toEqual([])
  expect(script.requests).toHaveLength(2)
  expect(script.requests[0].lastUserText).toContain(script.question)
  const results = script.requests[1].toolResults.filter(result => result.id === script.id)
  expect(results).toHaveLength(1)
  if (success) expect(results[0].text).toContain(`Service receipt: ${script.value}`)
  else {
    expect(results[0].text.trim()).not.toBe('')
    expect(results[0].text).not.toContain(`Service receipt: ${script.value}`)
  }
}

export async function mcpConversationEvidence(window: Page, turn: { spaceId: string; conversationId: string }) {
  const conversation = await readAcceptanceConversation(window, turn.spaceId, turn.conversationId)
  const thoughts: Thought[] = []
  for (const message of conversation.messages.filter(message => message.role === 'assistant')) {
    const result = await window.evaluate(async ({ spaceId, conversationId, messageId }) =>
      (globalThis as unknown as { halo: HaloAPI }).halo.getMessageThoughts(spaceId, conversationId, messageId),
    { ...turn, messageId: message.id })
    expect(result.success).toBe(true)
    thoughts.push(...(result.data as Thought[]).filter(thought => thought.type === 'tool_use' && thought.toolName?.endsWith('echo_acceptance')))
  }
  return { conversation, thoughts }
}

export async function isMcpTurnActive(window: Page, conversationId: string) {
  return window.evaluate(async id => {
    const result = await (globalThis as unknown as { halo: HaloAPI }).halo.getSessionState(id)
    if (!result.success || !result.data) throw new Error('Could not inspect the active MCP conversation')
    return (result.data as { isActive: boolean }).isActive
  }, conversationId)
}
