/**
 * Toolset Broker - Service entry (user-initiated)
 *
 * Thin façade for transport handlers (IPC/HTTP). Resolves the working
 * directory for a conversation and delegates to the broker. The AI-initiated
 * path goes directly through the broker's meta server instead.
 */

import { getWorkingDir } from '../helpers'
import { openToolset, closeToolset, listToolsetStatuses } from './broker'
import { getToolset } from './registry'
import { getToolsetContextMode } from './state'
import { isToolsetConfigurable } from './selection'
import { getConversation } from '../../conversation.service'
import { getConversationEngineMetadata } from '../engine-routing'
import type { OpenToolsetResult } from './broker'
import type { ToolsetScope, ToolsetStatus, ToolsetContextMode } from './types'

function controlsMode(spaceId: string, conversationId: string): ToolsetContextMode | 'pending' {
  const captured = getToolsetContextMode(conversationId)
  if (captured) return captured
  const conversation = getConversation(spaceId, conversationId)
  if (!conversation || getConversationEngineMetadata(conversation) !== 'halo') return 'manual'
  // Reading a menu never parses SDK history. The existing warm-up publishes its resolved mode.
  return conversation.engineBinding?.sessionId || conversation.sessionId ? 'pending' : 'automatic'
}

function scopeFor(spaceId: string, conversationId: string): ToolsetScope {
  return { spaceId, conversationId, workDir: getWorkingDir(spaceId) }
}

/** List toolset statuses for a conversation (renderer menu + AI parity) */
export function listToolsets(spaceId: string, conversationId: string): ToolsetStatus[] {
  return listToolsetStatuses(spaceId, conversationId, controlsMode(spaceId, conversationId))
}

/** User opens a toolset from the UI */
export function openToolsetByUser(
  spaceId: string,
  conversationId: string,
  toolsetId: string
): OpenToolsetResult {
  const definition = getToolset(toolsetId)
  const mode = controlsMode(spaceId, conversationId)
  if (definition && !isToolsetConfigurable(definition, mode)) {
    return { ok: true, alreadyOpen: true }
  }
  return openToolset(scopeFor(spaceId, conversationId), toolsetId, 'user')
}

/** User closes a toolset from the UI */
export function closeToolsetByUser(
  spaceId: string,
  conversationId: string,
  toolsetId: string
): OpenToolsetResult {
  const definition = getToolset(toolsetId)
  if (definition && !isToolsetConfigurable(definition, controlsMode(spaceId, conversationId))) {
    return { ok: false, error: 'This capability is managed automatically. Individual tool restrictions remain available in settings.' }
  }
  return closeToolset(scopeFor(spaceId, conversationId), toolsetId, 'user')
}
