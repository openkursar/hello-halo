/**
 * Builds fresh in-process MCP servers at session creation. The native context
 * mode selects automatic capabilities; actual grants and legacy context
 * selections remain user-controlled and rebuild only at a safe boundary.
 */

import { getConfig, saveConfig } from '../../../foundation/config.service'
import { emitAgentEvent } from '../events'
import { buildBaseToolset } from './base'
import { getAvailableToolsets, getToolset } from './registry'
import { getOpenToolsets, getExcludedToolsets, markOpen, markClosed, setToolsetContextMode } from './state'
import { isToolsetIncluded, isToolsetConfigurable } from './selection'
import { createBrokerMetaServer, CAPABILITIES_SERVER_NAME } from './meta-server'
import type { ToolsetOpener, ToolsetScope, ToolsetStatus, ToolsetsChangedEvent, ToolsetContextMode } from './types'

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

/**
 * Same shape as the seam above, for the same reason: `conversation-interop`
 * imports `session-manager.ts` (its busyness check composes
 * `activeSessions`/`getConsumerHandle`), and `session-manager.ts` imports
 * FROM this file (`setSessionInvalidator`/`buildCreationTimeServers`). A
 * static top-level `import { createConversationInteropMcpServer } from
 * '../../conversation-interop'` here would close that into a real cycle —
 * `session-manager → broker → conversation-interop → session-manager` —
 * pulling the entire agent stack (and `foundation/logging`'s module-level
 * config subscription) into this registry's own module-load time, which is
 * exactly what broke `broker.test.ts` / `toolsets-last-used.test.ts` (they
 * mock `config.service` without `onAgentConfigChange`, which only that cycle
 * ever needed). Bootstrap wires the real implementation in once, after both
 * modules exist, the same way it wires `setActiveTeamRuntime`.
 */
type ConversationInteropFactory = (
  scope: { spaceId: string; conversationId: string },
  includeSend: boolean
) => unknown

let createConversationInteropMcpServer: ConversationInteropFactory | null = null

export function setConversationInteropFactory(factory: ConversationInteropFactory): void {
  createConversationInteropMcpServer = factory
}

// ============================================
// Server record assembly
// ============================================

/**
 * Build the complete in-process MCP server record for a session's creation-time
 * options. Every instance is created fresh: an in-process MCP server binds to
 * exactly one session transport, so instances must never outlive the session
 * they were seeded into (a reused instance fails to connect and its tools
 * silently vanish). Callers therefore invoke this only at actual session
 * creation (see getOrCreateV2Session's buildMcpServers parameter).
 */
export function buildMcpServerRecord(scope: ToolsetScope): Record<string, unknown> {
  // Space chat takes the whole base toolset.
  const record: Record<string, unknown> = buildBaseToolset({ spaceId: scope.spaceId })

  const add = (name: string, factory: () => unknown): void => {
    const instance = factory()
    if (instance) record[name] = instance
  }

  // Boolean-gated, always-on — a brand-new conversation already has
  // conversation_read with no per-conversation setup. enableConversationSend
  // is a sub-switch: false builds conversation_read only ("omit, don't
  // error" shape), never a second gate a conversation could be missing both.
  // `createConversationInteropMcpServer` is null until bootstrap wires it in
  // (see the seam above) — never true in the running app, only in a unit
  // test that imports this file without also calling
  // `setConversationInteropFactory`.
  if (createConversationInteropMcpServer && getConfig().agent?.enableConversationInterop !== false) {
    const factory = createConversationInteropMcpServer
    add('halo-conversations', () =>
      factory(
        { spaceId: scope.spaceId, conversationId: scope.conversationId },
        getConfig().agent?.enableConversationSend !== false
      )
    )
  }

  // On-demand toolsets currently enabled for this conversation
  const openIds = getOpenToolsets(scope.spaceId, scope.conversationId)
  const excludedIds = getExcludedToolsets(scope.spaceId, scope.conversationId)
  const mode = scope.toolContextMode ?? 'manual'
  if (mode === 'manual') {
    for (const id of scope.requiredToolsets ?? []) {
      if (!excludedIds.has(id) && getToolset(id) && markOpen(scope.spaceId, scope.conversationId, id)) {
        emitChanged(scope, id, 'open', 'system')
      }
    }
  }
  const selectedIds = getAvailableToolsets()
    .filter(def => isToolsetIncluded(def, openIds, mode, excludedIds))
    .map(def => def.id)
  for (const id of selectedIds) {
    const def = getToolset(id)
    if (def) add(id, () => def.createServer(scope))
  }

  // The "capabilities" meta server (request_toolset) is present only while at
  // least one optional toolset is disabled — nothing to request once all are on.
  const hasDisabled = getAvailableToolsets().some(def => isToolsetConfigurable(def, mode) && !openIds.has(def.id))
  if (hasDisabled) {
    record[CAPABILITIES_SERVER_NAME] = createBrokerMetaServer(scope, {
      list: () => listToolsetStatuses(scope.spaceId, scope.conversationId, mode),
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
 * Called by the user toggle (opener='user') and by runtime auto-opens
 * (opener='system'); automation seeds toolsets from its app spec instead.
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
  if (getExcludedToolsets(scope.spaceId, scope.conversationId).has(toolsetId)) {
    return { ok: false, error: `Toolset is excluded from this conversation: ${toolsetId}` }
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

/** The agent may activate an available capability without a human enablement step. */
export function requestToolset(scope: ToolsetScope, toolsetId: string): RequestToolsetResult {
  const def = getToolset(toolsetId)
  if (!def || getExcludedToolsets(scope.spaceId, scope.conversationId).has(toolsetId)) {
    return { ok: false, error: `Unknown or unavailable toolset: ${toolsetId}` }
  }
  if (isToolsetIncluded(def, getOpenToolsets(scope.spaceId, scope.conversationId), scope.toolContextMode ?? 'manual')) {
    return { ok: true, displayName: def.displayName, alreadyOpen: true }
  }
  return openToolset(scope, toolsetId, 'ai')
}

/** Available capabilities, including those without a manual context control. */
export function listToolsetStatuses(spaceId: string, conversationId: string, mode: ToolsetContextMode | 'pending' = 'manual'): ToolsetStatus[] {
  const open = getOpenToolsets(spaceId, conversationId)
  const excluded = getExcludedToolsets(spaceId, conversationId)
  return getAvailableToolsets().map(def => ({
    id: def.id,
    displayName: def.displayName,
    summary: def.summary,
    open: isToolsetIncluded(def, open, mode === 'pending' ? 'manual' : mode, excluded),
    ...(!isToolsetConfigurable(def, mode) ? { configurable: false } : {}),
  }))
}

/** The controls follow the successfully created session, including during a pending engine change. */
export function publishToolsetContextMode(spaceId: string, conversationId: string, mode: ToolsetContextMode): void {
  setToolsetContextMode(conversationId, mode)
  const payload: ToolsetsChangedEvent = {
    spaceId, conversationId,
    open: [...getOpenToolsets(spaceId, conversationId)],
    statuses: listToolsetStatuses(spaceId, conversationId, mode),
  }
  emitAgentEvent('toolsets:changed', spaceId, conversationId, payload as unknown as Record<string, unknown>)
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
