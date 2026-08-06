/**
 * MCP Server Status Semantics
 *
 * Shared interpretation of the two-producer status model (probe verdict vs
 * agent session verdict) so every component renders the same judgment.
 */

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
