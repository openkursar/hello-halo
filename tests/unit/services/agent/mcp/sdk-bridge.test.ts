/**
 * Unit test: the localhost MCP bridge that carries Halo's in-process tools
 * across a process boundary.
 *
 * Every engine that runs in a child process reaches Halo's built-in tools —
 * AI Browser, memory, web search, the Apps surface — only through this bridge.
 * A regression here does not degrade a feature, it removes the entire built-in
 * tool set from that engine with no error at the call site: the model simply
 * never sees the tools.
 *
 * The assertions therefore drive a real MCP client over real HTTP rather than
 * calling the instance directly, because what has to hold is the wire contract,
 * not the delegation.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SdkMcpBridge } from '../../../../../src/main/services/agent/mcp/sdk-bridge'
import type { SdkMcpServerInstance } from '../../../../../src/main/services/agent/mcp/types'

const bridges: SdkMcpBridge[] = []
const clients: Client[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {})
  for (const bridge of bridges.splice(0)) await bridge.close().catch(() => {})
})

function stubInstance(overrides: Partial<SdkMcpServerInstance> = {}): SdkMcpServerInstance {
  return {
    name: 'stub',
    version: '1.0.0',
    listTools: () => [
      {
        name: 'echo',
        description: 'Echo the input back',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
      },
    ],
    callTool: async (_name, args) => ({ content: [{ type: 'text', text: String(args.text) }] }),
    ...overrides,
  }
}

async function connect(bridge: SdkMcpBridge, url: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  clients.push(client)
  return client
}

async function start(servers: Record<string, SdkMcpServerInstance>): Promise<Record<string, string>> {
  const bridge = new SdkMcpBridge(servers)
  bridges.push(bridge)
  return bridge.start()
}

describe('SdkMcpBridge', () => {
  it('serves each server on its own loopback URL', async () => {
    const urls = await start({ memory: stubInstance(), 'web-search': stubInstance() })

    expect(Object.keys(urls).sort()).toEqual(['memory', 'web-search'])
    for (const url of Object.values(urls)) {
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\//)
    }
  })

  it('publishes the instance tool list over the wire', async () => {
    const urls = await start({ memory: stubInstance() })
    const client = await connect(bridges[0], urls.memory)

    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name)).toEqual(['echo'])
    expect(tools[0].inputSchema).toEqual({
      type: 'object',
      properties: { text: { type: 'string' } },
    })
  })

  it('routes a call to the instance that owns the name', async () => {
    const memory = vi.fn(async () => ({ content: [{ type: 'text', text: 'from memory' }] }))
    const search = vi.fn(async () => ({ content: [{ type: 'text', text: 'from search' }] }))
    const urls = await start({
      memory: stubInstance({ callTool: memory }),
      'web-search': stubInstance({ callTool: search }),
    })

    const client = await connect(bridges[0], urls['web-search'])
    const result = await client.callTool({ name: 'echo', arguments: { text: 'hi' } })

    expect(search).toHaveBeenCalledWith('echo', { text: 'hi' })
    expect(memory).not.toHaveBeenCalled()
    expect(result.content).toEqual([{ type: 'text', text: 'from search' }])
  })

  it('wraps a bare return value in MCP content instead of dropping it', async () => {
    // Halo's in-process tools predate this bridge and several return a plain
    // string or object. Passing one through unwrapped yields a result the
    // client rejects, which surfaces as a tool that always fails.
    const urls = await start({ memory: stubInstance({ callTool: async () => 'plain string' as any }) })
    const client = await connect(bridges[0], urls.memory)

    const result = await client.callTool({ name: 'echo', arguments: {} })

    expect(result.content).toEqual([{ type: 'text', text: 'plain string' }])
  })

  it('reports an undefined result as an error rather than an empty success', async () => {
    const urls = await start({ memory: stubInstance({ callTool: async () => undefined }) })
    const client = await connect(bridges[0], urls.memory)

    const result = await client.callTool({ name: 'echo', arguments: {} })

    expect(result.isError).toBe(true)
  })

  it('substitutes an open schema for a tool that declares none', async () => {
    // The MCP client rejects a tool whose inputSchema is not an object, and one
    // malformed tool would fail the whole listTools call for its server.
    const urls = await start({
      memory: stubInstance({
        listTools: () => [{ name: 'no-schema', description: 'x' }],
      }),
    })
    const client = await connect(bridges[0], urls.memory)

    const { tools } = await client.listTools()

    expect(tools[0].inputSchema.type).toBe('object')
  })

  it('answers an unknown server name with 404 rather than another server', async () => {
    const urls = await start({ memory: stubInstance() })
    const base = urls.memory.slice(0, urls.memory.lastIndexOf('/'))

    const response = await fetch(`${base}/not-installed`, { method: 'POST' })

    expect(response.status).toBe(404)
  })

  it('stops listening once closed', async () => {
    const urls = await start({ memory: stubInstance() })
    await bridges[0].close()

    await expect(fetch(urls.memory, { method: 'POST' })).rejects.toThrow()
  })

  it('is idempotent on start so a retried session does not leak a second listener', async () => {
    const bridge = new SdkMcpBridge({ memory: stubInstance() })
    bridges.push(bridge)

    expect(await bridge.start()).toEqual(await bridge.start())
  })
})

/**
 * An engine's MCP client dials after its runtime already answers as ready, so
 * a turn started at that moment goes out before the tools exist. This wait is
 * the only evidence Halo has that discovery happened; resolving it early is
 * indistinguishable from not having it, and the failure is silent — a first
 * turn missing every built-in tool.
 */
describe('SdkMcpBridge.whenDialled', () => {
  it('returns immediately when there is nothing to wait for', async () => {
    const bridge = new SdkMcpBridge({})
    bridges.push(bridge)
    await bridge.start()

    await expect(bridge.whenDialled(50)).resolves.toBeUndefined()
  })

  it('waits for the catalogue to be read, not merely for a connection', async () => {
    const urls = await start({ memory: stubInstance() })
    const client = new Client({ name: 'test', version: '1.0.0' })
    clients.push(client)

    let settled = false
    void bridges[0].whenDialled(5000).then(() => { settled = true })

    // Connecting performs the MCP handshake but reads no tools.
    await client.connect(new StreamableHTTPClientTransport(new URL(urls.memory)))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(settled, 'settled on connection alone').toBe(false)

    await client.listTools()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(settled).toBe(true)
  })

  it('waits for every server, not just the first', async () => {
    const urls = await start({ memory: stubInstance(), 'web-search': stubInstance() })

    let settled = false
    void bridges[0].whenDialled(5000).then(() => { settled = true })

    const first = await connect(bridges[0], urls.memory)
    await first.listTools()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(settled).toBe(false)

    const second = await connect(bridges[0], urls['web-search'])
    await second.listTools()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(settled).toBe(true)
  })

  it('gives up after the timeout rather than stranding the session', async () => {
    // A runtime that never dials must cost one bounded wait, not the session.
    await start({ memory: stubInstance() })

    const startedAt = Date.now()
    await bridges[0].whenDialled(100)

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(90)
  })
})
