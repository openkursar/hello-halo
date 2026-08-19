/**
 * AI Terminal - Session proxy
 *
 * Main-process handle for a session living in the pty-host worker. Holds a
 * locally-mirrored TerminalInfo (kept fresh by the context from worker events
 * and local activity) so metadata reads — list(), space scoping, lifecycle
 * event payloads — stay synchronous, while all buffer/pty operations are RPCs
 * to the worker.
 *
 * Latency-sensitive paths (user keystrokes, resize) are fire-and-forget
 * notifications, not request/response — a keystroke must never wait on an RPC
 * round-trip's bookkeeping.
 */

import type {
  TerminalInfo,
  TerminalReadMode,
  TerminalReadResult,
  TerminalRunState,
  TerminalSearchResult,
  TerminalWaitOutcome,
  TerminalWriteResult
} from '../../../shared/types/terminal'
import { ptyHostNotify, ptyHostRequest } from './host'

const DEFAULT_WRITE_TIMEOUT_MS = 10_000

export class TerminalSessionProxy {
  readonly id: string
  /** Mirrored metadata; authoritative snapshots arrive with worker events. */
  readonly info: TerminalInfo

  constructor(info: TerminalInfo) {
    this.id = info.id
    this.info = info
  }

  /** Merge an authoritative info snapshot from a worker event. */
  applyInfo(info: TerminalInfo): void {
    Object.assign(this.info, info)
  }

  get state(): TerminalRunState {
    return this.info.state
  }

  async write(input: string, timeoutMs = DEFAULT_WRITE_TIMEOUT_MS, submit = true): Promise<TerminalWriteResult> {
    this.info.lastActivityAt = Date.now()
    return ptyHostRequest({ type: 'write', sessionId: this.id, input, timeoutMs, submit }, timeoutMs)
  }

  async read(mode: TerminalReadMode, opts: { lines?: number; offset?: number } = {}): Promise<TerminalReadResult> {
    return ptyHostRequest({ type: 'read', sessionId: this.id, mode, lines: opts.lines, offset: opts.offset })
  }

  async search(pattern: string, context?: number): Promise<TerminalSearchResult> {
    return ptyHostRequest({ type: 'search', sessionId: this.id, pattern, context })
  }

  /**
   * Wait for `text` in output produced after this call, as ONE worker-side RPC
   * (the poll loop runs next to the buffer, not chattily over IPC). Returns the
   * outcome plus ready-to-render context output.
   */
  async waitFor(text: string, timeoutMs: number): Promise<{ outcome: TerminalWaitOutcome; content: string }> {
    return ptyHostRequest({ type: 'wait-for', sessionId: this.id, text, timeoutMs }, timeoutMs)
  }

  async getReplay(): Promise<{ info: TerminalInfo; data: string }> {
    return ptyHostRequest({ type: 'replay', sessionId: this.id })
  }

  /** Flip the worker-authoritative aiTouched flag; true only on the first flip. */
  async markAiTouched(): Promise<boolean> {
    const { flipped, info } = await ptyHostRequest({ type: 'mark-ai-touched', sessionId: this.id })
    this.applyInfo(info)
    return flipped
  }

  /** Raw input passthrough (user keyboard). Fire-and-forget. */
  input(data: string): void {
    if (this.info.state === 'exited') return
    this.info.lastActivityAt = Date.now()
    ptyHostNotify({ type: 'input', sessionId: this.id, data })
  }

  resize(cols: number, rows: number): void {
    if (this.info.state === 'exited') return
    this.info.cols = cols
    this.info.rows = rows
    ptyHostNotify({ type: 'resize', sessionId: this.id, cols, rows })
  }

  kill(): void {
    ptyHostNotify({ type: 'kill', sessionId: this.id })
  }

  /** Flow control (driven by the main-side FlowController). */
  pause(): void {
    ptyHostNotify({ type: 'pause', sessionId: this.id })
  }

  resume(): void {
    ptyHostNotify({ type: 'resume', sessionId: this.id })
  }
}
