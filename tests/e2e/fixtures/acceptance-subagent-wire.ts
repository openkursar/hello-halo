import { modelTool, type ModelRequest, type ModelReply } from './acceptance-model'

export function assignmentTool(request: ModelRequest, name: string, input: Record<string, unknown>, id: string): ModelReply {
  const advertised = request.tools.find(tool => tool === name || tool.endsWith(`__${name}`))
  const definition = (request.body.tools ?? []).find((tool: Record<string, any>) => (tool.name ?? tool.function?.name) === advertised)
  if (advertised && (!definition?.defer_loading && !definition?.function?.defer_loading || request.toolResults.some(result => result.id === `discover-${name}`))) return { tools: [modelTool(request, name, input, id)] }
  return { tools: [modelTool(request, 'ToolSearch', { query: `select:mcp__halo-team__${name}`, max_results: 1 }, `discover-${name}`)] }
}

export function assignmentResult(text: string): any {
  let value = JSON.parse(text.replace(/^Wall time: \d+(?:\.\d+)? seconds\r?\nOutput:\r?\n/, ''))
  if (Array.isArray(value) && value[0]?.type === 'text') value = JSON.parse(value[0].text)
  return value
}

export function reasoningWire(body: Record<string, any>) {
  return { effort: body.reasoning_effort ?? body.reasoning?.effort ?? body.output_config?.effort, thinking: body.thinking }
}
