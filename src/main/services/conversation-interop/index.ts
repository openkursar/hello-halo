/**
 * Cross-Conversation Interop — public surface.
 *
 * Backend core (list/read/deliver/wait/circuit-breaker) plus the
 * `halo-conversations` MCP server (`conversation_read` / `conversation_send`).
 * The renderer is separate work — see DESIGN.md.
 */

export { createConversationInteropMcpServer, type ConversationInteropScope } from './mcp-server'
export { initConversationInterop, disposeConversationInterop } from './turn-end-watch'
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
