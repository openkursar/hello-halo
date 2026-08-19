/**
 * `DshRuntimeClient` over a real runtime child process.
 *
 * Composes the process lifecycle (`./connection.ts`) with the wire client
 * (`./jsonrpc-client.ts`) and exposes the seam the normalizer consumes. One
 * instance owns exactly one child process for its whole life; it cannot be
 * restarted, because a runtime carries session state the caller cannot rebuild.
 *
 * The runtime pins its provider/model at `initialize` and offers no cancel and
 * no session-close, so `close()` is the only way to abandon a turn — and it
 * ends every session in the runtime, not just one.
 */

import { createDshConnection, type DshConnection } from './connection'
import { DshJsonRpcClient } from './jsonrpc-client'
import {
  DshNotificationMethod,
  DshRequestMethod,
  isDshNotificationMethod,
  type DshInitializeResult,
  type DshSessionPromptResult,
} from '../types/dsh-protocol'
import type {
  DshInitializeParams,
  DshNotification,
  DshRuntimeClient,
  DshRuntimeLaunchSpec,
} from '../types'

export interface DshRuntimeClientOptions {
  launch: DshRuntimeLaunchSpec
  /** Per-request timeout. A prompt only enqueues, so this stays bounded. */
  requestTimeoutMs?: number
  /** How long to wait for the runtime to answer `shutdown` before the ladder. */
  shutdownTimeoutMs?: number
}

/** Matches `@deepseek-ai/dsh-sdk-client`'s bound for the protocol shutdown. */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 1000

export function createDshRuntimeClient(options: DshRuntimeClientOptions): DshRuntimeClient {
  return new ChildProcessRuntimeClient(options)
}

class ChildProcessRuntimeClient implements DshRuntimeClient {
  private readonly connection: DshConnection
  private readonly handlers = new Set<(notification: DshNotification) => void>()
  private client: DshJsonRpcClient | null = null
  private startPromise: Promise<void> | null = null
  private closePromise: Promise<void> | null = null
  private closed = false

  constructor(private readonly options: DshRuntimeClientOptions) {
    this.connection = createDshConnection({
      launch: options.launch,
      onStderr: (line) => console.log(`[Dsh][runtime:stderr] ${line}`),
    })
  }

  async initialize(params: DshInitializeParams): Promise<void> {
    await this.start()

    const started = Date.now()
    const result = await this.rpc().request<DshInitializeResult>(
      DshRequestMethod.Initialize,
      params
    )
    console.log(
      `[Dsh][client] initialized server=${result?.serverInfo?.name}@${result?.serverInfo?.version} ` +
        `provider=${params.provider} model=${params.model} cwd=${params.cwd} ` +
        `in ${Date.now() - started}ms`
    )
  }

  async prompt(sessionId: string, contentBlocks: unknown[]): Promise<{ messageId: string }> {
    const result = await this.rpc().request<DshSessionPromptResult>(
      DshRequestMethod.SessionPrompt,
      { sessionId, contentBlocks }
    )
    console.log(
      `[Dsh][client] prompt enqueued session=${sessionId} messageId=${result?.messageId} ` +
        `blocks=${contentBlocks.length}`
    )
    return { messageId: result.messageId }
  }

  onNotification(handler: (notification: DshNotification) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closePromise = this.doClose()
    return this.closePromise
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  /** Boots the child once; concurrent callers share the same attempt. */
  private async start(): Promise<void> {
    if (this.closed) {
      throw new Error('[Dsh][client] Client is closed and cannot be reused')
    }
    if (this.startPromise) return this.startPromise
    this.startPromise = this.doStart()
    return this.startPromise
  }

  private async doStart(): Promise<void> {
    await this.connection.start()

    const client = new DshJsonRpcClient({
      stdin: this.connection.stdin,
      stdout: this.connection.stdout,
      requestTimeoutMs: this.options.requestTimeoutMs,
      diagnostics: () => this.connection.stderrTail(),
      onClose: (reason) => {
        console.log(`[Dsh][client] transport closed (${reason}) pid=${this.connection.pid}`)
      },
    })

    // An unexpected exit must fail in-flight requests immediately rather than
    // leaving them to time out minutes later.
    this.connection.onExit((code, signal) => {
      if (!this.closed) {
        console.error(
          `[Dsh][client] runtime exited unexpectedly code=${code} signal=${signal}; ` +
            `stderr tail:\n${this.connection.stderrTail()}`
        )
      }
      client.close('eof')
    })

    for (const method of Object.values(DshNotificationMethod)) {
      client.onNotification(method, (payload) => this.fanOut(method, payload))
    }

    this.client = client
  }

  private fanOut(method: string, payload: unknown): void {
    if (!isDshNotificationMethod(method)) return
    const notification: DshNotification = { method, payload }
    // Snapshot so a handler unsubscribing during dispatch is safe.
    for (const handler of Array.from(this.handlers)) {
      try {
        handler(notification)
      } catch (err) {
        console.error(`[Dsh][client] notification handler threw for "${method}":`, err)
      }
    }
  }

  private rpc(): DshJsonRpcClient {
    if (!this.client) {
      throw new Error('[Dsh][client] Runtime not started; call initialize() first')
    }
    return this.client
  }

  private async doClose(): Promise<void> {
    this.closed = true
    const pid = this.connection.pid
    console.log(`[Dsh][client] closing runtime pid=${pid}`)

    // Ask the runtime to shut down cleanly. It normally exits within
    // milliseconds of answering; the connection's ladder covers the rest.
    if (this.client?.isOpen() && this.connection.isAlive()) {
      const timeoutMs = this.options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
      try {
        await withTimeout(this.rpc().request(DshRequestMethod.Shutdown), timeoutMs)
        console.log(`[Dsh][client] runtime acknowledged shutdown pid=${pid}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.warn(`[Dsh][client] shutdown request did not complete cleanly: ${message}`)
      }
    }

    this.client?.close('shutdown')
    await this.connection.stop()
    this.handlers.clear()
    console.log(`[Dsh][client] runtime closed pid=${pid}`)
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
