/** Usage guides follow the same mode-aware selection as the mounted servers. */

import { getAvailableToolsets } from './registry'
import { getOpenToolsets } from './state'
import { isToolsetIncluded } from './selection'
import type { ToolsetContextMode } from './types'

const AUTOMATIC_CONTEXT_GUIDANCE = `# Capability availability in this conversation
Supported browser, terminal, OCR and collaboration capabilities are supplied automatically. Operate Halo is a core capability: its API reference and scoped runtime credentials are available without a human enablement step. Do not ask the user to enable capability switches, even if an older Halo guide describes them. Use the tools exposed in this session and discover further tools when the engine provides a discovery entry.
Explicit tool restrictions, connection settings and caller-specific execution policies remain effective. A missing or denied tool does not authorize bypassing those restrictions.`

/** Captured once at session creation. */
export function buildToolsetSection(spaceId: string, conversationId: string, mode: ToolsetContextMode = 'manual'): string {
  const open = getOpenToolsets(spaceId, conversationId)

  let out = '\n\n' + AUTOMATIC_CONTEXT_GUIDANCE
  for (const def of getAvailableToolsets()) {
    if (isToolsetIncluded(def, open, mode) && def.usageGuide) {
      out += '\n\n' + def.usageGuide.trim()
    }
  }
  return out
}
