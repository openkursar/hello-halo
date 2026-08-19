/**
 * AI Terminal - Pty Host client
 *
 * Forks and manages the pty-host worker process (src/worker/pty-host) and
 * exposes a typed request/notify API over child_process IPC. The worker owns
 * the ptys; this module owns the process lifecycle and request correlation.
 *
 * Lifecycle:
 *  - lazily forked on first use (terminal creation), never at app startup;
 *  - on crash: every pending request is rejected and the registered crash
 *    handler runs (context marks all sessions exited — ptys died with the
 *    worker, there is nothing to revive). The next create forks a fresh host.
 */

import { fork, type ChildProcess } from 'child_process'
import { join } from 'path'
import type {
  MainToPtyHostMessage,
  PtyHostEvent,
  PtyHostNotification,
  PtyHostRequest,
  PtyHostResponsePayloads,
  PtyHostToMainMessage
} from '../../../shared/protocol/pty-host.protocol'

/**
 * Baseline RPC deadline. Long-running requests (write / wait-for) pass their
 * own budget; this guards everything else against a wedged worker.
 */
const REQUEST_TIMEOUT_MS = 30_000
/** Margin added to a caller-supplied budget before declaring the worker dead. */
const REQUEST_TIMEOUT_MARGIN_MS = 5_000

let hostProcess: ChildProcess | null = null
let isShuttingDown = false
let requestSeq = 0

const pending = new Map<string, {
  resolve: (data: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}>()

let eventHandler: ((event: PtyHostEvent) => void) | null = null
let crashHandler: (() => void) | null = null

/** Register the sink for unsolicited worker events (context wires this once). */
export function setPtyHostEventHandler(handler: (event: PtyHostEvent) => void): void {
  eventHandler = handler
}

/** Register the crash callback (context marks all sessions exited). */
export function setPtyHostCrashHandler(handler: () => void): void {
  crashHandler = handler
}

function getWorkerEntryPath(): string {
  // electron-vite puts worker output under out/main/worker/pty-host/index.mjs;
  // __dirname at runtime is out/main/.
  return join(__dirname, 'worker/pty-host/index.mjs')
}

function forkHost(): ChildProcess {
  const workerPath = getWorkerEntryPath()
  console.log(`[PtyHost] Forking worker: ${workerPath}`)

  const child = fork(workerPath, [], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env }
  })

  child.on('message', (msg: PtyHostToMainMessage) => {
    if (msg.type === 'response') {
      const entry = pending.get(msg.requestId)
      if (!entry) return
      clearTimeout(entry.timer)
      pending.delete(msg.requestId)
      if (msg.ok) entry.resolve(msg.data)
      else entry.reject(new Error(msg.error))
      return
    }
    if (msg.type === 'log') {
      const line = `[PtyHostWorker] ${msg.message}`
      if (msg.level === 'error') console.error(line)
      else if (msg.level === 'warn') console.warn(line)
      else console.log(line)
      return
    }
    eventHandler?.(msg)
  })

  child.stdout?.on('data', (data: Buffer) => {
    console.log(`[PtyHostWorker] ${data.toString().trim()}`)
  })
  child.stderr?.on('data', (data: Buffer) => {
    console.error(`[PtyHostWorker] ${data.toString().trim()}`)
  })

  child.on('exit', (code, signal) => {
    console.warn(`[PtyHost] Worker exited: code=${code}, signal=${signal}`)
    hostProcess = null
    for (const [requestId, entry] of Array.from(pending.entries())) {
      clearTimeout(entry.timer)
      entry.reject(new Error(`Pty host exited unexpectedly (code=${code})`))
      pending.delete(requestId)
    }
    // Ptys die with the worker — there is nothing to restart into. The context
    // marks every session exited; the next create() forks a fresh host.
    if (!isShuttingDown) crashHandler?.()
  })

  child.on('error', (error) => {
    console.error('[PtyHost] Worker error:', error)
  })

  return child
}

function ensureHost(): ChildProcess {
  if (!hostProcess) {
    hostProcess = forkHost()
  }
  return hostProcess
}

/** Whether a host process is currently alive (for peek-style callers). */
export function isPtyHostRunning(): boolean {
  return hostProcess !== null
}

/** Fire-and-forget notification (input/resize/kill/pause/resume). */
export function ptyHostNotify(msg: PtyHostNotification): void {
  // Notifications never fork: without a host there are no sessions to notify.
  if (!hostProcess) return
  hostProcess.send(msg satisfies MainToPtyHostMessage)
}

/**
 * Send a request and await its correlated response. `budgetMs` extends the RPC
 * deadline for calls with a caller-controlled wait (write / wait-for).
 */
export function ptyHostRequest<T extends PtyHostRequest['type']>(
  msg: Omit<Extract<PtyHostRequest, { type: T }>, 'requestId'> & { type: T },
  budgetMs?: number
): Promise<PtyHostResponsePayloads[T]> {
  const host = ensureHost()
  const requestId = `req-${++requestSeq}-${Date.now().toString(36)}`
  const timeoutMs = budgetMs !== undefined ? budgetMs + REQUEST_TIMEOUT_MARGIN_MS : REQUEST_TIMEOUT_MS

  return new Promise<PtyHostResponsePayloads[T]>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error(`Pty host request timed out: ${msg.type}`))
    }, timeoutMs)

    pending.set(requestId, {
      resolve: resolve as (data: unknown) => void,
      reject,
      timer
    })

    host.send({ ...msg, requestId } as MainToPtyHostMessage)
  })
}

/** Shutdown the worker gracefully (app teardown). */
export async function shutdownPtyHost(): Promise<void> {
  isShuttingDown = true
  for (const [requestId, entry] of Array.from(pending.entries())) {
    clearTimeout(entry.timer)
    entry.reject(new Error('Pty host shutting down'))
    pending.delete(requestId)
  }
  if (!hostProcess) {
    isShuttingDown = false
    return
  }
  console.log('[PtyHost] Shutting down worker...')
  const child = hostProcess
  ptyHostNotify({ type: 'shutdown' })
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      resolve()
    }, 3000)
    child.on('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  hostProcess = null
  isShuttingDown = false
}
