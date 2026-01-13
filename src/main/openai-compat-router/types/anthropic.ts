/**
 * Claude Messages API (Anthropic) - Complete Type Definitions
 * Based on: https://docs.anthropic.com/en/api/messages
 */

// ============================================================================
// Content Block Types (Discriminated Union)
// ============================================================================

export interface AnthropicCacheControl {
  type: 'ephemeral'
}

export interface AnthropicTextBlock {
  type: 'text'
  text: string
  cache_control?: AnthropicCacheControl
}

export interface AnthropicBase64ImageSource {
  type: 'base64'
  media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  data: string
}

export interface AnthropicURLImageSource {
  type: 'url'
  url: string
}

export type AnthropicImageSource = AnthropicBase64ImageSource | AnthropicURLImageSource

export interface AnthropicImageBlock {
  type: 'image'
  source: AnthropicImageSource
  cache_control?: AnthropicCacheControl
}

export interface AnthropicToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface AnthropicToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | AnthropicContentBlock[]
  is_error?: boolean
  cache_control?: AnthropicCacheControl
}

export interface AnthropicThinkingBlock {
  type: 'thinking'
  thinking: string
  signature?: string
}

// Server-side tool blocks (for web search, etc.)
export interface AnthropicServerToolUseBlock {
  type: 'server_tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface AnthropicWebSearchResult {
  type: 'web_search_result'
  url?: string
  title?: string
}

export interface AnthropicWebSearchToolResultBlock {
  type: 'web_search_tool_result'
  tool_use_id: string
  content: AnthropicWebSearchResult[]
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock
  | AnthropicServerToolUseBlock
  | AnthropicWebSearchToolResultBlock

// ============================================================================
// Message Types
// ============================================================================

export type AnthropicRole = 'user' | 'assistant'

export interface AnthropicMessage {
  role: AnthropicRole
  content: string | AnthropicContentBlock[]
}

export interface AnthropicSystemBlock {
  type: 'text'
  text: string
  cache_control?: AnthropicCacheControl
}

// ============================================================================
// Tool Types
// ============================================================================

export interface AnthropicToolInputSchema {
  type: 'object'
  properties: Record<string, AnthropicJSONSchemaProperty>
  required?: string[]
}

export interface AnthropicJSONSchemaProperty {
  type: string
  description?: string
  enum?: unknown[]
  items?: AnthropicJSONSchemaProperty
  properties?: Record<string, AnthropicJSONSchemaProperty>
  required?: string[]
  [key: string]: unknown
}

export interface AnthropicTool {
  name: string
  description?: string
  input_schema: AnthropicToolInputSchema
  strict?: boolean
  cache_control?: AnthropicCacheControl
}

export type AnthropicToolChoiceAuto = { type: 'auto' }
export type AnthropicToolChoiceAny = { type: 'any' }
export type AnthropicToolChoiceTool = { type: 'tool'; name: string }
export type AnthropicToolChoiceNone = { type: 'none' }

export interface AnthropicToolChoiceWithOptions {
  type: 'auto' | 'any' | 'tool'
  name?: string
  disable_parallel_tool_use?: boolean
}

export type AnthropicToolChoice =
  | AnthropicToolChoiceAuto
  | AnthropicToolChoiceAny
  | AnthropicToolChoiceTool
  | AnthropicToolChoiceNone
  | AnthropicToolChoiceWithOptions

// ============================================================================
// Request Types
// ============================================================================

export interface AnthropicThinkingConfig {
  type: 'enabled' | 'disabled'
  budget_tokens?: number
}

export interface AnthropicRequestMetadata {
  user_id?: string
  [key: string]: unknown
}

export interface AnthropicRequest {
  // Required
  model: string
  max_tokens: number
  messages: AnthropicMessage[]

  // Optional
  system?: string | AnthropicSystemBlock[]
  temperature?: number
  top_p?: number
  top_k?: number
  stop_sequences?: string[]
  stream?: boolean
  tools?: AnthropicTool[]
  tool_choice?: AnthropicToolChoice
  metadata?: AnthropicRequestMetadata
  thinking?: AnthropicThinkingConfig
}

// ============================================================================
// Response Types
// ============================================================================

export type AnthropicStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'pause_turn'
  | 'refusal'

export interface AnthropicUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

export interface AnthropicMessageResponse {
  id: string
  type: 'message'
  role: 'assistant'
  content: AnthropicContentBlock[]
  model: string
  stop_reason: AnthropicStopReason
  stop_sequence: string | null
  usage: AnthropicUsage
}

// ============================================================================
// Streaming Event Types
// ============================================================================

export interface AnthropicMessageStartEvent {
  type: 'message_start'
  message: {
    id: string
    type: 'message'
    role: 'assistant'
    content: []
    model: string
    stop_reason: null
    stop_sequence: null
    usage: {
      input_tokens: number
      output_tokens: number
    }
  }
}

export interface AnthropicContentBlockStartEvent {
  type: 'content_block_start'
  index: number
  content_block:
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, never> }
    | { type: 'thinking'; thinking: string }
    | { type: 'web_search_tool_result'; tool_use_id: string; content: AnthropicWebSearchResult[] }
}

export interface AnthropicTextDelta {
  type: 'text_delta'
  text: string
}

export interface AnthropicInputJsonDelta {
  type: 'input_json_delta'
  partial_json: string
}

export interface AnthropicThinkingDelta {
  type: 'thinking_delta'
  thinking: string
}

export interface AnthropicSignatureDelta {
  type: 'signature_delta'
  signature: string
}

export type AnthropicContentBlockDelta =
  | AnthropicTextDelta
  | AnthropicInputJsonDelta
  | AnthropicThinkingDelta
  | AnthropicSignatureDelta

export interface AnthropicContentBlockDeltaEvent {
  type: 'content_block_delta'
  index: number
  delta: AnthropicContentBlockDelta
}

export interface AnthropicContentBlockStopEvent {
  type: 'content_block_stop'
  index: number
}

export interface AnthropicMessageDeltaEvent {
  type: 'message_delta'
  delta: {
    stop_reason: AnthropicStopReason
    stop_sequence?: string | null
  }
  usage: {
    output_tokens: number
  }
}

export interface AnthropicMessageStopEvent {
  type: 'message_stop'
}

export interface AnthropicPingEvent {
  type: 'ping'
}

export interface AnthropicErrorEvent {
  type: 'error'
  error: {
    type: string
    message: string
  }
}

export type AnthropicStreamEvent =
  | AnthropicMessageStartEvent
  | AnthropicContentBlockStartEvent
  | AnthropicContentBlockDeltaEvent
  | AnthropicContentBlockStopEvent
  | AnthropicMessageDeltaEvent
  | AnthropicMessageStopEvent
  | AnthropicPingEvent
  | AnthropicErrorEvent

// ============================================================================
// Error Types
// ============================================================================

export type AnthropicErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'request_too_large'
  | 'rate_limit_error'
  | 'api_error'
  | 'overloaded_error'
  | 'timeout_error'
  | 'internal_error'

export interface AnthropicErrorResponse {
  type: 'error'
  error: {
    type: AnthropicErrorType
    message: string
  }
}

// ============================================================================
// Type Guards
// ============================================================================

export function isTextBlock(block: AnthropicContentBlock): block is AnthropicTextBlock {
  return block.type === 'text'
}

export function isImageBlock(block: AnthropicContentBlock): block is AnthropicImageBlock {
  return block.type === 'image'
}

export function isToolUseBlock(block: AnthropicContentBlock): block is AnthropicToolUseBlock {
  return block.type === 'tool_use'
}

export function isToolResultBlock(block: AnthropicContentBlock): block is AnthropicToolResultBlock {
  return block.type === 'tool_result'
}

export function isThinkingBlock(block: AnthropicContentBlock): block is AnthropicThinkingBlock {
  return block.type === 'thinking'
}

export function isBase64ImageSource(source: AnthropicImageSource): source is AnthropicBase64ImageSource {
  return source.type === 'base64'
}

export function isURLImageSource(source: AnthropicImageSource): source is AnthropicURLImageSource {
  return source.type === 'url'
}
