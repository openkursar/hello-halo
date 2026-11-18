import type { Page } from '@playwright/test'
import type { HaloAPI } from '../../../src/preload'
import { expect } from './acceptance-app'
import { assignmentCall } from './acceptance-subagent-models'
import { collaboratorReceipt } from './acceptance-collaboration'
import { initialUserInput, modelTool, type AcceptanceModel, type ModelRequest, type ModelReply } from './acceptance-model'

export async function configureRoutingTarget(page: Page, endpoint: AcceptanceModel) {
  const added = await page.evaluate(url => (globalThis as unknown as { halo: HaloAPI }).halo.aiSourcesAddSource({
    id: 'assignment-target-local', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    name: 'Isolated assignment target', provider: 'openai', authType: 'api-key', apiUrl: url, apiKey: 'local-assignment-target',
    apiType: 'chat_completions', model: 'gpt-4o', availableModels: [{ id: 'gpt-4o', name: 'gpt-4o' }],
  }), endpoint.url)
  expect(added.success, added.error).toBe(true)
  const config = await page.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.getConfig())
  const source = (config.data as { aiSources: { sources: Array<{ id: string; name: string }> } }).aiSources.sources.find(source => source.name === 'Isolated assignment target')!
  expect(source).toBeTruthy()
  expect(source.id).toBe('assignment-target-local')
  const reset = await page.evaluate(() => (globalThis as unknown as { halo: HaloAPI }).halo.aiSourcesSwitchSource('acceptance-local'))
  expect(reset.success).toBe(true)
  const saved = await assignmentCall(page, 'createSubagentModel', { name: 'Verifier', description: 'Verify isolated work', target: { kind: 'model', sourceId: source.id, modelId: 'gpt-4o' } })
  expect(saved.success, saved.error).toBe(true)
  return source
}

export function assignmentRoutingScript(options: { sourceMarker?: string; run?: boolean } = {}) {
  const childMarker = 'ASSIGNED_CHILD_WORK: Return assigned-target-confirmed.'
  const errors: string[] = []
  const parentRequests: ModelRequest[] = []
  const childRequests: ModelRequest[] = []
  let handle: string | undefined
  const call = (request: ModelRequest, name: string, input: Record<string, unknown>, id: string): ModelReply => {
    const advertised = request.tools.find(tool => tool === name || tool.endsWith(`__${name}`))
    const definition = (request.body.tools ?? []).find((tool: Record<string, any>) => (tool.name ?? tool.function?.name) === advertised)
    if (advertised && (!definition?.defer_loading && !definition?.function?.defer_loading || request.toolResults.some(result => result.id === `assignment-discover-${name}`))) return { tools: [modelTool(request, name, input, id)] }
    if (request.tools.includes('ToolSearch')) return { tools: [modelTool(request, 'ToolSearch', { query: `select:mcp__halo-team__${name}`, max_results: 1 }, `assignment-discover-${name}`)] }
    errors.push(`Missing assignment tool ${name}`)
    return { text: 'The assignment tool is unavailable.' }
  }
  const parent = (request: ModelRequest): ModelReply => {
    parentRequests.push(request)
    if (options.sourceMarker && !initialUserInput(request).includes(options.sourceMarker)) errors.push('Unexpected source actor')
    const catalog = request.toolResults.find(result => result.id === 'assigned-catalog')
    if (!catalog) return call(request, 'list_model_profiles', { query: 'Verifier' }, 'assigned-catalog')
    let reference: string | undefined
    try {
      let value = JSON.parse(catalog.text.replace(/^Wall time: \d+(?:\.\d+)? seconds\r?\nOutput:\r?\n/, ''))
      if (Array.isArray(value) && value[0]?.type === 'text') value = JSON.parse(value[0].text)
      reference = value.profiles?.find((profile: { name: string }) => profile.name === 'Verifier')?.selectionRef
    } catch (error) { errors.push(String(error)) }
    if (!reference) { errors.push('No selectable Verifier in directory'); return { text: 'No assignment was available.' } }
    const spawned = request.toolResults.find(result => result.id === 'assigned-spawn')
    if (!spawned) return call(request, 'spawn_agent', { name: 'Assigned verifier', prompt: childMarker, model_profile: reference }, 'assigned-spawn')
    try { handle = collaboratorReceipt(spawned).handle } catch (error) { errors.push(String(error)) }
    const done = request.text.includes('assigned-target-confirmed')
    if (done && options.run && !request.toolResults.some(result => result.id === 'assigned-report')) return call(request, 'report_to_user', { type: 'run_complete', message: 'assigned-target-confirmed' }, 'assigned-report')
    return { text: done ? 'The assignment returned assigned-target-confirmed.' : 'The assigned verifier is preparing.' }
  }
  const child = (request: ModelRequest): ModelReply => {
    childRequests.push(request)
    if (!initialUserInput(request).includes(childMarker)) errors.push('Wrong actor reached assigned provider')
    return { text: 'assigned-target-confirmed' }
  }
  return { parent, child, parentRequests, childRequests, errors, get handle() { return handle } }
}
