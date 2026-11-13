/** Contracts for built-in capabilities, context loading and manual grants. */

import type { AgentModelSelection } from '../../../../shared/types/ai-sources'
import type { EngineId } from '../../../../shared/types/engine'

export interface ToolsetExecutionOptions {
  engineId: EngineId
  collaborationEnabled: boolean
  permissionMode?: string
  allowDangerouslySkipPermissions?: boolean
  allowedTools?: string[]
  disallowedTools?: string[]
  mcpServerNames: string[]
}

/**
 * Who triggered a toolset open/close. 'system' marks an automatic open by the
 * runtime itself (e.g. the non-vision image fallback opening OCR) — distinct
 * from 'ai', which never opens directly and only requests.
 */
export type ToolsetOpener = 'user' | 'ai' | 'restore' | 'system'

export type ToolsetContextMode = 'manual' | 'automatic'

/** Per-session scope passed to toolset server factories */
export interface ToolsetScope {
  spaceId: string
  conversationId: string
  workDir: string
  toolContextMode?: ToolsetContextMode
  /** Capabilities needed by this input, resolved only when creating its session. */
  requiredToolsets?: readonly string[]
  /** Captured with the session, not the next turn's pending model selection. */
  modelSelection?: AgentModelSelection
  /** Read the captured execution's effective grants when work is delegated. */
  executionOptions?: () => ToolsetExecutionOptions
  collaborationEnabled?: boolean
}

/**
 * A registered toolset. Registration is the only step needed to add a new
 * on-demand MCP server — the broker, meta tools, capability index, and UI
 * menu all derive from this definition.
 */
export interface ToolsetDefinition {
  /** Stable identifier, also the MCP server name (tools become mcp__<id>__*) */
  id: string
  /** English display name (renderer translates via t()) */
  displayName: string
  /** One-line capability summary shared with its owning service metadata. */
  summary: string
  /** Short host guidance for a mounted capability; detailed instructions belong to MCP metadata. */
  usageGuide: string
  /** The host supplies this capability without manual enablement; the engine manages its tool context. */
  contextManaged?: boolean
  /** Platform/capability gate. Unavailable toolsets are hidden everywhere. */
  isAvailable: () => boolean
  /** Build the in-process SDK MCP server instance for a session scope */
  createServer: (scope: ToolsetScope) => unknown
}

/** Platform availability and manual controls exposed to the renderer. */
export interface ToolsetStatus {
  id: string
  displayName: string
  summary: string
  open: boolean
  /** False when the capability is available without a manual loading control. */
  configurable?: boolean
}

/** Payload of the `toolsets:changed` event */
export interface ToolsetsChangedEvent {
  conversationId: string
  spaceId: string
  /** Which toolset changed and how (omitted for bulk restore) */
  toolsetId?: string
  action?: 'open' | 'close'
  openedBy?: ToolsetOpener
  /** Full current open set after the change */
  open: string[]
  /** Replaces the displayed controls when the actual session mode becomes known. */
  statuses?: ToolsetStatus[]
}
