/**
 * Compact, hand-curated subset of the Codex app-server V2 protocol.
 *
 * The full schema lives in
 *   /codex-rs/app-server-protocol/schema/typescript/{,v2/}
 * across ~536 generated files. We deliberately do NOT vendor the full surface
 * — Halo only consumes a small, well-defined slice (lifecycle, threads,
 * turns, item streaming, the seven server requests we bridge). Vendoring
 * everything would create a 500-file maintenance burden with no benefit.
 *
 * For everything else we use `any` / `unknown` and let the runtime accept
 * whatever the server sends. The wire format is line-delimited JSON, so any
 * extension fields the server emits flow through transparently.
 *
 * If you need a type the team consumes that's missing here, ADD a narrow
 * interface; do not import from the generated tree.
 */

import type { RequestId } from './jsonrpc'

// ============================================================================
// Lifecycle
// ============================================================================

export interface InitializeParams {
  clientInfo: {
    name: string
    version: string
    title?: string
  }
  capabilities?: InitializeCapabilities
}

export interface InitializeCapabilities {
  /** REQUIRED to unlock the V2 protocol surface (thread/* and item/*). */
  experimentalApi?: boolean
}

export interface InitializeResponse {
  userAgent?: string
  codexHome?: string
  platformFamily?: string
  platformOs?: string
}

// ============================================================================
// Threads
// ============================================================================

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/**
 * Approval policy. The simple enum form is what we use — the granular
 * object form is also accepted by the server but Halo does not generate it.
 */
export type AskForApproval = 'untrusted' | 'on-failure' | 'on-request' | 'never'

export interface ThreadStartParams {
  model?: string
  modelProvider?: string
  cwd?: string
  approvalPolicy?: AskForApproval
  sandbox?: SandboxMode
  baseInstructions?: string
  developerInstructions?: string
  config?: Record<string, unknown>
  ephemeral?: boolean
  /** Custom tool registrations (we don't use this — pass via MCP). */
  dynamicTools?: unknown[]
  /** Additional roots writable in workspace-write sandbox mode. */
  environments?: unknown
}

export interface ThreadStartResponse {
  thread: { id: string }
}

export interface ThreadResumeParams extends ThreadStartParams {
  /** Thread id to resume. */
  threadId?: string
  /** Or resume from rollout file path. */
  path?: string
  /** Replay history from notification stream after resume. */
  history?: unknown[]
  excludeTurns?: number[]
}

// ============================================================================
// Turns
// ============================================================================

export type UserInput =
  | { type: 'text'; text: string; text_elements?: unknown[] }
  | { type: 'image'; url: string }
  | { type: 'localImage'; path: string }
  | { type: 'skill'; name: string; path?: string }
  | { type: 'mention'; name: string; path?: string }

export interface TurnStartParams {
  threadId: string
  input: UserInput[]
  model?: string
  effort?: string
  summary?: string
}

/** Verified against the bundled Codex app-server generated V2 schema. */
export interface TurnSteerParams {
  threadId: string
  input: UserInput[]
  expectedTurnId: string
}

export interface TurnInterruptParams {
  threadId: string
  turnId?: string
}

// ============================================================================
// Streaming notifications (server → client)
// ============================================================================

/** Common fields on item-lifecycle notifications. itemId IS NOT a top-level
 * field on ItemStarted/ItemCompleted — it's nested as `item.id`. Only the
 * delta notifications carry a top-level itemId. */
export interface ItemNotificationBase {
  threadId: string
  turnId: string
  itemId: string
}

export interface ItemStartedNotification {
  item: ThreadItem
  threadId: string
  turnId: string
  startedAtMs?: number
  /** Some builds may include this; we tolerate it for forward compat. */
  itemId?: string
}

export interface ItemCompletedNotification {
  item: ThreadItem
  threadId: string
  turnId: string
  completedAtMs?: number
  itemId?: string
}

export interface AgentMessageDeltaNotification extends ItemNotificationBase {
  delta: string
}

export interface ReasoningTextDeltaNotification extends ItemNotificationBase {
  delta: string
  contentIndex?: number
}

export interface ReasoningSummaryTextDeltaNotification extends ItemNotificationBase {
  delta: string
  summaryIndex?: number
}

export interface CommandExecutionOutputDeltaNotification extends ItemNotificationBase {
  delta: string
  /** Stream id, e.g. "stdout" / "stderr" — informational only. */
  stream?: string
}

export interface FileChangeOutputDeltaNotification extends ItemNotificationBase {
  delta: string
}

export interface TurnStartedNotification {
  threadId: string
  turn?: { id: string; status?: string }
  /** Legacy notification shape. */
  turnId?: string
}

export interface TurnCompletedNotification {
  threadId: string
  turn?: { id: string; status?: string; error?: { message: string } | null }
  /** Legacy notification shape. */
  turnId?: string
  usage?: TokenUsage
  status?: string
}

export interface ThreadStartedNotification {
  threadId: string
}

export interface TokenUsageUpdatedNotification {
  threadId: string
  usage: TokenUsage
}

export interface TokenUsage {
  input_tokens?: number
  cached_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
  /** camelCase alternates seen in some builds; tolerate both. */
  inputTokens?: number
  cachedInputTokens?: number
  outputTokens?: number
}

export interface ErrorNotification {
  /** Native retry keeps the current turn alive; only a terminal error ends it. */
  willRetry?: boolean
  message?: string
  threadId?: string
  turnId?: string
  /** Some builds wrap the message in a `error: { message }` object. */
  error?: { message?: string } | string
}

// ============================================================================
// Thread items (the streaming payloads)
//
// IMPORTANT: item.type values are CAMELCASE on the wire (matching the Rust
// ts-rs schema in codex-rs/app-server-protocol/schema/typescript/v2/ThreadItem.ts).
// `agentMessage`, NOT `agent_message`. Mismatching this will silently route
// every text/tool item through the orphan-tool path and surface as empty
// "tool-call - agentMessage" cards.
// ============================================================================

export type ThreadItem =
  | UserMessageItem
  | AgentMessageItem
  | ReasoningItem
  | CommandExecutionItem
  | FileChangeItem
  | McpToolCallItem
  | WebSearchItem
  | PlanItem
  | DynamicToolCallItem
  | ImageGenerationItem
  | ImageViewItem
  | ContextCompactionItem
  | EnteredReviewModeItem
  | ExitedReviewModeItem
  | HookPromptItem
  | UnknownItem

export interface UserMessageItem {
  type: 'userMessage'
  id?: string
  /** Array of UserInput entries (text/image/etc.) — Halo already rendered the bubble. */
  content?: unknown[]
}

export interface AgentMessageItem {
  type: 'agentMessage'
  id?: string
  text?: string
  phase?: string | null
  memoryCitation?: unknown | null
}

export interface ReasoningItem {
  type: 'reasoning'
  id?: string
  /** Array of summary segments — model's published reasoning summary. */
  summary?: string[]
  /** Array of content segments — full reasoning trace when emitted. */
  content?: string[]
}

export interface CommandExecutionItem {
  type: 'commandExecution'
  id?: string
  command?: string
  cwd?: string
  processId?: string | null
  status?: 'inProgress' | 'completed' | 'failed' | 'declined' | string
  commandActions?: unknown[]
  aggregatedOutput?: string | null
  exitCode?: number | null
  durationMs?: number | null
}

export interface FileChangeItem {
  type: 'fileChange'
  id?: string
  status?: string
  /** Per-file changes; each carries a unified diff string. */
  changes?: Array<{
    path: string
    kind?: string
    /** Unified diff string. */
    diff?: string
  }>
}

export interface McpToolCallItem {
  type: 'mcpToolCall'
  id?: string
  server?: string
  tool?: string
  arguments?: unknown
  status?: string
  mcpAppResourceUri?: string
  result?: { content?: Array<Record<string, unknown>>; structured_content?: unknown } | null
  error?: { message?: string } | string | null
  durationMs?: number | null
}

export interface WebSearchItem {
  type: 'webSearch'
  id?: string
  query?: string
  action?: unknown | null
}

/**
 * Codex's plan is a single text blob (the Markdown-formatted to-do list the
 * model produced), NOT a structured array of steps. The renderer flattens
 * this into a TodoWrite-shaped synthetic input via the event-normalizer.
 */
export interface PlanItem {
  type: 'plan'
  id?: string
  text?: string
}

export interface DynamicToolCallItem {
  type: 'dynamicToolCall'
  id?: string
  namespace?: string | null
  tool?: string
  arguments?: unknown
  status?: string
  contentItems?: unknown[]
  success?: boolean | null
  durationMs?: number | null
}

export interface ImageGenerationItem {
  type: 'imageGeneration'
  id?: string
  status?: string
  revisedPrompt?: string | null
  result?: string
  savedPath?: string
}

export interface ImageViewItem {
  type: 'imageView'
  id?: string
  path?: string
}

export interface ContextCompactionItem {
  type: 'contextCompaction'
  id?: string
}

export interface EnteredReviewModeItem {
  type: 'enteredReviewMode'
  id?: string
  review?: string
}

export interface ExitedReviewModeItem {
  type: 'exitedReviewMode'
  id?: string
  review?: string
}

export interface HookPromptItem {
  type: 'hookPrompt'
  id?: string
  fragments?: unknown[]
}

export interface UnknownItem {
  type: string
  id?: string
  [key: string]: unknown
}

// ============================================================================
// Server requests (server → client; client MUST respond with same id)
// ============================================================================

export interface CommandExecutionRequestApprovalParams {
  threadId: string
  turnId: string
  itemId: string
  approvalId?: string
  reason?: string
  command?: string
  cwd?: string
}

export interface FileChangeRequestApprovalParams {
  threadId: string
  turnId: string
  itemId: string
  reason?: string
  grantRoot?: boolean
}

export interface ToolRequestUserInputParams {
  threadId: string
  turnId: string
  itemId: string
  /** Question text or schema for the user; shape varies across builds. */
  question?: string
  schema?: Record<string, unknown>
  options?: Array<{ value: string; label?: string }>
  prompt?: string
}

export interface McpServerElicitationRequestParams {
  /** MCP elicitation parameters; passes through transparently. */
  message?: string
  schema?: Record<string, unknown>
  [key: string]: unknown
}

export interface PermissionsRequestApprovalParams {
  threadId: string
  turnId: string
  itemId: string
  reason?: string
  permissions?: unknown
}

/**
 * Approval decision returned to the server. Codex accepts `approved` /
 * `denied` / `abort` (the abort variant cancels the turn entirely).
 */
export type ApprovalDecision = 'approved' | 'denied' | 'abort'

export interface ApprovalDecisionResponse {
  decision: ApprovalDecision
}

// ============================================================================
// Method name catalog (typed string constants for safety)
// ============================================================================

/** Client → server requests Halo issues. */
export const ClientMethods = {
  Initialize: 'initialize',
  Initialized: 'initialized',
  ThreadStart: 'thread/start',
  ThreadResume: 'thread/resume',
  TurnStart: 'turn/start',
  TurnSteer: 'turn/steer',
  TurnInterrupt: 'turn/interrupt',
} as const

/** Server → client notifications Halo subscribes to. */
export const ServerNotifications = {
  ThreadStarted: 'thread/started',
  ThreadTokenUsageUpdated: 'thread/tokenUsage/updated',
  ThreadCompacted: 'thread/compacted',

  TurnStarted: 'turn/started',
  TurnCompleted: 'turn/completed',
  TurnFailed: 'turn/failed',

  ItemStarted: 'item/started',
  ItemCompleted: 'item/completed',

  AgentMessageDelta: 'item/agentMessage/delta',
  ReasoningTextDelta: 'item/reasoning/textDelta',
  ReasoningSummaryTextDelta: 'item/reasoning/summaryTextDelta',
  CommandExecutionOutputDelta: 'item/commandExecution/outputDelta',
  FileChangeOutputDelta: 'item/fileChange/outputDelta',
  McpToolCallProgress: 'item/mcpToolCall/progress',

  Error: 'error',
  Warning: 'warning',
} as const

/** Server → client requests Halo handles. */
export const ServerRequestMethods = {
  CommandExecutionRequestApproval: 'item/commandExecution/requestApproval',
  FileChangeRequestApproval: 'item/fileChange/requestApproval',
  ToolRequestUserInput: 'item/tool/requestUserInput',
  McpServerElicitationRequest: 'mcpServer/elicitation/request',
  PermissionsRequestApproval: 'item/permissions/requestApproval',
  ChatgptAuthTokensRefresh: 'account/chatgptAuthTokens/refresh',
  ApplyPatchApproval: 'applyPatchApproval',
  ExecCommandApproval: 'execCommandApproval',
  /** Dynamic tool calls (we register no dynamic tools, so we reject these). */
  ItemToolCall: 'item/tool/call',
} as const

export type ServerRequestId = RequestId
