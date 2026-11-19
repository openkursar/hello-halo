import { assertRequestedReasoning, reasoningSource, reasoningVariants } from '../fixtures/acceptance-subagent-reasoning'
import { test, expect, acceptance, sendAcceptanceMessage, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { initialUserInput, modelTool, type ModelRequest, type ModelReply } from '../fixtures/acceptance-model'
import { navigateToChat } from '../fixtures/helpers'
import { collaboratorReceipt } from '../fixtures/acceptance-collaboration'

for (const sdkEngine of ['halo', 'anthropic', 'codex', 'dsh'] as const)
for (const reasoning of reasoningVariants(sdkEngine)) test.describe(`Nested ${reasoning} model inheritance on ${sdkEngine}`, () => {
  test.use({ sdkEngine, aiSource: async ({ model }, use) => {
    await use(reasoningSource(model.url, reasoning))
  } })
  test('a grandchild inherits its immediate execution and reports through its own parent', acceptance('models.subagent-profiles.baseline-reasoning', { engine: sdkEngine, entry: 'nested', reasoning }), async ({ model, window }, info) => {
    test.setTimeout(180000)
    const markers = ['NESTED_ROOT: Delegate epsilon to a checker.', 'NESTED_CHILD: Delegate epsilon detail to your own private checker.', 'NESTED_GRANDCHILD: Return epsilon-nested-confirmed.']
    const requests: ModelRequest[][] = [[], [], []]
    const errors: string[] = []
    const handles: string[] = []
    const spawn = (request: ModelRequest, actor: number): ModelReply => {
      const result = request.toolResults.find(result => result.id === `nested-spawn-${actor}`)
      if (result) {
        try { const receipt = collaboratorReceipt(result); handles[actor] = receipt.handle } catch (error) { errors.push(String(error)) }
        return { text: request.text.includes('epsilon-nested-confirmed') ? 'epsilon-nested-confirmed' : 'A private checker is preparing.' }
      }
      const advertised = request.tools.find(tool => tool === 'spawn_agent' || tool.endsWith('__spawn_agent'))
      const definition = (request.body.tools ?? []).find((tool: Record<string, any>) => (tool.name ?? tool.function?.name) === advertised)
      if (advertised && (!definition?.defer_loading && !definition?.function?.defer_loading || request.toolResults.some(result => result.id === 'nested-discovery'))) return { tools: [modelTool(request, 'spawn_agent', { name: actor === 0 ? 'First checker' : 'Detail checker', prompt: markers[actor + 1] }, `nested-spawn-${actor}`)] }
      if (request.tools.includes('ToolSearch')) return { tools: [modelTool(request, 'ToolSearch', { query: 'select:mcp__halo-team__spawn_agent', max_results: 1 }, 'nested-discovery')] }
      errors.push(`Nested actor ${actor} cannot delegate`)
      return { text: 'No delegation tool.' }
    }
    model.respond(request => {
      const original = initialUserInput(request)
      const actor = markers.findIndex(marker => original.includes(marker))
      if (actor < 0) { errors.push('Unknown nested actor'); return { text: 'No matching task.' } }
      requests[actor].push(request)
      return actor === 2 ? { text: 'epsilon-nested-confirmed' } : spawn(request, actor)
    })
    await navigateToChat(window)
    const turn = await sendAcceptanceMessage(window, markers[0])
    await expect.poll(() => requests[0].some(request => request.text.includes('epsilon-nested-confirmed')), { timeout: 120000 }).toBe(true)
    await waitForAcceptanceIdle(window, turn.conversationId)
    expect(errors).toEqual([])
    expect(handles).toHaveLength(2)
    expect(new Set(handles).size).toBe(2)
    const wire = (body: Record<string, unknown>) => ({ model: body.model, reasoning_effort: body.reasoning_effort, reasoning: body.reasoning, thinking: body.thinking, output_config: body.output_config })
    expect(requests[0].length).toBeGreaterThan(0)
    assertRequestedReasoning(sdkEngine, reasoning, requests[0][0].body, 'nested')
    for (let actor = 1; actor < 3; actor++) {
      expect(requests[actor].length).toBeGreaterThan(0)
      assertRequestedReasoning(sdkEngine, reasoning, requests[actor][0].body, 'nested')
      for (const request of requests[actor]) expect(wire(request.body)).toEqual(wire(requests[actor - 1][0].body))
    }
    await info.attach('nested-execution-reasoning', { body: JSON.stringify({ engine: sdkEngine, handles, actors: requests.map(actor => actor.map(request => wire(request.body))) }, null, 2), contentType: 'application/json' })
  })
})
