/**
 * OpenAI Chat Completions API - Complete Type Definitions
 * Based on: https://platform.openai.com/docs/api-reference/chat
 */

// ============================================================================
// Content Part Types
// ============================================================================

export interface OpenAIChatTextPart {
  type: 'text'
  text: string
}

export interface OpenAIChatImagePart {
  type: 'image_url'
  image_url: {
    url: string
    detail?: 'auto' | 'low' | 'high'
  }
}

export type OpenAIChatContentPart = OpenAIChatTextPart | OpenAIChatImagePart

// ============================================================================
// Tool Call Types
// ============================================================================

export interface OpenAIChatToolCallFunction {
  name: string
  arguments: string // JSON string
}

export interface OpenAIChatToolCall {
  id: string
  type: 'function'
  function: OpenAIChatToolCallFunction
}

export interface OpenAIChatToolCallDelta {
  index: number
  id?: string
  type?: 'function'
  function?: {
    name?: string
    arguments?: string
  }
}

// ============================================================================
// Message Types
// ============================================================================

export interface OpenAIChatSystemMessage {
  role: 'system'
  content: string | OpenAIChatContentPart[]
  name?: string
}

export interface OpenAIChatUserMessage {
  role: 'user'
  content: string | OpenAIChatContentPart[]
  name?: string
}

export interface OpenAIChatAssistantMessage {
  role: 'assistant'
  content: string | null
  name?: string
  tool_calls?: OpenAIChatToolCall[]
  refusal?: string | null
}

export interface OpenAIChatToolMessage {
  role: 'tool'
  content: string
  tool_call_id: string
}

export type OpenAIChatMessage =
  | OpenAIChatSystemMessage
  | OpenAIChatUserMessage
  | OpenAIChatAssistantMessage
  | OpenAIChatToolMessage

// Extended message types with additional provider-specific fields
export interface OpenAIChatAssistantMessageExtended extends OpenAIChatAssistantMessage {
  // Some providers include these fields
  reasoning?: string
  reasoning_content?: string
  thinking?: {
    content?: string
    signature?: string
  }
  annotations?: OpenAIChatAnnotation[]
}

export interface OpenAIChatAnnotation {
  type: string
  url_citation?: {
    url?: string
    title?: string
  }
  [key: string]: unknown
}

// ============================================================================
// Tool Definition Types
// ============================================================================

export interface OpenAIChatJSONSchemaProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null'
  description?: string
  enum?: unknown[]
  items?: OpenAIChatJSONSchemaProperty
  properties?: Record<string, OpenAIChatJSONSchemaProperty>
  required?: string[]
  additionalProperties?: boolean
  [key: string]: unknown
}

export interface OpenAIChatFunctionParameters {
  type: 'object'
  properties: Record<string, OpenAIChatJSONSchemaProperty>
  required?: string[]
  additionalProperties?: boolean
}

export interface OpenAIChatFunction {
  name: string
  description?: string
  parameters: OpenAIChatFunctionParameters
  strict?: boolean
}

export interface OpenAIChatTool {
  type: 'function'
  function: OpenAIChatFunction
}

export type OpenAIChatToolChoiceString = 'none' | 'auto' | 'required'

export interface OpenAIChatToolChoiceFunction {
  type: 'function'
  function: { name: string }
}

export type OpenAIChatToolChoice = OpenAIChatToolChoiceString | OpenAIChatToolChoiceFunction

// ============================================================================
// Request Types
// ============================================================================

export interface OpenAIChatResponseFormat {
  type: 'text' | 'json_object' | 'json_schema'
  json_schema?: {
    name: string
    description?: string
    schema: Record<string, unknown>
    strict?: boolean
  }
}

export interface OpenAIChatStreamOptions {
  include_usage?: boolean
}

export interface OpenAIChatRequest {
  // Required
  model: string
  messages: OpenAIChatMessage[]

  // Optional - Generation
  temperature?: number
  top_p?: number
  n?: number
  max_tokens?: number
  max_completion_tokens?: number
  stop?: string | string[]
  presence_penalty?: number
  frequency_penalty?: number
  logit_bias?: Record<string, number>

  // Optional - Streaming
  stream?: boolean
  stream_options?: OpenAIChatStreamOptions

  // Optional - Tools
  tools?: OpenAIChatTool[]
  tool_choice?: OpenAIChatToolChoice
  parallel_tool_calls?: boolean

  // Optional - Output Format
  response_format?: OpenAIChatResponseFormat

  // Optional - Other
  user?: string
  seed?: number
  logprobs?: boolean
  top_logprobs?: number

  // Extended - Reasoning (some providers)
  reasoning?: {
    enabled?: boolean
    effort?: 'low' | 'medium' | 'high'
  }
}

// ============================================================================
// Response Types
// ============================================================================

export type OpenAIChatFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | null

export interface OpenAIChatTokenLogprob {
  token: string
  logprob: number
  bytes: number[] | null
  top_logprobs: {
    token: string
    logprob: number
    bytes: number[] | null
  }[]
}

export interface OpenAIChatLogprobs {
  content: OpenAIChatTokenLogprob[] | null
}

export interface OpenAIChatResponseMessage {
  role: 'assistant'
  content: string | null
  tool_calls?: OpenAIChatToolCall[]
  refusal?: string | null
  // Extended fields from some providers
  reasoning?: string
  reasoning_content?: string
  thinking?: {
    content?: string
    signature?: string
  }
  annotations?: OpenAIChatAnnotation[]
}

export interface OpenAIChatChoice {
  index: number
  message: OpenAIChatResponseMessage
  finish_reason: OpenAIChatFinishReason
  logprobs?: OpenAIChatLogprobs | null
}

export interface OpenAIChatUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  cache_read_input_tokens?: number
}

export interface OpenAIChatResponse {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  system_fingerprint?: string
  choices: OpenAIChatChoice[]
  usage: OpenAIChatUsage
}

// ============================================================================
// Streaming Types
// ============================================================================

export interface OpenAIChatChunkDelta {
  role?: 'assistant'
  content?: string
  tool_calls?: OpenAIChatToolCallDelta[]
  refusal?: string
  // Extended fields
  reasoning?: string
  thinking?: {
    content?: string
    signature?: string
  }
  annotations?: OpenAIChatAnnotation[]
}

export interface OpenAIChatChunkChoice {
  index: number
  delta: OpenAIChatChunkDelta
  finish_reason: OpenAIChatFinishReason
  logprobs?: OpenAIChatLogprobs | null
}

export interface OpenAIChatChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  system_fingerprint?: string
  choices: OpenAIChatChunkChoice[]
  usage?: OpenAIChatUsage
}

// ============================================================================
// Error Types
// ============================================================================

export interface OpenAIChatError {
  error: {
    message: string
    type: string
    param?: string | null
    code?: string | null
  }
}

// ============================================================================
// Type Guards
// ============================================================================

export function isSystemMessage(msg: OpenAIChatMessage): msg is OpenAIChatSystemMessage {
  return msg.role === 'system'
}

export function isUserMessage(msg: OpenAIChatMessage): msg is OpenAIChatUserMessage {
  return msg.role === 'user'
}

export function isAssistantMessage(msg: OpenAIChatMessage): msg is OpenAIChatAssistantMessage {
  return msg.role === 'assistant'
}

export function isToolMessage(msg: OpenAIChatMessage): msg is OpenAIChatToolMessage {
  return msg.role === 'tool'
}

export function isTextPart(part: OpenAIChatContentPart): part is OpenAIChatTextPart {
  return part.type === 'text'
}

export function isImagePart(part: OpenAIChatContentPart): part is OpenAIChatImagePart {
  return part.type === 'image_url'
}

export function hasToolCalls(msg: OpenAIChatAssistantMessage): boolean {
  return Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0
}
