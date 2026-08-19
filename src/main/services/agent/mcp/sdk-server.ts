/**
 * `tool()` and `createSdkMcpServer()` for engines that do not ship the Claude
 * Agent SDK's own helpers.
 *
 * Halo builds its whole in-process tool set — AI Browser, memory, web search,
 * the Apps surface, notifications — through these two functions, before it
 * knows which engine will run them, so every engine must supply them. The
 * result matches the SDK's server contract, which is what lets the call sites
 * stay engine-agnostic and what `sdk-bridge.ts` serves over loopback.
 *
 * Building descriptors without their handlers is not an option, however
 * unreachable a handler may look for a given engine: the bridge makes them all
 * reachable, and a server that lists a tool it cannot run gives the model a
 * tool that always fails.
 */

import type {
  SdkMcpServerConfig,
  SdkMcpServerInstance,
  SdkMcpToolDefinition,
} from './types'

export function tool<Schema extends Record<string, any>>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: (args: any, extra: unknown) => Promise<any>,
  extras?: {
    annotations?: Record<string, unknown>
    searchHint?: string
    alwaysLoad?: boolean
  }
): SdkMcpToolDefinition {
  const meta: Record<string, unknown> = {}
  if (extras?.searchHint) meta.searchHint = extras.searchHint
  if (extras?.alwaysLoad) meta.alwaysLoad = extras.alwaysLoad

  return {
    name,
    description,
    inputSchema,
    annotations: extras?.annotations,
    _meta: Object.keys(meta).length > 0 ? meta : undefined,
    handler,
  }
}

export function createSdkMcpServer(options: {
  name: string
  version?: string
  tools?: SdkMcpToolDefinition[]
}): SdkMcpServerConfig {
  const { name, version = '1.0.0', tools = [] } = options

  const instance: SdkMcpServerInstance = {
    name,
    version,
    async callTool(toolName: string, args: Record<string, unknown>) {
      const def = tools.find((candidate) => candidate.name === toolName)
      if (!def) return undefined
      return def.handler(args, {})
    },
    listTools() {
      return tools.map((def) => ({
        name: def.name,
        description: def.description,
        inputSchema: schemaToJson(def.inputSchema),
        annotations: def.annotations,
      }))
    },
  }

  return { type: 'sdk', name, instance }
}

/**
 * Call sites declare a field map of zod schemas, which is what the Claude SDK
 * takes. Anything crossing a process boundary needs JSON Schema instead, and
 * only the shapes Halo's own tools use are translated — an unrecognized field
 * becomes a string rather than an error, because a tool with one exotic
 * parameter should lose that parameter's typing, not the whole server.
 */
function schemaToJson(schema: Record<string, any>): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []

  for (const [key, value] of Object.entries(schema || {})) {
    properties[key] = zodLikeToJsonSchema(value)
    if (!isOptionalZodLike(value)) required.push(key)
  }

  return { type: 'object', properties, required, additionalProperties: false }
}

function zodLikeToJsonSchema(value: any): Record<string, unknown> {
  const def = value?._def
  const typeName = def?.typeName || def?.type

  if (typeName === 'ZodNumber' || typeName === 'number') return { type: 'number' }
  if (typeName === 'ZodBoolean' || typeName === 'boolean') return { type: 'boolean' }
  if (typeName === 'ZodArray' || typeName === 'array') return { type: 'array' }
  if (typeName === 'ZodObject' || typeName === 'object') return { type: 'object' }
  if (typeName === 'ZodEnum' && Array.isArray(def?.values)) return { type: 'string', enum: def.values }
  if (typeName === 'ZodOptional' || typeName === 'optional') {
    return zodLikeToJsonSchema(def?.innerType)
  }

  return { type: 'string' }
}

function isOptionalZodLike(value: any): boolean {
  const def = value?._def
  return def?.typeName === 'ZodOptional'
    || def?.type === 'optional'
    || (typeof value?.isOptional === 'function' && value.isOptional())
}
