import { readFileSync, statSync } from 'fs'
import { isAbsolute } from 'path'
import { request, type ClientRequest, type IncomingMessage } from 'http'
import { Transform } from 'stream'
import type { Express, Request, Response } from 'express'

export interface McpProxyConfig {
  path: string
  upstream: string
  allowedHosts: string[]
  allowedOrigins: string[]
  timeoutMs: number
  maxConcurrent: number
  maxRequestBytes: number
}

const REQUEST_HEADERS = new Set([
  'authorization', 'accept', 'content-type', 'content-length', 'origin',
  'mcp-protocol-version', 'mcp-session-id', 'last-event-id'
])
const RESPONSE_HEADERS = new Set([
  'content-type', 'content-length', 'content-encoding', 'mcp-session-id',
  'mcp-protocol-version', 'retry-after', 'allow', 'www-authenticate'
])
const HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'
])
// Every ingress path lives under this prefix, so it can never shadow a Halo route.
const MOUNT = '/mcp'
const CORS_HEADERS = ['authorization', 'content-type', 'mcp-protocol-version', 'mcp-session-id', 'last-event-id', 'accept']

function invalidConfig(): never {
  throw new Error('Invalid MCP proxy configuration')
}

/** Deployment-owned, credential-free configuration; absent means no proxy middleware. */
export function loadMcpProxyConfig(env: NodeJS.ProcessEnv = process.env): McpProxyConfig | null {
  const file = env.HALO_MCP_PROXY_CONFIG
  if (!file) return null
  if (!isAbsolute(file)) return invalidConfig()
  const stats = statSync(file)
  if (!stats.isFile() || stats.size > 16 * 1024) return invalidConfig()
  return parseMcpProxyConfig(JSON.parse(readFileSync(file, 'utf8')))
}

export function parseMcpProxyConfig(value: unknown): McpProxyConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidConfig()
  const row = value as Record<string, unknown>
  const keys = ['path', 'upstream', 'allowedHosts', 'allowedOrigins', 'timeoutMs', 'maxConcurrent', 'maxRequestBytes']
  if (Object.keys(row).some(key => !keys.includes(key))) return invalidConfig()
  if (typeof row.path !== 'string' || !/^\/mcp\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(row.path) || row.path.length > 200) return invalidConfig()
  if (typeof row.upstream !== 'string' || !/^http:\/\/(127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}\/[A-Za-z0-9_/-]*$/.test(row.upstream)) return invalidConfig()
  const upstream = new URL(row.upstream)
  if (!upstream.port || Number(upstream.port) > 65535 || upstream.pathname.split('/').some(part => part === '.' || part === '..')) return invalidConfig()
  if (!Array.isArray(row.allowedHosts) || row.allowedHosts.length < 1 || row.allowedHosts.length > 32) return invalidConfig()
  const allowedHosts = row.allowedHosts.map(host => {
    if (typeof host !== 'string' || host !== host.toLowerCase() || !/^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[::1\])(?::[1-9][0-9]{0,4})?$/.test(host)) return invalidConfig()
    const url = new URL('http://' + host)
    if (url.host !== host && !(host.endsWith(':80') && url.host === host.slice(0, -3))) return invalidConfig()
    return host
  })
  if (row.allowedOrigins !== undefined && (!Array.isArray(row.allowedOrigins) || row.allowedOrigins.length > 32)) return invalidConfig()
  const allowedOrigins = ((row.allowedOrigins ?? []) as unknown[]).map(origin => {
    if (typeof origin !== 'string') return invalidConfig()
    const url = new URL(origin)
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) return invalidConfig()
    return origin
  })
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const number = row[key] ?? fallback
    if (typeof number !== 'number' || !Number.isInteger(number) || number < min || number > max) return invalidConfig()
    return number
  }
  return {
    path: row.path, upstream: row.upstream, allowedHosts, allowedOrigins,
    timeoutMs: integer('timeoutMs', 60000, 100, 3600000),
    maxConcurrent: integer('maxConcurrent', 16, 1, 128),
    maxRequestBytes: integer('maxRequestBytes', 1024 * 1024, 1024, 16 * 1024 * 1024)
  }
}

function forwardHeaders(headers: IncomingMessage['headers'], permitted: Set<string>): Record<string, string | string[]> {
  const removed = new Set([...HOP_HEADERS, ...(headers.connection || '').toLowerCase().split(',').map(name => name.trim())])
  return Object.fromEntries(Object.entries(headers).filter(([name, value]) => value !== undefined && permitted.has(name) && !removed.has(name))) as Record<string, string | string[]>
}

/** Thin HTTP transport only: upstream owns MCP authentication, sessions and tools. */
export function attachMcpProxy(app: Express, input: McpProxyConfig): () => void {
  const config = parseMcpProxyConfig(input)
  const upstreamUrl = new URL(config.upstream)
  const hosts = new Set(config.allowedHosts)
  const origins = new Set(config.allowedOrigins)
  const active = new Set<() => void>()
  let sequence = 0
  let completed = 0
  let failed = 0
  let stopped = false
  const heartbeat = setInterval(() => {
    console.log('[MCPProxy] State', { active: active.size, requests: sequence, completed, failed })
  }, 300000)
  heartbeat.unref()
  app.use(MOUNT, (req: Request, res: Response) => {
    const id = ++sequence
    const began = performance.now()
    let finished = false
    let outcome = 'FORWARDED'
    let upstream: ClientRequest | undefined
    let incoming: IncomingMessage | undefined
    let body: Transform | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const dispose = () => fail(503, 'PROXY_STOPPED')
    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      active.delete(dispose)
      req.unpipe(body)
      body?.unpipe()
      body?.destroy()
      upstream?.destroy()
      incoming?.destroy()
      completed++
      if (outcome !== 'FORWARDED' || res.statusCode >= 400) {
        failed++
        console.warn('[MCPProxy] Request complete', { request: id, status: res.statusCode, outcome, durationMs: Math.round(performance.now() - began) })
      }
    }
    const fail = (status: number, code: string) => {
      if (finished) return
      outcome = code
      if (!res.headersSent && !res.destroyed) {
        res.statusCode = status
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Connection', 'close')
        res.end(JSON.stringify({ error: code }))
      } else res.destroy()
      finish()
    }
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    req.once('aborted', () => { outcome = 'CLIENT_ABORTED'; finish() })
    req.once('error', () => { outcome = 'CLIENT_REQUEST_ERROR'; res.destroy(); finish() })
    res.once('error', () => { outcome = 'CLIENT_RESPONSE_ERROR'; finish() })
    res.once('finish', () => {
      finish()
      if (!req.complete) req.destroy()
    })
    res.once('close', () => {
      if (!res.writableFinished) outcome = 'CLIENT_CLOSED'
      finish()
      if (!req.complete) req.destroy()
    })
    if (req.originalUrl !== config.path) return fail(404, 'MCP_PROXY_PATH_NOT_FOUND')
    if (!hosts.has(req.headers.host ?? '')) return fail(403, 'MCP_PROXY_HOST_REJECTED')
    if (req.headers.origin && !origins.has(req.headers.origin)) return fail(403, 'MCP_PROXY_ORIGIN_REJECTED')
    if (req.headers.origin) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate, Retry-After, Allow')
    }
    if (req.method === 'OPTIONS') {
      const method = req.headers['access-control-request-method']
      const requested = String(req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(name => name.trim()).filter(Boolean)
      if (!req.headers.origin || !['GET', 'POST', 'DELETE'].includes(String(method)) || requested.some(name => !CORS_HEADERS.includes(name))) return fail(403, 'MCP_PROXY_PREFLIGHT_REJECTED')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', CORS_HEADERS.join(', '))
      res.status(204).end()
      return
    }
    if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
      res.setHeader('Allow', 'GET, POST, DELETE, OPTIONS')
      return fail(405, 'MCP_PROXY_METHOD_NOT_ALLOWED')
    }
    if (!/^Bearer [^\s,]+$/i.test(req.headers.authorization || '')) {
      res.setHeader('WWW-Authenticate', 'Bearer')
      return fail(401, 'MCP_PROXY_BEARER_REQUIRED')
    }
    if (req.headers.upgrade || req.headers.expect) return fail(400, 'MCP_PROXY_UNSUPPORTED_HEADERS')
    if (stopped) return fail(503, 'PROXY_STOPPED')
    if (active.size >= config.maxConcurrent) {
      res.setHeader('Retry-After', '1')
      return fail(429, 'MCP_PROXY_BUSY')
    }
    if (Number(req.headers['content-length']) > config.maxRequestBytes) return fail(413, 'MCP_PROXY_BODY_TOO_LARGE')
    active.add(dispose)
    timer = setTimeout(() => fail(504, 'MCP_PROXY_TIMEOUT'), config.timeoutMs)
    const headers = forwardHeaders(req.headers, REQUEST_HEADERS)
    headers.host = upstreamUrl.host
    // Validate the public browser origin before translating it to the loopback origin.
    if (headers.origin) headers.origin = upstreamUrl.origin
    let bytes = 0
    body = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length
        if (bytes > config.maxRequestBytes) {
          fail(413, 'MCP_PROXY_BODY_TOO_LARGE')
          callback()
        } else callback(null, chunk)
      }
    })
    body.once('error', () => fail(400, 'MCP_PROXY_BODY_ERROR'))
    upstream = request(upstreamUrl, { method: req.method, headers, agent: false, maxHeaderSize: 16 * 1024 }, response => {
      if (finished) { response.destroy(); return }
      incoming = response
      // Never relay redirects or browser content into Halo's own origin.
      const type = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
      if ((response.statusCode ?? 502) >= 300 && (response.statusCode ?? 502) < 400) return fail(502, 'MCP_PROXY_REDIRECT_REJECTED')
      if (response.statusCode === 202 && !type) {
        response.once('error', () => fail(502, 'MCP_PROXY_RESPONSE_ERROR'))
        response.once('aborted', () => fail(502, 'MCP_PROXY_RESPONSE_ABORTED'))
        response.on('data', () => fail(502, 'MCP_PROXY_RESPONSE_TYPE_REJECTED'))
        response.once('end', () => {
          if (!finished) {
            res.writeHead(202, { ...forwardHeaders(response.headers, RESPONSE_HEADERS), 'cache-control': 'no-store' })
            res.end()
          }
        })
        return
      }
      if (response.statusCode !== 204 && type !== 'application/json' && type !== 'text/event-stream') return fail(502, 'MCP_PROXY_RESPONSE_TYPE_REJECTED')
      res.writeHead(response.statusCode || 502, { ...forwardHeaders(response.headers, RESPONSE_HEADERS), 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
      res.flushHeaders()
      response.once('error', () => fail(502, 'MCP_PROXY_RESPONSE_ERROR'))
      response.once('aborted', () => fail(502, 'MCP_PROXY_RESPONSE_ABORTED'))
      response.pipe(res)
    })
    upstream.once('error', () => fail(502, 'MCP_PROXY_UNAVAILABLE'))
    req.pipe(body).pipe(upstream)
  })
  console.log('[MCPProxy] Enabled', { path: config.path, timeoutMs: config.timeoutMs, maxConcurrent: config.maxConcurrent })
  return () => {
    if (stopped) return
    stopped = true
    clearInterval(heartbeat)
    for (const dispose of [...active]) dispose()
    console.log('[MCPProxy] Stopped', { requests: sequence, completed, failed })
  }
}
