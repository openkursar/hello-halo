/**
 * JSON-RPC 2.0 client for the dsh runtime.
 *
 * Wire format: line-delimited JSON over stdio (see ../types/dsh-protocol.ts).
 * Unidirectional in practice — the runtime never issues a request — so this
 * client only correlates its own requests and fans out notifications.
 *
 * Responsibilities:
 *   - Frame outgoing messages as `JSON + \n` on stdin.
 *   - Parse incoming stdout lines into JsonRpcMessage values.
 *   - Match responses to pending requests, with a per-request timeout.
 *   - Dispatch notifications to registered listeners.
 *
 * Failure model:
 *   - On transport close, every pending request rejects with a
 *     transport-closed error carrying the child's stderr tail, because a boot
 *     failure surfaces there and nowhere else.
 *   - Lines that are not valid JSON-RPC are logged and dropped. Plugins that
 *     misbehave and write to stdout would otherwise corrupt the stream.
 */

import { createInterface, type Interface as ReadlineInterface } from 'readline'
import type { Readable, Writable } from 'stream'
import {
  isJsonRpcError,
  isJsonRpcNotification,
  isJsonRpcSuccess,
  JSONRPC_VERSION,
  type JsonRpcErrorPayload,
  type JsonRpcMessage,
  type RequestId,
} from '../types/dsh-protocol'

export type Disposable = () => void

export interface DshJsonRpcClientOptions {
  stdin: Writable
  stdout: Readable
  /** Called when the underlying stdout closes. */
  onClose?: (reason: CloseReason) => void
  /** Explains an unexpected close; surfaced in pending-request rejections. */
  diagnostics?: () => string
  /** Per-request timeout. Defaults to 5 minutes. */
  requestTimeoutMs?: number
}

export type CloseReason = 'eof' | 'shutdown'

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  method: string
  timer: NodeJS.Timeout
}

/** A wire error response. Preserves the JSON-RPC `code` and `data`. */
export class DshResponseError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(method: string, payload: JsonRpcErrorPayload) {
    super(`[Dsh][rpc] "${method}" failed: ${payload.message} (code ${payload.code})`)
    this.name = 'DshResponseError'
    this.code = payload.code
    this.data = payload.data
  }
}

/** The runtime is gone. Carries whatever it said on the way out. */
export class DshTransportClosedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DshTransportClosedError'
  }
}

export class DshRequestTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`[Dsh][rpc] "${method}" timed out after ${timeoutMs}ms`)
    this.name = 'DshRequestTimeoutError'
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000

export class DshJsonRpcClient {
  private nextId = 1
  private readonly pending = new Map<string, PendingRequest>()
  private readonly notificationListeners = new Map<string, Set<(params: unknown) => void>>()
  private readonly stdin: Writable
  private readonly rl: ReadlineInterface
  private readonly opts: DshJsonRpcClientOptions
  private closed = false

  constructor(opts: DshJsonRpcClientOptions) {
    this.opts = opts
    this.stdin = opts.stdin
    this.rl = createInterface({ input: opts.stdout })
    this.rl.on('line', (line) => this.onLine(line))
    this.rl.on('close', () => this.handleClose('eof'))
  }

  // --------------------------------------------------------------------------
  // Outbound
  // --------------------------------------------------------------------------

  request<R = unknown>(method: string, params?: unknown): Promise<R> {
    if (this.closed) {
      return Promise.reject(
        new DshTransportClosedError(`[Dsh][rpc] Cannot send "${method}": connection closed`)
      )
    }

    const id = this.nextId++
    const timeoutMs = this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS

    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(idKey(id))
        console.error(`[Dsh][rpc] request "${method}" id=${id} timed out after ${timeoutMs}ms`)
        reject(new DshRequestTimeoutError(method, timeoutMs))
      }, timeoutMs)

      this.pending.set(idKey(id), {
        resolve: (v: unknown) => resolve(v as R),
        reject,
        method,
        timer,
      })
      this.send({ jsonrpc: JSONRPC_VERSION, id, method, params })
    })
  }

  // --------------------------------------------------------------------------
  // Inbound
  // --------------------------------------------------------------------------

  onNotification(method: string, cb: (params: unknown) => void): Disposable {
    let set = this.notificationListeners.get(method)
    if (!set) {
      set = new Set()
      this.notificationListeners.set(method, set)
    }
    set.add(cb)
    return () => set!.delete(cb)
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  close(reason: CloseReason = 'shutdown'): void {
    this.handleClose(reason)
  }

  isOpen(): boolean {
    return !this.closed
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  private send(message: unknown): void {
    let payload: string
    try {
      payload = JSON.stringify(message)
    } catch (err) {
      console.error(`[Dsh][rpc] serialize failed:`, err)
      return
    }
    this.stdin.write(payload + '\n', (err) => {
      if (err) console.error(`[Dsh][rpc] stdin.write error:`, err)
    })
  }

  private onLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return

    let msg: JsonRpcMessage
    try {
      msg = JSON.parse(trimmed) as JsonRpcMessage
    } catch {
      console.warn(`[Dsh][rpc] dropping non-JSON stdout line: ${truncate(trimmed, 200)}`)
      return
    }

    if (isJsonRpcSuccess(msg)) {
      const pending = this.takePending(msg.id)
      if (!pending) return
      pending.resolve(msg.result)
      return
    }

    if (isJsonRpcError(msg)) {
      const pending = this.takePending(msg.id)
      if (!pending) return
      pending.reject(new DshResponseError(pending.method, msg.error))
      return
    }

    if (isJsonRpcNotification(msg)) {
      this.dispatchNotification(msg.method, msg.params)
      return
    }

    console.warn(`[Dsh][rpc] unrecognized message shape: ${truncate(trimmed, 200)}`)
  }

  private takePending(id: RequestId): PendingRequest | null {
    const key = idKey(id)
    const pending = this.pending.get(key)
    if (!pending) {
      console.warn(`[Dsh][rpc] response for unknown id ${String(id)}; dropping`)
      return null
    }
    this.pending.delete(key)
    clearTimeout(pending.timer)
    return pending
  }

  private dispatchNotification(method: string, params: unknown): void {
    const set = this.notificationListeners.get(method)
    if (!set || set.size === 0) return
    // Snapshot so a listener disposing itself during dispatch is safe.
    for (const cb of Array.from(set)) {
      try {
        cb(params)
      } catch (err) {
        console.error(`[Dsh][rpc] notification "${method}" listener threw:`, err)
      }
    }
  }

  private handleClose(reason: CloseReason): void {
    if (this.closed) return
    this.closed = true
    try {
      this.rl.close()
    } catch {
      /* already closed */
    }

    const diagnostics = this.opts.diagnostics?.() ?? ''
    if (this.pending.size > 0) {
      console.error(
        `[Dsh][rpc] connection closed (${reason}) with ${this.pending.size} pending request(s)` +
          (diagnostics ? `; runtime stderr:\n${diagnostics}` : '')
      )
    }

    const err = new DshTransportClosedError(
      `[Dsh][rpc] connection closed (${reason})` + (diagnostics ? `; runtime stderr: ${diagnostics}` : '')
    )
    for (const pending of Array.from(this.pending.values())) {
      clearTimeout(pending.timer)
      pending.reject(err)
    }
    this.pending.clear()
    this.notificationListeners.clear()

    try {
      this.opts.onClose?.(reason)
    } catch (cbErr) {
      console.error(`[Dsh][rpc] onClose threw:`, cbErr)
    }
  }
}

function idKey(id: RequestId): string {
  return typeof id === 'number' ? `n:${id}` : `s:${id}`
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…(+${text.length - max})` : text
}
