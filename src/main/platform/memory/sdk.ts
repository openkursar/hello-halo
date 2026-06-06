/**
 * Memory SDK provider — dependency-inversion seam for the platform/memory tier.
 *
 * Memory exposes its read/write/list/status tools as an in-process MCP server
 * built with the agent SDK's `tool()` + `createSdkMcpServer()` primitives.
 * Those primitives are engine-resolved at runtime and live in the services
 * tier (`services/agent/resolved-sdk`), which sits ABOVE platform. Importing
 * them directly would invert the `platform <- services` direction.
 *
 * Instead, the wiring layer injects them once at startup via `setMemorySdk`
 * (a downward call from bootstrap). The injected functions are the same
 * resolved-sdk functions and are only invoked lazily when a memory MCP
 * server is built (during agent session setup), long after injection.
 */

type ToolFn = (...args: any[]) => any
type CreateSdkMcpServerFn = (options: any) => any

let _tool: ToolFn | null = null
let _createSdkMcpServer: CreateSdkMcpServerFn | null = null

/** Wire the resolved agent-SDK MCP primitives into the memory tier. */
export function setMemorySdk(sdk: { tool: ToolFn; createSdkMcpServer: CreateSdkMcpServerFn }): void {
  _tool = sdk.tool
  _createSdkMcpServer = sdk.createSdkMcpServer
}

/** Define an MCP tool. Throws if the SDK was not wired (a startup-order bug). */
export function tool(...args: any[]): any {
  if (!_tool) throw new Error('[Memory] SDK not initialized — call setMemorySdk() at startup')
  return _tool(...args)
}

/** Build an in-process MCP server. Throws if the SDK was not wired. */
export function createSdkMcpServer(options: any): any {
  if (!_createSdkMcpServer) throw new Error('[Memory] SDK not initialized — call setMemorySdk() at startup')
  return _createSdkMcpServer(options)
}
