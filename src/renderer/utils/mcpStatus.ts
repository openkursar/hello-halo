/**
 * MCP Server Status Semantics
 *
 * Shared interpretation of the two-producer status model (probe verdict vs
 * agent session verdict) so every component renders the same judgment.
 */

import type { InstalledApp } from '../../shared/apps/app-types'
import type { McpServerStatus } from '../types'

/**
 * The configuration itself connects, but the last agent session could not use
 * the server. A session 'pending' is a session still starting, not a failure,
 * so it must never trip this.
 */
export function isSessionOnlyFailure(entry: McpServerStatus | undefined): boolean {
  return entry?.probeStatus === 'connected' &&
    (entry.sessionStatus === 'failed' || entry.sessionStatus === 'needs-auth')
}

export type McpHealth =
  | 'connected'
  | 'disabled'
  | 'not-installed'
  | 'failed'
  | 'needs-login'
  /** Configuration connects, but the last agent session could not use it. */
  | 'session-stale'
  | 'unprobed'

/** Resolve an MCP server's health from its install status and live probe/session entry. */
export function deriveMcpHealth(mcpApp: InstalledApp | null, sdkEntry?: McpServerStatus): McpHealth {
  if (!mcpApp) return 'not-installed'
  if (mcpApp.status === 'paused') return 'disabled'
  if (mcpApp.status === 'error') return 'failed'
  if (mcpApp.status === 'needs_login') return 'needs-login'
  if (sdkEntry) {
    if (isSessionOnlyFailure(sdkEntry)) return 'session-stale'
    if (sdkEntry.status === 'failed') return 'failed'
    if (sdkEntry.status === 'needs-auth') return 'needs-login'
    if (sdkEntry.status === 'connected') return 'connected'
  }
  return 'unprobed'
}

/**
 * Human-readable health/tool-count text for the dependency list and card
 * wall. Empty for an installed-but-unprobed server — "no news is good news"
 * rather than announcing a status that hasn't been determined yet; grouping
 * (a "not yet probed" bucket) is what communicates that state instead.
 */
export function mcpHealthText(health: McpHealth, t: (s: string, opts?: Record<string, unknown>) => string, toolCount = 0): string {
  switch (health) {
    case 'connected':     return toolCount > 0 ? t('Connected · {{count}} tools', { count: toolCount }) : t('Connected')
    case 'disabled':      return t('MCP server globally disabled')
    case 'failed':        return t('Connection failed')
    case 'needs-login':   return t('Needs login')
    case 'session-stale': return t('Retrying on next message')
    case 'not-installed': return t('Not installed')
    default:              return ''
  }
}

/**
 * Dot color for one health value — same palette AppStatusDot uses for the
 * equivalent InstalledApp statuses, so a red dot means "error" the same way
 * everywhere in the Apps UI. MCP is the one app type with real runtime
 * connection health (Skill has none, per SkillCard's own doc comment), so
 * unlike Skill/AutomationCard this doesn't route through AppStatusDot's
 * AppStatus union — it has its own richer health model, but the colors stay
 * in sync with it by convention, not by sharing code.
 */
export function mcpHealthDotClass(health: McpHealth): string {
  switch (health) {
    case 'connected':     return 'bg-green-500/50'
    case 'failed':
    case 'session-stale': return 'bg-red-500'
    case 'needs-login':   return 'bg-yellow-400'
    case 'disabled':      return 'border border-muted-foreground/40'
    default:              return 'bg-muted-foreground/40'
  }
}
