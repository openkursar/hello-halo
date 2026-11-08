import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HeldResponse } from '../../../src/main/openai-compat-router/server/held-response'

/** The slice of a connection a handler's reply ends up on. */
class FakeConnection extends EventEmitter {
  statusCode = 200
  writableEnded = false
  headersSent = false
  socket = undefined
  readonly headers = new Map<string, string>()
  readonly chunks: string[] = []
  status(code: number) { this.statusCode = code; return this }
  setHeader(name: string, value: string) { this.headers.set(name.toLowerCase(), value); return this }
  getHeader(name: string) { return this.headers.get(name.toLowerCase()) }
  hasHeader(name: string) { return this.headers.has(name.toLowerCase()) }
  removeHeader(name: string) { this.headers.delete(name.toLowerCase()) }
  flushHeaders() { this.headersSent = true }
  write(chunk: string | Buffer) { this.headersSent = true; this.chunks.push(String(chunk)); return true }
  end(chunk?: string | Buffer) { if (chunk) this.chunks.push(String(chunk)); this.writableEnded = true; return this }
  json(body: unknown) { this.headers.set('content-type', 'application/json'); return this.end(JSON.stringify(body)) }
  get untouched() { return this.chunks.length === 0 && this.headers.size === 0 && this.statusCode === 200 && !this.writableEnded }
}

function setup(options?: ConstructorParameters<typeof HeldResponse>[1]) {
  const real = new FakeConnection()
  const held = new HeldResponse(real as never, options)
  const out = held.response as unknown as FakeConnection
  const closed = vi.fn()
  out.on('close', closed)
  return { real, held, out, closed }
}

const frame = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
const start = frame('message_start', { message: { id: 'm', content: [], usage: { input_tokens: 1, output_tokens: 0 } } })
const textStart = frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
const delta = (text: string) => frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text } })

function openStream(out: FakeConnection) {
  out.setHeader('Content-Type', 'text/event-stream')
  out.setHeader('Cache-Control', 'no-cache')
}

afterEach(() => { vi.useRealTimers() })

describe('a streamed reply', () => {
  it('is held until it says something, then sent whole and passed through', async () => {
    const { real, held, out } = setup()
    openStream(out)
    out.write(start)
    out.write(textStart)
    await Promise.resolve()
    expect(real.untouched).toBe(true)

    out.write(delta('Hi'))
    expect(await held.outcome).toEqual({ kind: 'committed' })
    expect(real.statusCode).toBe(200)
    expect(real.headers.get('content-type')).toBe('text/event-stream')
    expect(real.chunks.join('')).toBe(start + textStart + delta('Hi'))

    out.write(delta(' there'))
    out.end()
    expect(real.chunks.at(-1)).toBe(delta(' there'))
    expect(real.writableEnded).toBe(true)
  })

  it('ends once when the final chunk carries the first content', async () => {
    const { real, held, out } = setup()
    const end = vi.spyOn(real, 'end')
    openStream(out)
    out.write(start + textStart)
    expect(real.untouched).toBe(true)
    const final = delta('Hi') + frame('message_stop', {})
    out.end(final)
    expect(await held.outcome).toEqual({ kind: 'committed' })
    expect(real.chunks.join('')).toBe(start + textStart + final)
    expect(real.writableEnded).toBe(true)
    expect(end).toHaveBeenCalledTimes(1)
    expect(end).toHaveBeenCalledWith(undefined)
    out.end()
    expect(end).toHaveBeenCalledTimes(1)
  })

  it('leaves the connection untouched when the final chunk is an error', async () => {
    const { real, held, out, closed } = setup()
    const end = vi.spyOn(real, 'end')
    openStream(out)
    out.write(start)
    out.end(frame('error', { error: { type: 'overloaded_error', message: 'Overloaded' } }))
    expect(await held.outcome).toMatchObject({ kind: 'failed', failure: { cause: 'stream-error' } })
    expect(real.untouched).toBe(true)
    expect(end).not.toHaveBeenCalled()
    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('commits on a tool call without waiting for any text', async () => {
    const { real, held, out } = setup()
    openStream(out)
    out.write(start + frame('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 't', name: 'Read', input: {} } }))
    expect(await held.outcome).toEqual({ kind: 'committed' })
    expect(real.chunks).toHaveLength(1)
  })

  it('fails without touching the connection when an error comes before any content', async () => {
    const { real, held, out, closed } = setup()
    openStream(out)
    out.write(start)
    out.write(frame('error', { error: { type: 'overloaded_error', message: 'Overloaded' } }))
    const outcome = await held.outcome
    expect(outcome).toMatchObject({ kind: 'failed', failure: { cause: 'stream-error', errorType: 'overloaded_error', message: 'Overloaded' } })
    expect(real.untouched).toBe(true)
    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('fails as empty when it ends without ever saying anything', async () => {
    const { real, held, out } = setup()
    openStream(out)
    out.write(start + textStart + frame('content_block_stop', { index: 0 }) + frame('message_stop', {}))
    out.end()
    expect(await held.outcome).toMatchObject({ kind: 'failed', failure: { cause: 'empty' } })
    expect(real.untouched).toBe(true)
  })

  it('ignores what a failed handler keeps writing', async () => {
    const { real, held, out } = setup()
    openStream(out)
    out.write(frame('error', { error: { type: 'api_error', message: 'x' } }))
    await held.outcome
    out.write(delta('late'))
    out.end()
    expect(real.untouched).toBe(true)
  })

  it('sends a reply that has held too much without deciding', async () => {
    const { real, held, out } = setup({ maxHeldBytes: 64 })
    openStream(out)
    out.write(': ' + 'x'.repeat(100) + '\n\n')
    expect(await held.outcome).toEqual({ kind: 'committed' })
    expect(real.chunks).toHaveLength(1)
  })

  it('ends once when the final chunk exceeds the stream holding limit', async () => {
    const { real, held, out } = setup({ maxHeldBytes: 64 })
    const end = vi.spyOn(real, 'end')
    openStream(out)
    const body = ': ' + 'x'.repeat(100) + '\n\n'
    out.end(body)
    expect(await held.outcome).toEqual({ kind: 'committed' })
    expect(real.chunks.join('')).toBe(body)
    expect(real.writableEnded).toBe(true)
    expect(end).toHaveBeenCalledTimes(1)
  })

  it('gives up when nothing usable arrives in time', async () => {
    vi.useFakeTimers()
    const { real, held, out, closed } = setup({ firstContentTimeoutMs: 1000 })
    openStream(out)
    out.write(start)
    vi.advanceTimersByTime(1000)
    expect(await held.outcome).toMatchObject({ kind: 'failed', failure: { cause: 'timeout', phase: 'first-content' } })
    expect(real.untouched).toBe(true)
    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('does not time out a reply that has already begun', async () => {
    vi.useFakeTimers()
    const { held, out } = setup({ firstContentTimeoutMs: 1000 })
    openStream(out)
    out.write(start + textStart + delta('Hi'))
    vi.advanceTimersByTime(5000)
    expect(await held.outcome).toEqual({ kind: 'committed' })
  })
})

describe('a whole reply', () => {
  const message = (content: unknown[]) => ({ type: 'message', role: 'assistant', content, usage: { input_tokens: 1, output_tokens: 1 } })

  it('is sent when it has content', async () => {
    const { real, held, out } = setup()
    out.json(message([{ type: 'text', text: 'Hi' }]))
    expect(await held.outcome).toEqual({ kind: 'committed' })
    expect(real.statusCode).toBe(200)
    expect(JSON.parse(real.chunks.join('')).content[0].text).toBe('Hi')
    expect(real.writableEnded).toBe(true)
  })

  it.each([
    ['json', 1],
    ['json', 2_000],
    ['end', 1],
    ['end', 2_000],
  ] as const)('ends one %s reply exactly once with %i text characters', async (method, size) => {
    const { real, held, out } = setup({ maxJudgedBytes: 1_024 })
    const end = vi.spyOn(real, 'end')
    const body = message([{ type: 'text', text: 'x'.repeat(size) }])
    const serialized = JSON.stringify(body)
    if (method === 'json') out.json(body)
    else out.end(serialized)
    expect(await held.outcome).toEqual({ kind: 'committed' })
    expect(real.chunks.join('')).toBe(serialized)
    expect(real.writableEnded).toBe(true)
    expect(end).toHaveBeenCalledTimes(1)
    expect(end.mock.calls[0][0]).toBeUndefined()
    out.end()
    expect(end).toHaveBeenCalledTimes(1)
  })

  it.each([1, 2_000])('ends once after writing part of a reply with %i text characters', async size => {
    const { real, held, out } = setup({ maxJudgedBytes: 1_024 })
    const end = vi.spyOn(real, 'end')
    const body = JSON.stringify(message([{ type: 'text', text: 'x'.repeat(size) }]))
    out.write(body.slice(0, 20))
    expect(real.untouched).toBe(true)
    out.end(Buffer.from(body.slice(20)))
    expect(await held.outcome).toEqual({ kind: 'committed' })
    expect(real.chunks.join('')).toBe(body)
    expect(real.writableEnded).toBe(true)
    expect(end).toHaveBeenCalledTimes(1)
    expect(end.mock.calls[0][0]).toBeUndefined()
  })

  it('passes a final chunk through once when a previous write already committed', async () => {
    const { real, held, out } = setup({ maxJudgedBytes: 100 })
    const end = vi.spyOn(real, 'end')
    const body = JSON.stringify(message([{ type: 'text', text: 'x'.repeat(200) }]))
    out.write(body.slice(0, 150))
    expect(await held.outcome).toEqual({ kind: 'committed' })
    expect(real.writableEnded).toBe(false)
    out.end(body.slice(150))
    expect(real.chunks.join('')).toBe(body)
    expect(real.writableEnded).toBe(true)
    expect(end).toHaveBeenCalledTimes(1)
    expect(end).toHaveBeenCalledWith(body.slice(150))
  })

  it('keeps the strict judging threshold when the last chunk ends the reply', async () => {
    const body = JSON.stringify(message([]))
    const exact = setup({ maxJudgedBytes: Buffer.byteLength(body) })
    exact.out.end(body)
    expect(await exact.held.outcome).toMatchObject({ kind: 'failed', failure: { cause: 'empty' } })
    expect(exact.real.untouched).toBe(true)

    const oversized = setup({ maxJudgedBytes: Buffer.byteLength(body) - 1 })
    const end = vi.spyOn(oversized.real, 'end')
    oversized.out.end(body)
    expect(await oversized.held.outcome).toEqual({ kind: 'committed' })
    expect(oversized.real.chunks.join('')).toBe(body)
    expect(oversized.real.writableEnded).toBe(true)
    expect(end).toHaveBeenCalledTimes(1)
  })

  it.each(['json', 'end'] as const)('does not commit or end a large HTTP failure sent by %s', async method => {
    const { real, held, out, closed } = setup({ maxJudgedBytes: 100 })
    const end = vi.spyOn(real, 'end')
    const body = { type: 'error', error: { type: 'api_error', message: 'x'.repeat(200) } }
    out.status(502)
    if (method === 'json') out.json(body)
    else out.end(JSON.stringify(body))
    expect(await held.outcome).toMatchObject({ kind: 'failed', failure: { cause: 'http', status: 502 } })
    expect(real.untouched).toBe(true)
    expect(end).not.toHaveBeenCalled()
    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('fails as empty when it has none', async () => {
    const { real, held, out } = setup()
    out.json(message([]))
    expect(await held.outcome).toMatchObject({ kind: 'failed', failure: { cause: 'empty' } })
    expect(real.untouched).toBe(true)
  })

  it('fails on an error object that arrived with a success status', async () => {
    const { held, out } = setup()
    out.json({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } })
    expect(await held.outcome).toMatchObject({ kind: 'failed', failure: { cause: 'stream-error', errorType: 'rate_limit_error' } })
  })

  it('fails on an error status and keeps what the upstream said about when to retry, even if the handler removed it', async () => {
    const { real, held, out } = setup()
    out.setHeader('retry-after', '120')
    out.status(429)
    out.removeHeader('retry-after')
    out.json({ type: 'error', error: { type: 'rate_limit_error', message: 'Too many requests' } })
    const outcome = await held.outcome
    expect(outcome).toMatchObject({ kind: 'failed', failure: { cause: 'http', status: 429 }, reply: { status: 429 } })
    if (outcome.kind === 'failed') {
      expect(outcome.reply.headers['retry-after']).toBe('120')
      expect(JSON.parse(outcome.reply.body).error.message).toBe('Too many requests')
    }
    expect(real.untouched).toBe(true)
  })

  it('keeps the headers an upstream error reported to it directly', async () => {
    const { held, out } = setup()
    ;(out as unknown as { noteUpstreamHeaders(h: Headers): void }).noteUpstreamHeaders(new Headers({ 'Retry-After': '30' }))
    out.status(503).json({ type: 'error', error: { type: 'api_error', message: 'down' } })
    const outcome = await held.outcome
    expect(outcome.kind === 'failed' && outcome.reply.headers['retry-after']).toBe('30')
  })

  it('reads a status error ended with plain text', async () => {
    const { held, out } = setup()
    out.status(502)
    out.end('Bad gateway')
    expect(await held.outcome).toMatchObject({ kind: 'failed', failure: { cause: 'http', status: 502 }, reply: { body: 'Bad gateway' } })
  })

  it('is judged whole however long it is, so a long answer is not mistaken for an empty one', async () => {
    const { real, held, out } = setup()
    const text = 'long answer '.repeat(40_000)
    const body = JSON.stringify(message([{ type: 'text', text }]))
    expect(body.length).toBeGreaterThan(256 * 1024)
    for (let at = 0; at < body.length; at += 50_000) out.write(body.slice(at, at + 50_000))
    out.end()
    expect(await held.outcome).toEqual({ kind: 'committed' })
    expect(real.chunks.join('')).toBe(body)
  })

  it('is sent unjudged once it is too large to hold, and passed through from then on', async () => {
    const { real, held, out } = setup({ maxJudgedBytes: 100 })
    out.write('{"type":"message","content":[')
    out.write('x'.repeat(200))
    expect(await held.outcome).toEqual({ kind: 'committed' })
    out.write('tail')
    out.end()
    expect(real.chunks.join('')).toContain('tail')
    expect(real.writableEnded).toBe(true)
  })

  it('keeps only the start of a large error body, which is all that is ever read of it', async () => {
    const { real, held, out } = setup()
    out.status(502)
    out.write('<html>' + 'x'.repeat(5 * 1024 * 1024))
    out.end()
    const outcome = await held.outcome
    expect(outcome).toMatchObject({ kind: 'failed', failure: { cause: 'http', status: 502 } })
    if (outcome.kind === 'failed') {
      expect(outcome.reply.body.length).toBeLessThanOrEqual(64 * 1024)
      expect(outcome.reply.body.startsWith('<html>')).toBe(true)
    }
    expect(real.untouched).toBe(true)
  })
})

describe('abandoning a reply', () => {
  it('tells the handler, drops later writes and leaves the connection alone', async () => {
    const { real, held, out, closed } = setup()
    openStream(out)
    out.write(start)
    held.abandon()
    expect(await held.outcome).toEqual({ kind: 'abandoned' })
    expect(closed).toHaveBeenCalledTimes(1)
    out.write(delta('late'))
    out.end()
    expect(real.untouched).toBe(true)
  })

  it('does nothing once the reply was sent', async () => {
    const { real, held, out, closed } = setup()
    openStream(out)
    out.write(start + textStart + delta('Hi'))
    await held.outcome
    held.abandon()
    expect(closed).not.toHaveBeenCalled()
    out.write(delta('more'))
    expect(real.chunks.at(-1)).toBe(delta('more'))
  })
})

describe('the connection closing', () => {
  it('reaches the handler after the reply was sent, so its upstream is released', async () => {
    const { real, held, out, closed } = setup()
    openStream(out)
    out.write(start + textStart + delta('Hi'))
    await held.outcome
    real.emit('close')
    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('does not reach a handler whose attempt already failed', async () => {
    const { real, held, out, closed } = setup()
    openStream(out)
    out.write(frame('error', { error: { type: 'api_error', message: 'x' } }))
    await held.outcome
    closed.mockClear()
    real.emit('close')
    expect(closed).not.toHaveBeenCalled()
  })
})

describe('after the reply was sent', () => {
  it('lets the handler use the connection as it would have directly', async () => {
    const { real, held, out } = setup()
    openStream(out)
    out.write(start + textStart + delta('Hi'))
    await held.outcome
    expect(out.hasHeader('content-type')).toBe(true)
    expect(out.statusCode).toBe(200)
    out.status(500)
    expect(real.statusCode).toBe(500)
  })
})
