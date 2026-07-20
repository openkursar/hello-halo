/**
 * Toolset Broker - Per-conversation state
 *
 * In-memory open-set per conversation, write-through persisted on the
 * conversation record (Single Source of Truth is the main process; the
 * renderer mirrors state via `toolsets:changed` events).
 */

import { getConversation, updateConversation } from '../../conversation.service'

/** conversationId -> open toolset ids */
const openSets = new Map<string, Set<string>>()

/** conversationId -> cached MCP server instances (name -> instance) */
const serverCaches = new Map<string, Map<string, unknown>>()

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

/** Per-conversation MCP server instance cache (name-stable across applies) */
export function getServerCache(conversationId: string): Map<string, unknown> {
  let cache = serverCaches.get(conversationId)
  if (!cache) {
    cache = new Map()
    serverCaches.set(conversationId, cache)
  }
  return cache
}

/** Drop all in-memory state for a conversation (persisted record remains) */
export function dropConversationState(conversationId: string): void {
  openSets.delete(conversationId)
  serverCaches.delete(conversationId)
}
