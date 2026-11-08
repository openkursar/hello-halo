/**
 * What a digital human's web-search switch takes out of its sessions. Read by
 * every entry that builds one (its chats and its scheduled runs), so the
 * switch means the same wherever the digital human works. It covers searching
 * only: opening a given web page and the AI browser have their own controls.
 *
 * Applied to the owner's own session before any capability policy: a policy
 * only narrows, so a guest or teammate can never get back what the owner
 * switched off.
 */

import { isWebSearchEnabled } from '../../../shared/apps/app-types'
import type { InstalledApp } from '../../../shared/apps/app-types'
import type { BaseServerId } from '../../services/agent/toolsets/base'

/** The engine's own search tool, besides Halo's web search server. */
export const WEB_SEARCH_BUILTIN_TOOLS = ['WebSearch'] as const

export interface WithheldWebSearch {
  /** Base servers the session is built without. */
  servers: BaseServerId[]
  /** Built-in tools to add to the session's `disallowedTools`. */
  builtins: string[]
}

export function withheldWebSearch(app: Pick<InstalledApp, 'permissions' | 'spec'>): WithheldWebSearch {
  if (isWebSearchEnabled(app)) return { servers: [], builtins: [] }
  return { servers: ['web-search'], builtins: [...WEB_SEARCH_BUILTIN_TOOLS] }
}

/** Adds the withheld built-ins to a session's deny list. */
export function withholdWebSearchBuiltins(sdkOptions: { disallowedTools?: string[] }, withheld: WithheldWebSearch): void {
  if (withheld.builtins.length === 0) return
  sdkOptions.disallowedTools = [...new Set([...(sdkOptions.disallowedTools ?? []), ...withheld.builtins])]
}
