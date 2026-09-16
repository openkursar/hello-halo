/**
 * Tool Definition Converters
 *
 * Handles conversion of tool definitions between:
 * - Anthropic: { name, description, input_schema }
 * - OpenAI Chat: { type: "function", function: { name, description, parameters } }
 * - OpenAI Responses: { type: "function", name, description, parameters }
 */

import type {
  AnthropicTool,
  AnthropicToolChoice,
  OpenAIChatTool,
  OpenAIChatToolChoice,
  OpenAIResponsesFunctionTool,
  OpenAIResponsesToolChoice
} from '../types'

// ============================================================================
// Tool Definition Conversion
// ============================================================================

type JsonSchemaNode = Record<string, unknown>

/**
 * Map an Anthropic `input_schema` onto the OpenAI `parameters` slot.
 *
 * Both sides are plain JSON Schema, so this is an envelope rename and nothing
 * more: the schema is forwarded byte-for-byte, keeping Halo's wire output
 * equivalent to what the SDK would send an Anthropic endpoint directly.
 * Keywords an upstream may not implement — `$ref`, `$defs`,
 * `additionalProperties` — are still its own to reject; rewriting them here
 * would make every provider pay for the strictest one. Upstream-specific
 * rewrites belong in `server/provider-adapters.ts`.
 */
export function toOpenAIParameters(schema: AnthropicTool['input_schema']): JsonSchemaNode {
  const raw = schema as unknown as JsonSchemaNode | undefined
  if (!raw) return { type: 'object', properties: {} }
  return raw['type'] === 'object' ? raw : { ...raw, type: 'object' }
}

/**
 * Convert Anthropic tool to OpenAI Chat tool
 */
export function anthropicToolToOpenAIChatTool(tool: AnthropicTool): OpenAIChatTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: toOpenAIParameters(tool.input_schema),
      strict: tool.strict
    }
  }
}

/**
 * Convert Anthropic tool to OpenAI Responses tool
 * Uses the flat format (top-level name, description, parameters)
 */
export function anthropicToolToResponsesTool(tool: AnthropicTool): OpenAIResponsesFunctionTool {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description || '',
    parameters: toOpenAIParameters(tool.input_schema),
    strict: tool.strict
  }
}

/**
 * Convert array of Anthropic tools to OpenAI Chat tools
 * Filters out invalid tools, keeps valid ones
 */
export function convertAnthropicToolsToOpenAIChat(
  tools: AnthropicTool[] | undefined
): OpenAIChatTool[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) {
    return undefined
  }

  // Filter and convert - skip invalid tools instead of rejecting all
  return tools
    .filter((tool) => tool && tool.name)
    .map(anthropicToolToOpenAIChatTool)
}

/**
 * Convert array of Anthropic tools to OpenAI Responses tools
 */
export function convertAnthropicToolsToResponses(
  tools: AnthropicTool[] | undefined
): OpenAIResponsesFunctionTool[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) {
    return undefined
  }

  return tools
    .filter((tool) => tool && typeof tool.name === 'string' && tool.name.trim() !== '')
    .map(anthropicToolToResponsesTool)
}

// ============================================================================
// Tool Choice Conversion
// ============================================================================

/**
 * Convert Anthropic tool_choice to OpenAI Chat tool_choice
 */
export function convertAnthropicToolChoiceToOpenAIChat(
  toolChoice: AnthropicToolChoice | undefined
): OpenAIChatToolChoice | undefined {
  if (!toolChoice) return undefined

  switch (toolChoice.type) {
    case 'auto':
      return 'auto'
    case 'any':
      return 'required'
    case 'none':
      return 'none'
    case 'tool':
      if ('name' in toolChoice && toolChoice.name) {
        return {
          type: 'function',
          function: { name: toolChoice.name }
        }
      }
      return 'auto'
    default:
      return 'auto'
  }
}

/**
 * Convert Anthropic tool_choice to OpenAI Responses tool_choice
 */
export function convertAnthropicToolChoiceToResponses(
  toolChoice: AnthropicToolChoice | undefined
): OpenAIResponsesToolChoice | undefined {
  if (!toolChoice) return undefined

  switch (toolChoice.type) {
    case 'auto':
      return 'auto'
    case 'any':
      return 'required'
    case 'none':
      return 'none'
    case 'tool':
      if ('name' in toolChoice && toolChoice.name) {
        return {
          type: 'function',
          name: toolChoice.name
        }
      }
      return 'auto'
    default:
      return 'auto'
  }
}

