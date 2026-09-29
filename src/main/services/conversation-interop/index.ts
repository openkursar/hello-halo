/**
 * Cross-Conversation Interop — public surface.
 *
 * Backend core (list/read/deliver/wait/circuit-breaker) plus the
 * `halo-conversations` MCP server (`conversation_read` / `conversation_send`).
 * Conversations come from registered `ConversationSource`s — the space's own
 * are built in; a higher tier registers its own at bootstrap. The renderer is
 * separate work — see DESIGN.md.
 */

export { createConversationInteropMcpServer, type ConversationInteropScope } from './mcp-server'
export { initConversationInterop, disposeConversationInterop } from './lifecycle'
export { registerConversationSource, getReadableSources } from './source'
export { CHAT_SOURCE_KIND } from './chat-source'
export type {
  ConversationSource,
  SourceConversation,
  DispatchedMessage,
  DispatchOutcome,
} from './source'
export { isNativeConversationBusy } from './busy'
export { listConversationsForInterop, readConversationForInterop } from './list-read'
export {
  deliverToConversation,
  tryResolveAsReply,
  type DeliverParams,
  type DeliverAndWaitParams,
} from './delivery'
export { deliverToConversationAndWait } from './delivery'
export { deliverExternalMessage, type ExternalDeliverParams } from './delivery'
export { circuitBreaker, DEFAULT_CIRCUIT_LIMITS } from './circuit-breaker'
export type { CircuitLimits, CircuitBreachEvent, CircuitRejectReason } from './circuit-breaker'
export type {
  ConversationSummary,
  ConversationListPage,
  ListConversationsResult,
  TranscriptLine,
  ConversationReadPage,
  ReadConversationResult,
  DeliveryStatus,
  DeliverFailureReason,
  DeliverResult,
  WaitOutcome,
  WaitFailureReason,
  WaitResult,
} from './types'
