/**
 * Agent Module - MCP Manager
 *
 * Manages MCP (Model Context Protocol) server status including
 * caching, broadcasting, and connection testing.
 */

import { query as claudeQuery } from './resolved-sdk'
import { getConfig, getTempSpacePath } from '../../foundation/config.service'
import { ensureOpenAICompatRouter, encodeBackendConfig } from '../../openai-compat-router'
import type { McpServerStatusInfo } from './types'
import {
  getHeadlessElectronPath,
  getApiCredentials,
  getDbMcpServers,
  inferOpenAIWireApi,
  credentialsToBackendConfig
} from './helpers'
import { emitAgentBroadcast } from './events'
import { getCleanUserEnv } from './sdk-config'
import { resolveModelId } from '../../../shared/types/ai-sources'

// ============================================
// MCP Status Cache
// ============================================

// Cached MCP status - updated when SDK reports status during conversation
let cachedMcpStatus: McpServerStatusInfo[] = []
let lastMcpStatusUpdate: number = 0

/**
 * Get cached MCP status
 */
export function getCachedMcpStatus(): McpServerStatusInfo[] {
  return cachedMcpStatus
}

/**
 * Get last MCP status update timestamp
 */
export function getLastMcpStatusUpdate(): number {
  return lastMcpStatusUpdate
}

// ============================================
// MCP Tool Grouping
// ============================================

/**
 * Group flat tool names by MCP server.
 * Tool name convention: "mcp__{server-name}__{tool-name}"
 * Built-in tools (no "mcp__" prefix) are ignored.
 *
 * @returns Record mapping server name to array of short tool names
 */
export function groupToolsByMcpServer(tools: string[]): Record<string, string[]> {
  const MCP_PREFIX = 'mcp__'
  const grouped: Record<string, string[]> = {}
  for (const tool of tools) {
    if (!tool.startsWith(MCP_PREFIX)) continue
    const rest = tool.slice(MCP_PREFIX.length)
    const sepIdx = rest.indexOf('__')
    if (sepIdx <= 0) continue
    const serverName = rest.slice(0, sepIdx)
    const toolName = rest.slice(sepIdx + 2)
    if (!toolName) continue
    if (!grouped[serverName]) grouped[serverName] = []
    grouped[serverName].push(toolName)
  }
  return grouped
}

// ============================================
// MCP Status Broadcasting
// ============================================

/** Emit the current cache to all clients (desktop IPC + remote WebSocket). */
function emitMcpStatusBroadcast(): void {
  lastMcpStatusUpdate = Date.now()
  emitAgentBroadcast('agent:mcp-status', {
    servers: cachedMcpStatus,
    timestamp: lastMcpStatusUpdate
  })
  console.log(`[Agent] Broadcast MCP status: ${cachedMcpStatus.length} servers`)
}

/**
 * Broadcast MCP status to all renderers (global, not conversation-specific).
 * When allTools is provided, parses and groups them by server name.
 * When allTools is omitted, preserves previously cached tools (tools don't change within a session).
 *
 * Upsert semantics: a session init only reports the servers configured for
 * that session's space, so entries produced elsewhere (probe results,
 * other spaces' servers) must survive the merge. Removal is owned by the
 * app-lifecycle listener (pause/uninstall) via removeServerStatus().
 */
export function broadcastMcpStatus(
  mcpServers: Array<{ name: string; status: string }>,
  allTools?: string[]
): void {
  // Group tools by server name if provided
  const toolsByServer = allTools ? groupToolsByMcpServer(allTools) : null
  const now = Date.now()

  const byName = new Map(cachedMcpStatus.map(s => [s.name, s]))
  for (const s of mcpServers) {
    const prev = byName.get(s.name)
    const status = s.status as McpServerStatusInfo['status']
    const tools = toolsByServer
      ? toolsByServer[s.name]    // new tools from SDK
      : prev?.tools              // preserve cached tools
    byName.set(s.name, {
      name: s.name,
      status,
      ...(tools ? { tools } : {}),
      // SDK reports no failure reason — keep the last probe detail so the
      // UI is not blanked out; a fresh probe will refresh or clear it.
      ...(status !== 'connected' && prev?.errorDetail ? { errorDetail: prev.errorDetail } : {}),
      lastCheckedAt: now
    })
  }
  cachedMcpStatus = [...byName.values()]

  emitMcpStatusBroadcast()
}

/**
 * Upsert a single server's status (probe results) and broadcast.
 */
export function updateServerStatus(
  name: string,
  patch: Omit<McpServerStatusInfo, 'name'>
): void {
  const idx = cachedMcpStatus.findIndex(s => s.name === name)
  const entry: McpServerStatusInfo = { name, ...patch }
  if (idx >= 0) cachedMcpStatus[idx] = entry
  else cachedMcpStatus.push(entry)

  emitMcpStatusBroadcast()
}

/**
 * Drop a server from the status cache (paused/uninstalled app) and broadcast.
 * Prevents stale "connection error" from surviving a reinstall.
 */
export function removeServerStatus(name: string): void {
  const next = cachedMcpStatus.filter(s => s.name !== name)
  if (next.length === cachedMcpStatus.length) return
  cachedMcpStatus = next

  emitMcpStatusBroadcast()
}

// ============================================
// MCP Connection Testing
// ============================================

// Test MCP connections flag to prevent concurrent tests
let mcpTestInProgress = false

/**
 * Test MCP connections manually
 * Starts a temporary SDK query just to get MCP status
 */
export async function testMcpConnections(): Promise<{ success: boolean; servers: McpServerStatusInfo[]; error?: string }> {
  if (mcpTestInProgress) {
    return { success: false, servers: cachedMcpStatus, error: 'Test already in progress' }
  }

  mcpTestInProgress = true
  console.log('[Agent] Starting MCP connection test...')

  try {
    const config = getConfig()

    // Get API credentials based on current aiSources configuration
    const credentials = await getApiCredentials(config)
    if (!credentials.apiKey && credentials.provider !== 'oauth') {
      return { success: false, servers: [], error: 'API key not configured' }
    }

    // Get MCP servers from installed apps database (global scope for testing)
    // Use halo-temp as the space context since testMcpConnections has no explicit space
    const enabledMcpServers = getDbMcpServers('halo-temp')
    if (!enabledMcpServers || Object.keys(enabledMcpServers).length === 0) {
      return { success: true, servers: [], error: 'No MCP servers configured' }
    }

    console.log('[Agent] MCP servers to test:', Object.keys(enabledMcpServers).join(', '))

    // Use a temp space path for the query
    const cwd = getTempSpacePath()

    // Use the same electron path as sendMessage (prevents Dock icon on macOS)
    const electronPath = getHeadlessElectronPath()

    // Route through OpenAI compat router for non-Anthropic providers
    let anthropicBaseUrl = credentials.baseUrl
    let anthropicApiKey = credentials.apiKey
    let sdkModel = resolveModelId(credentials.model)

    // For non-Anthropic providers (openai or oauth), use the OpenAI compat router
    if (credentials.provider !== 'anthropic') {
      const router = await ensureOpenAICompatRouter({ debug: false })
      anthropicBaseUrl = router.baseUrl

      // Use apiType from credentials (set by provider), fallback to inference
      const apiType = credentials.apiType
        || (credentials.provider === 'oauth' ? 'chat_completions' : inferOpenAIWireApi(credentials.baseUrl))

      anthropicApiKey = encodeBackendConfig(credentialsToBackendConfig(credentials, { apiType }))
      console.log(`[Agent] MCP test: ${credentials.provider} provider enabled via ${anthropicBaseUrl}, apiType=${apiType}`)
    }

    console.log('[Agent] MCP test config:', JSON.stringify(enabledMcpServers, null, 2))

    // Create query with proper configuration (matching sendMessage)
    // Use a simple prompt that will get a quick response
    const abortController = new AbortController()
    const queryIterator = claudeQuery({
      prompt: 'hi', // Simple prompt to trigger MCP connection
      options: {
        apiKey: anthropicApiKey,
        model: sdkModel,
        anthropicBaseUrl,
        cwd,
        executable: electronPath,
        executableArgs: ['--no-warnings'],
        env: {
          ...getCleanUserEnv(),
          ELECTRON_RUN_AS_NODE: '1',
          ELECTRON_NO_ATTACH_CONSOLE: '1',
          ANTHROPIC_API_KEY: anthropicApiKey,
          ANTHROPIC_BASE_URL: anthropicBaseUrl,
          NO_PROXY: 'localhost,127.0.0.1',
          no_proxy: 'localhost,127.0.0.1',
          // Disable unnecessary API requests
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_TELEMETRY: '1',
          DISABLE_COST_WARNINGS: '1'
        },
        permissionMode: 'bypassPermissions',
        abortController,
        mcpServers: enabledMcpServers,
        maxTurns: 1  // Only need one turn to get MCP status
      } as any
    })

    // Iterate through messages looking for system message with MCP status
    let foundStatus = false
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => {
        abortController.abort()
        reject(new Error('MCP test timeout'))
      }, 30000) // 30s timeout
    })

    const iteratePromise = (async () => {
      for await (const msg of queryIterator) {
        console.log('[Agent] MCP test received msg type:', msg.type)

        // Check for system message which contains MCP status
        if (msg.type === 'system') {
          const mcpServers = (msg as any).mcp_servers as Array<{ name: string; status: string }> | undefined
          console.log('[Agent] MCP test mcp_servers field:', mcpServers)

          if (mcpServers) {
            console.log('[Agent] MCP test got status:', JSON.stringify(mcpServers))
            broadcastMcpStatus(mcpServers)
            foundStatus = true
          }
          // After getting system message with MCP status, abort to save resources
          abortController.abort()
          break
        }

        // If we get a result before system message, something is wrong
        if (msg.type === 'result') {
          break
        }
      }
    })()

    try {
      await Promise.race([iteratePromise, timeoutPromise])
    } catch (e) {
      // Ignore abort errors, they're expected
      if ((e as Error).name !== 'AbortError') {
        throw e
      }
    }

    if (foundStatus) {
      return { success: true, servers: cachedMcpStatus }
    } else {
      return { success: true, servers: [], error: 'No MCP status received from SDK' }
    }
  } catch (error) {
    const err = error as Error
    console.error('[Agent] MCP test error:', err)
    return { success: false, servers: cachedMcpStatus, error: err.message }
  } finally {
    mcpTestInProgress = false
  }
}

/**
 * Check if MCP test is currently in progress
 */
export function isMcpTestInProgress(): boolean {
  return mcpTestInProgress
}
