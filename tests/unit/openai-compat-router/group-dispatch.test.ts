/**
 * A request served from a load-balancing group: which members are tried, what
 * the engine sees, and what the balancer learns. The model handlers are
 * scripted per member; everything between them and the engine is the real code.
 */

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = vi.hoisted(() => ({ messages: vi.fn() }))
vi.mock('../../../src/main/openai-compat-router/server/request-handler', () => ({
  handleMessagesRequest: handlers.messages,
  handleCountTokensRequest: vi.fn(),
}))

import { createBalancer } from '../../../src/main/openai-compat-router/balancing'
import { replaceGroupBalancer } from '../../../src/main/openai-compat-router/server/group-balancer'
import { onGroupRouteFact, type GroupRouteFact } from '../../../src/main/openai-compat-router/server/group-facts'
import {
  ATTEMPT_FIRST_CONTENT_TIMEOUT_MS,
  ATTEMPT_HEADERS_TIMEOUT_MS,
  handleGroupMessagesRequest,
  sessionKeyFor,
} from '../../../src/main/openai-compat-router/server/group-dispatch'
import type { GroupPlan } from '../../../src/main/openai-compat-router/server/request-groups'
import type { AnthropicRequest, BackendConfig } from '../../../src/main/openai-compat-router/types'

class Connection extends EventEmitter {
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
  get body() { return this.chunks.join('') }
  get json_() { return JSON.parse(this.body) }
}

type Response = Connection
type Script = (res: Response, config: BackendConfig, request: AnthropicRequest) => void | Promise<void>

const frame = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
const start = frame('message_start', { message: { id: 'm', content: [], usage: { input_tokens: 1, output_tokens: 0 } } })
const textBlock = frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
const delta = (text: string) => frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text } })
const stop = frame('content_block_stop', { index: 0 }) + frame('message_stop', {})

const answers = (text: string): Script => res => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.write(start + textBlock + delta(text) + stop)
  res.end()
}
const failsWith = (status: number, error = { type: 'api_error', message: `HTTP ${status}` }, headers: Record<string, string> = {}): Script => res => {
  res.status(status)
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
  res.json({ type: 'error', error })
}
const streamErrors = (type: string): Script => res => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.write(start + frame('error', { error: { type, message: `stream ${type}` } }))
  res.end()
}
const saysNothing: Script = res => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.write(start + textBlock + stop)
  res.end()
}
const hangs: Script = res => new Promise<void>(resolve => { res.on('close', resolve) })

function planOf(members: string[], strategy: GroupPlan['strategy'] = 'priority', options?: { reject?: Record<string, string> }): GroupPlan {
  return {
    id: 'g',
    name: 'Daily',
    strategy,
    members: members.map(id => ({
      member: { key: `${id}\u0000model`, sourceId: id, modelId: 'model' },
      label: { account: `Account ${id}`, model: 'Model' },
    })),
    async materialize(member) {
      const reason = options?.reject?.[member.sourceId]
      if (reason) throw new Error(reason)
      return { sourceId: member.sourceId, url: `https://${member.sourceId}.invalid/v1/chat/completions`, key: 'k', model: member.modelId }
    },
  }
}

const sessionConfig: BackendConfig = { sourceId: 'g', url: 'https://halo-group.invalid/v1/chat/completions', key: 'k', model: 'halo-auto', pickedReasoningEffort: 'high' }
const request = (extra: Partial<AnthropicRequest> = {}): AnthropicRequest =>
  ({ model: 'halo-auto', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'Hello there' }], ...extra }) as AnthropicRequest

const START = 1_700_000_000_000
let scripts: Record<string, Script>
let calls: string[]
let facts: GroupRouteFact[]
let unsubscribe: { dispose(): void }

beforeEach(() => {
  // The balancer and the messages that quote its times read the same clock.
  vi.useFakeTimers()
  vi.setSystemTime(START)
  scripts = {}
  calls = []
  facts = []
  replaceGroupBalancer(createBalancer())
  unsubscribe = onGroupRouteFact(fact => facts.push(fact))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  handlers.messages.mockReset()
  handlers.messages.mockImplementation(async (req: AnthropicRequest, config: BackendConfig, res: Response, options: unknown) => {
    calls.push(config.sourceId ?? config.url)
    const script = scripts[config.sourceId ?? '']
    if (!script) throw new Error(`no script for ${config.sourceId}`)
    return script(res, config, req)
  })
})

afterEach(() => {
  unsubscribe.dispose()
  replaceGroupBalancer(null)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function dispatch(plan: GroupPlan, req = request(), headers: Record<string, string> = {}) {
  const res = new Connection()
  await handleGroupMessagesRequest(req, sessionConfig, plan, res as never, { sdkHeaders: headers })
  return res
}

describe('a request that the first member answers', () => {
  it('sends its reply and tells nobody about alternatives', async () => {
    scripts = { a: answers('from a'), b: answers('from b') }
    const res = await dispatch(planOf(['a', 'b']))
    expect(res.body).toContain('from a')
    expect(calls).toEqual(['a'])
    expect(facts.map(f => [f.phase, f.member?.sourceId, f.attempt])).toEqual([['trying', 'a', 1], ['served', 'a', 1]])
    expect(facts[1].member?.label).toEqual({ account: 'Account a', model: 'Model' })
  })

  it('gives the handler the member\'s own credential and the session\'s reasoning pick', async () => {
    scripts = { a: answers('hi') }
    await dispatch(planOf(['a']))
    const config = handlers.messages.mock.calls[0][1] as BackendConfig
    expect(config).toMatchObject({ sourceId: 'a', url: 'https://a.invalid/v1/chat/completions', pickedReasoningEffort: 'high' })
  })

  it('hands every attempt its own copy of the request', async () => {
    scripts = {
      a: (res, _config, req) => { req.model = 'rewritten-by-a'; failsWith(500)(res, _config, req) },
      b: (res, config, req) => { expect(req.model).toBe('halo-auto'); answers('ok')(res, config, req) },
    }
    const original = request()
    const res = await dispatch(planOf(['a', 'b']), original)
    expect(res.body).toContain('ok')
    expect(original.model).toBe('halo-auto')
  })

  it('does not sign the reply of a member that failed early', async () => {
    scripts = { a: failsWith(503), b: answers('from b') }
    const res = await dispatch(planOf(['a', 'b']))
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain('HTTP 503')
  })
})

describe('moving on to the next member', () => {
  it.each([
    ['rate limited', failsWith(429, { type: 'rate_limit_error', message: 'slow down' }, { 'retry-after': '30' })],
    ['out of quota', failsWith(402, { type: 'billing_error', message: 'insufficient balance' })],
    ['rejected the key', failsWith(401, { type: 'authentication_error', message: 'bad key' })],
    ['broken', failsWith(500)],
    ['overloaded in the middle of the stream', streamErrors('overloaded_error')],
    ['an empty reply', saysNothing],
    ['a stream error of an unknown kind', streamErrors('weird_error')],
    ['a request it rejects', failsWith(400, { type: 'invalid_request_error', message: 'bad thinking parameter' })],
  ])('when the first member is %s', async (_label, failing) => {
    scripts = { a: failing, b: answers('from b') }
    const res = await dispatch(planOf(['a', 'b']))
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('from b')
    expect(calls).toEqual(['a', 'b'])
  })

  it('says why it left the first member', async () => {
    scripts = { a: failsWith(429, { type: 'rate_limit_error', message: 'slow down' }), b: answers('ok') }
    await dispatch(planOf(['a', 'b']))
    expect(facts.map(f => f.phase)).toEqual(['trying', 'trying', 'served'])
    expect(facts[1]).toMatchObject({ attempt: 2, member: { sourceId: 'b' }, previous: { member: { sourceId: 'a' }, reason: 'is limiting requests' } })
  })

  it('remembers what it learned for the next request', async () => {
    scripts = { a: failsWith(402), b: answers('ok') }
    await dispatch(planOf(['a', 'b']))
    calls.length = 0
    await dispatch(planOf(['a', 'b']))
    expect(calls).toEqual(['b'])
  })

  it('keeps a conversation on the member that served it', async () => {
    scripts = { a: failsWith(500), b: answers('from b') }
    const headers = { 'x-claude-code-session-id': 'conv-1' }
    await dispatch(planOf(['a', 'b']), request(), headers)
    scripts.a = answers('from a')
    calls.length = 0
    const res = await dispatch(planOf(['a', 'b']), request(), headers)
    expect(res.body).toContain('from b')
    expect(calls).toEqual(['b'])
  })

  it('treats an account whose credential cannot be had as a failed member', async () => {
    scripts = { a: answers('from a'), b: answers('from b') }
    const res = await dispatch(planOf(['a', 'b'], 'priority', { reject: { a: 'This account is signed out.' } }))
    expect(res.body).toContain('from b')
    expect(calls).toEqual(['b'])
    calls.length = 0
    await dispatch(planOf(['a', 'b'], 'priority', { reject: { a: 'This account is signed out.' } }))
    expect(calls).toEqual(['b'])
  })

  it('treats a handler that crashes as a failed member', async () => {
    scripts = { a: () => { throw new Error('boom') }, b: answers('from b') }
    const res = await dispatch(planOf(['a', 'b']))
    expect(res.body).toContain('from b')
  })

  it('never replays a reply that has begun', async () => {
    scripts = {
      a: async res => {
        res.setHeader('Content-Type', 'text/event-stream')
        res.write(start + textBlock + delta('half of an answ'))
        res.write(frame('error', { error: { type: 'overloaded_error', message: 'cut off' } }))
        res.end()
      },
      b: answers('from b'),
    }
    const res = await dispatch(planOf(['a', 'b']))
    expect(res.body).toContain('half of an answ')
    expect(res.body).not.toContain('from b')
    expect(calls).toEqual(['a'])
  })

  it('does not choose a member for a request the router answers itself', async () => {
    scripts = { a: answers('real') }
    const res = new Connection()
    handlers.messages.mockImplementation(async (_req: unknown, config: BackendConfig, out: Response) => {
      calls.push(`local:${config.sourceId}`)
      out.end('ready')
    })
    await handleGroupMessagesRequest(request({ messages: [{ role: 'user', content: 'Warmup' }] }), sessionConfig, planOf(['a']), res as never, {})
    expect(calls).toEqual(['local:g'])
    expect(facts).toEqual([])
  })
})

describe('when nobody can answer', () => {
  it('names each member that failed and passes on the last real error, forbidding the engine another round', async () => {
    scripts = { a: failsWith(429, { type: 'rate_limit_error', message: 'slow down' }), b: failsWith(500, { type: 'api_error', message: 'upstream broke' }), c: failsWith(503) }
    const res = await dispatch(planOf(['a', 'b', 'c']))
    expect(res.statusCode).toBe(503)
    expect(res.headers.get('x-should-retry')).toBe('false')
    const { error } = res.json_
    expect(error.message).toContain('All 3 models tried in "Daily" failed')
    expect(error.message).toContain('Account a / Model is limiting requests')
    expect(error.message).toContain('Account b / Model returned a server error')
    expect(error.message).toContain('HTTP 503')
    expect(facts.at(-1)).toMatchObject({ phase: 'exhausted', attempt: 3 })
  })

  it('spends no more than three attempts', async () => {
    scripts = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map(id => [id, failsWith(500)]))
    await dispatch(planOf(['a', 'b', 'c', 'd', 'e']))
    expect(calls).toEqual(['a', 'b', 'c'])
  })

  it('leaves the engine its own retries when only one member could be tried', async () => {
    scripts = { a: failsWith(503) }
    const res = await dispatch(planOf(['a']))
    expect(res.statusCode).toBe(503)
    expect(res.headers.has('x-should-retry')).toBe(false)
    expect(res.json_.error.message).toBe('HTTP 503')
  })

  it('still refuses a retry the provider itself ruled out', async () => {
    scripts = { a: failsWith(402, { type: 'billing_error', message: 'insufficient balance' }) }
    const res = await dispatch(planOf(['a']))
    expect(res.headers.get('x-should-retry')).toBe('false')
  })

  it('does not call anyone when every member is resting, and says when one may return', async () => {
    scripts = { a: failsWith(429, undefined, { 'retry-after': '600' }), b: failsWith(429, undefined, { 'retry-after': '300' }) }
    await dispatch(planOf(['a', 'b']))
    calls.length = 0
    const res = await dispatch(planOf(['a', 'b']))
    expect(calls).toEqual([])
    expect(res.statusCode).toBe(529)
    expect(res.json_.error.message).toMatch(/None of the models in "Daily" can be used right now.*5 minutes/)
    expect(res.headers.has('x-should-retry')).toBe(false)
  })

  it('reports credentials that could not be had when that is all there was', async () => {
    const res = await dispatch(planOf(['a'], 'priority', { reject: { a: 'This account is signed out.' } }))
    expect(res.statusCode).toBe(401)
    expect(res.json_.error.message).toBe('This account is signed out.')
  })
})

describe('releasing balancing evidence', () => {
  it('finishes the run even when dispatch exits unexpectedly', async () => {
    const balancer = createBalancer()
    const plan = planOf(['a'])
    const run = balancer.start({ id: plan.id, strategy: plan.strategy, members: plan.members.map(entry => entry.member) }, 'session')
    const finish = vi.spyOn(run, 'finish')
    vi.spyOn(run, 'next').mockImplementation(() => { throw new Error('dispatch interrupted') })
    vi.spyOn(balancer, 'start').mockReturnValue(run)
    replaceGroupBalancer(balancer)
    await expect(dispatch(plan)).rejects.toThrow('dispatch interrupted')
    expect(finish).toHaveBeenCalledTimes(1)
  })
})

describe('the caller going away', () => {
  it('stops at once, lets the handler release its upstream, and writes nothing', async () => {
    const released = vi.fn()
    scripts = {
      a: async res => { await new Promise<void>(resolve => res.on('close', resolve)); released() },
      b: answers('from b'),
    }
    const res = new Connection()
    const done = handleGroupMessagesRequest(request(), sessionConfig, planOf(['a', 'b']), res as never, {})
    await vi.waitFor(() => expect(calls).toEqual(['a']))
    res.emit('close')
    await done
    expect(released).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['a'])
    expect(res.chunks).toEqual([])
    expect(facts.at(-1)?.phase).toBe('trying')
  })

  it('leaves the member unjudged, even when it reports a failure just as the caller goes', async () => {
    scripts = {
      a: async (res, config, req) => {
        await new Promise<void>(resolve => res.on('close', resolve))
        failsWith(401, { type: 'authentication_error', message: 'bad key' })(res, config, req)
      },
      b: answers('from b'),
    }
    const res = new Connection()
    const done = handleGroupMessagesRequest(request(), sessionConfig, planOf(['a', 'b']), res as never, {})
    await vi.waitFor(() => expect(calls).toEqual(['a']))
    res.emit('close')
    await done
    // A key the provider rejected would rest the whole account for minutes; nothing was learned.
    scripts.a = answers('from a')
    calls.length = 0
    await dispatch(planOf(['a', 'b']))
    expect(calls).toEqual(['a'])
  })

  it('stops, and learns nothing, when the caller goes while a model\'s credential is being prepared', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const plan = planOf(['a', 'b'])
    const materialize = plan.materialize
    plan.materialize = async member => { await gate; return materialize(member) }
    scripts = { a: answers('from a'), b: answers('from b') }
    const res = new Connection()
    const done = handleGroupMessagesRequest(request(), sessionConfig, plan, res as never, {})
    res.emit('close')
    release()
    await done
    expect(calls).toEqual([])
    expect(res.chunks).toEqual([])
    await dispatch(planOf(['a', 'b']))
    expect(calls).toEqual(['a'])
  })

  it('lets a reply that has begun finish and then forget the connection', async () => {
    let finish!: () => void
    scripts = {
      a: async res => {
        res.setHeader('Content-Type', 'text/event-stream')
        res.write(start + textBlock + delta('hello'))
        await new Promise<void>(resolve => { finish = resolve })
        res.write(delta(' world') + stop)
        res.end()
      },
    }
    const res = new Connection()
    const done = handleGroupMessagesRequest(request(), sessionConfig, planOf(['a']), res as never, {})
    await vi.waitFor(() => expect(res.body).toContain('hello'))
    finish()
    await done
    expect(res.body).toContain('"text":"hello"')
    expect(res.body).toContain('"text":" world"')
    res.emit('close')
    expect(res.listenerCount('close')).toBe(0)
  })
})

describe('how long a member may take', () => {
  const timeoutsSeen = () => handlers.messages.mock.calls.map(call => (call[3] as { timeoutMs?: number; headersTimeoutMs?: number }).headersTimeoutMs ?? (call[3] as { timeoutMs?: number }).timeoutMs)

  it('shortens the wait for a streamed reply while another member is behind it', async () => {
    scripts = { a: failsWith(500), b: failsWith(500), c: answers('ok') }
    await dispatch(planOf(['a', 'b', 'c']))
    expect(timeoutsSeen()).toEqual([ATTEMPT_HEADERS_TIMEOUT_MS, ATTEMPT_HEADERS_TIMEOUT_MS, undefined])
  })

  it('never shortens the wait of the last chance or of a single member', async () => {
    scripts = { a: failsWith(500), b: answers('ok') }
    await dispatch(planOf(['a', 'b']))
    expect(timeoutsSeen()).toEqual([ATTEMPT_HEADERS_TIMEOUT_MS, undefined])
    handlers.messages.mockClear()
    scripts = { a: answers('ok') }
    await dispatch(planOf(['a']))
    expect(timeoutsSeen()).toEqual([undefined])
  })

  it('never shortens the wait for a reply that is not streamed', async () => {
    scripts = { a: failsWith(500), b: failsWith(500), c: answers('ok') }
    await dispatch(planOf(['a', 'b', 'c']), request({ stream: false }))
    expect(timeoutsSeen()).toEqual([undefined, undefined, undefined])
  })

  it('keeps the provider response timeout separate from the group header deadline', async () => {
    scripts = { a: answers('ok'), b: answers('backup') }
    const res = new Connection()
    await handleGroupMessagesRequest(request(), sessionConfig, planOf(['a', 'b']), res as never, { timeoutMs: 600_000 })
    expect(handlers.messages.mock.calls[0][3]).toMatchObject({
      timeoutMs: 600_000, headersTimeoutMs: ATTEMPT_HEADERS_TIMEOUT_MS,
    })
  })

  it('does not lengthen a wait the caller already shortened', async () => {
    scripts = { a: failsWith(500), b: answers('ok') }
    const res = new Connection()
    await handleGroupMessagesRequest(request(), sessionConfig, planOf(['a', 'b']), res as never, { timeoutMs: 5_000 })
    expect(timeoutsSeen()).toEqual([5_000, 5_000])
  })

  it('moves on when a streamed reply opens but never says anything', async () => {
    scripts = {
      a: res => { res.setHeader('Content-Type', 'text/event-stream'); res.write(start); return new Promise<void>(resolve => res.on('close', resolve)) },
      b: answers('from b'),
    }
    const res = new Connection()
    const done = handleGroupMessagesRequest(request(), sessionConfig, planOf(['a', 'b']), res as never, {})
    await vi.waitFor(() => expect(calls).toEqual(['a']))
    await vi.advanceTimersByTimeAsync(ATTEMPT_FIRST_CONTENT_TIMEOUT_MS + 1)
    await done
    expect(res.body).toContain('from b')
    expect(calls).toEqual(['a', 'b'])
  })

  it('waits as long as it takes for the last chance', async () => {
    scripts = {
      a: res => { res.setHeader('Content-Type', 'text/event-stream'); res.write(start); return new Promise<void>(resolve => res.on('close', resolve)) },
    }
    const res = new Connection()
    const done = handleGroupMessagesRequest(request(), sessionConfig, planOf(['a']), res as never, {})
    await vi.waitFor(() => expect(calls).toEqual(['a']))
    await vi.advanceTimersByTimeAsync(ATTEMPT_FIRST_CONTENT_TIMEOUT_MS * 3)
    expect(res.chunks).toEqual([])
    res.emit('close')
    await done
  })
})

describe('knowing the conversation', () => {
  it('uses the session header an engine sends', () => {
    expect(sessionKeyFor(request(), { 'x-claude-code-session-id': 'conv-1' })).toBe('conv-1')
    expect(sessionKeyFor(request(), { session_id: 'thread-9' })).toBe('thread-9')
  })

  it('falls back to the opening message, the same for every request of a conversation', () => {
    const first = sessionKeyFor(request({ messages: [{ role: 'user', content: 'Plan my trip' }] }))
    const later = sessionKeyFor(request({ messages: [
      { role: 'user', content: 'Plan my trip' },
      { role: 'assistant', content: 'Where to?' },
      { role: 'user', content: 'Rome' },
    ] }))
    expect(first).toMatch(/^opening:/)
    expect(later).toBe(first)
    expect(sessionKeyFor(request({ messages: [{ role: 'user', content: 'Something else' }] }))).not.toBe(first)
  })

  it('has no key for a request with nothing to go by', () => {
    expect(sessionKeyFor(request({ messages: [] }))).toBeNull()
  })

  it('keeps a spread group\'s conversations on different members', async () => {
    scripts = { a: answers('from a'), b: answers('from b') }
    const plan = planOf(['a', 'b'], 'spread')
    const first = await dispatch(plan, request(), { 'x-claude-code-session-id': 'one' })
    const second = await dispatch(plan, request(), { 'x-claude-code-session-id': 'two' })
    expect(first.body).toContain('from a')
    expect(second.body).toContain('from b')
    const again = await dispatch(plan, request(), { 'x-claude-code-session-id': 'one' })
    expect(again.body).toContain('from a')
  })
})
