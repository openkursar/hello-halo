/** Usage guides follow the same mode-aware selection as the mounted servers. */

import { getAvailableToolsets } from './registry'
import { getExcludedToolsets, getOpenToolsets } from './state'
import { isToolsetIncluded } from './selection'
import type { ToolsetContextMode } from './types'

const AUTOMATIC_CONTEXT_GUIDANCE = `# Capability availability in this conversation
Supported browser, terminal, OCR and collaboration capabilities are supplied automatically. Operate Halo is a core capability: its API reference and scoped runtime credentials are available without a human enablement step. Do not ask the user to enable capability switches, even if an older Halo guide describes them. Use the tools exposed in this session and discover further tools when the engine provides a discovery entry.
Explicit tool restrictions, connection settings and caller-specific execution policies remain effective. A missing or denied tool does not authorize bypassing those restrictions.`

/** Captured once at session creation. */
export function buildToolsetSection(spaceId: string, conversationId: string, mode: ToolsetContextMode = 'manual'): string {
  const open = getOpenToolsets(spaceId, conversationId)
  const excluded = getExcludedToolsets(spaceId, conversationId)
  const available = getAvailableToolsets()

  let out = '\n\n' + AUTOMATIC_CONTEXT_GUIDANCE
  const excludedNames = available.filter(def => excluded.has(def.id)).map(def => def.displayName)
  if (excludedNames.length > 0) {
    out += `\n\nThe following capabilities are excluded from this conversation and unavailable: ${excludedNames.join(', ')}. Do not offer them or ask the user to enable them.`
  }
  for (const def of available) {
    if (isToolsetIncluded(def, open, mode, excluded) && def.usageGuide) {
      out += '\n\n' + def.usageGuide.trim()
    }
  }
  return out
}
