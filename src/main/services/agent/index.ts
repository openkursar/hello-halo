/**
 * Agent Module - Public API
 *
 * This module provides the AI agent functionality for Halo.
 * It manages V2 Sessions with Claude Code SDK, handles message streaming,
 * tool permissions, and MCP server connections.
 *
 * Module Structure:
 * - types.ts           - Type definitions
 * - events.ts          - Event declarations (Emitter-based, decoupled from BrowserWindow)
 * - helpers.ts         - Utility functions
 * - session-manager.ts - V2 Session lifecycle management
 * - mcp-manager.ts     - MCP server status management
 * - permission-handler.ts - Tool permission handling
 * - message-utils.ts   - Message building and parsing
 * - stream-processor.ts - Core stream processing (shared by send-message + app-chat)
 * - session-consumer.ts - Persistent REPL consumer (mirrors CC's REPL model)
 * - send-message.ts    - Main conversation message sending (send-only, consumer handles response)
 * - live-turn.ts       - Turn-in-flight probe + persistence-free mid-turn send
 * - control.ts         - Generation control (stop, status)
 */

// ============================================
// Type Exports
// ============================================

export type {
  ApiCredentials,
  ImageMediaType,
  ImageAttachment,
  CanvasContext,
  AgentRequest,
  ToolCall,
  ThoughtType,
  Thought,
  SessionState,
  V2SDKSession,
  V2SessionInfo,
  McpServerStatusInfo,
  TokenUsage,
  SingleCallUsage
} from './types'

// ============================================
// Event System
// ============================================

export {
  onAgentEvent,
  onAgentBroadcast,
  emitAgentEvent,
  emitAgentBroadcast
} from './events'

export type {
  AgentEvent,
  AgentBroadcastEvent
} from './events'

// ============================================
// Core Functions
// ============================================

// Send message to agent
export { sendMessage } from './send-message'

// Inject message into active session mid-turn (Agent Team / deadlock recovery)
export { injectMessage } from './inject-message'

// Turn-in-flight probe + persistence-free mid-turn delivery, for callers that
// own their own record of the message (an app chat's transcript)
export { hasLiveTurn, sendIntoLiveTurn } from './live-turn'

// Stream processor (shared core for main agent + app chat)
export { processStream } from './stream-processor'
export type { ProcessStreamParams, StreamCallbacks, StreamResult } from './stream-processor'

// Generation control
export {
  stopGeneration,
  isGenerating,
  getActiveSessions,
  getSessionState
} from './control'

// ============================================
// Session Management
// ============================================

export {
  ensureSessionWarm,
  closeV2Session,
  closeAllV2Sessions,
  invalidateAllSessions
} from './session-manager'

// Conversation goal (engines with features.goal)
export { getConversationGoal, setConversationGoal } from './goal'

// ============================================
// MCP Management
// ============================================

export {
  getCachedMcpStatus,
  testMcpConnections
} from './mcp-manager'

export { probeMcpApp } from './mcp-probe'
export type { McpProbeResult } from './mcp-probe'

// ============================================
// Re-exports for Internal Use
// ============================================

export { createCanUseTool, resolveQuestion, rejectQuestion, rejectAllQuestions } from './permission-handler'
export type { ToolGate } from './permission-handler'
export { listToolsets, openToolsetByUser, closeToolsetByUser } from './toolsets'
/**
 * Toolsets opened or closed by Halo itself for one conversation (opener
 * 'system'): unlike the user's toggle they never change the last-used set new
 * conversations start from. `getToolset` answers whether one is available.
 */
export { openToolset, closeToolset, getToolset } from './toolsets'
export type { ToolsetStatus, ToolsetsChangedEvent } from './toolsets'
export { getWorkingDir, getApiCredentials, getApiCredentialsForConversation } from './helpers'
/**
 * The one way to add engine hooks to session options: merges event by event,
 * so no concern that watches tool calls (the memory guard, a delegation audit,
 * a file boundary) can drop another's by assigning `hooks`.
 */
export { addSdkHooks } from './sdk-config'
/**
 * For an in-process MCP server that keeps the settings it was built from: a
 * live session built with other settings is then rebuilt on its next send.
 */
export { markMcpServerSettings } from './sdk-config'
export { parseSDKMessage, buildMessageContent, formatCanvasContext } from './message-utils'
/**
 * What a user turn carries besides its text, as the model reads it (references
 * and built-in task blocks), and the brief form a cross-conversation reader sees.
 */
export { formatTurnAttachments, formatReferencesBlock, formatMessageAttachmentsBrief } from './references'
/** Making text that is not the user's own safe to place inside those blocks (see prompt-text.ts). */
export { inlineCode, inlinePath, inlineText } from './prompt-text'
export { getOrCreateV2Session, activeSessions, v2Sessions, getConsumerHandle, SessionOptionsStaleError } from './session-manager'
/** Sending entries acquire before preparation and await lease.send() through SDK acceptance. */
export { acquireV2Session } from './session-manager'
export type { V2SessionLease } from './session-manager'
/** Headless callers protect manager-owned sessions until their execution reaches its release boundary. */
export { createSessionState, registerActiveSession, unregisterActiveSession } from './session-manager'
// Whether a conversation's session must not be disturbed: a turn in flight, or team agents still working between turns.
export { isSessionBusy } from './session-manager'
export { listResidentSessions, evictIdleSession, setResidentSessionLimit, getSessionEvictionCount, getResidentSessionLimit } from './session-manager'
export type { ResidentSessionInfo } from './session-manager'
export type { SessionGates } from './session-manager'
export { broadcastMcpStatus } from './mcp-manager'
