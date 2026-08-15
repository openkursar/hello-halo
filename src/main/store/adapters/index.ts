/**
 * Adapter Registry
 *
 * Maps sourceType strings to their adapter implementations.
 * Import this module to resolve the correct adapter for a registry source.
 */

import type { RegistryAdapter } from './types'
import { HaloAdapter } from './halo.adapter'
import { DhpV2Adapter } from './dhp-v2.adapter'
import { McpRegistryAdapter } from './mcp-registry.adapter'
import { SmitheryAdapter } from './smithery.adapter'
import { ClaudeSkillsAdapter } from './claude-skills.adapter'
import { SkillHubAdapter } from './skillhub.adapter'
import type { RegistrySource } from '../../../shared/store/store-types'

// Singleton adapter instances. Adapters hold no per-call state; the DHP v2
// driver additionally carries a protocol-level handshake cache, keyed by source
// so a federation of several such sources cannot cross-talk.
const haloAdapter = new HaloAdapter()
const dhpV2Adapter = new DhpV2Adapter()
const mcpRegistryAdapter = new McpRegistryAdapter()
const smitheryAdapter = new SmitheryAdapter()
const claudeSkillsAdapter = new ClaudeSkillsAdapter()
const skillHubAdapter = new SkillHubAdapter()

/**
 * Return the adapter for the given registry source.
 * Falls back to HaloAdapter when sourceType is absent (backward-compatible).
 */
export function getAdapter(source: RegistrySource): RegistryAdapter {
  switch (source.sourceType) {
    case 'dhp-v2':
      return dhpV2Adapter
    case 'mcp-registry':
      return mcpRegistryAdapter
    case 'smithery':
      return smitheryAdapter
    case 'claude-skills':
      return claudeSkillsAdapter
    case 'skillhub':
      return skillHubAdapter
    case 'halo':
    default:
      return haloAdapter
  }
}

export type { RegistryAdapter }
