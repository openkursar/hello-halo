/**
 * A load-balancing group over real HTTP: the engine's request reaches the
 * router's Express app, the real handlers talk to scripted upstreams, and the
 * engine reads whatever the router sends back. Only the outgoing fetch is
 * replaced; everything between the two sockets is production code.
 */

import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { EventEmitter } from 'node:events'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type Upstream = (init: RequestInit, url: string) => Response | Promise<Response>
const upstreams = new Map<string, Upstream>()
const seen: Array<{ host: string; body: Record<string, unknown>; signal?: AbortSignal | null }> = []

vi.mock('../../../src/main/services/proxy-fetch', () => ({
  proxyFetch: async (url: string, init: RequestInit) => {
    const host = new URL(url).hostname
    const upstream = upstreams.get(host)
    if (!upstream) throw new Error(`no upstream for ${host}`)
    seen.push({ host, body: JSON.parse(String(init.body ?? '{}')), signal: init.signal })
    return upstream(init, url)
  },
}))

import { createBalancer } from '../../../src/main/openai-compat-router/balancing'
import { encodeBackendConfig } from '../../../src/main/openai-compat-router/utils'
import { createApp } from '../../../src/main/openai-compat-router/server/router'
import { replaceGroupBalancer } from '../../../src/main/openai-compat-router/server/group-balancer'
import { setGroupPlanResolver, type GroupPlan } from '../../../src/main/openai-compat-router/server/request-groups'
import type { AnthropicRequest, BackendConfig } from '../../../src/main/openai-compat-router/types'
import { eventStreamFrame } from '../../e2e/fixtures/acceptance-kiro-upstream'
import { handleGroupMessagesRequest } from '../../../src/main/openai-compat-router/server/group-dispatch'

const CONFIGS: Record<string, BackendConfig> = {
  openai: { sourceId: 'openai', url: 'http://openai.test/v1/chat/completions', key: 'k1', model: 'gpt-x', apiType: 'chat_completions' },
  claude: { sourceId: 'claude', url: 'http://claude.test/v1/messages', key: 'k2', model: 'claude-x', apiType: 'anthropic_passthrough' },
  backup: { sourceId: 'backup', url: 'http://backup.test/v1/chat/completions', key: 'k3', model: 'backup-x', apiType: 'chat_completions' },
  kiro: { sourceId: 'kiro', url: 'http://kiro.test/generateAssistantResponse', key: 'k4', model: 'claude-sonnet-4', apiType: 'kiro' },
}

function planOf(...ids: Array<keyof typeof CONFIGS>): GroupPlan {
  return {
    id: 'group-1',
    name: 'Daily',
    strategy: 'priority',
    members: ids.map(id => ({
      member: { key: `${id}\u0000m`, sourceId: id, modelId: 'm' },
      label: { account: id, model: CONFIGS[id].model ?? 'm' },
    })),
    materialize: async member => CONFIGS[member.sourceId],
  }
}

const sse = (...events: string[]) =>
  new Response(new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      for (const event of events) controller.enqueue(encoder.encode(event))
      controller.close()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })

const openAiChunk = (delta: object, finish: string | null = null, usage?: object) =>
  `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: 'gpt-x', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`
const openAiText = (text: string) => sse(
  openAiChunk({ role: 'assistant', content: '' }),
  openAiChunk({ content: text }),
  openAiChunk({}, 'stop', { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }),
  'data: [DONE]\n\n',
)

const anthropicFrame = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
const anthropicText = (text: string) => sse(
  anthropicFrame('message_start', { message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'claude-x', usage: { input_tokens: 3, output_tokens: 0 } } }),
  anthropicFrame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  anthropicFrame('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }),
  anthropicFrame('content_block_stop', { index: 0 }),
  anthropicFrame('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }),
  anthropicFrame('message_stop', {}),
)

const json = (status: number, body: object, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

let server: Server
let baseUrl: string

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const app = createApp()
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  vi.restoreAllMocks()
})

beforeEach(() => {
  upstreams.clear()
  seen.length = 0
  replaceGroupBalancer(createBalancer())
})

afterEach(() => {
  vi.useRealTimers()
  setGroupPlanResolver(null)
  replaceGroupBalancer(null)
})

async function ask(plan: GroupPlan, options: { stream?: boolean; session?: string; signal?: AbortSignal; text?: string } = {}) {
  setGroupPlanResolver(() => plan)
  const key = encodeBackendConfig({ sourceId: plan.id, url: 'https://halo-group.invalid/v1/chat/completions', key: 'k', model: 'halo-auto', apiType: 'chat_completions' })
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'x-claude-code-session-id': options.session ?? 'conv-1' },
    body: JSON.stringify({ model: 'halo-auto', max_tokens: 100, stream: options.stream ?? true, messages: [{ role: 'user', content: options.text ?? 'hello' }] }),
    signal: options.signal,
  })
  return { response, text: await response.text() }
}

const hosts = () => seen.map(call => call.host.replace('.test', ''))

/** Real handlers with virtual time, without making an HTTP socket wait for that clock. */
class TimedConnection extends EventEmitter {
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
  end(chunk?: string | Buffer) { if (chunk) this.write(chunk); this.writableEnded = true; this.emit('close'); return this }
  json(body: unknown) { this.setHeader('content-type', 'application/json'); return this.end(JSON.stringify(body)) }
}

const kiroContent = (text: string) => eventStreamFrame(
  { ':message-type': 'event', ':event-type': 'assistantResponseEvent', ':content-type': 'application/json' },
  { content: text },
)

function timedAsk(res: TimedConnection) {
  return handleGroupMessagesRequest(
    { model: 'halo-auto', stream: true, max_tokens: 100, messages: [{ role: 'user', content: 'hello' }] } as AnthropicRequest,
    { url: 'https://halo-group.invalid/v1/chat/completions', key: 'fixture', model: 'halo-auto' },
    planOf('kiro', 'backup'), res as never, {},
  )
}

describe('Kiro group deadlines through the real handler', () => {
  it('allows an answer already started to finish after the group header deadline', async () => {
    vi.useFakeTimers()
    let body!: ReadableStreamDefaultController<Uint8Array>
    upstreams.set('kiro.test', init => new Response(new ReadableStream({
      start(controller) {
        body = controller
        controller.enqueue(kiroContent('Kiro has already started answering.'))
        init.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true })
      },
    })))
    upstreams.set('backup.test', () => openAiText('backup'))
    const res = new TimedConnection()
    const done = timedAsk(res)
    await vi.advanceTimersByTimeAsync(0)
    expect(res.chunks.join('')).toContain('Kiro has already started answering.')
    await vi.advanceTimersByTimeAsync(91_000)
    expect(seen[0].signal?.aborted).toBe(false)
    expect(res.writableEnded).toBe(false)
    body.close()
    await done
    expect(res.chunks.join('')).toContain('event: message_stop')
    expect(res.writableEnded).toBe(true)
    expect(hosts()).toEqual(['kiro'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('still passes over Kiro when response headers never arrive', async () => {
    vi.useFakeTimers()
    upstreams.set('kiro.test', init => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    upstreams.set('backup.test', () => openAiText('backup answered'))
    const res = new TimedConnection()
    const done = timedAsk(res)
    await vi.advanceTimersByTimeAsync(90_000)
    await done
    expect(hosts()).toEqual(['kiro', 'backup'])
    expect(res.chunks.join('')).toContain('backup answered')
    // The OpenAI handler schedules its input-token estimate with setImmediate.
    await vi.advanceTimersByTimeAsync(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps Kiro\'s original full-response deadline after content begins', async () => {
    vi.useFakeTimers()
    upstreams.set('kiro.test', init => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(kiroContent('Kiro has started but does not finish.'))
        init.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true })
      },
    })))
    const res = new TimedConnection()
    const done = timedAsk(res)
    await vi.advanceTimersByTimeAsync(599_999)
    expect(seen[0].signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(seen[0].signal?.aborted).toBe(true)
    expect(hosts()).toEqual(['kiro'])
    expect(res.writableEnded).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('a group on the wire', () => {
  it('sends the first member\'s reply, translated for the engine', async () => {
    upstreams.set('openai.test', () => openAiText('hello from openai'))
    const { response, text } = await ask(planOf('openai', 'claude'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(text).toContain('hello from openai')
    expect(text).toContain('event: message_start')
    expect(hosts()).toEqual(['openai'])
    expect(seen[0].body.model).toBe('gpt-x')
  })

  it('moves to the next member when the first is rate limited, without the engine ever seeing the 429', async () => {
    upstreams.set('openai.test', () => json(429, { error: { type: 'rate_limit_error', message: 'Too many requests' } }, { 'retry-after': '120' }))
    upstreams.set('claude.test', () => anthropicText('hello from claude'))
    const { response, text } = await ask(planOf('openai', 'claude'))
    expect(response.status).toBe(200)
    expect(text).toContain('hello from claude')
    expect(text).not.toContain('Too many requests')
    expect(hosts()).toEqual(['openai', 'claude'])
    expect(seen[1].body.model).toBe('claude-x')
  })

  it('remembers that the first member is resting, and where the conversation went', async () => {
    upstreams.set('openai.test', () => json(429, { error: { type: 'rate_limit_error', message: 'Too many requests' } }, { 'retry-after': '120' }))
    upstreams.set('claude.test', () => anthropicText('from claude'))
    await ask(planOf('openai', 'claude'))
    seen.length = 0
    const { text } = await ask(planOf('openai', 'claude'))
    expect(text).toContain('from claude')
    expect(hosts()).toEqual(['claude'])
  })

  it('moves on when an upstream answers 200 and then reports an error before saying anything', async () => {
    upstreams.set('openai.test', () => sse(
      openAiChunk({ role: 'assistant', content: '' }),
      `data: ${JSON.stringify({ error: { message: 'The server is overloaded', type: 'overloaded_error' } })}\n\n`,
    ))
    upstreams.set('claude.test', () => anthropicText('from claude'))
    const { response, text } = await ask(planOf('openai', 'claude'))
    expect(response.status).toBe(200)
    expect(text).toContain('from claude')
    expect(hosts()).toEqual(['openai', 'claude'])
  })

  it('moves on when an upstream answers 200 and says nothing at all', async () => {
    upstreams.set('openai.test', () => sse(
      openAiChunk({ role: 'assistant', content: '' }),
      openAiChunk({}, 'stop', { prompt_tokens: 3, completion_tokens: 0, total_tokens: 3 }),
      'data: [DONE]\n\n',
    ))
    upstreams.set('claude.test', () => anthropicText('from claude'))
    const { text } = await ask(planOf('openai', 'claude'))
    expect(text).toContain('from claude')
    expect(hosts()).toEqual(['openai', 'claude'])
  })

  it('moves on when the first upstream cannot be reached', async () => {
    upstreams.set('claude.test', () => anthropicText('from claude'))
    const { text } = await ask(planOf('backup', 'claude'))
    expect(text).toContain('from claude')
  })

  it('never replays an answer that has begun, even if it is cut short', async () => {
    upstreams.set('openai.test', () => new Response(new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        controller.enqueue(encoder.encode(openAiChunk({ role: 'assistant', content: '' })))
        controller.enqueue(encoder.encode(openAiChunk({ content: 'half an answ' })))
        // Erroring a stream throws away what the reader has not taken yet.
        setTimeout(() => controller.error(new Error('connection reset')), 50)
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    upstreams.set('claude.test', () => anthropicText('from claude'))
    const { text } = await ask(planOf('openai', 'claude'))
    expect(text).toContain('half an answ')
    expect(text).not.toContain('from claude')
    expect(hosts()).toEqual(['openai'])
  })

  it('passes on the last error and forbids the engine another round when every member failed', async () => {
    upstreams.set('openai.test', () => json(500, { error: { type: 'server_error', message: 'internal error' } }))
    upstreams.set('claude.test', () => json(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }))
    const { response, text } = await ask(planOf('openai', 'claude'))
    expect(response.status).toBe(529)
    expect(response.headers.get('x-should-retry')).toBe('false')
    expect(JSON.parse(text).error.message).toContain('All 2 models tried in "Daily" failed')
    expect(JSON.parse(text).error.message).toContain('Overloaded')
  })

  it('answers a request that is not streamed the same way', async () => {
    upstreams.set('openai.test', () => json(503, { error: { type: 'server_error', message: 'down' } }))
    upstreams.set('claude.test', () => json(200, {
      id: 'm', type: 'message', role: 'assistant', model: 'claude-x', stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'whole answer' }], usage: { input_tokens: 3, output_tokens: 2 },
    }))
    const { response, text } = await ask(planOf('openai', 'claude'), { stream: false })
    expect(response.status).toBe(200)
    expect(JSON.parse(text).content[0].text).toBe('whole answer')
  })

  it('ends a non-streaming answer that crosses the whole-reply buffer limit', async () => {
    const answer = 'x'.repeat(8 * 1024 * 1024 + 1)
    upstreams.set('claude.test', () => json(200, {
      id: 'm', type: 'message', role: 'assistant', model: 'claude-x', stop_reason: 'end_turn',
      content: [{ type: 'text', text: answer }], usage: { input_tokens: 3, output_tokens: 2 },
    }))
    const { response, text } = await ask(planOf('claude'), { stream: false, signal: AbortSignal.timeout(5_000) })
    expect(response.status).toBe(200)
    expect(JSON.parse(text).content[0].text).toBe(answer)
    expect(hosts()).toEqual(['claude'])
  })

  it('moves on from a non-streamed 200 that carries an error', async () => {
    upstreams.set('claude.test', () => json(200, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }))
    upstreams.set('backup.test', () => json(200, {
      id: 'c', object: 'chat.completion', model: 'backup-x',
      choices: [{ index: 0, message: { role: 'assistant', content: 'from backup' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }))
    const { response, text } = await ask(planOf('claude', 'backup'), { stream: false })
    expect(response.status).toBe(200)
    expect(JSON.parse(text).content[0].text).toBe('from backup')
  })

  it('releases the upstream when the engine goes away', async () => {
    let started!: () => void
    const reached = new Promise<void>(resolve => { started = resolve })
    upstreams.set('openai.test', (init) => {
      started()
      return new Response(new ReadableStream({
        start(controller) {
          init.signal?.addEventListener('abort', () => controller.error(new Error('aborted')))
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })
    upstreams.set('claude.test', () => anthropicText('from claude'))
    const abort = new AbortController()
    const pending = ask(planOf('openai', 'claude'), { signal: abort.signal }).catch(() => null)
    await reached
    abort.abort()
    await pending
    await vi.waitFor(() => expect(seen[0].signal?.aborted).toBe(true))
    expect(hosts()).toEqual(['openai'])
  })

  it('answers a warmup itself without asking any member', async () => {
    const { response, text } = await ask(planOf('openai', 'claude'), { text: 'Warmup' })
    expect(response.status).toBe(200)
    expect(text).toContain('Ready.')
    expect(seen).toEqual([])
  })

  it('answers a conversation whose group was deleted with a clear message', async () => {
    setGroupPlanResolver(() => null)
    const key = encodeBackendConfig({ sourceId: 'gone', url: 'https://halo-group.invalid/v1/chat/completions', key: 'k', model: 'halo-auto', apiType: 'chat_completions' })
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ model: 'halo-auto', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(response.status).toBe(404)
    expect((await response.json()).error.message).toContain('no longer exists')
  })
})
