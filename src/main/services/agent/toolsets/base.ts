/**
 * Toolset Broker - Base Toolset
 *
 * The in-process MCP servers every user-facing session starts from, whatever
 * the entry point: web search, Halo's own documentation, and (while the user
 * allows it) digital-human management. An entry builds on this record and
 * removes what does not apply to it, stating why at the call site — never the
 * other way round, so a new base server reaches every entry by default.
 *
 * What is NOT here, on purpose: conversation collaboration (a separate switch
 * per entry kind), and everything granted per conversation or per permission —
 * browser, terminal, OCR, email, Halo's own API, memory, reporting, notify,
 * team tools, person context, IM file send.
 *
 * Import this file directly rather than through the barrel: the barrel loads
 * the toolset registry and with it every optional toolset's dependencies,
 * which an entry that only needs the base has no reason to pull in.
 *
 * Servers bind to exactly one session transport, so every call builds fresh
 * instances; call it only at actual session creation (see broker.ts).
 */

import { createWebSearchMcpServer } from '../../web-search'
import { createHaloAppsMcpServer } from '../../app-bridge'
import { createOfficialDocsSession } from '../../official-docs-mcp'
import { isDigitalHumansEnabled } from '../user-agent-settings'

export const BASE_SERVER_IDS = ['web-search', 'halo-docs', 'halo-apps'] as const

export type BaseServerId = (typeof BASE_SERVER_IDS)[number]

export interface BaseToolsetOptions {
  /** The space `halo-apps` manages digital humans in. */
  spaceId: string
  /**
   * Base servers this entry does not get. Each one is a decision: say why where
   * it is passed.
   */
  exclude?: readonly BaseServerId[]
  /** The entry mounts its own person-context tool; keep it out of `halo-apps`. */
  omitPersonContext?: boolean
}

export function buildBaseToolset(options: BaseToolsetOptions): Record<string, unknown> {
  const excluded = new Set<BaseServerId>(options.exclude)
  const record: Record<string, unknown> = {}

  // The documentation stays available with digital humans switched off: it is
  // how the agent answers "how do I do this in Halo", and how it hands back a
  // task no tool can reach.
  const { server: docsMcpServer, guideConsulted } = createOfficialDocsSession()

  const webSearch = excluded.has('web-search') ? null : createWebSearchMcpServer()
  if (webSearch) record['web-search'] = webSearch
  if (!excluded.has('halo-docs')) record['halo-docs'] = docsMcpServer

  if (!excluded.has('halo-apps') && isDigitalHumansEnabled()) {
    // Null until the Apps layer is wired in.
    const haloApps = createHaloAppsMcpServer(options.spaceId, guideConsulted, {
      omitPersonContext: options.omitPersonContext,
    })
    if (haloApps) record['halo-apps'] = haloApps
    else console.warn('[BaseToolset] halo-apps not mounted: the Apps layer is not wired in yet')
  }
  return record
}
