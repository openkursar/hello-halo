/**
 * Toolset Broker - Service entry (user-initiated)
 *
 * Thin façade for transport handlers (IPC/HTTP). Resolves the working
 * directory for a conversation and delegates to the broker. The AI-initiated
 * path goes directly through the broker's meta server instead.
 */

import { getWorkingDir } from '../helpers'
import { openToolset, closeToolset, listToolsetStatuses } from './broker'
import type { OpenToolsetResult } from './broker'
import type { ToolsetScope, ToolsetStatus } from './types'

function scopeFor(spaceId: string, conversationId: string): ToolsetScope {
  return { spaceId, conversationId, workDir: getWorkingDir(spaceId) }
}

/** List toolset statuses for a conversation (renderer menu + AI parity) */
export function listToolsets(spaceId: string, conversationId: string): ToolsetStatus[] {
  return listToolsetStatuses(spaceId, conversationId)
}

/** User opens a toolset from the UI */
export function openToolsetByUser(
  spaceId: string,
  conversationId: string,
  toolsetId: string
): OpenToolsetResult {
  return openToolset(scopeFor(spaceId, conversationId), toolsetId, 'user')
}

/** User closes a toolset from the UI */
export function closeToolsetByUser(
  spaceId: string,
  conversationId: string,
  toolsetId: string
): OpenToolsetResult {
  return closeToolset(scopeFor(spaceId, conversationId), toolsetId, 'user')
}
