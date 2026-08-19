/**
 * Unit test: services/agent/mcp/sdk-server — the `tool()` / `createSdkMcpServer()`
 * pair every engine without the Claude SDK's own helpers runs on.
 *
 * Halo's entire built-in tool set is constructed through these two functions
 * before the engine is known, so a defect here is not scoped to one tool or one
 * engine: it is every built-in tool, on every engine that uses this
 * implementation. The failure mode that matters is a server that lists a tool
 * it cannot run — the model sees the tool, calls it, and gets an error.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createSdkMcpServer, tool } from '../../../../../src/main/services/agent/mcp/sdk-server'
import { SdkMcpBridge } from '../../../../../src/main/services/agent/mcp/sdk-bridge'

describe('createSdkMcpServer', () => {
  it('runs the handler the tool was declared with', async () => {
    const handler = vi.fn(async () => ({ content: [{ type: 'text', text: 'ran' }] }))
    const server = createSdkMcpServer({
      name: 'memory',
      tools: [tool('remember', 'Store a fact', { fact: z.string() }, handler)],
    })

    const result = await server.instance.callTool('remember', { fact: 'x' })

    expect(handler).toHaveBeenCalledWith({ fact: 'x' }, {})
    expect(result).toEqual({ content: [{ type: 'text', text: 'ran' }] })
  })

  it('returns nothing for a tool it does not have', async () => {
    const server = createSdkMcpServer({ name: 'memory', tools: [] })

    await expect(server.instance.callTool('absent', {})).resolves.toBeUndefined()
  })

  it('translates the declared field schemas into JSON Schema', async () => {
    // Call sites write zod; anything crossing a process boundary needs JSON
    // Schema, and a client rejects a tool whose schema it cannot read.
    const server = createSdkMcpServer({
      name: 'memory',
      tools: [
        tool(
          'search',
          'Search memory',
          { query: z.string(), limit: z.number().optional(), exact: z.boolean() },
          async () => ({ content: [] }),
        ),
      ],
    })

    const [listed] = server.instance.listTools()

    expect(listed.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
        exact: { type: 'boolean' },
      },
    })
    expect((listed.inputSchema as any).required).toEqual(['query', 'exact'])
  })

  it('is callable by a real client through the bridge', async () => {
    // The whole point of the pair: a tool built here, published on loopback,
    // and invoked by an engine in another process.
    const server = createSdkMcpServer({
      name: 'memory',
      tools: [
        tool('remember', 'Store a fact', { fact: z.string() }, async (args) => ({
          content: [{ type: 'text', text: `stored ${args.fact}` }],
        })),
      ],
    })
    const bridge = new SdkMcpBridge({ memory: server.instance })
    const urls = await bridge.start()
    const client = new Client({ name: 'test', version: '1.0.0' })

    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(urls.memory)))
      const result = await client.callTool({ name: 'remember', arguments: { fact: 'halo' } })

      expect(result.content).toEqual([{ type: 'text', text: 'stored halo' }])
    } finally {
      await client.close().catch(() => {})
      await bridge.close()
    }
  })
})
