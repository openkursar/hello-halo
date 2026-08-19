/**
 * Shared types for the DeepSeek Harness (dsh) engine adapter.
 *
 * dsh runs as a child process and speaks newline-delimited JSON-RPC over stdio
 * (`@deepseek-ai/dsh-sdk-protocol`). This file holds the seam between the two
 * halves of the adapter: the transport owns the process and the wire, the
 * normalizer owns the translation into Halo's per-turn frame contract
 * (see `services/agent/DESIGN.md` §2). Neither half imports the other's
 * internals.
 *
 * Protocol-level payload shapes live in `./types/dsh-protocol.ts`.
 */

import type { EngineCapabilities } from '../capabilities'

/** How the dsh runtime child process is started. */
export interface DshRuntimeLaunchSpec {
  command: string
  args: string[]
  /** Full child environment. Callers own credential policy; never inherited blindly. */
  env: Record<string, string>
  cwd: string
}

/** Process-wide handshake. dsh pins provider/model per runtime, not per turn. */
export interface DshInitializeParams {
  cwd: string
  provider: string
  model: string
  maxTokens?: number
}

/** A server-to-client notification, method plus its raw payload. */
export interface DshNotification {
  method: 'session.event' | 'session.status' | 'subagent.started' | 'subagent.finished'
  payload: unknown
}

/**
 * The wire client the normalizer consumes. One instance owns one runtime
 * child process; `close()` is the only way to abandon a turn because the
 * protocol has no cancel method.
 */
export interface DshRuntimeClient {
  initialize(params: DshInitializeParams): Promise<void>
  /** Enqueue receipt only — it does not identify a later assistant message. */
  prompt(sessionId: string, contentBlocks: unknown[]): Promise<{ messageId: string }>
  /** Returns an unsubscribe function. */
  onNotification(handler: (notification: DshNotification) => void): () => void
  /** Resolves once the child has actually exited. Idempotent. */
  close(): Promise<void>
}

/** Halo-facing SDK module contract, same surface `resolved-sdk.ts` expects. */
export interface DshSdkModule {
  tool: (...args: any[]) => any
  createSdkMcpServer: (options: any) => any
  createSession: (options: Record<string, any>) => Promise<any>
  query: (params: any) => AsyncIterable<any>
  capabilities: EngineCapabilities
}
