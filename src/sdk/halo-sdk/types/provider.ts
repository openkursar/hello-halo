/**
 * @module types/provider
 * Provider-agnostic request/response types shared across all LLM provider implementations.
 * @license MIT
 */

// ---------------------------------------------------------------------------
// StopReason
// ---------------------------------------------------------------------------

/** The reason a model stopped generating tokens. */
export type StopReason =
  | 'end_turn'
  | 'stop_sequence'
  | 'max_tokens'
  | 'tool_use'
  | 'content_filtered'
  | string; // Provider-specific unknown stop reasons

// ---------------------------------------------------------------------------
// ContentBlock
// ---------------------------------------------------------------------------

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  /**
   * Cryptographic signature issued by the Anthropic API.
   * Must be preserved and sent back in subsequent turns when using
   * extended thinking — the API verifies it to prevent tampering.
   */
  signature?: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}

export interface ImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export interface DocumentBlock {
  type: 'document';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export interface SignatureBlock {
  type: 'signature';
  signature: string;
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock
  | DocumentBlock
  | SignatureBlock;

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

export interface Message {
  /** SDK journal metadata, removed before provider encoding and public event delivery. */
  toolContext?: import('../core/tool-context/types.js').ToolContextRecord;
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
  /**
   * Internal flag — set to `true` on all messages injected by the loop-inject
   * mechanism (userContext, turn-boundary notices, max_tokens recovery).
   *
   * The query loop filters out `isMeta: true` messages before yielding
   * `SDKUserMessage` events, ensuring SDK consumers never see internal
   * housekeeping messages.
   */
  isMeta?: boolean;
}

// ---------------------------------------------------------------------------
// SystemPrompt
// ---------------------------------------------------------------------------

export interface SystemPromptBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export type SystemPrompt = string | SystemPromptBlock[];

// ---------------------------------------------------------------------------
// UsageInfo
// ---------------------------------------------------------------------------

export interface UsageInfo {
  /** Uncached input when cache fields are supplied; otherwise total input. */
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  web_search_requests?: number;
}

// ---------------------------------------------------------------------------
// ThinkingConfig
// ---------------------------------------------------------------------------

export type ThinkingConfig =
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'adaptive' }
  | { type: 'disabled' };

// ---------------------------------------------------------------------------
// ToolDefinition
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// ProviderRequest
// ---------------------------------------------------------------------------

/** A normalized request that any provider adapter can consume. */
export interface ProviderRequest {
  /** Model identifier (e.g. "deepseek-chat", "glm-4.6") */
  model: string;
  /** Conversation history */
  messages: Message[];
  /** Optional system / developer prompt */
  systemPrompt?: SystemPrompt;
  /** Tool definitions available to the model for this turn */
  tools?: ToolDefinition[];
  /** Maximum number of tokens to generate */
  maxTokens: number;
  /** Sampling temperature */
  temperature?: number;
  /** Nucleus sampling probability mass */
  topP?: number;
  /** Top-k sampling cutoff */
  topK?: number;
  /** Stop sequences */
  stopSequences?: string[];
  /** Extended thinking / chain-of-thought configuration */
  thinking?: ThinkingConfig;
  /** Whether to request a streaming response */
  stream: boolean;
  /** Arbitrary provider-specific options */
  providerOptions?: Record<string, unknown>;
  /** Tool choice constraint (auto / any / specific tool). */
  toolChoice?: { type: 'auto' } | { type: 'any' } | { type: 'tool'; name: string };
}

// ---------------------------------------------------------------------------
// ProviderResponse
// ---------------------------------------------------------------------------

/** A normalized response returned by any provider adapter. */
export interface ProviderResponse {
  /** Provider-assigned message / request identifier */
  id: string;
  /** Generated content blocks */
  content: ContentBlock[];
  /** Why the model stopped generating */
  stopReason: StopReason;
  /** Token usage for billing / budget tracking */
  usage: UsageInfo;
  /** The model that produced this response (as reported by the provider) */
  model: string;
  /** Recognized calls were unreadable; no tool calls from this response are executable. */
  unreadableToolCall?: string;
}

// ---------------------------------------------------------------------------
// StreamEvent
// ---------------------------------------------------------------------------

/**
 * Events emitted by the provider-agnostic streaming layer.
 *
 * Field names use the Anthropic wire-format convention (snake_case) so that
 * `stream_event` SDKMessages forwarded to the consumer are compatible with the
 * Anthropic `BetaRawMessageStreamEvent` format.  Consumer code reads
 * `event.content_block?.type`, `event.content_block?.text`, etc.
 */
export type StreamEvent =
  | { type: 'message_start'; id: string; model: string; usage: UsageInfo; stopReason?: StopReason }
  | { type: 'content_block_start'; index: number; content_block: ContentBlock }
  | { type: 'text_delta'; index: number; text: string }
  | { type: 'thinking_delta'; index: number; thinking: string }
  | { type: 'input_json_delta'; index: number; partialJson: string }
  | { type: 'signature_delta'; index: number; signature: string }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; stopReason?: StopReason; usage?: Partial<UsageInfo> }
  | {
      type: 'message_stop';
      /**
       * Set when the model plainly meant to call a tool and the attempt could
       * not be read. Only prompt-protocol adapters produce this; providers with
       * native tool calling report the same condition per tool call.
       */
      unreadableToolCall?: string;
    }
  | { type: 'error'; errorType: string; message: string }
  | { type: 'reasoning_delta'; index: number; reasoning: string }
  | StreamRetryEvent;

/**
 * The provider's previous attempt failed and it will send the request again
 * after `delayMs`. Emitted before the wait, so a consumer can report it while
 * it happens. Content events already emitted for the failed attempt are void:
 * the next attempt starts over from `message_start`.
 */
export interface StreamRetryEvent {
  type: 'retry';
  /** 1-based number of the attempt about to be made. */
  attempt: number;
  maxRetries: number;
  delayMs: number;
  /** HTTP status of the failed attempt; null when no response arrived. */
  status: number | null;
  /** Why the attempt failed, in the server's own words when it gave any. */
  message: string;
}

// ---------------------------------------------------------------------------
// ProviderCapabilities
// ---------------------------------------------------------------------------

/** Describes the features supported by a provider/model combination. */
export interface ProviderCapabilities {
  /** Supports streaming responses via SSE or websocket */
  streaming: boolean;
  /** Supports function / tool calling */
  toolCalling: boolean;
  /** Supports extended thinking / chain-of-thought tokens */
  thinking: boolean;
  /** Accepts image inputs */
  imageInput: boolean;
  /** Accepts PDF document inputs */
  pdfInput: boolean;
  /** Accepts audio inputs */
  audioInput: boolean;
  /** Accepts video inputs */
  videoInput: boolean;
  /** Supports prompt caching */
  caching: boolean;
  /** How the provider expects the system prompt to be delivered */
  systemPromptStyle: SystemPromptStyle;
}

/** Where/how a provider expects the system prompt. */
export type SystemPromptStyle =
  | 'top_level'       // Anthropic style: top-level `system` field
  | 'system_message'  // OpenAI style: { role: 'system', content: '...' }
  | 'system_instruction'; // Google Gemini style

// ---------------------------------------------------------------------------
// ProviderStatus
// ---------------------------------------------------------------------------

/** Health status of a provider endpoint. */
export type ProviderStatus =
  | { status: 'healthy' }
  | { status: 'degraded'; reason: string }
  | { status: 'unavailable'; reason: string };

// ---------------------------------------------------------------------------
// LlmProvider interface
// ---------------------------------------------------------------------------

/** The core interface every LLM provider adapter must implement. */
export interface LlmProvider {
  /** Unique machine-readable identifier, e.g. "anthropic", "openai" */
  readonly id: string;
  /** Human-readable display name, e.g. "Anthropic", "OpenAI" */
  readonly name: string;
  /** Send a message and receive a complete (non-streaming) response */
  createMessage(request: ProviderRequest): Promise<ProviderResponse>;
  /** Send a message and receive a streaming response */
  createMessageStream(request: ProviderRequest): AsyncGenerator<StreamEvent, void, undefined>;
  /** Return the list of models available through this provider */
  listModels?(): Promise<ProviderModelInfo[]>;
  /** Check whether the provider is authenticated and reachable */
  healthCheck?(): Promise<ProviderStatus>;
  /** Return the static capabilities of this provider */
  capabilities(): ProviderCapabilities;
}

/** Static metadata about a model available through a provider. */
export interface ProviderModelInfo {
  /** Model unique identifier (e.g. "glm-4.6") */
  id: string;
  /** Provider that hosts this model */
  providerId: string;
  /** Human-readable display name */
  name: string;
  /** Total context window size in tokens */
  contextWindow: number;
  /** Maximum output tokens per response */
  maxOutputTokens: number;
}
