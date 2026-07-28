/**
 * Unit + integration tests for apps/runtime/sources/webhook.source.ts.
 *
 * Unit coverage (WebhookSource on the ingress router):
 *   - Route mounting on a real Express 5 router (the legacy `:hookPath(*)`
 *     syntax threw at registration time and silently disabled the source).
 *   - Multi-segment hook paths resolve to a joined `payload.path`.
 *   - HMAC-SHA256 verification: GitHub-style `x-hub-signature-256` accepted,
 *     invalid signature rejected with 401, paths without a secret accepted.
 *   - Verification uses raw body bytes captured by the ingress JSON parser.
 *   - dedupKey derivation from body `dedupKey` field or path+body hash.
 *   - stop() defers to later mounts (no 503 shadowing); stop()/start()
 *     cycles do not stack duplicate handlers; a replacement instance on the
 *     same router takes over from a stopped one.
 *
 * Integration coverage (replicates http/server.ts attachWebhookIngress and
 * middleware order):
 *   - The ingress router is mounted before the global JSON parser and the
 *     auth/login-page fallbacks, so webhooks are reachable even though
 *     WebhookSource starts long after server creation. This ordering was the
 *     production bug: a catch-all login page swallowed every /hooks request
 *     with a fake 200.
 *   - The ingress router is a process-lifetime singleton: routes registered
 *     before any app exists work once the router is attached, and survive
 *     re-attachment to a fresh app (HTTP server restart).
 *   - Payloads between the global 100kb default and the 256kb webhook limit
 *     are accepted; payloads above 256kb get a JSON 413 (no HTML stack).
 *   - Non-JSON content types get a JSON 415.
 *   - Before WebhookSource starts, /hooks answers 404 (not the login page).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'crypto'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import express, { type Express, type Request, type Response, type NextFunction, type Router } from 'express'
import { WebhookSource } from '../../../../src/main/apps/runtime/sources/webhook.source'
import type { AutomationEventInput } from '../../../../src/main/apps/runtime/event-types'

const LOGIN_PAGE = '<html>login</html>'

/**
 * Replicates http/server.ts attachWebhookIngress() and the surrounding
 * middleware registration order: ingress chain first, then global JSON
 * parser, then the auth/login-page catch-all that used to swallow /hooks.
 */
function createServerLikeApp(ingress: Router): Express {
  const app = express()
  app.use('/hooks', (req: Request, res: Response, next: NextFunction) => {
    if (!req.is('application/json')) {
      res.status(415).json({ error: 'Webhook payloads must be application/json' })
      return
    }
    next()
  })
  app.use(
    '/hooks',
    express.json({
      limit: '256kb',
      verify: (req, _res, buf) => {
        ;(req as Request & { rawBody?: Buffer }).rawBody = buf
      }
    }),
    ingress
  )
  app.use('/hooks', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'Webhook ingress not available' })
  })
  app.use('/hooks', (err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.status ?? 400).json({ error: 'Invalid webhook request' })
  })
  app.use(express.json())
  app.use('/{*path}', (_req, res) => {
    res.status(200).send(LOGIN_PAGE)
  })
  return app
}

function listen(app: Express): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolve) => {
    const server = createServer(app)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` })
    })
  })
}

function sign(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

describe('WebhookSource', () => {
  let servers: Server[] = []
  let baseUrl = ''
  let events: AutomationEventInput[] = []

  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {}
  ): Promise<globalThis.Response> =>
    fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body)
    })

  beforeEach(() => {
    events = []
  })

  afterEach(async () => {
    await Promise.all(
      servers.map((server) => new Promise((resolve) => server.close(resolve)))
    )
    servers = []
  })

  async function startApp(app: Express): Promise<void> {
    const started = await listen(app)
    servers.push(started.server)
    baseUrl = started.baseUrl
  }

  async function startSource(secretResolver?: (path: string) => string | null): Promise<{
    source: WebhookSource
    ingress: Router
  }> {
    const ingress = express.Router()
    const source = new WebhookSource(ingress, secretResolver ?? null)
    source.start((event) => events.push(event))
    await startApp(createServerLikeApp(ingress))
    return { source, ingress }
  }

  describe('routing', () => {
    it('mounts on a real Express 5 router and emits webhook.received', async () => {
      await startSource()

      const res = await post('/hooks/github-pr', { action: 'opened' })

      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toEqual({ ok: true, received: true })
      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('webhook.received')
      expect(events[0].payload).toMatchObject({
        path: 'github-pr',
        method: 'POST',
        body: { action: 'opened' }
      })
    })

    it('joins multi-segment hook paths', async () => {
      await startSource()

      const res = await post('/hooks/github/repo-a/pr', { n: 1 })

      expect(res.status).toBe(200)
      expect(events[0].payload).toMatchObject({ path: 'github/repo-a/pr' })
    })
  })

  describe('HMAC verification', () => {
    it('accepts a valid GitHub-style signature', async () => {
      await startSource((path) => (path === 'github-pr' ? 'top-secret' : null))
      const body = JSON.stringify({ action: 'opened', pr: 42 })

      const res = await post('/hooks/github-pr', body, {
        'x-hub-signature-256': sign(body, 'top-secret')
      })

      expect(res.status).toBe(200)
      expect(events).toHaveLength(1)
    })

    it('rejects an invalid or missing signature with 401 and emits nothing', async () => {
      await startSource(() => 'top-secret')
      const body = JSON.stringify({ action: 'opened' })

      const badSig = await post('/hooks/github-pr', body, {
        'x-hub-signature-256': sign(body, 'wrong-secret')
      })
      const noSig = await post('/hooks/github-pr', body)

      expect(badSig.status).toBe(401)
      expect(noSig.status).toBe(401)
      expect(events).toHaveLength(0)
    })

    it('skips verification for paths without a configured secret', async () => {
      await startSource((path) => (path === 'secured' ? 'top-secret' : null))

      const res = await post('/hooks/open-path', { hello: 1 })

      expect(res.status).toBe(200)
      expect(events).toHaveLength(1)
    })
  })

  describe('dedup', () => {
    it('derives dedupKey from body dedupKey or path+body hash', async () => {
      await startSource()

      await post('/hooks/a', { dedupKey: 'evt-1' })
      await post('/hooks/a', { x: 1 })
      await post('/hooks/a', { x: 1 })

      expect(events[0].dedupKey).toBe('wh:evt-1')
      expect(events[1].dedupKey).toMatch(/^wh:a:[0-9a-f]{16}$/)
      expect(events[1].dedupKey).toBe(events[2].dedupKey)
    })
  })

  describe('lifecycle', () => {
    it('falls through to the ingress 404 after stop() and recovers on restart without stacking handlers', async () => {
      const { source } = await startSource()
      source.stop()

      const stopped = await post('/hooks/github-pr', { action: 'opened' })
      expect(stopped.status).toBe(404)
      expect(events).toHaveLength(0)

      source.start((event) => events.push(event))
      const restarted = await post('/hooks/github-pr', { action: 'opened' })
      expect(restarted.status).toBe(200)
      expect(events).toHaveLength(1)
    })

    it('lets a replacement instance on the same router take over from a stopped one', async () => {
      const { source, ingress } = await startSource()
      source.stop()

      const replacement = new WebhookSource(ingress, null)
      replacement.start((event) => events.push(event))

      const res = await post('/hooks/github-pr', { action: 'opened' })
      expect(res.status).toBe(200)
      expect(events).toHaveLength(1)
    })

    it('supports routes registered before any app exists and survives app re-creation (server restart)', async () => {
      // Real bootstrap order: WebhookSource starts before the HTTP server.
      const ingress = express.Router()
      const source = new WebhookSource(ingress, null)
      source.start((event) => events.push(event))

      await startApp(createServerLikeApp(ingress))
      const first = await post('/hooks/github-pr', { action: 'opened' })
      expect(first.status).toBe(200)

      // Server restart: a fresh Express app re-attaches the same router.
      await startApp(createServerLikeApp(ingress))
      const second = await post('/hooks/github-pr', { action: 'reopened' })
      expect(second.status).toBe(200)
      expect(events).toHaveLength(2)
    })
  })

  describe('server middleware ordering (http/server.ts contract)', () => {
    it('reaches the webhook route despite the login-page catch-all', async () => {
      await startSource()

      const hook = await post('/hooks/github-pr', { action: 'opened' })
      const other = await post('/somewhere-else', { x: 1 })

      expect(hook.status).toBe(200)
      await expect(hook.json()).resolves.toEqual({ ok: true, received: true })
      expect(other.status).toBe(200)
      await expect(other.text()).resolves.toBe(LOGIN_PAGE)
      expect(events).toHaveLength(1)
    })

    it('accepts payloads above the global 100kb default up to 256kb, rejects above with JSON 413', async () => {
      await startSource()
      const at150kb = JSON.stringify({ data: 'x'.repeat(150 * 1024) })
      const at300kb = JSON.stringify({ data: 'x'.repeat(300 * 1024) })

      const ok = await post('/hooks/github-pr', at150kb)
      const tooLarge = await post('/hooks/github-pr', at300kb)

      expect(ok.status).toBe(200)
      expect(tooLarge.status).toBe(413)
      expect(tooLarge.headers.get('content-type')).toContain('application/json')
      await expect(tooLarge.json()).resolves.toEqual({ error: 'Invalid webhook request' })
      expect(events).toHaveLength(1)
    })

    it('verifies HMAC of a >100kb payload via raw bytes from the ingress parser', async () => {
      await startSource(() => 'top-secret')
      const body = JSON.stringify({ data: 'y'.repeat(150 * 1024) })

      const res = await post('/hooks/github-pr', body, {
        'x-hub-signature-256': sign(body, 'top-secret')
      })

      expect(res.status).toBe(200)
      expect(events).toHaveLength(1)
    })

    it('rejects non-JSON content types with JSON 415', async () => {
      await startSource()

      const res = await fetch(`${baseUrl}/hooks/github-pr`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'payload=%7B%22action%22%3A%22opened%22%7D'
      })

      expect(res.status).toBe(415)
      await expect(res.json()).resolves.toEqual({ error: 'Webhook payloads must be application/json' })
      expect(events).toHaveLength(0)
    })

    it('answers 404 (not the login page) before WebhookSource starts', async () => {
      await startApp(createServerLikeApp(express.Router()))

      const res = await post('/hooks/github-pr', { action: 'opened' })

      expect(res.status).toBe(404)
      await expect(res.json()).resolves.toEqual({ error: 'Webhook ingress not available' })
    })
  })
})
