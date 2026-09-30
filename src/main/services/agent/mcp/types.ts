/**
 * The two shapes Halo's `mcpServers` option actually holds, named so engine
 * adapters can stop re-deriving them.
 *
 * Halo assembles that option from two unrelated sources: `createSdkMcpServer()`
 * descriptors built in this process (AI Browser, memory, web search, the Apps
 * surface), and records for servers the user installed, which are configuration
 * only. In-process engines consume both directly. Every out-of-process engine
 * has to tell them apart, because only the second kind can be handed to a child
 * as-is — the first has no existence outside Halo's heap.
 */

export interface SdkMcpToolDescriptor {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  annotations?: Record<string, unknown>
}

/** One `tool()` result: what the model is told, plus what actually runs. */
export interface SdkMcpToolDefinition {
  name: string
  description: string
  /** As written at the call site — a record of zod-like field schemas. */
  inputSchema: Record<string, any>
  annotations?: Record<string, unknown>
  _meta?: Record<string, unknown>
  handler: (args: any, extra: unknown) => Promise<any>
}

/** The callable half of a `createSdkMcpServer()` result. */
export interface SdkMcpServerInstance {
  readonly name?: string
  readonly version?: string
  listTools(): SdkMcpToolDescriptor[]
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>
}

/** The shape Halo puts in `sdkOptions.mcpServers` for an in-process server. */
export interface SdkMcpServerConfig {
  type: 'sdk'
  name: string
  instance: SdkMcpServerInstance
}

export interface StdioMcpServer {
  transport: 'stdio'
  command: string
  args: string[]
  cwd?: string
  env: Record<string, string>
}

export interface HttpMcpServer {
  transport: 'http'
  url: string
  headers: Record<string, string>
}

export interface SseMcpServer {
  transport: 'sse'
  url: string
  headers: Record<string, string>
}

/**
 * A server that exists independently of Halo, in the vocabulary every engine
 * can render into its own configuration dialect.
 *
 * `sse` is a member of its own rather than a second spelling of `http`: no
 * engine Halo ships speaks SSE, and collapsing the two would have each adapter
 * dial an SSE endpoint as if it were streamable — a connection that hangs at
 * the handshake instead of failing. Keeping it separate forces every renderer
 * to say what it does with one.
 */
export type ExternalMcpServer = StdioMcpServer | HttpMcpServer | SseMcpServer
