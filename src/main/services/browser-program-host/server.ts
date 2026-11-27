import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { Socket } from 'node:net'
import type { BrowserContext } from '../ai-browser'
import { runBrowserCommand } from './browser'
import { fetchForAdapter, grantSchema, type HostGrant } from './fetch'
import { runAdapterHelper } from './helpers'
import { runPageAdapter } from './page'
import { fail, MAX_BYTES } from './protocol'

export const PROTOCOL_PATH = '/webcli/v1'
const REQUEST_TIMEOUT_MS = 60_000
const MAX_CONNECTIONS = 64

interface HostRequest { schemaVersion: 1; operation: string; [key: string]: unknown }

/**
 * One Adapter call: the scope its CLI declared and the connections that carry
 * it. The protocol names no call, so a call is known by its connections.
 */
interface Invocation {
  grant: HostGrant
  sockets: Set<Socket>
}

/** A browser lent to programs: one per browser context, reached with its own token. */
interface Registration {
  token: string
  ctx: BrowserContext
  /** At most one request at a time; programs serialize their own requests. */
  busy: boolean
  invocation?: Invocation
  controllers: Set<AbortController>
}

const byToken = new Map<string, Registration>()
const byContext = new WeakMap<BrowserContext, Registration>()
let listening: Promise<{ server: Server; endpoint: string }> | undefined

/** The token for a browser context, issued once and valid until the context is released. */
export function registrationFor(ctx: BrowserContext): Registration {
  sweep()
  let registration = byContext.get(ctx)
  if (!registration) {
    registration = { token: randomBytes(32).toString('hex'), ctx, busy: false, controllers: new Set() }
    byContext.set(ctx, registration)
    byToken.set(registration.token, registration)
  }
  return registration
}

function sweep(): void {
  for (const registration of byToken.values()) {
    if (registration.ctx.isReleased) revoke(registration)
  }
}

function revoke(registration: Registration): void {
  byToken.delete(registration.token)
  byContext.delete(registration.ctx)
  registration.invocation = undefined
  for (const controller of registration.controllers) controller.abort(Object.assign(new Error('The browser was released.'), { code: 'HOST_UNAVAILABLE' }))
}

const openSocket = (socket: Socket) => !socket.destroyed

function invocationLive(invocation: Invocation | undefined, socket: Socket): boolean {
  return !!invocation && [...invocation.sockets].some(other => other !== socket && openSocket(other))
}

async function dispatch(registration: Registration, request: HostRequest, socket: Socket, signal: AbortSignal): Promise<unknown> {
  const ctx = registration.ctx
  if (request.operation === 'browser') {
    return runBrowserCommand(ctx, String(request.command), request.args, signal)
  }
  if (request.operation === 'adapter.prepare') {
    const current = registration.invocation
    if (current?.sockets.has(socket)) return fail('HOST_GRANT_EXISTS', 'Adapter context was already initialized.')
    if (invocationLive(current, socket)) return fail('HOST_BUSY', 'Another program call is using this browser. Retry after it finishes.')
    const { schemaVersion: _version, operation: _operation, ...value } = request
    const parsed = grantSchema.safeParse(value)
    if (!parsed.success) return fail('INVALID_ARGS', 'Invalid Adapter context.')
    const invokedCommand = parsed.data.invokedCommand
    if (invokedCommand && invokedCommand !== `${parsed.data.name}.${parsed.data.commandId}`) {
      return fail('HOST_CALL_MISMATCH', 'Adapter context does not match the invoked command.')
    }
    registration.invocation = { grant: parsed.data, sockets: new Set([socket]) }
    return { ready: true }
  }
  if (!['adapter.fetch', 'adapter.helper', 'adapter.page'].includes(request.operation)) {
    return fail('HOST_UNSUPPORTED_OPERATION', 'Host operation is not supported.')
  }
  const invocation = registration.invocation
  if (!invocation) return fail('HOST_GRANT_MISSING', 'Prepare the Adapter context first.')
  if (!invocation.sockets.has(socket)) {
    // The same program reconnecting after its idle connection closed continues its call.
    if (invocationLive(invocation, socket)) return fail('HOST_BUSY', 'Another program call is using this browser. Retry after it finishes.')
    invocation.sockets.add(socket)
  }
  const grant = invocation.grant
  if (request.operation === 'adapter.fetch') return fetchForAdapter(grant, request, signal)
  if (request.operation === 'adapter.helper') {
    return runAdapterHelper(ctx, grant, String(request.action), (request.payload || {}) as Record<string, unknown>, signal)
  }
  if (!grant.pageHosts) return fail('HOST_PAGE_UNAVAILABLE', 'The Adapter did not declare a page origin.')
  return runPageAdapter(ctx, grant, request, signal,
    (action, payload, helperSignal) => runAdapterHelper(ctx, grant, action, payload, helperSignal))
}

/**
 * Run one request against the context's browser. Adapter requests act on pages
 * the host opens for them and leave the page the AI was on in front afterwards.
 */
async function serveRequest(registration: Registration, request: HostRequest, socket: Socket, signal: AbortSignal): Promise<unknown> {
  const ctx = registration.ctx
  const restore = request.operation.startsWith('adapter.') ? ctx.getActiveViewId() : null
  ctx.beginToolCall()
  try {
    return await dispatch(registration, request, socket, signal)
  } finally {
    ctx.endToolCall()
    if (restore && restore !== ctx.getActiveViewId() && !ctx.isReleased && ctx.canReachView(restore)) {
      ctx.setActiveViewId(restore)
    }
  }
}

function reply(res: ServerResponse, body: unknown, status = 200): void {
  let text = JSON.stringify(body)
  if (Buffer.byteLength(text) > MAX_BYTES) {
    text = JSON.stringify({ schemaVersion: 1, ok: false, error: { code: 'HOST_PAYLOAD_TOO_LARGE', message: 'Host response exceeds the size limit.' } })
  }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(text)
}

function deny(res: ServerResponse): void {
  reply(res, { schemaVersion: 1, ok: false, error: { code: 'HOST_ACCESS_DENIED', message: 'Host access denied.' } }, 403)
}

async function handle(req: IncomingMessage, res: ServerResponse, port: number): Promise<void> {
  // Pages can reach loopback too: refuse anything a browser would mark, and any other host name.
  if (req.method !== 'POST' || req.url !== PROTOCOL_PATH || req.headers.origin || req.headers['sec-fetch-site']
    || req.headers.host !== `127.0.0.1:${port}` || req.headers['content-type'] !== 'application/json') {
    deny(res)
    return
  }
  const auth = req.headers.authorization
  const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : ''
  const registration = /^[a-f0-9]{64}$/.test(token) ? byToken.get(token) : undefined
  if (!registration || registration.ctx.isReleased) {
    if (registration) revoke(registration)
    console.warn('[BrowserProgramHost] Rejected request with an unknown or retired credential')
    deny(res)
    return
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(Object.assign(new Error('Host operation timed out; it was not retried.'), { code: 'HOST_TIMEOUT' })), REQUEST_TIMEOUT_MS)
  // The program went away (finished, interrupted or killed): stop what it asked for.
  const gone = () => { if (!res.writableFinished) controller.abort(Object.assign(new Error('The program disconnected.'), { code: 'HOST_CANCELLED' })) }
  res.on('close', gone)
  registration.controllers.add(controller)
  let claimed = false
  try {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += (chunk as Buffer).length
      if (size > MAX_BYTES) fail('HOST_PAYLOAD_TOO_LARGE', 'Host request exceeds the size limit.')
      chunks.push(chunk as Buffer)
    }
    let request: HostRequest
    try { request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as HostRequest } catch { return fail('HOST_PROTOCOL_ERROR', 'Invalid host protocol request.') }
    if (request?.schemaVersion !== 1 || typeof request.operation !== 'string') fail('HOST_PROTOCOL_ERROR', 'Invalid host protocol request.')
    if (registration.busy) fail('HOST_BUSY', 'Another program call is using this browser. Retry after it finishes.')
    registration.busy = true
    claimed = true
    const result = await serveRequest(registration, request, req.socket, controller.signal)
    controller.signal.throwIfAborted()
    reply(res, { schemaVersion: 1, ok: true, result: result ?? null })
  } catch (error) {
    const code = (error as { code?: string }).code || 'HOST_OPERATION_FAILED'
    if (code !== 'HOST_BUSY') console.warn('[BrowserProgramHost] Request failed', { code })
    if (!res.destroyed && !res.headersSent) {
      reply(res, { schemaVersion: 1, ok: false, error: { code, message: (error as Error).message || 'Host operation failed.' } })
    }
  } finally {
    clearTimeout(timer)
    res.off('close', gone)
    registration.controllers.delete(controller)
    if (claimed) registration.busy = false
  }
}

/** The loopback endpoint, started the first time a session needs it. */
export function ensureListening(): Promise<{ endpoint: string }> {
  listening ??= new Promise<{ server: Server; endpoint: string }>((resolve, reject) => {
    let port = 0
    const server = createServer((req, res) => {
      void handle(req, res, port).catch(() => res.destroy())
    })
    // Long page operations answer within REQUEST_TIMEOUT_MS; a request body must arrive promptly.
    server.requestTimeout = 10_000
    server.headersTimeout = 10_000
    server.keepAliveTimeout = 30_000
    server.maxConnections = MAX_CONNECTIONS
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      server.on('error', error => console.error('[BrowserProgramHost] Server error', { message: error.message }))
      port = (server.address() as { port: number }).port
      server.unref()
      console.log('[BrowserProgramHost] Listening on loopback')
      resolve({ server, endpoint: `http://127.0.0.1:${port}${PROTOCOL_PATH}` })
    })
  }).catch(error => {
    listening = undefined
    throw error
  })
  return listening.then(({ endpoint }) => ({ endpoint }))
}

export async function closeServer(): Promise<void> {
  const current = listening
  listening = undefined
  for (const registration of [...byToken.values()]) revoke(registration)
  if (!current) return
  const { server } = await current.catch(() => ({ server: undefined }))
  if (!server) return
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
}
