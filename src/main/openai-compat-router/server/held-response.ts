/**
 * A stand-in for the Express response a handler writes to. It buffers the reply
 * until it carries something the engine would act on, then sends everything held
 * and passes through; a reply that fails first leaves the real connection
 * untouched. It implements only the part of a response the handlers use.
 */

import type { Response as ExpressResponse } from 'express'
import { StreamCommitDetector, judgeMessageReply } from './commit-detector'

export type HeldFailure =
  | { cause: 'http'; status: number }
  | { cause: 'stream-error'; errorType?: string; message: string }
  | { cause: 'empty' }
  | { cause: 'timeout'; phase: 'headers' | 'first-content' }
  /** The handler itself threw. */
  | { cause: 'error'; message: string }

/** What the handler wrote, for forwarding when no member answers. */
export interface HeldReply {
  status: number
  /** Every header the handler or the upstream set at any time, even one later removed. */
  headers: Record<string, string>
  body: string
}

export type HeldOutcome =
  | { kind: 'committed' }
  | { kind: 'failed'; failure: HeldFailure; reply: HeldReply }
  | { kind: 'abandoned' }

export interface HeldResponseOptions {
  /** Give up on the reply when nothing usable has arrived this long after it started. */
  firstContentTimeoutMs?: number
  /** Held bytes beyond which a streamed reply is sent regardless, so a silent stream cannot grow memory. */
  maxHeldBytes?: number
  /** Size beyond which a reply that is not streamed is sent without being judged; it must be read whole to be judged. */
  maxJudgedBytes?: number
}

const DEFAULT_MAX_HELD_BYTES = 256 * 1024
const DEFAULT_MAX_JUDGED_BYTES = 8 * 1024 * 1024
/** How much of an error body is kept: it is only quoted back in a message and checked for wording. */
const REPLY_BODY_CAP = 64 * 1024

type Listener = () => void

export class HeldResponse {
  readonly outcome: Promise<HeldOutcome>
  /** The object handlers write to. */
  readonly response: ExpressResponse

  private state: 'holding' | 'committed' | 'failed' | 'abandoned' = 'holding'
  private settle!: (outcome: HeldOutcome) => void
  private statusCode = 200
  private readonly headers = new Map<string, string>()
  private readonly seen = new Map<string, string>()
  private chunks: Buffer[] = []
  private heldBytes = 0
  private ended = false
  private detector: StreamCommitDetector | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly closeListeners = new Set<Listener>()
  private readonly maxHeldBytes: number
  private readonly maxJudgedBytes: number
  private readonly onRealClose = () => this.emitClose()

  constructor(private readonly real: ExpressResponse, options: HeldResponseOptions = {}) {
    this.maxHeldBytes = options.maxHeldBytes ?? DEFAULT_MAX_HELD_BYTES
    this.maxJudgedBytes = options.maxJudgedBytes ?? DEFAULT_MAX_JUDGED_BYTES
    this.outcome = new Promise<HeldOutcome>(resolve => { this.settle = resolve })
    this.response = this.createStandIn()
    real.once('close', this.onRealClose)
    if (options.firstContentTimeoutMs && options.firstContentTimeoutMs > 0) {
      this.timer = setTimeout(
        () => this.fail({ cause: 'timeout', phase: 'first-content' }),
        options.firstContentTimeoutMs
      )
      this.timer.unref?.()
    }
  }

  /** End the attempt as a failure the handler did not report itself. */
  fail(failure: HeldFailure): void {
    if (this.state !== 'holding') return
    this.state = 'failed'
    const reply: HeldReply = {
      status: this.statusCode,
      headers: Object.fromEntries(this.seen),
      body: Buffer.concat(this.chunks).toString('utf8').slice(0, REPLY_BODY_CAP),
    }
    this.finishHolding()
    this.settle({ kind: 'failed', failure, reply })
    // Whatever the handler is still doing for this reply is no longer wanted.
    this.emitClose()
  }

  /** Stop holding and drop everything: the caller no longer wants this reply. */
  abandon(): void {
    if (this.state !== 'holding') return
    this.state = 'abandoned'
    this.finishHolding()
    this.settle({ kind: 'abandoned' })
    this.emitClose()
  }

  private createStandIn(): ExpressResponse {
    const self = this
    const standIn = {
      get statusCode() { return self.state === 'committed' ? self.real.statusCode : self.statusCode },
      set statusCode(code: number) { if (self.state === 'committed') self.real.statusCode = code; else self.statusCode = code },
      get writableEnded() { return self.state === 'committed' ? self.real.writableEnded : self.ended },
      get headersSent() { return self.state === 'committed' && self.real.headersSent },
      get socket() { return self.real.socket },
      status(code: number) {
        if (self.state === 'committed') self.real.status(code)
        else self.statusCode = code
        return standIn
      },
      setHeader(name: string, value: string | number | readonly string[]) {
        const key = name.toLowerCase()
        const text = Array.isArray(value) ? value.join(', ') : String(value)
        if (self.state === 'committed') { self.real.setHeader(name, value as string); return standIn }
        self.headers.set(key, text)
        self.seen.set(key, text)
        return standIn
      },
      getHeader(name: string) { return self.state === 'committed' ? self.real.getHeader(name) : self.headers.get(name.toLowerCase()) },
      hasHeader(name: string) { return self.state === 'committed' ? self.real.hasHeader(name) : self.headers.has(name.toLowerCase()) },
      removeHeader(name: string) {
        if (self.state === 'committed') self.real.removeHeader(name)
        else self.headers.delete(name.toLowerCase())
        return standIn
      },
      flushHeaders() { if (self.state === 'committed') self.real.flushHeaders() },
      noteUpstreamHeaders(headers: Headers) {
        headers.forEach((value, name) => { self.seen.set(name.toLowerCase(), value) })
      },
      write(chunk: unknown) { return self.write(chunk) },
      end(chunk?: unknown) { self.end(chunk); return standIn },
      json(body: unknown) {
        if (self.state === 'committed') { self.real.json(body); return standIn }
        self.headers.set('content-type', 'application/json')
        self.seen.set('content-type', 'application/json')
        self.end(JSON.stringify(body))
        return standIn
      },
      on(event: string, listener: Listener) {
        if (event === 'close') self.closeListeners.add(listener)
        return standIn
      },
      once(event: string, listener: Listener) {
        if (event === 'close') {
          const wrapped = () => { self.closeListeners.delete(wrapped); listener() }
          self.closeListeners.add(wrapped)
        }
        return standIn
      },
      off(event: string, listener: Listener) {
        if (event === 'close') self.closeListeners.delete(listener)
        return standIn
      },
    }
    return standIn as unknown as ExpressResponse
  }

  private isStream(): boolean {
    return (this.headers.get('content-type') ?? '').includes('text/event-stream')
  }

  private write(chunk: unknown): boolean {
    if (this.state === 'committed') return this.real.write(chunk as string | Buffer)
    if (this.state !== 'holding' || this.ended) return true
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    const before = this.heldBytes
    this.heldBytes += buffer.length

    if (this.statusCode >= 400) {
      if (before < REPLY_BODY_CAP) this.chunks.push(buffer)
    } else if (this.isStream()) {
      this.chunks.push(buffer)
      this.detector ??= new StreamCommitDetector()
      const verdict = this.detector.push(buffer)
      if (verdict.kind === 'content') this.commit()
      else if (verdict.kind === 'error') this.fail({ cause: 'stream-error', errorType: verdict.errorType, message: verdict.message })
      else if (this.heldBytes > this.maxHeldBytes) this.commit()
    } else {
      this.chunks.push(buffer)
      if (this.heldBytes > this.maxJudgedBytes) this.commit()
    }
    return true
  }

  private end(chunk?: unknown): void {
    if (this.ended) return
    if (this.state === 'holding' && chunk !== undefined && chunk !== null && chunk !== '') {
      this.write(chunk)
      chunk = undefined
    }
    if (this.state === 'committed') {
      this.ended = true
      this.real.end(chunk as string | Buffer | undefined)
      return
    }
    if (this.state !== 'holding') return
    this.ended = true

    if (this.statusCode >= 400) {
      this.fail({ cause: 'http', status: this.statusCode })
      return
    }
    if (this.isStream()) {
      // The stream finished and never said anything.
      this.fail({ cause: 'empty' })
      return
    }
    const verdict = judgeMessageReply(Buffer.concat(this.chunks).toString('utf8'))
    if (verdict.kind === 'content') this.commit()
    else if (verdict.kind === 'error') this.fail({ cause: 'stream-error', errorType: verdict.errorType, message: verdict.message })
    else this.fail({ cause: 'empty' })
  }

  private commit(): void {
    if (this.state !== 'holding') return
    this.state = 'committed'
    this.finishHolding()
    this.real.status(this.statusCode)
    for (const [name, value] of this.headers) this.real.setHeader(name, value)
    for (const chunk of this.chunks) this.real.write(chunk)
    this.chunks = []
    if (this.ended) this.real.end()
    this.settle({ kind: 'committed' })
  }

  private finishHolding(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.chunks = this.state === 'committed' ? this.chunks : []
    this.heldBytes = 0
    if (this.state !== 'committed') this.real.off('close', this.onRealClose)
  }

  private emitClose(): void {
    for (const listener of [...this.closeListeners]) {
      try { listener() } catch (error) { console.warn('[Router] held response close listener failed:', error) }
    }
    this.closeListeners.clear()
  }
}
