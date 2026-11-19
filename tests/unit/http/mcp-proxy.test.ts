import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import { createServer, request, type Server, type IncomingHttpHeaders, type RequestListener } from 'http'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { attachMcpProxy, loadMcpProxyConfig, parseMcpProxyConfig } from '../../../src/main/http/mcp-proxy'

const servers: Server[] = []
const disposers: Array<() => void> = []
const token = 'fixture-reader-token'
const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
async function listen(server: Server): Promise<string> {
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
}
async function setup(handler: RequestListener, settings: Record<string, unknown> = {}) {
  const target = await listen(createServer(handler))
  const app = express()
  const config = { path: '/mcp/knowledge', upstream: target + '/mcp', allowedHosts: ['public.example'], allowedOrigins: ['https://public.example'], ...settings }
  disposers.push(attachMcpProxy(app, parseMcpProxyConfig(config)))
  app.use(express.json())
  app.get('/api/status', (_req, res) => res.json({ halo: true }))
  app.use((_req, res) => res.type('html').send('SPA'))
  const base = await listen(createServer(app))
  const send = (path = '/mcp/knowledge', extra: { method?: string; headers?: IncomingHttpHeaders; body?: string } = {}) => new Promise<{ status: number; body: string; headers: IncomingHttpHeaders }>((resolve, reject) => {
    const req = request(base + path, { method: extra.method ?? 'POST', headers: { ...headers, host: 'public.example', ...extra.headers } }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(extra.body ?? (extra.method && extra.method !== 'POST' ? undefined : '{}'))
  })
  return { base, target, send }
}
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  vi.restoreAllMocks()
})
const reply = (_req: unknown, res: any) => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true}') }

describe('MCP proxy configuration', () => {
  const valid = { path: '/mcp/knowledge', upstream: 'http://127.0.0.1:8787/mcp', allowedHosts: ['public.example'] }
  it('is disabled without a deployment config and has bounded defaults', () => {
    expect(loadMcpProxyConfig({})).toBeNull()
    expect(parseMcpProxyConfig(valid)).toMatchObject({ timeoutMs: 60000, maxConcurrent: 16, maxRequestBytes: 1048576, allowedOrigins: [] })
    expect(parseMcpProxyConfig({ ...valid, path: '/mcp/department', upstream: 'http://[::1]:8787/mcp' }).path).toBe('/mcp/department')
  })
  it.each([
    { upstream: 'http://example.com/mcp' }, { upstream: 'http://localhost:8787/mcp' },
    { upstream: 'http://127.1:8787/mcp' }, { upstream: 'https://127.0.0.1:8787/mcp' },
    { upstream: 'http://user:password@127.0.0.1:8787/mcp' }, { upstream: 'http://127.0.0.1:8787/mcp?target=other' },
    { path: '/api/mcp/knowledge' }, { path: '/hooks' }, { path: '/mcp/knowledge/../api' }, { path: '/' },
    { path: '/mcp' }, { path: '/knowledge' },
    { allowedHosts: [] }, { allowedHosts: ['*'] }, { allowedOrigins: ['*'] },
    { allowedOrigins: ['https://public.example/'] }, { timeoutMs: 0 }, { maxConcurrent: 129 },
    { maxRequestBytes: 17000000 }, { bearer: 'must-not-configure-secret' }
  ])('rejects unsafe configuration %j', change => {
    expect(() => parseMcpProxyConfig({ ...valid, ...change })).toThrow()
  })
  it('reads a bounded absolute config file and rejects invalid JSON', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-config-'))
    try {
      const path = join(root, 'config.json')
      writeFileSync(path, JSON.stringify(valid))
      expect(loadMcpProxyConfig({ HALO_MCP_PROXY_CONFIG: path })?.path).toBe('/mcp/knowledge')
      writeFileSync(path, 'x'.repeat(17000))
      expect(() => loadMcpProxyConfig({ HALO_MCP_PROXY_CONFIG: path })).toThrow()
      expect(() => loadMcpProxyConfig({ HALO_MCP_PROXY_CONFIG: 'relative.json' })).toThrow()
    } finally { rmSync(root, { recursive: true }) }
  })
  it('attaches before global parsers, management auth and SPA, with shutdown cleanup', () => {
    const source = readFileSync(join(__dirname, '../../../src/main/http/server.ts'), 'utf8')
    expect(source.indexOf('const parseJson = express.json()')).toBeGreaterThan(-1)
    expect(source.indexOf('disposeMcpProxy = attachMcpProxy')).toBeLessThan(source.indexOf('const parseJson = express.json()'))
    expect(source.indexOf('disposeMcpProxy = attachMcpProxy')).toBeLessThan(source.indexOf("expressApp.use('/api', authMiddleware)"))
    expect(source.match(/disposeMcpProxy\?\.\(\)/g)?.length).toBe(2)
    // Server mode only: a desktop sharing Remote Access ignores the variable.
    expect(source).toContain('process.env.HALO_MCP_PROXY_CONFIG && !isServerMode()')
  })
})

describe('MCP proxy transport', () => {
  it('forwards raw bytes and protocol headers, but no Halo cookies or forwarding credentials', async () => {
    let observed: any
    const { send } = await setup((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => { observed = { headers: req.headers, url: req.url, body }; reply(req, res) })
    })
    const text = '{ "original": "ü€😀" }'
    expect((await send('/mcp/knowledge', { body: text, headers: { cookie: 'halo=secret', 'x-forwarded-host': 'other', 'mcp-session-id': 'session', 'mcp-protocol-version': '2025-03-26' } })).status).toBe(200)
    expect(observed.body).toBe(text)
    expect(observed.url).toBe('/mcp')
    expect(observed.headers).toMatchObject({ authorization: 'Bearer ' + token, 'mcp-session-id': 'session', 'mcp-protocol-version': '2025-03-26' })
    expect(observed.headers.cookie).toBeUndefined()
    expect(observed.headers['x-forwarded-host']).toBeUndefined()
  })
  it('rejects unknown paths and target query strings instead of falling into the SPA', async () => {
    const upstream = vi.fn(reply)
    const { send } = await setup(upstream)
    for (const path of ['/mcp/other', '/mcp/knowledge/other', '/mcp/knowledge/', '/mcp/knowledge?target=http://other']) expect((await send(path)).status).toBe(404)
    expect(upstream).not.toHaveBeenCalled()
    expect((await send('/api/status', { method: 'GET' })).body).toBe('{"halo":true}')
  })
  it('requires an explicit Host and Bearer, never trusting forwarded Host', async () => {
    const { send } = await setup(reply)
    expect((await send('/mcp/knowledge', { headers: { host: 'other', 'x-forwarded-host': 'public.example' } })).status).toBe(403)
    expect((await send('/mcp/knowledge', { headers: { authorization: '' } })).status).toBe(401)
    expect((await send('/mcp/knowledge', { headers: { authorization: 'Basic credential' } })).status).toBe(401)
  })
  it('keeps upstream authentication authoritative and preserves its error response', async () => {
    const { send } = await setup((req, res) => {
      res.setHeader('content-type', 'application/json')
      res.statusCode = req.headers.authorization === 'Bearer ' + token ? 200 : 401
      res.end(JSON.stringify({ status: res.statusCode }))
    })
    expect((await send('/mcp/knowledge', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
    expect((await send()).status).toBe(200)
  })
  it('validates HTTPS public origins before translating to the loopback origin', async () => {
    let origin: string | undefined
    const { send, target } = await setup((req, res) => { origin = req.headers.origin; reply(req, res) })
    expect((await send('/mcp/knowledge', { headers: { origin: 'https://untrusted.example' } })).status).toBe(403)
    const allowed = await send('/mcp/knowledge', { headers: { origin: 'https://public.example' } })
    expect(allowed.status).toBe(200)
    expect(allowed.headers['access-control-allow-origin']).toBe('https://public.example')
    expect(origin).toBe(target)
    expect((await send()).headers['access-control-allow-origin']).toBeUndefined()
  })
  it('answers only allowlisted CORS preflights and supports GET/DELETE for stateful MCP', async () => {
    const { send } = await setup(reply)
    expect((await send('/mcp/knowledge', { method: 'OPTIONS', headers: { authorization: '', origin: 'https://public.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'Authorization, Mcp-Session-Id' } })).status).toBe(204)
    expect((await send('/mcp/knowledge', { method: 'OPTIONS', headers: { origin: 'https://public.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'Cookie' } })).status).toBe(403)
    expect((await send('/mcp/knowledge', { method: 'GET' })).status).toBe(200)
    expect((await send('/mcp/knowledge', { method: 'DELETE' })).status).toBe(200)
    expect((await send('/mcp/knowledge', { method: 'PUT' })).status).toBe(405)
  })
  it('strips hop-by-hop headers, cookies and redirects from upstream responses', async () => {
    const { send } = await setup((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'halo=owned', connection: 'x-private', 'x-private': 'private', 'mcp-session-id': 'session', 'access-control-allow-origin': '*' })
      res.end('{}')
    })
    const response = await send()
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(response.headers['x-private']).toBeUndefined()
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
    expect(response.headers['mcp-session-id']).toBe('session')
    expect(response.headers['cache-control']).toBe('no-store')
  })
  it.each([{ status: 302, type: 'application/json' }, { status: 200, type: 'text/html' }])('rejects unsafe upstream reply %j', async ({ status, type }) => {
    const { send } = await setup((_req, res) => { res.writeHead(status, { 'content-type': type, location: 'https://other' }); res.end('unsafe') })
    const response = await send()
    expect(response.status).toBe(502)
    expect(response.headers.location).toBeUndefined()
    expect(response.body).not.toContain('unsafe')
  })
  it.each([202, 204])('preserves explicitly empty %i acknowledgements', async status => {
    const { send } = await setup((_req, res) => { res.writeHead(status, { 'content-length': '0' }); res.end() })
    expect((await send()).status).toBe(status)
  })
  it('accepts empty chunked 202 notifications but rejects untyped bodies', async () => {
    let hasBody = false
    const { send } = await setup((_req, res) => {
      res.writeHead(202)
      res.end(hasBody ? 'unsafe' : undefined)
    })
    expect((await send()).status).toBe(202)
    hasBody = true
    expect((await send()).status).toBe(502)
  })
  it('rejects untyped content instead of serving it under Halo origin', async () => {
    const { send } = await setup((_req, res) => res.end('<html>unsafe</html>'))
    expect((await send()).status).toBe(502)
  })
  it('closes an unfinished upload after an early upstream rejection', async () => {
    const { base } = await setup((_req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{}') }, { timeoutMs: 100 })
    await new Promise<void>((resolve, reject) => {
      const client = request(base + '/mcp/knowledge', { method: 'POST', headers: { ...headers, host: 'public.example', 'content-length': '100000' } }, res => {
        expect(res.statusCode).toBe(401)
        res.resume()
      })
      const timer = setTimeout(() => { client.destroy(); reject(new Error('Early response left upload connected')) }, 500)
      client.on('error', () => {})
      client.on('socket', socket => socket.once('close', () => { clearTimeout(timer); resolve() }))
      client.write('{')
    })
  })
  it('bounds known-length and chunked bodies without parsing JSON', async () => {
    const { send } = await setup((req, res) => { req.resume(); req.on('end', () => reply(req, res)) }, { maxRequestBytes: 1024 })
    expect((await send('/mcp/knowledge', { body: 'x'.repeat(1500), headers: { 'content-length': '1500' } })).status).toBe(413)
    expect((await send('/mcp/knowledge', { body: 'x'.repeat(1500), headers: { 'transfer-encoding': 'chunked' } })).status).toBe(413)
    expect((await send('/mcp/knowledge', { body: '{not-json' })).status).toBe(200)
  })
  it('bounds concurrency and timeout, releases slots and stays responsive', async () => {
    const { send } = await setup(req => req.resume(), { timeoutMs: 150, maxConcurrent: 1 })
    const first = send()
    await new Promise(resolve => setTimeout(resolve, 30))
    const busy = await send()
    expect(busy.status).toBe(429)
    expect(busy.headers['retry-after']).toBe('1')
    expect((await first).status).toBe(504)
    expect((await send('/api/status', { method: 'GET' })).status).toBe(200)
    expect((await send()).status).toBe(504)
  })
  it('returns 502 for a stopped upstream without a SPA fallback', async () => {
    const { send } = await setup(reply)
    const upstream = servers[0]
    await new Promise<void>(resolve => upstream.close(() => resolve()))
    const response = await send()
    expect(response.status).toBe(502)
    expect(JSON.parse(response.body).error).toBe('MCP_PROXY_UNAVAILABLE')
  })
  it('does not buffer event streams until completion', async () => {
    const { base } = await setup((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: first\n\n')
      const timer = setTimeout(() => res.end('data: second\n\n'), 200)
      res.once('close', () => clearTimeout(timer))
    })
    await new Promise<void>((resolve, reject) => {
      request(base + '/mcp/knowledge', { headers: { ...headers, host: 'public.example' } }, res => {
        const started = performance.now()
        let first = 0
        let body = ''
        res.on('data', chunk => { if (!body) first = performance.now() - started; body += chunk })
        res.on('end', () => {
          try { expect(body).toContain('data: second'); expect(performance.now() - started - first).toBeGreaterThan(100); resolve() } catch (error) { reject(error) }
        })
      }).on('error', reject).end()
    })
  })
  it('closes upstream on client disconnect and shutdown and never logs credentials or body', async () => {
    let closed!: () => void
    const upstreamClosed = new Promise<void>(resolve => { closed = resolve })
    const { base, send } = await setup((req, res) => { req.resume(); res.once('close', closed) })
    const client = request(base + '/mcp/knowledge', { method: 'POST', headers: { ...headers, host: 'public.example' } })
    client.on('error', () => {})
    client.end('private-query-body')
    await new Promise(resolve => setTimeout(resolve, 30))
    client.destroy()
    await upstreamClosed
    const pending = send()
    await new Promise(resolve => setTimeout(resolve, 30))
    disposers[0]()
    expect((await pending).status).toBe(503)
    expect((await send()).status).toBe(503)
    const logs = JSON.stringify(vi.mocked(console.warn).mock.calls)
    expect(logs).not.toContain(token)
    expect(logs).not.toContain('private-query-body')
  })
})
