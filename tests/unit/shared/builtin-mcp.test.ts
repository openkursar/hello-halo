/**
 * Drift guard for shared/apps/builtin-mcp.
 *
 * BUILTIN_MCP_SERVER_IDS mirrors the mcpServers literals in
 * apps/runtime/execute.ts and app-chat.ts by convention (a comment) — nothing
 * enforces it at runtime because the runtime builds servers conditionally.
 * This test scans those sources for `'<id>': <factory>McpServer` keys and
 * fails when either side drifts, which would make the renderer's dependency
 * panel misclassify a built-in capability as an uninstalled MCP app.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { BUILTIN_MCP_SERVER_IDS } from '../../../src/shared/apps/builtin-mcp'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')

/** Extract server-id keys whose value is an MCP server instance/factory call */
function extractInjectedServerIds(relPath: string): Set<string> {
  const source = readFileSync(join(repoRoot, relPath), 'utf-8')
  const ids = new Set<string>()
  for (const match of source.matchAll(/'([a-z0-9-]+)':\s*\w*McpServer/g)) {
    ids.add(match[1])
  }
  return ids
}

describe('BUILTIN_MCP_SERVER_IDS', () => {
  const executeIds = extractInjectedServerIds('src/main/apps/runtime/execute.ts')
  const chatIds = extractInjectedServerIds('src/main/apps/runtime/app-chat.ts')
  const runtimeIds = new Set([...executeIds, ...chatIds])

  it('extraction finds the runtime injection sites (guards the regex itself)', () => {
    expect(runtimeIds.size).toBeGreaterThanOrEqual(5)
    expect(runtimeIds.has('halo-memory')).toBe(true)
  })

  it('every runtime-injected built-in server id is in the shared set', () => {
    for (const id of runtimeIds) {
      expect(BUILTIN_MCP_SERVER_IDS.has(id), `runtime injects '${id}' but shared set lacks it`).toBe(true)
    }
  })

  it('every shared id (except the documented alias) is injected by the runtime', () => {
    // 'email' is the permission-name alias for 'halo-email' in requires.mcps
    for (const id of BUILTIN_MCP_SERVER_IDS) {
      if (id === 'email') continue
      expect(runtimeIds.has(id), `shared set declares '${id}' but runtime never injects it`).toBe(true)
    }
  })
})
