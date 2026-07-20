/**
 * Toolset Broker - System-prompt section
 *
 * Appends the full usage guide of each currently-ENABLED optional toolset to the
 * system prompt, so the AI has rich cross-tool guidance for capabilities that are
 * actually available (their mcp__<id>__* tools).
 *
 * Awareness of DISABLED toolsets (and how to ask the user to enable one) is NOT
 * here — it lives in the `request_toolset` tool's own description (meta-server.ts),
 * which is present only while something is disabled. Keeping it there avoids a
 * redundant resident index and the "generic MCP manager" framing.
 */

import { getAvailableToolsets } from './registry'
import { getOpenToolsets } from './state'

/**
 * Build the enabled-toolset guides section for a conversation's system prompt.
 * Returns an empty string when no toolset is enabled.
 */
export function buildToolsetSection(spaceId: string, conversationId: string): string {
  const open = getOpenToolsets(spaceId, conversationId)
  if (open.size === 0) return ''

  let out = ''
  for (const def of getAvailableToolsets()) {
    if (open.has(def.id) && def.usageGuide) {
      out += '\n\n' + def.usageGuide.trim()
    }
  }
  return out
}
