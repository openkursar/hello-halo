/**
 * Toolset Broker - Types
 *
 * A "toolset" is a built-in in-process MCP server (ai-browser, ai-terminal, ...)
 * that is loaded into a session on demand instead of at session creation.
 * The broker keeps the resident context cost constant (a one-line summary per
 * toolset in the system prompt) regardless of how many toolsets exist.
 */

/** Who triggered a toolset open/close */
export type ToolsetOpener = 'user' | 'ai' | 'restore'

/** Per-session scope passed to toolset server factories */
export interface ToolsetScope {
  spaceId: string
  conversationId: string
  workDir: string
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
  /** One-line capability summary — the only resident context cost */
  summary: string
  /**
   * Full usage guide for the toolset. Appended to the system prompt only while
   * the toolset is enabled (buildToolsetSection); a rich system-prompt fragment.
   */
  usageGuide: string
  /** Platform/capability gate. Unavailable toolsets are hidden everywhere. */
  isAvailable: () => boolean
  /** Build the in-process SDK MCP server instance for a session scope */
  createServer: (scope: ToolsetScope) => unknown
}

/** Toolset state exposed to the AI (toolsets_list) and the renderer */
export interface ToolsetStatus {
  id: string
  displayName: string
  summary: string
  open: boolean
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
}
