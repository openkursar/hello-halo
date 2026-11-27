import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Agent, request } from 'node:http'

const mocks = vi.hoisted(() => ({
  browser: vi.fn(async (_ctx: unknown, command: string, _args?: unknown, _signal?: AbortSignal) => ({ command })),
  fetch: vi.fn(async (_grant: unknown, _request: unknown, _signal: AbortSignal) => ({ ok: true })),
}))
vi.mock('electron', () => ({}))
vi.mock('../../../src/main/services/ai-browser', () => ({
  browserContextOfServer: (server: any) => server?.ctx,
}))
vi.mock('../../../src/main/services/browser-program-host/browser', () => ({ runBrowserCommand: mocks.browser }))
vi.mock('../../../src/main/services/browser-program-host/helpers', () => ({ runAdapterHelper: vi.fn(async () => ({ helper: true })) }))
vi.mock('../../../src/main/services/browser-program-host/page', () => ({ runPageAdapter: vi.fn(async () => ({ page: true })) }))
vi.mock('../../../src/main/services/browser-program-host/fetch', async importActual => ({
  ...(await importActual<typeof import('../../../src/main/services/browser-program-host/fetch')>()),
  fetchForAdapter: mocks.fetch,
}))

import { applyProgramHostEnvironment } from '../../../src/main/services/browser-program-host'
import { closeServer } from '../../../src/main/services/browser-program-host/server'

function context() {
  let active: string | null = 'user-page'
  return {
    isReleased: false,
    beginToolCall: vi.fn(), endToolCall: vi.fn(),
    getActiveViewId: () => active,
    setActiveViewId: vi.fn((id: string) => { active = id }),
    canReachView: () => true,
    moveTo(id: string) { active = id },
  }
}

async function hostFor(ctx: object) {
  const env: Record<string, string | number | undefined> = {}
  await applyProgramHostEnvironment(env, { 'ai-browser': { ctx } })
  return { endpoint: String(env.WEBCLI_HOST_ENDPOINT), token: String(env.WEBCLI_HOST_TOKEN) }
}

interface Reply { status: number; body: any }
function call(host: { endpoint: string; token: string }, payload: object, options: { agent?: Agent; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Reply> {
  const body = JSON.stringify({ schemaVersion: 1, ...payload })
  return new Promise((resolve, reject) => {
    const req = request(host.endpoint, {
      method: 'POST', agent: options.agent, signal: options.signal,
      headers: { authorization: `Bearer ${host.token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...options.headers },
    }, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

const prepare = { operation: 'adapter.prepare', name: 'example.com', commandId: 'read', hosts: ['example.com'], write: false, confirmed: false }
const keepAlive = () => new Agent({ keepAlive: true })

beforeEach(() => { vi.clearAllMocks() })
afterEach(async () => { await closeServer() })

describe('browser program host environment', () => {
  it('lends the browser of the mounted AI Browser server and nothing otherwise', async () => {
    const ctx = context()
    const env: Record<string, string | number | undefined> = { WEBCLI_HOST_ENDPOINT: 'inherited', WEBCLI_HOST_TOKEN: 'inherited', KEEP: '1' }
    await applyProgramHostEnvironment(env, { 'web-search': {}, 'ai-browser': { ctx } })
    expect(env.WEBCLI_HOST_ENDPOINT).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/webcli\/v1$/)
    expect(env.WEBCLI_HOST_TOKEN).toMatch(/^[a-f0-9]{64}$/)
    const again: Record<string, string | number | undefined> = {}
    await applyProgramHostEnvironment(again, { 'ai-browser': { ctx } })
    expect(again.WEBCLI_HOST_TOKEN).toBe(env.WEBCLI_HOST_TOKEN)

    const withoutBrowser: Record<string, string | number | undefined> = { WEBCLI_HOST_ENDPOINT: 'inherited', WEBCLI_HOST_TOKEN: 'inherited', KEEP: '1' }
    await applyProgramHostEnvironment(withoutBrowser, { 'web-search': {} })
    expect(withoutBrowser).toEqual({ KEEP: '1' })
    const released: Record<string, string | number | undefined> = {}
    await applyProgramHostEnvironment(released, { 'ai-browser': { ctx: { ...context(), isReleased: true } } })
    expect(released).toEqual({})
  })
})

describe('browser program host endpoint', () => {
  it('answers only its token, without browser markers, on its own host name', async () => {
    const host = await hostFor(context())
    expect((await call(host, { operation: 'browser', command: 'doctor', args: {} })).body).toMatchObject({ ok: true, result: { command: 'doctor' } })
    for (const headers of <Record<string, string>[]>[{ authorization: `Bearer ${'0'.repeat(64)}` }, { origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { host: 'localhost' }]) {
      const reply = await call(host, { operation: 'browser', command: 'doctor', args: {} }, { headers })
      expect(reply.status).toBe(403)
      expect(reply.body.error.code).toBe('HOST_ACCESS_DENIED')
    }
  })

  it('retires the token when its browser is released', async () => {
    const ctx = context()
    const host = await hostFor(ctx)
    ctx.isReleased = true
    expect((await call(host, { operation: 'browser', command: 'doctor', args: {} })).status).toBe(403)
    ctx.isReleased = false
    expect((await call(host, { operation: 'browser', command: 'doctor', args: {} })).status).toBe(403)
  })

  it('shows the AI as operating and gives the AI its page back after an Adapter request', async () => {
    const ctx = context()
    mocks.fetch.mockImplementationOnce(async () => { ctx.moveTo('adapter-page'); return { ok: true } })
    const host = await hostFor(ctx)
    const agent = keepAlive()
    await call(host, prepare, { agent })
    expect((await call(host, { operation: 'adapter.fetch', url: 'https://example.com/' }, { agent })).body.ok).toBe(true)
    expect(ctx.getActiveViewId()).toBe('user-page')
    expect(ctx.beginToolCall).toHaveBeenCalledTimes(2)
    expect(ctx.endToolCall).toHaveBeenCalledTimes(2)
    agent.destroy()
  })

  it('refuses a second program while the first one holds its call, then serves it once that program is gone', async () => {
    const host = await hostFor(context())
    const first = keepAlive()
    const second = keepAlive()
    expect((await call(host, prepare, { agent: first })).body).toMatchObject({ ok: true, result: { ready: true } })
    expect((await call(host, prepare, { agent: second })).body.error.code).toBe('HOST_BUSY')
    expect((await call(host, { operation: 'adapter.fetch', url: 'https://example.com/' }, { agent: second })).body.error.code).toBe('HOST_BUSY')
    expect((await call(host, prepare, { agent: first })).body.error.code).toBe('HOST_GRANT_EXISTS')
    first.destroy()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect((await call(host, prepare, { agent: second })).body.ok).toBe(true)
    second.destroy()
  })

  it('continues a call whose program reconnected after its idle connection closed', async () => {
    const host = await hostFor(context())
    const first = keepAlive()
    await call(host, prepare, { agent: first })
    first.destroy()
    await new Promise(resolve => setTimeout(resolve, 50))
    const reconnected = keepAlive()
    expect((await call(host, { operation: 'adapter.fetch', url: 'https://example.com/' }, { agent: reconnected })).body.ok).toBe(true)
    expect(mocks.fetch).toHaveBeenCalledWith(expect.objectContaining({ name: 'example.com', hosts: ['example.com'] }), expect.anything(), expect.anything())
    reconnected.destroy()
  })

  it('requires a prepared call before Adapter requests and rejects a mismatched one', async () => {
    const host = await hostFor(context())
    expect((await call(host, { operation: 'adapter.fetch', url: 'https://example.com/' })).body.error.code).toBe('HOST_GRANT_MISSING')
    expect((await call(host, { ...prepare, invokedCommand: 'other.read' })).body.error.code).toBe('HOST_CALL_MISMATCH')
    expect((await call(host, { operation: 'unknown' })).body.error.code).toBe('HOST_UNSUPPORTED_OPERATION')
  })

  it('serves one request at a time and stops a request whose program disconnects', async () => {
    let seen: AbortSignal | undefined
    let release!: () => void
    mocks.browser.mockImplementationOnce(async (_ctx, _command, _args, signal) => {
      seen = signal
      await new Promise<void>(resolve => { release = resolve; signal?.addEventListener('abort', () => resolve()) })
      return { command: 'slow' }
    })
    const host = await hostFor(context())
    const controller = new AbortController()
    const slow = call(host, { operation: 'browser', command: 'state', args: {} }, { signal: controller.signal }).catch(error => error)
    await vi.waitFor(() => expect(seen).toBeDefined())
    expect((await call(host, { operation: 'browser', command: 'doctor', args: {} })).body.error.code).toBe('HOST_BUSY')
    controller.abort()
    await slow
    await vi.waitFor(() => expect(seen!.aborted).toBe(true))
    release()
    await vi.waitFor(async () => expect((await call(host, { operation: 'browser', command: 'doctor', args: {} })).body.ok).toBe(true))
  })
})
