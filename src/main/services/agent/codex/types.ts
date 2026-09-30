/**
 * Shared types for the Codex engine adapter.
 *
 * The protocol-level types (thread events / items / notifications) live in
 * `./types/codex-protocol.ts` and `./types/jsonrpc.ts`. This file holds only
 * the Halo-facing facade type. The in-process MCP server types are engine
 * neutral and live in `../mcp/types.ts`.
 */

import type { EngineCapabilities } from '../capabilities'

export interface CodexSdkModule {
  tool: (...args: any[]) => any
  createSdkMcpServer: (options: any) => any
  createSession: (options: Record<string, any>) => Promise<any>
  query: (params: any) => AsyncIterable<any>
  /** Engine capability descriptor consumed by the IPC capabilities channel. */
  capabilities: EngineCapabilities
}
