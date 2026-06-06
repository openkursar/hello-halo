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

/**
 * Broadcast MCP status to all renderers (global, not conversation-specific).
 * When allTools is provided, parses and groups them by server name.
 * When allTools is omitted, preserves previously cached tools (tools don't change within a session).
 */
export function broadcastMcpStatus(
  mcpServers: Array<{ name: string; status: string }>,
  allTools?: string[]
): void {
  // Group tools by server name if provided
  const toolsByServer = allTools ? groupToolsByMcpServer(allTools) : null

  // Build previous tools lookup for cache preservation
  const prevToolsMap = !toolsByServer
    ? new Map(cachedMcpStatus.filter(s => s.tools).map(s => [s.name, s.tools!]))
    : null

  // Convert to our status type, merging tools
  cachedMcpStatus = mcpServers.map(s => {
    const tools = toolsByServer
      ? toolsByServer[s.name]    // new tools from SDK
      : prevToolsMap?.get(s.name) // preserve cached tools
    return {
      name: s.name,
      status: s.status as McpServerStatusInfo['status'],
      ...(tools ? { tools } : {})
    }
  })
  lastMcpStatusUpdate = Date.now()

  const eventData = {
    servers: cachedMcpStatus,
    timestamp: lastMcpStatusUpdate
  }

  // Broadcast to all clients via event emitter
  emitAgentBroadcast('agent:mcp-status', eventData)
  console.log(`[Agent] Broadcast MCP status: ${cachedMcpStatus.length} servers`)
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
    let sdkModel = credentials.model || 'claude-sonnet-4-20250514'

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
