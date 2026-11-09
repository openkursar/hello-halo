/**
 * Toolset Broker - Per-conversation state
 *
 * In-memory open-set per conversation, write-through persisted on the
 * conversation record (Single Source of Truth is the main process; the
 * renderer mirrors state via `toolsets:changed` events).
 */

import { getConversation, updateConversation } from '../../conversation.service'
import { releaseInteractiveBrowserContext } from '../../ai-browser'
import type { ToolsetContextMode } from './types'

/** conversationId -> open toolset ids */
const openSets = new Map<string, Set<string>>()
const contextModes = new Map<string, ToolsetContextMode>()

export function getToolsetContextMode(conversationId: string): ToolsetContextMode | undefined {
  return contextModes.get(conversationId)
}

export function setToolsetContextMode(conversationId: string, mode: ToolsetContextMode): void {
  contextModes.set(conversationId, mode)
}

/**
 * Get the open set for a conversation, lazily hydrating from the persisted
 * conversation record. Persisted ids are kept as-is — including toolsets that
 * are currently unavailable on this platform — so the user's selection survives
 * availability transitions instead of being silently rewritten on the next
 * toggle. All consumers gate on registry availability at use time
 * (buildMcpServerRecord / listToolsetStatuses / buildToolsetSection).
 */
export function getOpenToolsets(spaceId: string, conversationId: string): Set<string> {
  let set = openSets.get(conversationId)
  if (!set) {
    set = new Set(getConversation(spaceId, conversationId)?.toolsets ?? [])
    openSets.set(conversationId, set)
  }
  return set
}

/**
 * Toolsets this conversation must not mount, even context-managed ones. Read
 * from the persisted conversation so a rebuilt session keeps the exclusion.
 */
export function getExcludedToolsets(spaceId: string, conversationId: string): ReadonlySet<string> {
  return new Set(getConversation(spaceId, conversationId)?.excludedToolsets ?? [])
}

/** Mark a toolset open. Returns false if it was already open. */
export function markOpen(spaceId: string, conversationId: string, toolsetId: string): boolean {
  const set = getOpenToolsets(spaceId, conversationId)
  if (set.has(toolsetId)) return false
  set.add(toolsetId)
  persist(spaceId, conversationId, set)
  return true
}

/** Mark a toolset closed. Returns false if it was not open. */
export function markClosed(spaceId: string, conversationId: string, toolsetId: string): boolean {
  const set = getOpenToolsets(spaceId, conversationId)
  if (!set.has(toolsetId)) return false
  set.delete(toolsetId)
  persist(spaceId, conversationId, set)
  return true
}

function persist(spaceId: string, conversationId: string, set: Set<string>): void {
  try {
    updateConversation(spaceId, conversationId, { toolsets: [...set] })
  } catch (e) {
    console.error(`[Toolsets] Failed to persist toolset state for ${conversationId}:`, e)
  }
}

/** Drop all in-memory state for a conversation (persisted record remains) */
export function dropConversationState(conversationId: string): void {
  openSets.delete(conversationId)
  contextModes.delete(conversationId)
  // The conversation's view of the browser goes with it. Releases rather than
  // destroys — the tabs are the user's and stay open.
  releaseInteractiveBrowserContext(conversationId)
}
