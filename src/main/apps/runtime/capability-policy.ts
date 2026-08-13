/**
 * Applying a capability policy to a digital-human turn.
 *
 * Two callers drive a digital human that is not its owner — an IM guest and a
 * teammate in a team — and both must be held to the same, single set of rules.
 * This module is where those rules turn into SDK options, so the two paths can
 * never quietly drift apart.
 *
 * The vocabulary (which tools exist, which capabilities can be switched, what an
 * unstated permission means) lives in `shared/apps/capability-policy`, shared
 * with the screens that offer the switches.
 */

import {
  allowsCapability,
  allowsUserMcp,
  computeDisallowedBuiltins,
  CAPABILITY_MCP_TOGGLES,
  CAPABILITY_SAFE_MCP,
} from '../../../shared/apps/capability-policy'
import type { CapabilityMode, CapabilityPolicy } from '../../../shared/apps/capability-policy'

export { computeDisallowedBuiltins }

const SAFE_MCP = new Set(CAPABILITY_SAFE_MCP)
const TOGGLE_BY_SERVER = new Map(CAPABILITY_MCP_TOGGLES.map((t) => [t.server, t.key]))

/**
 * The MCP servers this turn may see. A server that is not injected does not
 * exist for the model — no refusal to argue with, no tool to talk it into.
 *
 * `alwaysKeep` covers servers that are not a capability at all but the channel
 * the turn happens on (the team's own coordination tools): withholding those
 * would not restrict the caller, it would isolate the digital human.
 */
export function filterMcpServersByPolicy(
  allMcpServers: Record<string, unknown>,
  dbMcpServers: Record<string, unknown> | null,
  policy: CapabilityPolicy | undefined,
  mode: CapabilityMode,
  alwaysKeep?: ReadonlySet<string>
): Record<string, any> {
  const result: Record<string, any> = {}

  for (const [name, server] of Object.entries(allMcpServers)) {
    if (alwaysKeep?.has(name)) {
      result[name] = server
      continue
    }
    if (dbMcpServers && name in dbMcpServers) {
      if (allowsUserMcp(policy, name, mode)) result[name] = server
      continue
    }
    if (SAFE_MCP.has(name)) {
      result[name] = server
      continue
    }
    const toggle = TOGGLE_BY_SERVER.get(name)
    if (toggle) {
      if (allowsCapability(policy, toggle, mode)) result[name] = server
      continue
    }
    // A server nobody has classified yet. In strict mode it stays out (a guest
    // gets only what was granted); in permissive mode it stays in (a teammate
    // loses only what the owner switched off).
    if (mode === 'permissive') result[name] = server
  }

  return result
}
