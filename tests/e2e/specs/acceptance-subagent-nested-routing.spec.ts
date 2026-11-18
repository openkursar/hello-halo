import { test, expect, acceptance, sendAcceptanceMessage, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { startAcceptanceModel, initialUserInput, modelTool, type ModelRequest, type ModelReply } from '../fixtures/acceptance-model'
import { configureRoutingTarget, assignmentRoutingScript } from '../fixtures/acceptance-subagent-routing'
import { collaboratorReceipt } from '../fixtures/acceptance-collaboration'
import { navigateToChat } from '../fixtures/helpers'

for (const sdkEngine of ['halo', 'anthropic', 'codex', 'dsh'] as const) test.describe(`Nested selected target on ${sdkEngine}`, () => {
  test.use({ sdkEngine })
  test('a selected child delegates to its own endpoint rather than the root account', acceptance('models.subagent-profiles.owner-routing', { engine: sdkEngine, entry: 'nested', choice: 'profile' }), async ({ model, window }, info) => {
    test.setTimeout(180000)
    const endpoint = await startAcceptanceModel()
    const script = assignmentRoutingScript()
    const nestedMarker = 'ASSIGNED_GRANDCHILD: Return assigned-target-confirmed.'
    const childRequests: ModelRequest[] = []
    const grandchildRequests: ModelRequest[] = []
    const errors: string[] = []
    let grandchildHandle: string | undefined
    model.respond(script.parent)
    endpoint.respond((request): ModelReply => {
      if (initialUserInput(request).includes(nestedMarker)) {
        grandchildRequests.push(request)
        return { text: 'assigned-target-confirmed' }
      }
      childRequests.push(request)
      const result = request.toolResults.find(result => result.id === 'selected-nested-spawn')
      if (result) {
        try { grandchildHandle = collaboratorReceipt(result).handle } catch (error) { errors.push(String(error)) }
        return { text: request.text.includes('assigned-target-confirmed') ? 'assigned-target-confirmed' : 'The detail verifier is preparing.' }
      }
      const advertised = request.tools.find(tool => tool === 'spawn_agent' || tool.endsWith('__spawn_agent'))
      const definition = (request.body.tools ?? []).find((tool: Record<string, any>) => (tool.name ?? tool.function?.name) === advertised)
      if (advertised && (!definition?.defer_loading && !definition?.function?.defer_loading || request.toolResults.some(result => result.id === 'selected-nested-discovery'))) return { tools: [modelTool(request, 'spawn_agent', { name: 'Detail verifier', prompt: nestedMarker }, 'selected-nested-spawn')] }
      return { tools: [modelTool(request, 'ToolSearch', { query: 'select:mcp__halo-team__spawn_agent', max_results: 1 }, 'selected-nested-discovery')] }
    })
    try {
      await configureRoutingTarget(window, endpoint)
      await navigateToChat(window)
      const source = await sendAcceptanceMessage(window, 'Assign the Verifier and ask it to delegate a detail check using its own model.')
      await expect.poll(() => grandchildRequests.length > 0 && script.parentRequests.some(request => request.text.includes('assigned-target-confirmed')), { timeout: 120000 }).toBe(true)
      await waitForAcceptanceIdle(window, source.conversationId)
      expect(script.errors).toEqual([])
      expect(errors).toEqual([])
      expect(script.handle).toBeTruthy()
      expect(grandchildHandle).toBeTruthy()
      expect(grandchildHandle).not.toBe(script.handle)
      expect(childRequests.length).toBeGreaterThan(0)
      expect(grandchildRequests.length).toBeGreaterThan(0)
      const wire = (body: Record<string, unknown>) => ({ model: body.model, reasoning_effort: body.reasoning_effort, reasoning: body.reasoning, thinking: body.thinking, output_config: body.output_config })
      for (const request of grandchildRequests) expect(wire(request.body)).toEqual(wire(childRequests[0].body))
      expect(model.exchanges.some(exchange => initialUserInput(exchange.request).includes(nestedMarker))).toBe(false)
    } finally {
      await info.attach('selected-nested-provider-exchanges', { body: JSON.stringify({ exchanges: endpoint.exchanges, child: script.handle, grandchild: grandchildHandle }, null, 2), contentType: 'application/json' })
      await endpoint.close()
    }
  })
})
