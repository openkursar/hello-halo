import type { HaloAPI } from '../../../src/preload'
import { test, expect, acceptance, sendAcceptanceMessage, waitForAcceptanceIdle } from '../fixtures/acceptance-app'
import { startAcceptanceModel, initialUserInput, modelTool, type ModelRequest, type ModelReply } from '../fixtures/acceptance-model'
import { collaboratorReceipt } from '../fixtures/acceptance-collaboration'
import { assignmentCall, assignmentSettings } from '../fixtures/acceptance-subagent-models'
import { navigateToChat } from '../fixtures/helpers'

function decodedResult(text: string): any {
  const parsed = JSON.parse(text.replace(/^Wall time: \d+(?:\.\d+)? seconds\r?\nOutput:\r?\n/, ''))
  return Array.isArray(parsed) && parsed[0]?.type === 'text' ? JSON.parse(parsed[0].text) : parsed
}

for (const sdkEngine of ['halo', 'anthropic', 'codex', 'dsh'] as const) {
  test.describe(`Assignment routing on ${sdkEngine}`, () => {
    test.use({ sdkEngine })
    test('an explicit assignment reaches a different local endpoint without changing the parent', acceptance('models.subagent-profiles.owner-routing', { engine: sdkEngine, entry: 'space', choice: 'profile' }), async ({ model, window }, info) => {
      test.setTimeout(180000)
      const childEndpoint = await startAcceptanceModel()
      const errors: string[] = []
      let handle: string | undefined
      let reference: string | undefined
      const sourceMarker = 'ASSIGNMENT_ROUTE_SOURCE: Ask the configured verifier to check item beta.'
      const memberMarker = 'ASSIGNMENT_ROUTE_MEMBER: Check item beta and report beta-route-confirmed.'
      const sourceRequests: ModelRequest[] = []
      const call = (request: ModelRequest, name: string, input: Record<string, unknown>, id: string): ModelReply => {
        const advertised = request.tools.find(tool => tool === name || tool.endsWith(`__${name}`))
        const definition = (request.body.tools ?? []).find((tool: Record<string, any>) => (tool.name ?? tool.function?.name) === advertised)
        if (advertised && (!definition?.defer_loading && !definition?.function?.defer_loading || request.toolResults.some(result => result.id === `discover-${name}`))) return { tools: [modelTool(request, name, input, id)] }
        if (request.tools.includes('ToolSearch')) return { tools: [modelTool(request, 'ToolSearch', { query: `select:mcp__halo-team__${name}`, max_results: 1 }, `discover-${name}`)] }
        errors.push(`Missing model assignment tool ${name}`)
        return { text: 'The requested assignment is unavailable.' }
      }
      model.respond(request => {
        sourceRequests.push(request)
        if (!initialUserInput(request).includes(sourceMarker)) { errors.push('A child request reached the parent endpoint'); return { text: 'Unexpected actor.' } }
        const catalog = request.toolResults.find(result => result.id === 'assignment-catalog')
        if (!catalog) return call(request, 'list_model_profiles', { query: 'Verifier' }, 'assignment-catalog')
        try {
          const value = decodedResult(catalog.text)
          reference = value.profiles?.find((profile: { name: string }) => profile.name === 'Verifier')?.selectionRef
          if (!reference) errors.push(`Directory did not expose a selectable verifier: ${catalog.text}`)
        } catch (error) { errors.push(String(error)) }
        if (!reference) return { text: 'No verifier was available.' }
        const spawned = request.toolResults.find(result => result.id === 'assignment-spawn')
        if (!spawned) return call(request, 'spawn_agent', { name: 'Verifier worker', prompt: memberMarker, model_profile: reference }, 'assignment-spawn')
        try { handle = collaboratorReceipt(spawned).handle } catch (error) { errors.push(String(error)) }
        return { text: request.text.includes('beta-route-confirmed') ? 'The configured verifier confirmed beta-route-confirmed.' : 'The configured verifier is checking beta.' }
      })
      childEndpoint.respond(request => {
        if (!initialUserInput(request).includes(memberMarker)) errors.push('A parent request reached the child endpoint')
        return { text: 'beta-route-confirmed' }
      })
      try {
        const added = await window.evaluate(url => (globalThis as unknown as { halo: HaloAPI }).halo.aiSourcesAddSource({
          id: 'verifier-local', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
          name: 'Isolated verifier endpoint', provider: 'openai', authType: 'api-key', apiUrl: url,
          apiKey: 'local-child-only', apiType: 'chat_completions', model: 'gpt-4o', availableModels: [{ id: 'gpt-4o', name: 'gpt-4o' }],
        }), childEndpoint.url)
        expect(added.success, added.error).toBe(true)
        const config = await window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.getConfig())
        const sources = (config.data as { aiSources: { sources: Array<{ id: string; name: string }> } }).aiSources.sources
        const childSource = sources.find(source => source.name === 'Isolated verifier endpoint')!
        expect(childSource).toBeTruthy()
        expect(childSource.id).toBe('verifier-local')
        const reset = await window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.aiSourcesSwitchSource('acceptance-local'))
        expect(reset.success).toBe(true)
        const saved = await assignmentCall(window, 'createSubagentModel', { name: 'Verifier', description: 'Verify item beta', target: { kind: 'model', sourceId: childSource.id, modelId: 'gpt-4o' } })
        expect(saved.success, saved.error).toBe(true)
        expect((await assignmentSettings(window)).selectionMode).toBe('inherit')
        await navigateToChat(window)
        const turn = await sendAcceptanceMessage(window, sourceMarker)
        await expect.poll(() => childEndpoint.exchanges.length, { timeout: 90000 }).toBeGreaterThan(0)
        await expect.poll(() => sourceRequests.some(request => request.text.includes('beta-route-confirmed')), { timeout: 90000 }).toBe(true)
        await waitForAcceptanceIdle(window, turn.conversationId)
        expect(errors).toEqual([])
        expect(handle).toBeTruthy()
        expect(childEndpoint.errors).toEqual([])
        for (const exchange of childEndpoint.exchanges) expect(exchange.request.body.model).toBe('gpt-4o')
        expect(sourceRequests.length).toBeGreaterThan(1)
        for (const request of sourceRequests) expect(request.body.model).toBe('gpt-4o')
        const after = await window.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.getConfig())
        expect((after.data as { aiSources: { currentId: string } }).aiSources.currentId).toBe('acceptance-local')
      } finally {
        await info.attach('child-endpoint-exchanges', { body: JSON.stringify({ exchanges: childEndpoint.exchanges, errors: childEndpoint.errors }, null, 2), contentType: 'application/json' })
        await childEndpoint.close()
      }
    })
  })
}
