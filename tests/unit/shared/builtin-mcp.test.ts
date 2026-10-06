/**
 * Drift guard for shared/apps/builtin-mcp.
 *
 * BUILTIN_MCP_SERVER_IDS mirrors the mcpServers literals in
 * apps/runtime/execute.ts and app-chat.ts plus the base toolset
 * (services/agent/toolsets/base.ts) by convention (a comment) — nothing
 * enforces it at runtime because the runtime builds servers conditionally.
 * This test scans those sources for `'<id>': <factory>McpServer` keys and
 * fails when either side drifts, which would make the renderer's dependency
 * panel misclassify a built-in capability as an uninstalled MCP app.
 *
 * Which entry gets which server is not this test's job — that is pinned by
 * tests/unit/services/agent/entry-capability-matrix.test.ts.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { BUILTIN_MCP_SERVER_IDS } from '../../../src/shared/apps/builtin-mcp'
import { BASE_SERVER_IDS } from '../../../src/main/services/agent/toolsets/base'
import { findMatches, listSourceFiles } from '../architecture/lib/source-scan'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')

/** Extract server-id keys whose value is an MCP server instance/factory call */
function extractInjectedServerIds(relPath: string): Set<string> {
  const source = readFileSync(join(repoRoot, relPath), 'utf-8')
  const ids = new Set<string>()
  for (const match of source.matchAll(/'([a-z0-9-]+)':\s*(?:await\s+)?\w*McpServer/g)) {
    ids.add(match[1])
  }
  return ids
}

describe('BUILTIN_MCP_SERVER_IDS', () => {
  const executeIds = extractInjectedServerIds('src/main/apps/runtime/execute.ts')
  const chatIds = extractInjectedServerIds('src/main/apps/runtime/app-chat.ts')
  // The base toolset is assembled once and spread into each entry's record.
  const runtimeIds = new Set([...executeIds, ...chatIds, ...BASE_SERVER_IDS])

  it('extraction finds the runtime injection sites (guards the regex itself)', () => {
    expect(runtimeIds.size).toBeGreaterThanOrEqual(5)
    expect(runtimeIds.has('halo-report')).toBe(true)
    expect(runtimeIds.has('halo-memory')).toBe(false)
    expect(BUILTIN_MCP_SERVER_IDS.has('halo-memory')).toBe(false)
  })

  it('keeps the retired memory tool, SDK injection seam and live roster out of production sources', () => {
    const files = [...listSourceFiles('src/main'), ...listSourceFiles('src/shared')]
    const retired = /\b(?:memory_status|createMemoryStatusMcpServer|setMemorySdk|listLiveInstances|buildLiveInstancesSection|noteInstanceTurnStarted|noteInstanceTurnEnded)\b|['"]halo-memory['"]/
    expect(findMatches(files, retired)).toEqual([])
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
