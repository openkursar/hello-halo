import type { ModelRequest, ModelReply, ModelToolCall } from './acceptance-model'

export type ModelToolPlan = { call: ModelToolCall } | { error: string }

function matches(actual: string, requested: string): boolean {
  return actual === requested || actual.endsWith(`__${requested}`)
}

/** A scripted model reads definitions from its search result, never from a private tool registry. */
export function planModelTool(request: ModelRequest, name: string, input: Record<string, unknown>, id: string): ModelToolPlan {
  const direct = request.tools.filter(tool => matches(tool, name))
  if (direct.length === 1) return { call: { id, name: direct[0], input } }
  if (direct.length > 1) return { error: `Multiple advertised tools match ${name}` }
  if (!request.tools.includes('ToolSearch') || !request.tools.includes('CallTool')) {
    return { error: `No advertised tool or client discovery gateway for ${name}` }
  }
  const searchId = `${id}-search`
  const fullId = `${id}-definition`
  const result = request.toolResults.find(item => item.id === fullId)
    ?? request.toolResults.find(item => item.id === searchId)
  if (!result) return { call: { id: searchId, name: 'ToolSearch', input: { query: name, max_results: 10 } } }
  if (result.error) return { error: `ToolSearch failed for ${name}: ${result.text}` }
  let payload: unknown
  try { payload = JSON.parse(result.text) }
  catch { return { error: `ToolSearch did not return JSON definitions for ${name}` } }
  const listed = (payload as { tools?: unknown[] } | null)?.tools
  const definitions = Array.isArray(listed) ? listed.filter((item): item is Record<string, unknown> =>
    Boolean(item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string'
      && matches((item as { name: string }).name, name))) : []
  if (definitions.length !== 1) return { error: `Expected one discovered ${name}; received ${definitions.length}` }
  const definition = definitions[0]
  if (definition.already_loaded === true && result.id !== fullId) {
    return { call: { id: fullId, name: 'ToolSearch', input: { query: `select:${definition.name}` } } }
  }
  if (typeof definition.version !== 'string' || typeof definition.description !== 'string'
      || !definition.input_schema || typeof definition.input_schema !== 'object'
      || Array.isArray(definition.input_schema)) {
    return { error: `ToolSearch did not deliver a complete definition for ${name}` }
  }
  return { call: { id, name: 'CallTool', input: { tool: definition.name, arguments: JSON.stringify(input) } } }
}

export function replyWithModelTool(
  request: ModelRequest, name: string, input: Record<string, unknown>, id: string, issues: string[],
): ModelReply {
  const next = planModelTool(request, name, input, id)
  if ('call' in next) return { tools: [next.call] }
  issues.push(next.error)
  return { text: `The requested fixture tool is unavailable: ${name}.` }
}

export function createToolDiscoveryScenario(label: string, complete: (request: ModelRequest, answer: string) => ModelReply = (_request, answer) => ({ text: answer })) {
  const requests = new Map<string, ModelRequest[]>()
  const results = new Map<string, string>()
  const issues: string[] = []
  let phase = 'discover'
  let target: string | undefined
  return {
    requests, results, issues,
    get target() { return target },
    start(next: string) { phase = next },
    respond(request: ModelRequest): ModelReply {
      const turn = requests.get(phase) ?? []
      turn.push(request)
      requests.set(phase, turn)
      const id = `${label}-${phase}`
      const answer = `Channel operation recorded: ${id}.`
      const result = request.toolResults.find(item => item.id === id)
      if (result) {
        results.set(phase, result.text)
        return complete(request, answer)
      }
      if (phase === 'discover') {
        const next = planModelTool(request, 'echo_acceptance', { value: id }, id)
        if ('call' in next) {
          if (next.call.name === 'CallTool') target = String(next.call.input.tool)
          return { tools: [next.call] }
        }
        issues.push(next.error)
      } else if (target) {
        return { tools: [{ id, name: 'CallTool', input: { tool: target, arguments: JSON.stringify({ value: id }) } }] }
      } else issues.push('No complete tool definition was delivered before continuation')
      return { text: answer }
    },
  }
}
