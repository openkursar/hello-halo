/**
 * OpenAI Responses API - Complete Type Definitions
 * Based on: https://platform.openai.com/docs/api-reference/responses
 */

// ============================================================================
// Input Content Types
// ============================================================================

export interface OpenAIResponsesInputText {
  type: 'input_text'
  text: string
}

export interface OpenAIResponsesInputImage {
  type: 'input_image'
  image_url: string
  detail?: 'auto' | 'low' | 'high'
  file_id?: string
}

export type OpenAIResponsesInputContentPart = OpenAIResponsesInputText | OpenAIResponsesInputImage

// ============================================================================
// Output Content Types
// ============================================================================

export interface OpenAIResponsesOutputText {
  type: 'output_text'
  text: string
}

export interface OpenAIResponsesRefusal {
  type: 'refusal'
  refusal: string
}

export type OpenAIResponsesOutputContentPart = OpenAIResponsesOutputText | OpenAIResponsesRefusal

// ============================================================================
// Input Item Types
// ============================================================================

export interface OpenAIResponsesInputMessage {
  role: 'user' | 'assistant' | 'developer' | 'system'
  content: string | OpenAIResponsesInputContentPart[]
}

export interface OpenAIResponsesFunctionCall {
  type: 'function_call'
  call_id: string
  name: string
  arguments: string // JSON string
}

export interface OpenAIResponsesFunctionCallOutput {
  type: 'function_call_output'
  call_id: string
  output: string | OpenAIResponsesInputContentPart[]
}

export type OpenAIResponsesInputItem =
  | OpenAIResponsesInputMessage
  | OpenAIResponsesFunctionCall
  | OpenAIResponsesFunctionCallOutput

// ============================================================================
// Output Item Types
// ============================================================================

export interface OpenAIResponsesMessageOutput {
  id: string
  type: 'message'
  role: 'assistant'
  status: 'completed' | 'incomplete'
  content: OpenAIResponsesOutputContentPart[]
}

export interface OpenAIResponsesFunctionCallOutput2 {
  id: string
  type: 'function_call'
  status: 'in_progress' | 'completed'
  name: string
  call_id: string
  arguments: string // JSON string
}

export interface OpenAIResponsesReasoningOutput {
  id: string
  type: 'reasoning'
  status: 'completed'
  summary?: {
    type: 'output_text'
    text: string
  }[]
  encrypted_content?: string
}

export type OpenAIResponsesOutputItem =
  | OpenAIResponsesMessageOutput
  | OpenAIResponsesFunctionCallOutput2
  | OpenAIResponsesReasoningOutput

// ============================================================================
// Tool Types
// ============================================================================

export interface OpenAIResponsesFunctionToolParameters {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

export interface OpenAIResponsesFunctionTool {
  type: 'function'
  name: string
  description?: string
  parameters: OpenAIResponsesFunctionToolParameters
  strict?: boolean
  // Alternative format with nested function object
  function?: {
    name: string
    description?: string
    parameters: OpenAIResponsesFunctionToolParameters
    strict?: boolean
  }
}

export interface OpenAIResponsesCodeInterpreterTool {
  type: 'code_interpreter'
  container?: {
    type: 'auto'
    memory_limit?: '4g' | '8g'
    file_ids?: string[]
  }
}

export interface OpenAIResponsesFileSearchTool {
  type: 'file_search'
  vector_store_ids?: string[]
}

export interface OpenAIResponsesWebSearchTool {
  type: 'web_search'
}

export interface OpenAIResponsesComputerUseTool {
  type: 'computer_use_preview'
}

export type OpenAIResponsesTool =
  | OpenAIResponsesFunctionTool
  | OpenAIResponsesCodeInterpreterTool
  | OpenAIResponsesFileSearchTool
  | OpenAIResponsesWebSearchTool
  | OpenAIResponsesComputerUseTool

// Tool choice types
export type OpenAIResponsesToolChoiceString = 'auto' | 'none' | 'required'

export interface OpenAIResponsesToolChoiceFunction {
  type: 'function'
  name: string
}

export interface OpenAIResponsesToolChoiceAllowed {
  type: 'allowed_tools'
  mode: 'auto' | 'required'
  tools: { type: string; name: string }[]
}

export type OpenAIResponsesToolChoice =
  | OpenAIResponsesToolChoiceString
  | OpenAIResponsesToolChoiceFunction
  | OpenAIResponsesToolChoiceAllowed

// ============================================================================
// Request Types
// ============================================================================

export interface OpenAIResponsesReasoningConfig {
  effort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh'
  summary?: 'none' | 'concise' | 'detailed'
  include?: ('encrypted_content')[]
  enabled?: boolean // Some providers use this
}

export interface OpenAIResponsesTextFormat {
  type: 'text'
}

export interface OpenAIResponsesJsonObjectFormat {
  type: 'json_object'
}

export interface OpenAIResponsesJsonSchemaFormat {
  type: 'json_schema'
  json_schema: {
    name: string
    schema: Record<string, unknown>
    strict?: boolean
  }
}

export type OpenAIResponsesOutputFormat =
  | OpenAIResponsesTextFormat
  | OpenAIResponsesJsonObjectFormat
  | OpenAIResponsesJsonSchemaFormat

export interface OpenAIResponsesStreamOptions {
  include_usage?: boolean
}

export interface OpenAIResponsesAudioConfig {
  voice: 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer'
  format: 'wav' | 'mp3' | 'flac' | 'opus' | 'pcm16'
}

export interface OpenAIResponsesRequest {
  // Required
  model: string

  // Input (one of these)
  input: string | OpenAIResponsesInputItem[]

  // Optional - Context
  instructions?: string
  previous_response_id?: string

  // Optional - Tools
  tools?: OpenAIResponsesTool[]
  tool_choice?: OpenAIResponsesToolChoice
  parallel_tool_calls?: boolean

  // Optional - Generation
  temperature?: number
  top_p?: number
  max_output_tokens?: number
  stop?: string | string[]

  // Optional - Reasoning
  reasoning?: OpenAIResponsesReasoningConfig

  // Optional - Output Format
  text?: {
    format?: OpenAIResponsesOutputFormat
  }

  // Optional - Streaming
  stream?: boolean
  stream_options?: OpenAIResponsesStreamOptions

  // Optional - Context Management
  truncation?: 'auto' | 'disabled'

  // Optional - Storage and Metadata
  store?: boolean
  metadata?: Record<string, string>

  // Optional - Modalities
  modalities?: ('text' | 'audio')[]
  audio?: OpenAIResponsesAudioConfig

  // Optional - User
  user?: string
}

// ============================================================================
// Response Types
// ============================================================================

export type OpenAIResponsesStatus = 'in_progress' | 'completed' | 'incomplete' | 'failed'

export interface OpenAIResponsesIncompleteDetails {
  reason: 'max_output_tokens' | 'content_filter'
}

export interface OpenAIResponsesError {
  code: string
  message: string
}

export interface OpenAIResponsesUsage {
  input_tokens: number
  input_tokens_details?: {
    cached_tokens: number
  }
  output_tokens: number
  output_tokens_details: {
    reasoning_tokens: number
  }
  total_tokens: number
}

export interface OpenAIResponsesResponse {
  id: string
  object: 'response'
  created_at: number
  model: string
  status: OpenAIResponsesStatus
  output: OpenAIResponsesOutputItem[]
  incomplete_details?: OpenAIResponsesIncompleteDetails | null
  error?: OpenAIResponsesError | null

  // Echoed request parameters
  instructions?: string
  metadata?: Record<string, string>
  parallel_tool_calls?: boolean
  previous_response_id?: string | null
  temperature?: number
  text?: {
    format?: OpenAIResponsesOutputFormat
  }
  tool_choice?: OpenAIResponsesToolChoice
  tools?: OpenAIResponsesTool[]
  top_p?: number
  max_output_tokens?: number
  reasoning?: OpenAIResponsesReasoningConfig
  truncation?: string
  user?: string

  // Usage
  usage: OpenAIResponsesUsage
}

// ============================================================================
// Streaming Event Types
// ============================================================================

export interface OpenAIResponsesCreatedEvent {
  type: 'response.created'
  response: OpenAIResponsesResponse
}

export interface OpenAIResponsesInProgressEvent {
  type: 'response.in_progress'
  response: OpenAIResponsesResponse
}

export interface OpenAIResponsesCompletedEvent {
  type: 'response.completed'
  response: OpenAIResponsesResponse
}

export interface OpenAIResponsesIncompleteEvent {
  type: 'response.incomplete'
  response: OpenAIResponsesResponse
  incomplete_details: OpenAIResponsesIncompleteDetails
}

export interface OpenAIResponsesFailedEvent {
  type: 'response.failed'
  response: OpenAIResponsesResponse
  error: OpenAIResponsesError
}

export interface OpenAIResponsesOutputItemAddedEvent {
  type: 'response.output_item.added'
  item: OpenAIResponsesOutputItem
  output_index: number
}

export interface OpenAIResponsesOutputItemDoneEvent {
  type: 'response.output_item.done'
  item: OpenAIResponsesOutputItem
  output_index: number
}

export interface OpenAIResponsesContentPartAddedEvent {
  type: 'response.content_part.added'
  part: OpenAIResponsesOutputContentPart
  item_id: string
  content_index: number
}

export interface OpenAIResponsesContentPartDoneEvent {
  type: 'response.content_part.done'
  part: OpenAIResponsesOutputContentPart
  item_id: string
  content_index: number
}

export interface OpenAIResponsesTextDeltaEvent {
  type: 'response.output_text.delta'
  delta: string
  item_id: string
  content_index: number
  output_index?: number
}

export interface OpenAIResponsesTextDoneEvent {
  type: 'response.output_text.done'
  text: string
  item_id: string
  content_index: number
}

export interface OpenAIResponsesFunctionCallArgumentsDeltaEvent {
  type: 'response.function_call_arguments.delta'
  delta: string
  output_index: number
  call_id?: string
}

export interface OpenAIResponsesFunctionCallArgumentsDoneEvent {
  type: 'response.function_call_arguments.done'
  arguments: string
  output_index: number
  call_id?: string
}

export interface OpenAIResponsesErrorEvent {
  type: 'error'
  error: OpenAIResponsesError
}

export type OpenAIResponsesStreamEvent =
  | OpenAIResponsesCreatedEvent
  | OpenAIResponsesInProgressEvent
  | OpenAIResponsesCompletedEvent
  | OpenAIResponsesIncompleteEvent
  | OpenAIResponsesFailedEvent
  | OpenAIResponsesOutputItemAddedEvent
  | OpenAIResponsesOutputItemDoneEvent
  | OpenAIResponsesContentPartAddedEvent
  | OpenAIResponsesContentPartDoneEvent
  | OpenAIResponsesTextDeltaEvent
  | OpenAIResponsesTextDoneEvent
  | OpenAIResponsesFunctionCallArgumentsDeltaEvent
  | OpenAIResponsesFunctionCallArgumentsDoneEvent
  | OpenAIResponsesErrorEvent

// ============================================================================
// Type Guards
// ============================================================================

export function isInputMessage(item: OpenAIResponsesInputItem): item is OpenAIResponsesInputMessage {
  return 'role' in item
}

export function isFunctionCall(item: OpenAIResponsesInputItem): item is OpenAIResponsesFunctionCall {
  return 'type' in item && item.type === 'function_call'
}

export function isFunctionCallOutput(item: OpenAIResponsesInputItem): item is OpenAIResponsesFunctionCallOutput {
  return 'type' in item && item.type === 'function_call_output'
}

export function isMessageOutput(item: OpenAIResponsesOutputItem): item is OpenAIResponsesMessageOutput {
  return item.type === 'message'
}

export function isFunctionCallOutput2(item: OpenAIResponsesOutputItem): item is OpenAIResponsesFunctionCallOutput2 {
  return item.type === 'function_call'
}

export function isReasoningOutput(item: OpenAIResponsesOutputItem): item is OpenAIResponsesReasoningOutput {
  return item.type === 'reasoning'
}

export function isInputText(part: OpenAIResponsesInputContentPart): part is OpenAIResponsesInputText {
  return part.type === 'input_text'
}

export function isInputImage(part: OpenAIResponsesInputContentPart): part is OpenAIResponsesInputImage {
  return part.type === 'input_image'
}

export function isOutputText(part: OpenAIResponsesOutputContentPart): part is OpenAIResponsesOutputText {
  return part.type === 'output_text'
}

export function isRefusal(part: OpenAIResponsesOutputContentPart): part is OpenAIResponsesRefusal {
  return part.type === 'refusal'
}

export function isFunctionTool(tool: OpenAIResponsesTool): tool is OpenAIResponsesFunctionTool {
  return tool.type === 'function'
}
