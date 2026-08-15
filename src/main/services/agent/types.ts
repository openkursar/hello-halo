/**
 * Agent Module - Type Definitions
 *
 * Centralized type definitions for the agent module.
 * This file has no dependencies and is imported by all other agent modules.
 */

import type { ReasoningEffortSetting } from '../../../shared/constants/reasoning-effort'

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
  /**
   * How hard the model should think while Deep Thinking is on, as set by the
   * user in Model Config. `undefined` = use Halo's default level.
   */
  reasoningEffort?: ReasoningEffortSetting
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
   * The source's effective vision capability for this model (per-model override
   * → provider declaration → id heuristic), resolved by AISourceManager and
   * forwarded to the OpenAI-compat converter. Keeping this authoritative is what
   * makes the input-area hint and the actual request agree.
   * `undefined` = credentials not built from a source; downstream falls back to
   * its own heuristic.
   */
  visionOverride?: boolean
  /**
   * Resolved capabilities for the chosen model (preset + user override merged).
   * Optional because legacy callers and api-validator construct credentials
   * before capabilities are known; the SDK config layer falls back to safe
   * defaults when this is missing.
   */
  capabilities?: ResolvedModelCapabilities
  /**
   * Provider-declared vision capability for the chosen model. Propagated into
   * the encoded BackendConfig so the OpenAI-compat router strips image content
   * for non-vision models instead of letting the upstream provider reject them
   * with HTTP 400. undefined = router falls back to supportsVisionById. (#139)
   */
  supportsVision?: boolean
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
    type: string  // 'browser' | 'code' | 'markdown' | 'image' | 'pdf' | 'text' | 'json' | 'csv' | 'terminal'
    title: string
    url?: string   // For browser/pdf tabs
    path?: string  // For file tabs
    terminalSessionId?: string  // For terminal tabs - the pty session id the AI drives via terminal_* tools
  } | null
  tabs: Array<{
    type: string
    title: string
    url?: string
    path?: string
    terminalSessionId?: string  // For terminal tabs - the pty session id the AI drives via terminal_* tools
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
  thinkingEnabled?: boolean   // Enable extended thinking; depth comes from the model's reasoning effort
  model?: string              // Model to use (for future model switching)
  canvasContext?: CanvasContext  // Current canvas state for AI awareness
  knowledgeBaseId?: string         // When set, run as a "chat with this knowledge base" turn:
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
  // Dynamic runtime methods forwarded from the SDK Query object to the v2
  // session by patches/@anthropic-ai+claude-agent-sdk (anthropic engine).
  // Optional because alternate engines may not expose them — callers must guard.
  setMaxThinkingTokens?: (maxThinkingTokens: number | null) => Promise<void>
  setPermissionMode?: (mode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan') => Promise<void>
}

/**
 * V2 Session info stored in the sessions map
 *
 * Note: session rebuilds are driven by credentialsGeneration (global model /
 * API-config changes), a per-conversation credentialsFingerprint (this
 * conversation's own model/source pin — see session-manager
 * computeCredentialsFingerprint), and a knowledgeFingerprint (the conversation's
 * knowledge-base set, baked into the system prompt at creation). Toolset changes
 * are seeded at creation and take effect via an explicit rebuild (toolset broker),
 * so no toolset snapshot needs to be tracked here.
 */
export interface V2SessionInfo {
  session: V2SDKSession
  spaceId: string
  conversationId: string
  createdAt: number
  lastUsedAt: number
  // Credentials generation at session creation time
  // Used to detect stale credentials (session created before global config change)
  credentialsGeneration: number
  // Per-conversation credential/model fingerprint at session creation time.
  // Detects a change to THIS conversation's model pin (which the global
  // credentialsGeneration does not track), triggering a targeted rebuild.
  credentialsFingerprint: string
  // The conversation's knowledge-base set at session creation time. The KB list
  // is baked into the system prompt (frozen at creation) but not covered by the
  // credentials fingerprint; tracking it here rebuilds the session when the user
  // attaches/detaches a KB — or when a session was created before its KB seed.
  knowledgeFingerprint: string
  // Fingerprint of the session-defining inputs a caller bakes into sdkOptions up
  // front (system prompt + MCP server set). Only set for callers that fully
  // specify these eagerly — app chat and automation runs — so a permission /
  // prompt / config change is detected on the next send and the session is
  // rebuilt, instead of silently reusing a process wired with the old tool set.
  // undefined for main chat, which builds MCP servers lazily and handles toolset
  // changes via requestSessionRebuild.
  inputsFingerprint?: string
  // Detaches this session's process-exit listener. Must be called on cleanup:
  // session.close() never calls transport.close(), so the listener would
  // otherwise outlive the session and fire against a successor registered
  // under the same conversationId.
  exitUnsubscribe?: () => void
}

// ============================================
// MCP Types
// ============================================

/** Verdict of a native connection probe — is this configuration usable now. */
export type McpProbeStatus = 'connected' | 'failed' | 'needs-auth'

/**
 * MCP server status.
 *
 * Two producers report on a server and they can legitimately disagree: the
 * probe answers "is the configuration usable", an agent session answers "could
 * that session actually use it". Collapsing both into one field let whichever
 * wrote last hide the other, so a server the session could not use still
 * showed as connected. They are kept apart; `status` is the derived value
 * consumers should read.
 */
export interface McpServerStatusInfo {
  name: string
  /** Derived: the session verdict when one applies, otherwise the probe's. */
  status: 'connected' | 'failed' | 'needs-auth' | 'pending'
  /** Last native probe verdict. Absent until a probe has run. */
  probeStatus?: McpProbeStatus
  /** Last agent session verdict. Cleared once a probe reconnects. */
  sessionStatus?: 'connected' | 'failed' | 'needs-auth' | 'pending'
  serverInfo?: {
    name: string
    version: string
  }
  error?: string
  /** Short tool names provided by this server (without mcp__ prefix) */
  tools?: string[]
  /**
   * Human-readable failure reason from the native connection probe
   * (e.g. "HTTP 401 Unauthorized", "connect ECONNREFUSED ..."). The SDK
   * only reports failed/connected; this field is how the UI escapes the
   * black box. Cleared when the server connects.
   */
  errorDetail?: string
  /** Epoch ms of the last probe/SDK report that produced this entry */
  lastCheckedAt?: number
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

