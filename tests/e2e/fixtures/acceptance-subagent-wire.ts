import { modelTool, type ModelRequest, type ModelReply } from './acceptance-model'

export function assignmentTool(request: ModelRequest, name: string, input: Record<string, unknown>, id: string): ModelReply {
  const advertised = request.tools.find(tool => tool === name || tool.endsWith(`__${name}`))
  const definition = (request.body.tools ?? []).find((tool: Record<string, any>) => (tool.name ?? tool.function?.name) === advertised)
  if (advertised && (!definition?.defer_loading && !definition?.function?.defer_loading || request.toolResults.some(result => result.id === `discover-${name}`))) return { tools: [modelTool(request, name, input, id)] }
  return { tools: [modelTool(request, 'ToolSearch', { query: `select:mcp__halo-team__${name}`, max_results: 1 }, `discover-${name}`)] }
}

export const shortModelProfileId = /^p[0-9a-f]{12}[0-9a-z]+$/

export interface DirectoryProfile {
  name: string
  description: string
  target: { kind: 'model' | 'group'; label: string }
  selectionRef?: string
  unavailableReason?: string
}

export interface ModelDirectory {
  text: string
  profiles: DirectoryProfile[]
}

export function parseModelDirectory(result: string): ModelDirectory {
  let text = result.replace(/^Wall time: \d+(?:\.\d+)? seconds\r?\nOutput:\r?\n/, '').trim()
  if (text.startsWith('[')) {
    const blocks: unknown = JSON.parse(text)
    if (!Array.isArray(blocks) || blocks.length !== 1 || blocks[0]?.type !== 'text' || typeof blocks[0].text !== 'string') {
      throw new Error('Expected one text block for the directory')
    }
    text = blocks[0].text.trim()
  }
  const directory: ModelDirectory = { text, profiles: [] }
  if (text === 'No configured model profiles.') return directory
  for (const block of text.split(/\r?\n\r?\n/)) {
    const entry = /^- ([^\r\n]+)\r?\n  (Model|Load-balancing group): ([^\r\n]+)\r?\n  (model_profile|Unavailable): ([^\r\n]+)$/.exec(block)
    if (!entry || (entry[4] === 'model_profile' && !shortModelProfileId.test(entry[5]))) {
      throw new Error(`Expected a plain-text model directory entry, got: ${block}`)
    }
    const [name, ...description] = entry[1].split(' — ')
    directory.profiles.push({ name, description: description.join(' — '),
      target: { kind: entry[2] === 'Model' ? 'model' : 'group', label: entry[3] },
      ...(entry[4] === 'model_profile' ? { selectionRef: entry[5] } : { unavailableReason: entry[5] }),
    })
  }
  return directory
}

export function reasoningWire(body: Record<string, any>) {
  return { effort: body.reasoning_effort ?? body.reasoning?.effort ?? body.output_config?.effort, thinking: body.thinking }
}
