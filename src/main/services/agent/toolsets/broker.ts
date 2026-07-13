/**
 * Toolset Broker - Orchestration
 *
 * Assembles the complete in-process MCP server set for a session and seeds it at
 * session creation (buildCreationTimeServers → buildMcpServerRecord). Every engine
 * receives its in-process servers up front: always-on web-search / halo-apps, the
 * broker meta server, and the currently-open toolsets. Only external process-based
 * MCP servers (user-installed apps) are passed separately by the caller.
 *
 * Toolsets are toggled by the user from the input "Tools" menu. A change persists
 * to the conversation record and schedules a session rebuild, so the new set is
 * seeded at the next session creation. There is deliberately NO runtime hot-swap:
 * one uniform mechanism across all engines (creation-time seed + rebuild-on-change)
 * keeps the agent hot path free of mid-turn MCP machinery. The AI never opens a
 * toolset itself — it asks the user to enable one (request_toolset), which the user
 * grants via the same toggle.
 */

import { getConfig, saveConfig } from '../../../foundation/config.service'
import { createWebSearchMcpServer } from '../../web-search'
import { createHaloAppsMcpServer } from '../../app-bridge'
import { emitAgentEvent } from '../events'
import { getAvailableToolsets, getToolset } from './registry'
import { getOpenToolsets, markOpen, markClosed, getServerCache } from './state'
import { createBrokerMetaServer, CAPABILITIES_SERVER_NAME } from './meta-server'
import type { ToolsetOpener, ToolsetScope, ToolsetStatus, ToolsetsChangedEvent } from './types'

/**
 * Complete in-process MCP server set seeded at session creation: always-on
 * servers + broker meta server + currently-open toolsets. Toolset changes take
 * effect via a session rebuild (see openToolset/closeToolset).
 */
export function buildCreationTimeServers(scope: ToolsetScope): Record<string, unknown> {
  return buildMcpServerRecord(scope)
}

// ============================================
// Session rebuild (DI seam)
// ============================================

/**
 * Schedules a session rebuild for a conversation. Injected by session-manager
 * (dependency-inversion seam so the broker never imports session-manager, which
 * imports the broker). A toolset open/close cannot mutate a live session, so the
 * session is rebuilt and the new set is seeded at creation. The invalidator defers
 * the rebuild until the current turn finishes when the session is mid-turn.
 */
type SessionInvalidator = (conversationId: string) => void

let invalidateSessionForRebuild: SessionInvalidator = () => {}

export function setSessionInvalidator(invalidator: SessionInvalidator): void {
  invalidateSessionForRebuild = invalidator
}

// ============================================
// Server record assembly
// ============================================

/**
 * Build the complete in-process MCP server record for a session's creation-time
 * options. Toolset/always-on instances are cached per conversation so a rebuild
 * keeps name-stable identities. The capabilities meta server is the exception:
 * its tool description bakes in the current disabled list, so it is recreated
 * on every build — caching it would leave the AI a stale "Currently off" list
 * after a toggle-triggered rebuild.
 */
export function buildMcpServerRecord(scope: ToolsetScope): Record<string, unknown> {
  const cache = getServerCache(scope.conversationId)
  const record: Record<string, unknown> = {}

  const ensure = (name: string, factory: () => unknown): void => {
    let instance = cache.get(name)
    if (!instance) {
      instance = factory()
      if (instance) cache.set(name, instance)
    }
    if (instance) record[name] = instance
  }

  // Always-on servers
  ensure('web-search', () => createWebSearchMcpServer())
  if (getConfig().agent?.enableDigitalHumans !== false) {
    ensure('halo-apps', () => createHaloAppsMcpServer(scope.spaceId))
  }

  // On-demand toolsets currently enabled for this conversation
  const openIds = getOpenToolsets(scope.spaceId, scope.conversationId)
  for (const id of openIds) {
    const def = getToolset(id)
    if (def) ensure(id, () => def.createServer(scope))
  }

  // The "capabilities" meta server (request_toolset) is present only while at
  // least one optional toolset is disabled — nothing to request once all are on.
  // Never cached: recreated per build so its description reflects the current set.
  const hasDisabled = getAvailableToolsets().some(def => !openIds.has(def.id))
  if (hasDisabled) {
    record[CAPABILITIES_SERVER_NAME] = createBrokerMetaServer(scope, {
      list: () => listToolsetStatuses(scope.spaceId, scope.conversationId),
      request: (id) => requestToolset(scope, id)
    })
  }

  return record
}

// ============================================
// Open / Close (user toggle) / Request (AI → user) / List
// ============================================

export interface OpenToolsetResult {
  ok: boolean
  error?: string
  alreadyOpen?: boolean
}

/**
 * Open a toolset for a conversation: persist the change, schedule a session
 * rebuild (the new set is seeded at the next creation), and notify UI surfaces.
 * Called by the user toggle (opener='user'); automation seeds toolsets from its
 * app spec instead of calling this.
 */
export function openToolset(
  scope: ToolsetScope,
  toolsetId: string,
  opener: ToolsetOpener
): OpenToolsetResult {
  const def = getToolset(toolsetId)
  if (!def) {
    return { ok: false, error: `Unknown or unavailable toolset: ${toolsetId}` }
  }

  const changed = markOpen(scope.spaceId, scope.conversationId, toolsetId)
  if (!changed) {
    return { ok: true, alreadyOpen: true }
  }

  invalidateSessionForRebuild(scope.conversationId)
  rememberLastToolsets(scope, opener)
  emitChanged(scope, toolsetId, 'open', opener)
  console.log(`[Toolsets][${scope.conversationId}] Opened ${toolsetId} (by ${opener}); rebuild scheduled`)
  return { ok: true }
}

/** Close a toolset for a conversation. */
export function closeToolset(
  scope: ToolsetScope,
  toolsetId: string,
  opener: ToolsetOpener
): OpenToolsetResult {
  const changed = markClosed(scope.spaceId, scope.conversationId, toolsetId)
  if (!changed) {
    return { ok: true, alreadyOpen: false }
  }

  getServerCache(scope.conversationId).delete(toolsetId)
  invalidateSessionForRebuild(scope.conversationId)
  rememberLastToolsets(scope, opener)
  emitChanged(scope, toolsetId, 'close', opener)
  console.log(`[Toolsets][${scope.conversationId}] Closed ${toolsetId} (by ${opener}); rebuild scheduled`)
  return { ok: true }
}

/**
 * Persist the conversation's current open-set as the global last-used selection,
 * the toolset analog of the global model selection. Only a user toggle updates it
 * (an AI request never opens a toolset, and a restore must not rewrite the seed),
 * so a new conversation inherits the last set the user chose by hand
 * (createConversation reads config.lastToolsets).
 */
function rememberLastToolsets(scope: ToolsetScope, opener: ToolsetOpener): void {
  if (opener !== 'user') return
  try {
    saveConfig({ lastToolsets: [...getOpenToolsets(scope.spaceId, scope.conversationId)] })
  } catch (e) {
    console.error(`[Toolsets][${scope.conversationId}] Failed to persist last-used toolsets:`, e)
  }
}

export interface RequestToolsetResult {
  ok: boolean
  error?: string
  displayName?: string
  /** True when the toolset is already enabled — no user action needed. */
  alreadyOpen?: boolean
}

/**
 * The AI asks the user to enable a toolset. This does NOT open it (only the user
 * can, via the toggle) — it emits a UI hint so the renderer highlights that
 * toolset's switch, and returns metadata so the meta-server can craft guidance.
 */
export function requestToolset(scope: ToolsetScope, toolsetId: string): RequestToolsetResult {
  const def = getToolset(toolsetId)
  if (!def) {
    return { ok: false, error: `Unknown or unavailable toolset: ${toolsetId}` }
  }
  if (getOpenToolsets(scope.spaceId, scope.conversationId).has(toolsetId)) {
    return { ok: true, displayName: def.displayName, alreadyOpen: true }
  }
  const payload = { conversationId: scope.conversationId, spaceId: scope.spaceId, toolsetId, displayName: def.displayName }
  emitAgentEvent('toolsets:requested', scope.spaceId, scope.conversationId, payload as unknown as Record<string, unknown>)
  console.log(`[Toolsets][${scope.conversationId}] AI requested user enable ${toolsetId}`)
  return { ok: true, displayName: def.displayName }
}

/** Current statuses for the AI (toolsets_list) and the renderer menu */
export function listToolsetStatuses(spaceId: string, conversationId: string): ToolsetStatus[] {
  const open = getOpenToolsets(spaceId, conversationId)
  return getAvailableToolsets().map(def => ({
    id: def.id,
    displayName: def.displayName,
    summary: def.summary,
    open: open.has(def.id)
  }))
}

function emitChanged(
  scope: ToolsetScope,
  toolsetId: string,
  action: 'open' | 'close',
  openedBy: ToolsetOpener
): void {
  const payload: ToolsetsChangedEvent = {
    conversationId: scope.conversationId,
    spaceId: scope.spaceId,
    toolsetId,
    action,
    openedBy,
    open: [...getOpenToolsets(scope.spaceId, scope.conversationId)]
  }
  emitAgentEvent('toolsets:changed', scope.spaceId, scope.conversationId, payload as unknown as Record<string, unknown>)
}
