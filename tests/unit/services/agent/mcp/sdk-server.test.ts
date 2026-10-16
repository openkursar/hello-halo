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

  it('serves a tool with no input fields', async () => {
    const handler = vi.fn(async () => ({ content: [] }))
    const server = createSdkMcpServer({ name: 'team', tools: [tool('list', 'List teams', {}, handler)] })
    expect(server.instance.listTools()[0].inputSchema).toMatchObject({ type: 'object', properties: {} })
    await server.instance.callTool('list', {})
    expect(handler).toHaveBeenCalledWith({}, {})
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

  it('preserves nested object and array constraints, descriptions, enums and optional fields', () => {
    const server = createSdkMcpServer({ name: 'team', tools: [tool('assemble', 'Assemble', {
      members: z.array(z.object({
        name: z.string().min(1).describe('Member handle'),
        role: z.enum(['reviewer', 'writer']),
        metadata: z.object({ tags: z.array(z.string()).optional() }).optional(),
        priority: z.number().int().min(1).max(5).default(2),
        note: z.string().nullable().optional(),
      })).min(1).max(3),
    }, async () => ({ content: [] }))] })
    expect(server.instance.listTools()[0].inputSchema).toMatchObject({
      type: 'object', required: ['members'], properties: { members: {
        type: 'array', minItems: 1, maxItems: 3, items: {
          type: 'object', required: ['name', 'role'], additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, description: 'Member handle' },
            role: { type: 'string', enum: ['reviewer', 'writer'] },
            metadata: { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } },
            priority: { type: 'integer', minimum: 1, maximum: 5, default: 2 },
            note: { type: ['string', 'null'] },
          },
        },
      } },
    })
  })

  it('validates nested arguments before handlers and applies defaults and transforms', async () => {
    const handler = vi.fn(async () => ({ content: [] }))
    const server = createSdkMcpServer({ name: 'team', tools: [tool('assemble', 'Assemble', {
      members: z.array(z.object({ responsibility: z.string().min(1).transform(value => value.trim()) })).min(1),
      wait: z.boolean().default(false),
    }, handler)] })
    const invalid = await server.instance.callTool('assemble', { members: [{}] }) as { isError: boolean; content: Array<{ text: string }> }
    expect(invalid.isError).toBe(true)
    expect(invalid.content[0].text).toContain('responsibility')
    expect(handler).not.toHaveBeenCalled()
    await server.instance.callTool('assemble', { members: [{ responsibility: '  Review concurrency  ' }] })
    expect(handler).toHaveBeenCalledWith({ members: [{ responsibility: 'Review concurrency' }], wait: false }, {})
  })
})
