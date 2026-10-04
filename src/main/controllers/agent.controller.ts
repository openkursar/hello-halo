/**
 * Agent Controller - Unified business logic for agent operations
 * Used by both IPC handlers and HTTP routes
 */

import {
  sendMessage as agentSendMessage,
  injectMessage as agentInjectMessage,
  stopGeneration as agentStopGeneration,
  isGenerating,
  getActiveSessions,
  getSessionState as agentGetSessionState,
  testMcpConnections as agentTestMcpConnections,
  probeMcpApp as agentProbeMcpApp,
  resolveQuestion
} from '../services/agent'
import type { AgentRequest } from '../services/agent'
import { markIntentionalStop } from '../apps/runtime'
import { analytics } from '../services/analytics/analytics.service'
import { isReasoningEffortLevel } from '../../shared/constants/reasoning-effort'
import type { AgentInjectRequest, AgentSendRequest } from '../../shared/types/agent-send'
import { parseCanvasContext, parseTurnReferences } from './chat-turn-input'

export interface ControllerResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

type Fields = Partial<Record<keyof AgentSendRequest, unknown>>

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined

/**
 * The turn a client asked for, built field by field: only what a client may
 * send crosses (a built-in task, for one, is started in-process only), and
 * what reaches the model's prompt is checked and bounded first.
 */
export function toAgentRequest(body: unknown): { ok: true; request: AgentRequest } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Invalid request' }
  const fields = body as Fields
  if (typeof fields.spaceId !== 'string' || !fields.spaceId || typeof fields.conversationId !== 'string' || !fields.conversationId) {
    return { ok: false, error: 'Missing required fields: spaceId, conversationId' }
  }
  if (typeof fields.message !== 'string') return { ok: false, error: 'message must be a string' }
  const references = parseTurnReferences(fields.references)
  if (!references.ok) return references
  const canvasContext = parseCanvasContext(fields.canvasContext)
  const resumeSessionId = optionalString(fields.resumeSessionId)
  const knowledgeBaseId = optionalString(fields.knowledgeBaseId)
  return {
    ok: true,
    request: {
      spaceId: fields.spaceId,
      conversationId: fields.conversationId,
      message: fields.message,
      ...(resumeSessionId ? { resumeSessionId } : {}),
      ...(Array.isArray(fields.images) && fields.images.length > 0 ? { images: fields.images as AgentRequest['images'] } : {}),
      ...(typeof fields.thinkingEnabled === 'boolean' ? { thinkingEnabled: fields.thinkingEnabled } : {}),
      ...(isReasoningEffortLevel(fields.reasoningEffort) ? { reasoningEffort: fields.reasoningEffort } : {}),
      ...(knowledgeBaseId ? { knowledgeBaseId } : {}),
      // Checked by the service, where a refused goal can leave no trace.
      ...(fields.goal !== undefined && fields.goal !== null ? { goal: fields.goal as AgentRequest['goal'] } : {}),
      ...(canvasContext ? { canvasContext } : {}),
      ...(references.references ? { references: references.references } : {}),
    },
  }
}

/**
 * Send a message to the agent
 */
export async function sendMessage(body: unknown): Promise<ControllerResponse> {
  const parsed = toAgentRequest(body)
  if (!parsed.ok) {
    console.warn(`[Agent] Send refused at the boundary: ${parsed.error}`)
    return { success: false, error: parsed.error }
  }
  try {
    await agentSendMessage(parsed.request)
    return { success: true }
  } catch (error: unknown) {
    const err = error as Error
    analytics.trackErrorSurface('agent-send', err)
    return { success: false, error: err.message }
  }
}

/**
 * Add a message to the turn a space conversation is running.
 */
export function injectMessage(body: unknown): ControllerResponse {
  const fields = (body && typeof body === 'object' ? body : {}) as Partial<Record<keyof AgentInjectRequest, unknown>>
  const references = parseTurnReferences(fields.references)
  if (!references.ok) return { success: false, error: references.error }
  const message = typeof fields.message === 'string' ? fields.message : ''
  if (typeof fields.conversationId !== 'string' || !fields.conversationId || (!message.trim() && !references.references)) {
    return { success: false, error: 'Missing required fields: conversationId, message' }
  }
  try {
    agentInjectMessage(fields.conversationId, message, references.references)
    return { success: true }
  } catch (error: unknown) {
    const err = error as Error
    console.error('[Agent] inject-message failed:', err)
    return { success: false, error: err.message }
  }
}

/**
 * Stop generation for a specific conversation or all
 */
export function stopGeneration(conversationId?: string): ControllerResponse {
  try {
    // Marked BEFORE stopping — see intentional-stop.ts: a team member's stop
    // kills its CC subprocess outright, surfacing the same way a crash does,
    // and this is the only thing that tells turn-report.ts the difference.
    if (conversationId) markIntentionalStop(conversationId)
    agentStopGeneration(conversationId)
    return { success: true }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}

/**
 * Approve tool execution - no-op (all permissions auto-allowed)
 */
export function approveTool(_conversationId: string): ControllerResponse {
  return { success: true }
}

/**
 * Reject tool execution - no-op (all permissions auto-allowed)
 */
export function rejectTool(_conversationId: string): ControllerResponse {
  return { success: true }
}

/**
 * Check if a conversation is currently generating
 */
export function checkGenerating(conversationId: string): ControllerResponse<boolean> {
  try {
    return { success: true, data: isGenerating(conversationId) }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}

/**
 * Get all active session conversation IDs
 */
export function listActiveSessions(): ControllerResponse<string[]> {
  try {
    return { success: true, data: getActiveSessions() }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}

/**
 * Get current session state for recovery after refresh
 */
export function getSessionState(conversationId: string): ControllerResponse {
  try {
    return { success: true, data: agentGetSessionState(conversationId) }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}

/**
 * Answer a pending AskUserQuestion
 */
export function answerQuestion(
  conversationId: string,
  id: string,
  answers: Record<string, string>
): ControllerResponse {
  try {
    const resolved = resolveQuestion(id, answers)
    if (!resolved) {
      return { success: false, error: `No pending question found for id: ${id}` }
    }
    return { success: true }
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}

/**
 * Test MCP server connections
 */
export async function testMcpConnections(): Promise<ControllerResponse> {
  try {
    const result = await agentTestMcpConnections()
    return result
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}

/**
 * Probe a single installed MCP app (native handshake, no agent session)
 */
export async function probeMcpApp(appId: string): Promise<ControllerResponse> {
  try {
    return await agentProbeMcpApp(appId)
  } catch (error: unknown) {
    const err = error as Error
    return { success: false, error: err.message }
  }
}
