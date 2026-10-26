import { test, expect, acceptance, sendAcceptanceMessage, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { startAcceptanceMcp } from '../fixtures/acceptance-mcp'
import { modelTool } from '../fixtures/acceptance-model'
import { navigateToApps, navigateToChat } from '../fixtures/helpers'

test('an MCP connection installed through the UI executes real tools and reports operation and connection failures', acceptance('capabilities.connections.tool-call'), async ({ model, window }, testInfo) => {
  test.setTimeout(150000)
  const service = await startAcceptanceMcp()
  model.respond(request => {
    if (request.lastUserText.includes('Use the connected service successfully.')) {
      const result = request.toolResults.find(result => result.id === 'successful-service-call')
      if (!result) return { tools: [modelTool(request, 'echo_acceptance', { value: 'original-request' }, 'successful-service-call')] }
      expect(result.text).toContain('Service receipt: original-request')
      return { text: 'The connected service returned original-request.' }
    }
    if (request.lastUserText.includes('Use the service while its operation is failing.')) {
      const result = request.toolResults.find(result => result.id === 'failed-service-call')
      if (!result) return { tools: [modelTool(request, 'echo_acceptance', { value: 'failing-request' }, 'failed-service-call')] }
      expect(result.text).toContain('The requested service operation failed. No result was produced.')
      return { text: 'The service operation failed. It did not produce the requested result.' }
    }
    if (request.lastUserText.includes('Try the recovered service.')) {
      const result = request.toolResults.find(result => result.id === 'recovered-service-call')
      if (!result) return { tools: [modelTool(request, 'echo_acceptance', { value: 'recovered-request' }, 'recovered-service-call')] }
      expect(result.text).toContain('Service receipt: recovered-request')
      return { text: 'The recovered service returned recovered-request.' }
    }
    throw new Error(`Unexpected MCP scenario model request ${request.sequence}`)
  })
  try {
    await navigateToApps(window)
    await window.getByRole('button', { name: 'Capability library', exact: true }).click()
    await window.getByRole('button', { name: 'MCP connections', exact: true }).click()
    await window.getByRole('button', { name: 'Manual Add MCP', exact: true }).click()
    const dialog = window.getByRole('dialog', { name: 'Add connection', exact: true })
    await dialog.getByPlaceholder('e.g. my-mcp-server', { exact: true }).fill('Acceptance echo')
    await dialog.locator('select:has(option[value="streamable-http"])').selectOption('streamable-http')
    await dialog.getByPlaceholder('https://...', { exact: true }).fill(service.url)
    await dialog.getByRole('button', { name: 'Create connection', exact: true }).click()
    await expect(dialog.getByText('Connections saved.', { exact: true })).toBeVisible()
    await dialog.getByRole('button', { name: 'Test connection', exact: true }).click()
    await expect(dialog.getByRole('status')).toHaveText('Connected')
    expect(service.requests.some(request => request.method === 'initialize')).toBe(true)
    expect(service.requests.some(request => request.method === 'tools/list')).toBe(true)
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()

    await navigateToChat(window)
    const success = await sendAcceptanceMessage(window, 'Use the connected service successfully.')
    await expect(window.locator('.message-assistant').last()).toContainText('The connected service returned original-request.')
    await waitForAcceptanceIdle(window, success.conversationId)
    expect(service.calls).toEqual([{ value: 'original-request', failed: false }])
    service.failTools(true)
    const failure = await sendAcceptanceMessage(window, 'Use the service while its operation is failing.')
    await expect(window.locator('.message-assistant').last()).toContainText('The service operation failed. It did not produce the requested result.')
    await waitForAcceptanceIdle(window, failure.conversationId)
    expect(service.calls).toEqual([{ value: 'original-request', failed: false }, { value: 'failing-request', failed: true }])

    await navigateToApps(window)
    await window.getByRole('button', { name: 'Capability library', exact: true }).click()
    await window.getByRole('button', { name: 'MCP connections', exact: true }).click()
    await window.getByRole('heading', { name: 'Acceptance echo', exact: true, level: 3 }).click()
    const configuration = window.getByRole('heading', { name: 'Configuration', exact: true }).locator('..')
    service.setAvailable(false)
    await configuration.getByRole('button', { name: 'Test connection', exact: true }).click()
    await expect(window.getByText('The MCP server failed to connect.', { exact: true })).toBeVisible({ timeout: 30000 })
    expect(service.requests.some(request => request.status === 503)).toBe(true)
    service.setAvailable(true)
    service.failTools(false)
    await configuration.getByRole('button', { name: 'Test connection', exact: true }).click()
    await expect(window.getByText('The MCP server failed to connect.', { exact: true })).toHaveCount(0)
    await expect(window.getByText('Connected', { exact: true })).toBeVisible()
    await navigateToChat(window)
    const recovered = await sendAcceptanceMessage(window, 'Try the recovered service.')
    await expect(window.locator('.message-assistant').last()).toContainText('The recovered service returned recovered-request.')
    await waitForAcceptanceIdle(window, recovered.conversationId)
    expect(service.calls).toHaveLength(3)
    expect(service.calls.at(-1)).toEqual({ value: 'recovered-request', failed: false })
  } finally {
    await testInfo.attach('external-mcp-exchanges', { body: JSON.stringify({ requests: service.requests, calls: service.calls }, null, 2), contentType: 'application/json' })
    await service.close()
  }
})
