/**
 * Agent Module - Type Definitions
 *
 * Centralized type definitions for the agent module.
 * This file has no dependencies and is imported by all other agent modules.
 */

// ============================================
// API Credentials
// ============================================

/**
 * Resolved per-model capability values consumed by the agent runtime.
 *
 * These come from `modelCapabilitiesService.resolve(modelId, source.modelOverrides)`,
 * which merges built-in presets with the per-source user overrides edited in
 * Settings > Provider > Model Config. Carrying them on the credential keeps
 * resolution in a single place (helpers.ts) so every SDK call site uses the
 * same effective numbers.
 */
export interface ResolvedModelCapabilities {
  /** Effective max output tokens for the model (preset merged with user override) */
  maxOutputTokens: number
  /** Effective context window for the model (preset merged with user override) */
  contextWindow: number
}

/**
 * API credentials for agent requests
 * Unified structure for custom API and OAuth sources
 */
export interface ApiCredentials {
  baseUrl: string
  apiKey: string
  model: string
  displayModel?: string
  provider: 'anthropic' | 'openai' | 'oauth'
  /** Custom headers for OAuth providers */
  customHeaders?: Record<string, string>
  /** API type for the backend provider */
  apiType?: 'chat_completions' | 'responses' | 'anthropic_passthrough' | 'kiro'
  /** Force streaming mode (for providers that only support streaming) */
  forceStream?: boolean
  /** Filter sensitive content from messages (e.g., GitHub URLs) */
  filterContent?: boolean
  /** Provider adapter ID for request/response transformations */
  adapterId?: string
  /**
   * Resolved capabilities for the chosen model (preset + user override merged).
   * Optional because legacy callers and api-validator construct credentials
   * before capabilities are known; the SDK config layer falls back to safe
   * defaults when this is missing.
   */
  capabilities?: ResolvedModelCapabilities
}

// ============================================
// Image Attachments
// ============================================

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'

export interface ImageAttachment {
  id: string
  type: 'image'
  mediaType: ImageMediaType
  data: string  // Base64 encoded
  name?: string
  size?: number
}

// ============================================
// Canvas Context
// ============================================

/**
 * Canvas Context - Injected into messages to provide AI awareness of user's open tabs
 * This allows AI to naturally understand what the user is currently viewing
 */
export interface CanvasContext {
  isOpen: boolean
  tabCount: number
  activeTab: {
    type: string  // 'browser' | 'code' | 'markdown' | 'image' | 'pdf' | 'text' | 'json' | 'csv'
    title: string
    url?: string   // For browser/pdf tabs
    path?: string  // For file tabs
  } | null
  tabs: Array<{
    type: string
    title: string
    url?: string
    path?: string
    isActive: boolean
  }>
}

// ============================================
// Agent Request
// ============================================

export interface AgentRequest {
  spaceId: string
  conversationId: string
  message: string
  resumeSessionId?: string
  images?: ImageAttachment[]  // Optional images for multi-modal messages
  aiBrowserEnabled?: boolean  // Enable AI Browser tools for this request
  thinkingEnabled?: boolean   // Enable extended thinking mode (maxThinkingTokens: 10240)
  model?: string              // Model to use (for future model switching)
  canvasContext?: CanvasContext  // Current canvas state for AI awareness
  tlonKbId?: string         // When set, run as a "chat with this knowledge base" turn:
                              // working dir = the KB's wiki dir, that KB injected into the prompt
}

// ============================================
// Tool Calls
// ============================================

export interface ToolCall {
  id: string
  name: string
  status: 'pending' | 'running' | 'success' | 'error' | 'waiting_approval'
  input: Record<string, unknown>
  output?: string
  error?: string
  progress?: number
  requiresApproval?: boolean
  description?: string
}

// ============================================
// Thoughts (Agent Reasoning Process)
// ============================================

export type ThoughtType = 'thinking' | 'text' | 'tool_use' | 'tool_result' | 'system' | 'result' | 'error'

export interface Thought {
  id: string
  type: ThoughtType
  content: string
  timestamp: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolOutput?: string
  isError?: boolean
  errorCode?: string  // Original SDK error code (rate_limit, authentication_failed, etc.)
  duration?: number
  // For streaming state (real-time updates)
  isStreaming?: boolean  // True while content is being streamed
  isReady?: boolean      // True when tool params are complete (for tool_use)
  // For merged tool result display (tool_use contains its result)
  toolResult?: {
    output: string
    isError: boolean
    timestamp: string
  }
  // Sub-agent support: links this thought to a parent Task tool_use
  // Matches SDK's parent_tool_use_id — null/undefined for main agent thoughts
  parentToolUseId?: string
  // Task/Agent tool progress (updated via task_started/task_progress/task_notification)
  taskProgress?: TaskProgress
}

/**
 * Progress tracking for a Task/Agent tool_use thought.
 * Updated in real-time via SDK task lifecycle events.
 */
export interface TaskProgress {
  taskId: string
  status: 'running' | 'completed' | 'failed' | 'stopped'
  lastToolName?: string
  toolCount: number
  durationMs: number
  summary?: string
  totalTokens?: number
}

// ============================================
// Session State
// ============================================

/**
 * Active session state for a conversation
 * Used to track in-flight requests and accumulated thoughts
 */
export interface SessionState {
  /** Halo-internal signal to break stream-processor's consumption loop.
   *  Does NOT propagate to the CC subprocess — use session.interrupt() for that. */
  abortController: AbortController
  spaceId: string
  conversationId: string
  thoughts: Thought[]  // Backend accumulates thoughts (Single Source of Truth)
}

// ============================================
// V2 Session Types
// ============================================

/**
 * V2 SDK Session interface
 *
 * Note: SDK types are unstable after patching (return values may not be Promise<...>),
 * using minimal interface for type safety and maintainability, avoiding inference to never.
 */
export type V2SDKSession = {
  send: (message: any) => void
  stream: () => AsyncIterable<any>
  close: () => void
  interrupt?: () => Promise<void> | void
  // Dynamic runtime methods (exposed via patch)
  setModel?: (model: string | undefined) => Promise<void>
  setMaxThinkingTokens?: (maxThinkingTokens: number | null) => Promise<void>
  setPermissionMode?: (mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan') => Promise<void>
}

/**
 * Session configuration that requires session rebuild when changed
 * These are "process-level" parameters fixed at Claude Code subprocess startup
 *
 * Note: model changes are handled via credentialsGeneration in config.service
 * (model is part of the aiSources signature), not through SessionConfig.
 */
export interface SessionConfig {
  aiBrowserEnabled: boolean
  // thinkingEnabled is dynamic via setMaxThinkingTokens, no rebuild needed
  // digitalHumansEnabled: intentionally excluded — low-frequency toggle, relies on new conversation to take effect (UI hints this)
}

/**
 * V2 Session info stored in the sessions map
 */
export interface V2SessionInfo {
  session: V2SDKSession
  spaceId: string
  conversationId: string
  createdAt: number
  lastUsedAt: number
  // Track config at session creation time for rebuild detection
  config: SessionConfig
  // Credentials generation at session creation time
  // Used to detect stale credentials (session created before config change)
  credentialsGeneration: number
}

// ============================================
// MCP Types
// ============================================

/**
 * MCP server status type (matches SDK)
 */
export interface McpServerStatusInfo {
  name: string
  status: 'connected' | 'failed' | 'needs-auth' | 'pending'
  serverInfo?: {
    name: string
    version: string
  }
  error?: string
  /** Short tool names provided by this server (without mcp__ prefix) */
  tools?: string[]
}

// ============================================
// Token Usage
// ============================================

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalCostUsd: number
  contextWindow: number
}

export interface SingleCallUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

