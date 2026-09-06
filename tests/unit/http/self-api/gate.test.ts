/**
 * The pieces of the self-API gate are covered in isolation elsewhere; this
 * exercises them assembled, over a real socket, which is the only way to catch
 * the failures that live between them — a scope table whose path syntax does
 * not match what Express routes on, redaction that never gets installed, or an
 * encoded path that authorizes as one route and dispatches as another.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import express from 'express'
import type { Server } from 'http'

// routes.json is the dispatch table and scope.json the exposed subset of it,
// so every scope entry must also appear here — the generator produces both
// from one pass, and `classify` resolves the dispatched route before asking
// whether it is exposed.
vi.mock('../../../../src/main/services/api-ref/resource-path', () => ({
  readApiRefJson: (file: string) => {
    if (file === 'scope.json')
      return [
        { method: 'GET', path: '/api/apps/:appId' },
        { method: 'POST', path: '/api/apps/:appId/boom' },
        { method: 'GET', path: '/api/apps' },
      ]
    if (file === 'routes.json') {
      return [
        { method: 'GET', path: '/api/apps', group: 'digital-human' },
        { method: 'GET', path: '/api/apps/:appId', group: 'digital-human' },
        { method: 'POST', path: '/api/apps/:appId/boom', group: 'digital-human' },
        { method: 'GET', path: '/api/config', group: 'settings' },
      ]
    }
    return null
  },
  getApiRefPath: () => '/tmp/api-ref/index.txt',
  readApiRefFile: () => null,
}))

import {
  rejectNonApi,
  selfApiAuthMiddleware,
  selfApiErrorHandler,
} from '../../../../src/main/http/self-api/middleware'
import { redactResponses } from '../../../../src/main/http/self-api/redact'
import { issueSelfApiToken, resetSelfApiTokens } from '../../../../src/main/http/self-api/token-store'
import { resetScopeCache } from '../../../../src/main/http/self-api/scope'

let server: Server
let base: string
let token: string
const SESSION_SPACE = 'space-a'

beforeAll(async () => {
  resetSelfApiTokens()
  resetScopeCache()
  token = issueSelfApiToken(SESSION_SPACE)

  const app = express()
  app.use(express.json())
  app.use(rejectNonApi)
  app.use(redactResponses)
  app.use('/api', selfApiAuthMiddleware)

  // Stands in for the real registrar: same shape, no Electron behind it.
  app.get('/api/apps/:appId', (req, res) => {
    res.json({
      success: true,
      data: {
        id: req.params.appId,
        userConfig: { github_repo: 'openkursar/hello-halo', api_key: 'sk-live-must-not-leak' },
        spec: { mcp_server: { env: { GITHUB_TOKEN: 'ghp_must_not_leak' } } },
        tokenCount: 1234,
      },
    })
  })
  app.get('/api/config', (_req, res) => res.json({ success: true, data: {} }))
  // Echoes what the guard left behind, so a test can see the defaulted space.
  app.get('/api/apps', (req, res) => res.json({ success: true, data: { sawSpaceId: req.query.spaceId } }))
  // Mirrors the exposed handlers that destructure req.body with no try/catch.
  app.post('/api/apps/:appId/boom', (req, res) => {
    const { nothing } = req.body as { nothing: string }
    res.json({ success: true, data: nothing })
  })
  app.set('env', 'production')
  app.use(selfApiErrorHandler)

  await new Promise<void>((done) => {
    server = app.listen(0, '127.0.0.1', () => done())
  })
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(() => new Promise<void>((done) => server.close(() => done())))

const call = (path: string, auth = `Bearer ${token}`) =>
  fetch(`${base}${path}`, { headers: auth ? { Authorization: auth } : {} })

describe('self-API gate, assembled', () => {
  it('passes an in-scope request through to the handler', async () => {
    const res = await call('/api/apps/ap_7f3c')
    expect(res.status).toBe(200)
    expect((await res.json()).data.id).toBe('ap_7f3c')
  })

  it('redacts secret-shaped values but keeps their keys and leaves counters alone', async () => {
    const body = (await (await call('/api/apps/ap_7f3c')).json()).data
    expect(body.userConfig.api_key).toBe('[redacted]')
    expect(body.userConfig.github_repo).toBe('[redacted]')
    expect(Object.keys(body.userConfig)).toEqual(['github_repo', 'api_key'])
    expect(body.spec.mcp_server.env.GITHUB_TOKEN).toBe('[redacted]')
    expect(body.tokenCount).toBe(1234)
  })

  it('rejects a route that exists but is out of scope, and says which group', async () => {
    const res = await call('/api/config')
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('halo.self_api.not_exposed')
    expect(body.error).not.toContain('<group>')
  })

  it('separates an unrouted path from an out-of-scope one', async () => {
    const res = await call('/api/nope')
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe('halo.self_api.unknown_endpoint')
  })

  it('refuses a wrong token and a missing one', async () => {
    expect((await call('/api/apps/ap_1', 'Bearer wrong')).status).toBe(401)
    expect((await call('/api/apps/ap_1', '')).status).toBe(401)
  })

  it('does not let an encoded path authorize as one route and dispatch as another', async () => {
    const res = await call('/api/apps%2Fap_1%2Fnested')
    expect(res.status).not.toBe(200)
  })

  it('answers a thrown handler with an envelope instead of a stack trace', async () => {
    const res = await fetch(`${base}/api/apps/ap/boom`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body: 'not json',
    })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.code).toBe('halo.self_api.handler_failed')
    expect(JSON.stringify(body)).not.toMatch(/self-api|\.ts:|at Object|node_modules/)
  })

  it('defaults a missing spaceId to the calling session, not to every space', async () => {
    const res = await call('/api/apps')
    expect(res.status).toBe(200)
    expect((await res.json()).data.sawSpaceId).toBe(SESSION_SPACE)
  })

  it('refuses a request aimed at another space', async () => {
    const res = await call('/api/apps?spaceId=space-b')
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('halo.self_api.wrong_space')
  })

  it('keeps one session token from reaching another session space', async () => {
    const other = issueSelfApiToken('space-b')
    const mine = await call('/api/apps')
    expect((await mine.json()).data.sawSpaceId).toBe(SESSION_SPACE)
    const theirs = await call('/api/apps', `Bearer ${other}`)
    expect((await theirs.json()).data.sawSpaceId).toBe('space-b')
  })

  it('serves nothing outside /api/', async () => {
    const res = await fetch(`${base}/index.html`)
    expect(res.status).toBe(404)
  })
})
