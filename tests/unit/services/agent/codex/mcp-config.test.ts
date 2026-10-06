/**
 * Unit test: services/agent/codex — Halo's MCP server records rendered into the
 * dialect codex app-server accepts.
 *
 * Codex reads `mcp_servers` from `thread/start` config and takes a bearer token
 * only by naming the environment variable that holds it, never inline. A server
 * this renderer silently drops is a tool set the user installed and never sees,
 * so the cases that produce no config are asserted as deliberately as the ones
 * that do.
 */

import { describe, expect, it } from 'vitest'
import {
  prepareCodexMcpServers,
  toCodexMcpServer,
} from '../../../../../src/main/services/agent/codex/mcp-config'
import { normalizeExternalMcpServer } from '../../../../../src/main/services/agent/mcp/partition'

/** Halo's stored record → normalized → codex dialect, the way a session does it. */
function render(server: unknown): unknown {
  const normalized = normalizeExternalMcpServer(server)
  return normalized ? toCodexMcpServer(normalized) : null
}

describe('toCodexMcpServer', () => {
  it('passes a stdio server through with its spawn arguments', () => {
    expect(
      render({ command: 'npx', args: ['-y', 'server'], cwd: '/w', env: { TOKEN: 'secret' } }),
    ).toEqual({ command: 'npx', args: ['-y', 'server'], cwd: '/w', env: { TOKEN: 'secret' } })
  })

  it('keeps a streamable-http server as a URL', () => {
    expect(render({ type: 'http', url: 'https://example.com/mcp' })).toEqual({
      url: 'https://example.com/mcp',
    })
  })

  it('treats an http(s) command as the URL it is', () => {
    // Halo stores the endpoint in `command` for remote transports, so a record
    // that reaches here without an explicit `type` still has to route by shape.
    expect(render({ command: 'https://example.com/mcp' })).toEqual({
      url: 'https://example.com/mcp',
    })
  })

  it('names the environment variable holding a bearer token instead of inlining it', () => {
    expect(
      render({
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer ${MY_TOKEN}' },
      }),
    ).toEqual({ url: 'https://example.com/mcp', bearer_token_env_var: 'MY_TOKEN' })
  })

  it('drops an SSE server rather than dialing it with the wrong transport', () => {
    // codex app-server speaks stdio and streamable HTTP only. Handing it an SSE
    // endpoint as if it were streamable produces a connection that never
    // completes a handshake.
    expect(render({ type: 'sse', url: 'https://example.com/sse' })).toBeNull()
  })

  it('drops a record with neither a command nor a URL', () => {
    expect(render({ env: { A: '1' } })).toBeNull()
  })
})

describe('prepareCodexMcpServers', () => {
  it('gives an in-process server a loopback URL alongside the external ones', async () => {
    const prepared = await prepareCodexMcpServers({
      'ai-browser': {
        type: 'sdk',
        instance: { listTools: () => [], callTool: async () => undefined },
      },
      filesystem: { command: 'npx', args: ['-y', 'fs-server'] },
    })

    try {
      expect(prepared.mcpServers['ai-browser'].url).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/mcp\/ai-browser$/,
      )
      expect(prepared.mcpServers.filesystem).toEqual({ command: 'npx', args: ['-y', 'fs-server'] })
      expect(prepared.injectedServerNames.sort()).toEqual(['ai-browser', 'filesystem'])
    } finally {
      await prepared.bridge?.close()
    }
  })

  it('starts no listener when every server is external', async () => {
    // The bridge is a live socket for the length of a session; opening one that
    // serves nothing is a resource leak per conversation.
    const prepared = await prepareCodexMcpServers({ filesystem: { command: 'server' } })

    expect(prepared.bridge).toBeUndefined()
  })

  it('leaves out the tools turned off on a server card, for that server only', async () => {
    const prepared = await prepareCodexMcpServers(
      { gateway: { command: 'gateway' }, filesystem: { command: 'server' } },
      { gateway: ['drop_table'], uninstalled: ['x'] },
    )

    expect(prepared.mcpServers).toEqual({
      gateway: { command: 'gateway', disabled_tools: ['drop_table'] },
      filesystem: { command: 'server' },
    })
  })

  it('names the servers it could not inject', async () => {
    const prepared = await prepareCodexMcpServers({
      legacy: { type: 'sse', url: 'https://example.com/sse' },
      broken: {},
    })

    expect(prepared.skippedServerNames.sort()).toEqual(['broken', 'legacy'])
    expect(prepared.injectedServerNames).toEqual([])
  })
})
