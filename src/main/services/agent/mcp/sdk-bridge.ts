/**
 * Publish Halo's in-process MCP servers on loopback so a child process can call
 * them.
 *
 * An out-of-process engine cannot reach a `createSdkMcpServer()` instance: the
 * tool bodies close over Halo's heap, and no engine Halo ships opens a
 * request channel back from the child. Inverting the direction is what makes
 * them reachable — Halo becomes the MCP server, the engine's own MCP client
 * dials in, and the engine needs to understand nothing beyond a URL.
 *
 * One bridge instance belongs to one session and is closed with it. The
 * listener binds to 127.0.0.1 on an ephemeral port and is never advertised
 * anywhere but into that session's child process.
 */

import http, { type IncomingMessage, type ServerResponse } from 'http'
import { AddressInfo } from 'net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js'
import type { SdkMcpServerInstance } from './types'

export class SdkMcpBridge {
  private server: http.Server | null = null
  private port: number | null = null
  private readonly dialled = new Set<string>()
  private readonly dialWaiters: Array<() => void> = []

  constructor(private readonly instances: Record<string, SdkMcpServerInstance>) {}

  /** Start listening and return the URL for each server, keyed by name. */
  async start(): Promise<Record<string, string>> {
    if (this.server && this.port) return this.urls()

    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res).catch((err) => {
        console.error('[Agent][mcp] bridge request failed:', err)
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
        res.end('MCP bridge request failed')
      })
    })

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(0, '127.0.0.1', () => resolve())
    })

    this.port = (this.server.address() as AddressInfo).port
    console.log(
      `[Agent][mcp] SDK MCP bridge listening on 127.0.0.1:${this.port} ` +
        `for [${Object.keys(this.instances).join(', ')}]`,
    )
    return this.urls()
  }

  /**
   * Resolve once every published server has been contacted, or when `timeoutMs`
   * elapses.
   *
   * An engine's MCP client dials after its runtime is already answering, so a
   * turn started the moment the runtime says it is ready can go out before the
   * tools exist. This is the only evidence Halo has that the connection
   * happened; the dial is a loopback request to a server Halo itself is
   * running, so in practice it arrives in milliseconds and the timeout is a
   * bound on a runtime that never dials at all, not a delay anyone waits out.
   *
   * Servers the engine connects to directly are outside this signal — nothing
   * about them passes through Halo.
   */
  async whenDialled(timeoutMs = 2000): Promise<void> {
    if (this.allDialled()) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        console.warn(
          `[Agent][mcp] bridge not dialled within ${timeoutMs}ms by ` +
            `[${Object.keys(this.instances).filter((name) => !this.dialled.has(name)).join(', ')}]`,
        )
        finish()
      }, timeoutMs)
      const finish = (): void => {
        clearTimeout(timer)
        const index = this.dialWaiters.indexOf(check)
        if (index >= 0) this.dialWaiters.splice(index, 1)
        resolve()
      }
      const check = (): void => {
        if (this.allDialled()) finish()
      }
      this.dialWaiters.push(check)
    })
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = null
    this.port = null
    if (!server) return
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private allDialled(): boolean {
    return Object.keys(this.instances).every((name) => this.dialled.has(name))
  }

  private markDialled(name: string): void {
    if (this.dialled.has(name)) return
    this.dialled.add(name)
    for (const waiter of [...this.dialWaiters]) waiter()
  }

  private urls(): Record<string, string> {
    return Object.fromEntries(
      Object.keys(this.instances).map((name) => [
        name,
        `http://127.0.0.1:${this.port}/mcp/${encodeURIComponent(name)}`,
      ]),
    )
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const name = decodeURIComponent((req.url || '').split('?')[0].replace(/^\/mcp\//, ''))
    const instance = this.instances[name]
    if (!instance) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('Unknown MCP server')
      return
    }

    // Discovery, not the connection, is what `whenDialled` waits for: a client
    // that has connected but not yet read the catalogue has registered nothing
    // its model can call. The flag is raised when the response is on the wire,
    // not when the handler runs, so the wait ends no earlier than the answer.
    let servedCatalogue = false
    const mcpServer = createMcpServerForInstance(name, instance, () => { servedCatalogue = true })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    await mcpServer.connect(transport)
    res.on('close', () => {
      void mcpServer.close().catch(() => {})
    })
    res.on('finish', () => {
      if (servedCatalogue) this.markDialled(name)
    })
    await transport.handleRequest(req, res)
  }
}

function createMcpServerForInstance(
  name: string,
  instance: SdkMcpServerInstance,
  onToolsListed: () => void,
): Server {
  const server = new Server(
    { name, version: instance.version || '1.0.0' },
    { capabilities: { tools: { listChanged: false } } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    onToolsListed()
    return {
      tools: instance.listTools().map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: normalizeJsonSchema(tool.inputSchema),
        annotations: tool.annotations as any,
      })),
    }
  })

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const result = await instance.callTool(request.params.name, request.params.arguments || {})
    return normalizeToolResult(result)
  })

  return server
}

/**
 * Halo's in-process tools predate MCP and several return a bare string or
 * object. A client rejects a result that is not MCP content, so a tool that
 * works in the default engine would fail on every call through the bridge.
 */
function normalizeToolResult(result: unknown): CallToolResult {
  if (result && typeof result === 'object' && Array.isArray((result as any).content)) {
    return result as CallToolResult
  }
  if (result === undefined) {
    return { content: [{ type: 'text', text: 'Tool returned no result.' }], isError: true }
  }
  return {
    content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }],
  }
}

/** A tool with no declared schema would fail validation for its whole server. */
function normalizeJsonSchema(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === 'object') return schema as Record<string, unknown>
  return { type: 'object', properties: {}, additionalProperties: true }
}
