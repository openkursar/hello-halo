/**
 * Toolset Broker - Registry
 *
 * Central catalog of on-demand toolsets. Adding a new toolset:
 *   1. Implement its MCP server (in-process SDK server) under services/.
 *   2. Add one ToolsetDefinition entry here.
 * Everything else (meta tools, capability index, renderer menu, persistence)
 * derives from this registry.
 */

import { createAIBrowserMcpServer, AI_BROWSER_SYSTEM_PROMPT } from '../../ai-browser'
import {
  createTerminalMcpServer,
  getGlobalTerminalContext,
  isTerminalAvailable,
  AI_TERMINAL_SYSTEM_PROMPT
} from '../../ai-terminal'
import type { ToolsetDefinition, ToolsetScope } from './types'

const definitions: ToolsetDefinition[] = []

/** Register a toolset. Called at module init (below) and by feature modules. */
export function registerToolset(def: ToolsetDefinition): void {
  if (definitions.some(d => d.id === def.id)) {
    console.warn(`[Toolsets] Duplicate toolset registration ignored: ${def.id}`)
    return
  }
  definitions.push(def)
  console.log(`[Toolsets] Registered toolset: ${def.id} (available=${def.isAvailable()})`)
}

/** All registered toolsets that are available on this platform */
export function getAvailableToolsets(): ToolsetDefinition[] {
  return definitions.filter(d => d.isAvailable())
}

/** Look up an available toolset by id */
export function getToolset(id: string): ToolsetDefinition | undefined {
  return definitions.find(d => d.id === id && d.isAvailable())
}

// ============================================
// Built-in registrations
// ============================================

registerToolset({
  id: 'ai-browser',
  displayName: 'Web Control',
  summary: 'Control an embedded real browser: navigate pages, click/fill/snapshot, run scripts, inspect network.',
  usageGuide: AI_BROWSER_SYSTEM_PROMPT,
  isAvailable: () => true,
  createServer: (scope: ToolsetScope) => createAIBrowserMcpServer(undefined, scope.workDir)
})

registerToolset({
  id: 'ai-terminal',
  displayName: 'Terminal',
  summary: 'Interactive terminals: run commands, SSH into remote hosts, drive REPLs, and background long-running tasks.',
  usageGuide: AI_TERMINAL_SYSTEM_PROMPT,
  isAvailable: isTerminalAvailable,
  createServer: (scope: ToolsetScope) =>
    createTerminalMcpServer(getGlobalTerminalContext(scope.workDir), {
      spaceId: scope.spaceId,
      workDir: scope.workDir
    })
})
