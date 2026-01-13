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

/**
 * Convert Anthropic tool to OpenAI Chat tool
 */
export function anthropicToolToOpenAIChatTool(tool: AnthropicTool): OpenAIChatTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: {
        type: 'object',
        properties: tool.input_schema?.properties || {},
        required: tool.input_schema?.required
      },
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
    parameters: {
      type: 'object',
      properties: tool.input_schema?.properties || {},
      required: tool.input_schema?.required
    },
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

// ============================================================================
// Reasoning/Thinking Conversion
// ============================================================================

/**
 * Map Anthropic thinking budget_tokens to OpenAI reasoning effort
 */
export function budgetTokensToReasoningEffort(budgetTokens: number | undefined): 'low' | 'medium' | 'high' {
  if (!budgetTokens) return 'medium'
  if (budgetTokens > 10000) return 'high'
  if (budgetTokens > 5000) return 'medium'
  return 'low'
}

/**
 * Convert Anthropic thinking config to OpenAI Chat reasoning config
 */
export function convertAnthropicThinkingToOpenAIReasoning(
  thinking: { type: 'enabled' | 'disabled'; budget_tokens?: number } | undefined
): { enabled?: boolean; effort?: 'low' | 'medium' | 'high' } | undefined {
  if (!thinking) return undefined

  return {
    enabled: thinking.type === 'enabled',
    effort: budgetTokensToReasoningEffort(thinking.budget_tokens)
  }
}

/**
 * Convert Anthropic thinking config to OpenAI Responses reasoning config
 */
export function convertAnthropicThinkingToResponsesReasoning(
  thinking: { type: 'enabled' | 'disabled'; budget_tokens?: number } | undefined
): { effort?: 'low' | 'medium' | 'high'; enabled?: boolean } | undefined {
  if (!thinking) return undefined

  return {
    enabled: thinking.type === 'enabled',
    effort: budgetTokensToReasoningEffort(thinking.budget_tokens)
  }
}
