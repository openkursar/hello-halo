/**
 * Wire types for the DeepSeek Harness SDK runtime protocol.
 *
 * Unlike Codex's app-server dialect, dsh speaks true JSON-RPC 2.0: every frame
 * carries `"jsonrpc": "2.0"`. Framing is line-delimited JSON over the child's
 * stdin/stdout, one compact object per `\n`-terminated line.
 *
 * Three client→server requests (`initialize`, `session/prompt`, `shutdown`) and
 * four server→client notifications. The server never issues a request: the
 * transport carries them, but the runtime does not send one, so there is no
 * inbound-request handler here (contrast `codex/transport/server-request-handler.ts`).
 *
 * Mirrors `@deepseek-ai/dsh-sdk-protocol`'s `types.ts`. The session-event and
 * content-block payloads are left as `unknown`: they are the session vocabulary
 * of an unstable pre-release, and the normalizer — not the transport — owns
 * interpreting them.
 */

export type RequestId = string | number

export const JSONRPC_VERSION = '2.0'

export interface JsonRpcRequest {
  jsonrpc: typeof JSONRPC_VERSION
  id: RequestId
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  jsonrpc: typeof JSONRPC_VERSION
  method: string
  params?: unknown
}

export interface JsonRpcSuccessResponse {
  jsonrpc: typeof JSONRPC_VERSION
  id: RequestId
  result: unknown
}

export interface JsonRpcErrorPayload {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcErrorResponse {
  jsonrpc: typeof JSONRPC_VERSION
  id: RequestId
  error: JsonRpcErrorPayload
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccessResponse
  | JsonRpcErrorResponse

export function isJsonRpcNotification(msg: any): msg is JsonRpcNotification {
  return msg && msg.id === undefined && typeof msg.method === 'string'
}

export function isJsonRpcSuccess(msg: any): msg is JsonRpcSuccessResponse {
  return msg && msg.id !== undefined && typeof msg.method !== 'string' && 'result' in msg
}

export function isJsonRpcError(msg: any): msg is JsonRpcErrorResponse {
  return msg && msg.id !== undefined && typeof msg.method !== 'string' && 'error' in msg
}

/** Standard JSON-RPC error codes the runtime answers with. */
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const

// ============================================
// Request / result payloads
// ============================================

/** Method names the runtime answers. */
export const DshRequestMethod = {
  Initialize: 'initialize',
  SessionPrompt: 'session/prompt',
  Shutdown: 'shutdown',
} as const

/** `serverInfo.name` is the wire-stable `deepseek-harness-sdk-runtime`. */
export interface DshInitializeResult {
  serverInfo: { name: string; version: string }
}

export interface DshSessionPromptParams {
  sessionId: string
  contentBlocks: unknown[]
}

/**
 * Enqueue receipt for one prompt. `messageId` identifies the queued user
 * message only — never a later assistant message, turn ending, or result.
 */
export interface DshSessionPromptResult {
  messageId: string
}

// ============================================
// Notification payloads
// ============================================

/** Notification method names the runtime emits. */
export const DshNotificationMethod = {
  SessionEvent: 'session.event',
  SessionStatus: 'session.status',
  SubagentStarted: 'subagent.started',
  SubagentFinished: 'subagent.finished',
} as const

export type DshNotificationMethodName =
  (typeof DshNotificationMethod)[keyof typeof DshNotificationMethod]

const NOTIFICATION_METHODS = new Set<string>(Object.values(DshNotificationMethod))

export function isDshNotificationMethod(method: string): method is DshNotificationMethodName {
  return NOTIFICATION_METHODS.has(method)
}

// The notification bodies below are a READ MODEL: they name only the fields
// Halo reads, and every one of them is optional because the runtime is a
// separate program at a pre-release version. The authoritative vocabulary is
// `@deepseek-ai/dsh-session` and `@deepseek-ai/dsh-llm`; a field that
// disappears upstream must surface as `undefined` here, never as a type error
// that hides behind a cast at the call site.

export interface DshTokenUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export interface DshContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  arguments?: string
  toolCallId?: string
  content?: DshContentBlock[]
  isError?: boolean
}

/** One incremental frame of an assistant message. */
export interface DshStreamChunk {
  type: string
  index?: number
  blockType?: string
  text?: string
  id?: string
  name?: string
  argumentsDelta?: string
  block?: DshContentBlock
  usage?: DshTokenUsage
  reason?: { kind: string; failure?: { message?: string } }
}

export interface DshMessage {
  id?: string
  role?: string
  content?: DshContentBlock[]
  source?: { kind?: string }
}

export interface DshTurnEndReason {
  kind: string
  error?: { message?: string }
  reason?: { kind?: string }
}

/** One persisted session-log event envelope. */
export interface DshSessionEvent {
  type: string
  seq?: number
  time?: number
  data?: Record<string, any>
}

/**
 * One session-log event. The runtime streams events for **every** session it
 * holds, not only the one that was prompted — consumers scope by `sessionId`.
 */
export interface DshSessionEventNotification {
  sessionId?: string
  event?: DshSessionEvent
}

/** Whole-agent lifecycle for one session. A turn settles on `idle`. */
export interface DshSessionStatusNotification {
  sessionId?: string
  status?: string
}

export interface DshSubagentStartedNotification {
  parentSessionId?: string
  childSessionId?: string
}

export interface DshSubagentFinishedNotification {
  parentSessionId?: string
  childSessionId?: string
  status?: string
  stopReason?: string
  lastAssistantMessage?: DshContentBlock[]
}
