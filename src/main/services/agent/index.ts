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

// ============================================
// MCP Management
// ============================================

export {
  getCachedMcpStatus,
  testMcpConnections
} from './mcp-manager'

// ============================================
// Re-exports for Internal Use
// ============================================

export { createCanUseTool, resolveQuestion, rejectQuestion, rejectAllQuestions } from './permission-handler'
export { listToolsets, openToolsetByUser, closeToolsetByUser } from './toolsets'
export type { ToolsetStatus, ToolsetsChangedEvent } from './toolsets'
export { getWorkingDir, getApiCredentials } from './helpers'
export { parseSDKMessage, buildMessageContent, formatCanvasContext } from './message-utils'
export { getOrCreateV2Session, activeSessions, v2Sessions, getConsumerHandle } from './session-manager'
export { broadcastMcpStatus } from './mcp-manager'
