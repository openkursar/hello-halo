/**
 * Render Halo's MCP servers into `@deepseek-ai/dsh-mcp-client` plugin rows.
 *
 * One plugin instance connects one server, so a composition carries one row per
 * server. The client registers each server's tools as
 * `mcp__<serverName>__<rawName>` — already Halo's naming convention, so the
 * event normalizer passes those names through untouched.
 *
 * Nothing a server's configuration contains is written into the row. The
 * composition is a file on disk that outlives the session, and a server's
 * config routinely holds an API token; the bridge URL is worse still, being a
 * port that only means anything for the lifetime of one child. Both travel in
 * the child's environment, and the row names the key that holds them. That also
 * keeps the document a function of the SERVER NAMES alone, which is what lets
 * `materializeCordisConfig` keep addressing files by content digest.
 *
 * `@deepseek-ai/dsh-mcp-client` is pinned to an exact version rather than a
 * range: its peer dependencies name the whole runtime bundle, so a newer
 * patch resolves peers the rest of the tree is not on and the composition
 * fails to load.
 */

import type { ExternalMcpServer } from '../../mcp/types'

/** Environment variable holding the JSON table the rows read from. */
export const DSH_MCP_SERVERS_ENV = 'DSH_MCP_SERVERS'

/**
 * dsh's own per-server config. Field names are the plugin's, not Halo's.
 *
 * `failOnStartupError` is false throughout: a composition that refuses to
 * activate takes the whole runtime with it, so one unreachable MCP server would
 * cost the user their entire session rather than one server's tools.
 */
type DshMcpClientConfig =
  | {
      transport: 'stdio'
      serverName: string
      command: string
      args: string[]
      env: Record<string, string>
      cwd: string
      failOnStartupError: false
    }
  | {
      transport: 'streamable-http'
      serverName: string
      url: string
      headers: Record<string, string>
      failOnStartupError: false
    }

export interface DshMcpComposition {
  /** Rows to append to the composition, one per reachable server. */
  yaml: string
  /** Value for {@link DSH_MCP_SERVERS_ENV}, keyed by the row's `serverName`. */
  env: string
  /** Server names carried into the runtime, in row order. */
  mounted: string[]
  /** Server names dsh cannot reach, with the reason, for the launch log. */
  skipped: { name: string; reason: string }[]
}

export function buildDshMcpComposition(
  servers: Record<string, ExternalMcpServer>,
  fallbackCwd: string,
): DshMcpComposition {
  const configs: Record<string, DshMcpClientConfig> = {}
  const rows: string[] = []
  const skipped: { name: string; reason: string }[] = []

  for (const [name, server] of Object.entries(servers)) {
    const serverName = toServerName(name)
    if (!serverName) {
      skipped.push({ name, reason: 'name is not expressible as a dsh tool namespace' })
      continue
    }
    if (configs[serverName]) {
      // Namespaces must be unique across live instances, and two rows claiming
      // one would make the second plugin fail to activate.
      skipped.push({ name, reason: `namespace "${serverName}" already taken` })
      continue
    }
    const config = toDshMcpClient(server, serverName, fallbackCwd)
    if (!config) {
      skipped.push({ name, reason: 'SSE transport is not supported by the dsh MCP client' })
      continue
    }
    configs[serverName] = config
    // The expression is a double-quoted YAML scalar, so the JS string index
    // must use single quotes. `toServerName` has already excluded every
    // character that would need escaping inside one.
    rows.push(
      `- id: mcp-${serverName}\n` +
        `  name: '@deepseek-ai/dsh-mcp-client'\n` +
        `  config: !!js "JSON.parse(process.env.${DSH_MCP_SERVERS_ENV})['${serverName}']"\n`,
    )
  }

  return {
    yaml: rows.join('\n'),
    env: JSON.stringify(configs),
    mounted: Object.keys(configs),
    skipped,
  }
}

function toDshMcpClient(
  server: ExternalMcpServer,
  serverName: string,
  fallbackCwd: string,
): DshMcpClientConfig | null {
  if (server.transport === 'sse') return null

  if (server.transport === 'http') {
    return {
      transport: 'streamable-http',
      serverName,
      url: server.url,
      headers: server.headers,
      failOnStartupError: false,
    }
  }

  return {
    transport: 'stdio',
    serverName,
    command: server.command,
    args: server.args,
    env: server.env,
    // The plugin requires a working directory; a server that did not declare
    // one inherits the session's, matching where every other tool operates.
    cwd: server.cwd || fallbackCwd,
    failOnStartupError: false,
  }
}

/**
 * Halo's server id in dsh's namespace grammar (`[A-Za-z0-9_-]{1,32}`), or null
 * when nothing recognizable survives.
 *
 * Truncation is not attempted: two long ids sharing a prefix would collapse
 * into one namespace and silently merge two servers' tools.
 */
function toServerName(name: string): string | null {
  return /^[A-Za-z0-9_-]{1,32}$/.test(name) ? name : null
}
