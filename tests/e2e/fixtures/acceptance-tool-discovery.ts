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
  const searchCalls = new Set<string>()
  for (const message of request.messages) {
    for (const call of message.tool_calls ?? []) {
      if (call.function?.name === 'ToolSearch') searchCalls.add(String(call.id))
    }
    if (Array.isArray(message.content)) for (const block of message.content) {
      if (block.type === 'tool_use' && block.name === 'ToolSearch') searchCalls.add(String(block.id))
    }
  }
  const current = request.toolResults.find(item => item.id === fullId && searchCalls.has(item.id)) ?? request.toolResults.find(item => item.id === searchId && searchCalls.has(item.id))
  if (current?.error) return { error: `ToolSearch failed for ${name}: ${current.text}` }
  const known = new Map<string, Record<string, unknown>>()
  const latest = new Map<string, Record<string, unknown>>()
  for (const receipt of request.toolResults) {
    if (!searchCalls.has(receipt.id) || receipt.error) continue
    let payload: { tools?: unknown[] }
    try { payload = JSON.parse(receipt.text) } catch {
      if (receipt === current) return { error: `ToolSearch did not return JSON definitions for ${name}` }
      continue
    }
    if (!Array.isArray(payload?.tools)) {
      if (receipt === current) return { error: `ToolSearch did not return definitions for ${name}` }
      continue
    }
    const matching = payload.tools.filter(entry => entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string' && matches((entry as { name: string }).name, name))
    if (receipt === current && matching.length === 0) return { error: `Expected one discovered ${name}; received 0` }
    for (const entry of payload.tools) {
      if (!entry || typeof entry !== 'object') continue
      const tool = entry as Record<string, unknown>
      if (typeof tool.name !== 'string' || !matches(tool.name, name)) continue
      if (typeof tool.version !== 'string') return { error: `Invalid discovered version for ${name}` }
      latest.set(tool.name, tool)
      const previous = known.get(tool.name)
      if (tool.already_loaded === true) {
        if (previous?.version !== tool.version) known.delete(tool.name)
        continue
      }
      if (typeof tool.description !== 'string' || !tool.input_schema || typeof tool.input_schema !== 'object' || Array.isArray(tool.input_schema)) {
        return { error: `ToolSearch did not deliver a complete definition for ${name}` }
      }
      known.set(tool.name, tool)
    }
  }
  if (latest.size > 1) return { error: `Multiple discovered tools match ${name}` }
  if (known.size === 1) {
    const tool = [...known.values()][0]
    return { call: { id, name: 'CallTool', input: { tool: tool.name, arguments: JSON.stringify(input) } } }
  }
  const summary = [...latest.values()][0]
  if (summary) {
    if (current?.id === fullId) return { error: `ToolSearch did not deliver the current complete definition for ${name}` }
    return { call: { id: fullId, name: 'ToolSearch', input: { query: `select:${summary.name}` } } }
  }
  return { call: { id: searchId, name: 'ToolSearch', input: { query: name, max_results: 10 } } }
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
