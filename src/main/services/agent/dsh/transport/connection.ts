/**
 * dsh runtime child-process lifecycle.
 *
 * Spawns the runtime bin as a long-running child whose stdin/stdout carry
 * newline-delimited JSON-RPC frames. One connection per Halo session.
 *
 * Kept separate from `jsonrpc-client.ts` for the same reason Codex does:
 * process management (spawn, env, exit handling, the shutdown ladder) is
 * independent of framing and dispatch, and the client can then be tested
 * against in-memory streams with no child process.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import type { Readable, Writable } from 'stream'
import type { DshRuntimeLaunchSpec } from '../types'

/**
 * Rungs of the shutdown ladder, in order. The runtime normally exits within
 * milliseconds of answering `shutdown`, so these bounds are only reached when
 * it is wedged. Defaults match `@deepseek-ai/dsh-sdk-client`.
 */
export interface DshShutdownTimings {
  /** Wait after stdin EOF before escalating to SIGTERM. */
  eofGraceMs: number
  /** Wait after SIGTERM before escalating to SIGKILL. */
  termGraceMs: number
}

export const DEFAULT_SHUTDOWN_TIMINGS: DshShutdownTimings = {
  eofGraceMs: 6000,
  termGraceMs: 3000,
}

export interface DshConnectionOptions {
  launch: DshRuntimeLaunchSpec
  /** The runtime writes diagnostics and boot failures here. */
  onStderr?: (line: string) => void
  shutdownTimings?: Partial<DshShutdownTimings>
}

export interface DshConnection {
  start(): Promise<void>
  /** Walk stdin EOF → SIGTERM → SIGKILL until the child has actually exited. */
  stop(): Promise<void>
  isAlive(): boolean
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): () => void
  /** Last lines the child wrote to stderr; used to explain an early exit. */
  stderrTail(): string
  readonly stdin: Writable
  readonly stdout: Readable
  readonly pid: number | null
}

/** Bounded so a chatty runtime cannot grow this without limit. */
const STDERR_TAIL_LINES = 50

export function createDshConnection(options: DshConnectionOptions): DshConnection {
  return new ChildProcessConnection(options)
}

class ChildProcessConnection implements DshConnection {
  private child: ChildProcessWithoutNullStreams | null = null
  private readonly exitListeners = new Set<
    (code: number | null, signal: NodeJS.Signals | null) => void
  >()
  private exited = false
  private stderrBuffer = ''
  private readonly stderrLines: string[] = []
  private readonly timings: DshShutdownTimings

  constructor(private readonly options: DshConnectionOptions) {
    this.timings = { ...DEFAULT_SHUTDOWN_TIMINGS, ...options.shutdownTimings }
  }

  get pid(): number | null {
    return this.child?.pid ?? null
  }

  get stdin(): Writable {
    if (!this.child) throw new Error('[Dsh][connection] Connection not started')
    return this.child.stdin
  }

  get stdout(): Readable {
    if (!this.child) throw new Error('[Dsh][connection] Connection not started')
    return this.child.stdout
  }

  isAlive(): boolean {
    return !this.exited && this.child !== null && this.child.exitCode === null && !this.child.killed
  }

  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): () => void {
    this.exitListeners.add(cb)
    return () => this.exitListeners.delete(cb)
  }

  stderrTail(): string {
    return this.stderrLines.join('\n')
  }

  async start(): Promise<void> {
    if (this.child) throw new Error('[Dsh][connection] Connection already started')

    const { command, args, env, cwd } = this.options.launch

    console.log(
      `[Dsh][connection] spawning command=${command} args=${JSON.stringify(args)} ` +
        `cwd=${cwd} pid_parent=${process.pid}`
    )

    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    this.child = child

    child.stderr.setEncoding('utf-8')
    child.stderr.on('data', (chunk: string) => {
      this.stderrBuffer += chunk
      let nl: number
      while ((nl = this.stderrBuffer.indexOf('\n')) >= 0) {
        const line = this.stderrBuffer.slice(0, nl)
        this.stderrBuffer = this.stderrBuffer.slice(nl + 1)
        if (line) this.recordStderr(line)
      }
    })

    child.once('error', (err) => {
      console.error(`[Dsh][connection] spawn error:`, err)
      if (!this.exited) this.handleExit(null, null)
    })

    child.once('exit', (code, signal) => {
      console.log(
        `[Dsh][connection] child exited code=${code} signal=${signal} pid=${child.pid}`
      )
      if (this.stderrBuffer) {
        this.recordStderr(this.stderrBuffer)
        this.stderrBuffer = ''
      }
      this.handleExit(code, signal)
    })

    if (child.pid === undefined) {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = (): void => {
          child.removeListener('error', onError)
          resolve()
        }
        const onError = (err: Error): void => {
          child.removeListener('spawn', onSpawn)
          reject(err)
        }
        child.once('spawn', onSpawn)
        child.once('error', onError)
      })
    }

    console.log(`[Dsh][connection] spawned pid=${child.pid}`)
  }

  async stop(): Promise<void> {
    const child = this.child
    if (!child || this.exited) return

    // Attach the exit listener before any signal so an immediate exit cannot
    // land between the escalation and the wait.
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || this.exited) {
        resolve()
        return
      }
      child.once('exit', () => resolve())
    })

    console.log(`[Dsh][connection] stopping pid=${child.pid}: stdin EOF`)
    try {
      child.stdin.end()
    } catch {
      /* stream already torn down */
    }
    if (await settlesWithin(exited, this.timings.eofGraceMs)) return

    console.warn(
      `[Dsh][connection] pid=${child.pid} still alive ${this.timings.eofGraceMs}ms after EOF; sending SIGTERM`
    )
    try {
      child.kill('SIGTERM')
    } catch {
      /* already dead */
    }
    if (await settlesWithin(exited, this.timings.termGraceMs)) return

    console.error(
      `[Dsh][connection] pid=${child.pid} ignored SIGTERM after ${this.timings.termGraceMs}ms; sending SIGKILL`
    )
    try {
      child.kill('SIGKILL')
    } catch {
      /* already dead */
    }
    await exited
  }

  private recordStderr(line: string): void {
    this.stderrLines.push(line)
    if (this.stderrLines.length > STDERR_TAIL_LINES) this.stderrLines.shift()
    this.options.onStderr?.(line)
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return
    this.exited = true
    for (const cb of this.exitListeners) {
      try {
        cb(code, signal)
      } catch (err) {
        console.error(`[Dsh][connection] exit listener threw:`, err)
      }
    }
  }
}

/** Resolve true if `promise` settles before `ms` elapses. */
async function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
  })
  try {
    return await Promise.race([promise.then(() => true), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
