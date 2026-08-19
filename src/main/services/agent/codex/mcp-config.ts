/**
 * Render Halo's MCP servers into the `mcp_servers` map codex app-server takes
 * in `thread/start` config.
 *
 * Only the dialect lives here. Telling in-process servers from external ones,
 * normalizing the stored records, and publishing the in-process ones on
 * loopback are engine-neutral and belong to `../mcp/`.
 */

import { SdkMcpBridge } from '../mcp/sdk-bridge'
import { bearerTokenEnvVar, partitionMcpServers } from '../mcp/partition'
import type { ExternalMcpServer } from '../mcp/types'

export interface CodexMcpServerConfig {
  command?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  bearer_token_env_var?: string
}

export interface PreparedCodexMcpServers {
  mcpServers: Record<string, CodexMcpServerConfig>
  /** Owned by the session: alive for as long as the thread that uses it. */
  bridge?: SdkMcpBridge
  injectedServerNames: string[]
  skippedServerNames: string[]
}

export async function prepareCodexMcpServers(
  servers: Record<string, unknown> | undefined,
): Promise<PreparedCodexMcpServers> {
  const { sdk, external, unusable } = partitionMcpServers(servers)

  const mcpServers: Record<string, CodexMcpServerConfig> = {}
  const skippedServerNames = [...unusable]
  for (const [name, server] of Object.entries(external)) {
    const config = toCodexMcpServer(server)
    if (config) mcpServers[name] = config
    else skippedServerNames.push(name)
  }

  let bridge: SdkMcpBridge | undefined
  if (Object.keys(sdk).length > 0) {
    bridge = new SdkMcpBridge(sdk)
    for (const [name, url] of Object.entries(await bridge.start())) {
      mcpServers[name] = { url }
    }
  }

  if (skippedServerNames.length > 0) {
    console.warn(`[Codex][mcp] not injected: ${skippedServerNames.join(', ')}`)
  }

  return {
    mcpServers,
    bridge,
    injectedServerNames: Object.keys(mcpServers),
    skippedServerNames,
  }
}

/**
 * One normalized server in codex's vocabulary, or null when codex cannot reach
 * it. A bearer token is passed by naming the variable that holds it, never
 * inline: codex resolves `bearer_token_env_var` from the child's environment.
 */
export function toCodexMcpServer(server: ExternalMcpServer): CodexMcpServerConfig | null {
  if (server.transport === 'sse') {
    // codex app-server accepts stdio and streamable HTTP. Dialing an SSE
    // endpoint as streamable hangs at the handshake instead of failing.
    return null
  }

  if (server.transport === 'http') {
    const tokenEnvVar = bearerTokenEnvVar(server.headers)
    return { url: server.url, ...(tokenEnvVar ? { bearer_token_env_var: tokenEnvVar } : {}) }
  }

  return {
    command: server.command,
    ...(server.args.length > 0 ? { args: server.args } : {}),
    ...(server.cwd ? { cwd: server.cwd } : {}),
    ...(Object.keys(server.env).length > 0 ? { env: server.env } : {}),
  }
}
