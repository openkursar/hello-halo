import { test, expect, acceptance, sendAcceptanceMessage, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { startAcceptanceMcp } from '../fixtures/acceptance-mcp'
import {
  assertMcpModelResult, changeMcpUrl, installMcpConnection, isMcpTurnActive,
  mcpConnections, mcpConversationEvidence, scriptMcpTurn, type McpTurn,
} from '../fixtures/acceptance-mcp-recovery'
import { navigateToChat } from '../fixtures/helpers'

test.setTimeout(150000)

test('a real engine tool request fails while its MCP server is unavailable and later turns recover on the same connection', acceptance('capabilities.connections.reconnect'), async ({ model, window }, info) => {
  const service = await startAcceptanceMcp()
  const scripts: McpTurn[] = []
  try {
    const connection = await installMcpConnection(window, 'Recoverable connection', service.url)
    await navigateToChat(window)
    const warm = scriptMcpTurn(model, 'before-outage')
    scripts.push(warm)
    const original = await sendAcceptanceMessage(window, warm.question)
    await expect(window.locator('.message-assistant').last()).toContainText(warm.answer)
    await waitForAcceptanceIdle(window, original.conversationId)
    assertMcpModelResult(warm, true)
    expect(service.calls).toEqual([{ value: warm.value, failed: false }])

    service.setAvailable(false)
    const failed = scriptMcpTurn(model, 'during-outage')
    scripts.push(failed)
    const failure = await sendAcceptanceMessage(window, failed.question)
    expect(failure.conversationId).toBe(original.conversationId)
    await expect(window.locator('.message-assistant').last()).toContainText(failed.answer)
    await waitForAcceptanceIdle(window, failure.conversationId)
    assertMcpModelResult(failed, false)
    const rejectedCalls = service.exchanges.filter(exchange => exchange.method === 'tools/call' && exchange.value === failed.value)
    expect(rejectedCalls.length).toBeGreaterThan(0)
    expect(rejectedCalls.every(exchange => exchange.status === 503 && exchange.completed && !exchange.cancelled)).toBe(true)
    const failedEvidence = await mcpConversationEvidence(window, failure)
    const failedThoughts = failedEvidence.thoughts.filter(thought => thought.toolInput?.value === failed.value)
    expect(failedThoughts).toHaveLength(1)
    expect(failedThoughts[0].toolResult).toMatchObject({ isError: true })

    service.setAvailable(true)
    for (const label of ['after-recovery', 'still-recovered']) {
      const script = scriptMcpTurn(model, label)
      scripts.push(script)
      const next = await sendAcceptanceMessage(window, script.question)
      expect(next.conversationId).toBe(original.conversationId)
      await expect(window.locator('.message-assistant').last()).toContainText(script.answer)
      await waitForAcceptanceIdle(window, next.conversationId)
      assertMcpModelResult(script, true)
    }
    expect(service.calls).toEqual(scripts.filter(script => script !== failed).map(script => ({ value: script.value, failed: false })))
    const current = (await mcpConnections(window)).find(app => app.id === connection.id)
    expect(current).toMatchObject({ status: 'active', spec: { mcp_server: { command: service.url } } })
    const evidence = await mcpConversationEvidence(window, original)
    expect(evidence.conversation.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(scripts.map(script => script.question))
    expect(evidence.thoughts).toHaveLength(4)
    for (const script of scripts) {
      const thoughts = evidence.thoughts.filter(thought => thought.toolInput?.value === script.value)
      expect(thoughts).toHaveLength(1)
      expect(thoughts[0].toolResult?.isError).toBe(script === failed)
      if (script !== failed) expect(thoughts[0].toolResult?.output).toContain(`Service receipt: ${script.value}`)
    }
    await info.attach('recovered-mcp-conversation', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' })
  } finally {
    try { await info.attach('recovered-mcp-protocol', { body: JSON.stringify({ exchanges: service.exchanges, calls: service.calls, scripts }, null, 2), contentType: 'application/json' }) }
    finally { await service.close() }
  }
})

test('editing a connection while its real tool call is pending preserves that call and routes later turns to the saved endpoint', acceptance('capabilities.connections.active-change'), async ({ model, window }, info) => {
  const originalService = await startAcceptanceMcp()
  let replacementService: Awaited<ReturnType<typeof startAcceptanceMcp>> | undefined
  const held = originalService.holdNextToolCall()
  const scripts: McpTurn[] = []
  try {
    replacementService = await startAcceptanceMcp()
    const connection = await installMcpConnection(window, 'Editable connection', originalService.url)
    await navigateToChat(window)
    const current = scriptMcpTurn(model, 'running-on-original')
    scripts.push(current)
    const running = await sendAcceptanceMessage(window, current.question)
    await expect.poll(() => originalService.calls).toEqual([{ value: current.value, failed: false }])
    expect(await isMcpTurnActive(window, running.conversationId)).toBe(true)
    await changeMcpUrl(window, 'Editable connection', replacementService.url)
    const saved = (await mcpConnections(window)).find(app => app.id === connection.id)
    expect(saved).toMatchObject({ status: 'active', spec: { mcp_server: { command: replacementService.url } } })
    expect(await isMcpTurnActive(window, running.conversationId)).toBe(true)
    const inFlight = originalService.exchanges.filter(exchange => exchange.method === 'tools/call' && exchange.value === current.value)
    expect(inFlight).toHaveLength(1)
    expect(inFlight[0]).toMatchObject({ status: null, completed: false, cancelled: false })
    expect(replacementService.calls).toEqual([])
    held.release()
    await navigateToChat(window)
    await expect(window.locator('.message-assistant').last()).toContainText(current.answer)
    await waitForAcceptanceIdle(window, running.conversationId)
    assertMcpModelResult(current, true)
    expect(inFlight[0]).toMatchObject({ status: 200, completed: true, cancelled: false })

    for (const label of ['new-endpoint', 'new-endpoint-again']) {
      const script = scriptMcpTurn(model, label)
      scripts.push(script)
      const next = await sendAcceptanceMessage(window, script.question)
      expect(next.conversationId).toBe(running.conversationId)
      await expect(window.locator('.message-assistant').last()).toContainText(script.answer)
      await waitForAcceptanceIdle(window, next.conversationId)
      assertMcpModelResult(script, true)
    }
    expect(originalService.calls).toEqual([{ value: current.value, failed: false }])
    expect(replacementService.calls).toEqual(scripts.slice(1).map(script => ({ value: script.value, failed: false })))
    const evidence = await mcpConversationEvidence(window, running)
    expect(evidence.conversation.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(scripts.map(script => script.question))
    expect(evidence.thoughts).toHaveLength(3)
    for (const script of scripts) {
      const thoughts = evidence.thoughts.filter(thought => thought.toolInput?.value === script.value)
      expect(thoughts).toHaveLength(1)
      expect(thoughts[0].toolResult).toMatchObject({ isError: false, output: expect.stringContaining(`Service receipt: ${script.value}`) })
    }
    await info.attach('changed-mcp-conversation', { body: JSON.stringify({ connectionId: connection.id, saved, evidence }, null, 2), contentType: 'application/json' })
  } finally {
    held.release()
    try { await info.attach('changed-mcp-protocol', { body: JSON.stringify({ original: { url: originalService.url, exchanges: originalService.exchanges, calls: originalService.calls }, replacement: replacementService && { url: replacementService.url, exchanges: replacementService.exchanges, calls: replacementService.calls }, scripts }, null, 2), contentType: 'application/json' }) }
    finally { await Promise.all([originalService.close(), replacementService?.close()]) }
  }
})
