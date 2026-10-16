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

import { getParseErrorMessage, objectFromShape, safeParseAsync } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
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
  const registered = tools.map((definition) => {
    const schema = objectFromShape(definition.inputSchema)
    return { definition, schema, jsonSchema: undefined as Record<string, unknown> | undefined }
  })

  const instance: SdkMcpServerInstance = {
    name,
    version,
    async callTool(toolName: string, args: Record<string, unknown>) {
      const registeredTool = registered.find((candidate) => candidate.definition.name === toolName)
      if (!registeredTool) return undefined
      const parsed = await safeParseAsync(registeredTool.schema, args)
      if (!parsed.success) {
        console.warn(`[Agent][mcp] tool arguments rejected server=${name} tool=${toolName}`)
        return { isError: true, content: [{ type: 'text', text: `Invalid arguments for ${toolName}: ${getParseErrorMessage(parsed.error)}` }] }
      }
      return registeredTool.definition.handler(parsed.data, {})
    },
    listTools() {
      return registered.map((registeredTool) => {
        registeredTool.jsonSchema ??= toJsonSchemaCompat(registeredTool.schema, { strictUnions: true, pipeStrategy: 'input' })
        const { definition } = registeredTool
        return {
          name: definition.name,
          description: definition.description,
          inputSchema: registeredTool.jsonSchema,
          annotations: definition.annotations,
        }
      })
    },
  }

  return { type: 'sdk', name, instance }
}
