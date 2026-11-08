import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { request, type Server } from 'http'
import type { AddressInfo } from 'net'
import type { Express, Request, RequestHandler, Response } from 'express'
import { PassThrough } from 'stream'
import { gzipSync } from 'zlib'
import { CHAT_BODY_LIMIT, isChatRequest, parseChatBody } from '../../../src/main/http/chat-body'
import { MAX_IMAGES, MAX_IMAGE_SIZE, MAX_IMAGE_DIMENSION } from '../../../src/shared/constants/chat-attachments'

const env = vi.hoisted(() => ({ received: vi.fn(), servers: [] as Server[] }))
// Exercise the real server middleware and auth on an isolated loopback listener.
vi.mock('http', async original => {
  const real = await original<typeof import('http')>()
  return {
    ...real,
    createServer: (...args: Parameters<typeof real.createServer>) => {
      const server = real.createServer(...args)
      const listen = server.listen.bind(server)
      server.listen = ((_port: number, _host: string, callback: () => void) => listen(0, '127.0.0.1', callback)) as typeof server.listen
      env.servers.push(server)
      return server
    },
  }
})
vi.mock('../../../src/main/http/websocket', () => ({ initWebSocket: vi.fn(), shutdownWebSocket: vi.fn(), getClientCount: () => 0 }))
vi.mock('../../../src/main/apps/team', () => ({ getTeamStore: () => null }))
vi.mock('../../../src/main/http/identity', () => ({ getLocalIdentity: () => null }))
vi.mock('../../../src/main/foundation/window.service', () => ({ getMainWindow: () => null }))
vi.mock('../../../src/main/http/routes', () => ({
  registerApiRoutes(app: Express) {
    const receive: RequestHandler = (req, res) => {
      env.received(req.body)
      res.json({ success: true, data: { count: req.body.images?.length ?? 0 } })
    }
    for (const path of [
      '/api/agent/message', '/api/apps/:appId/chat/send', '/api/teams/:teamId/members/:appId/send',
      '/api/config', '/api/skills/import', '/api/agent/inject-message', '/api/apps/:appId/config',
    ]) app.post(path, receive)
  },
}))

import { getWebhookIngressRouter, startHttpServer, stopHttpServer } from '../../../src/main/http/server'

let baseUrl: string
let token: string

beforeAll(async () => {
  getWebhookIngressRouter().post('/chat-body-test', (req, res) => res.json({ success: true, length: req.body.text.length }))
  ;({ token } = await startHttpServer(0))
  const address = env.servers[0].address() as AddressInfo
  expect(address.address).toBe('127.0.0.1')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  stopHttpServer()
  await Promise.all(env.servers.map(server => new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => resolve())
  })))
})

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

function post(path: string, body: unknown, authorized = true) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(authorized ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
}

function message(count: number, size = 256 * 1024) {
  return {
    spaceId: 'space', conversationId: 'conversation', message: 'Inspect these images',
    images: Array.from({ length: count }, (_, index) => ({
      id: `image-${index}`, type: 'image', mediaType: 'image/png', data: Buffer.alloc(size, index).toString('base64'),
    })),
  }
}

describe('remote chat body parsing', () => {
  it.each([
    '/api/agent/message', '/api/apps/assistant/chat/send', '/api/teams/office/members/assistant/send',
    '/API/AGENT/MESSAGE/', '/API/APPS/assistant/CHAT/SEND/?source=test',
  ])('preserves a >100 KiB image request through %s', async path => {
    const body = message(1)
    const response = await post(path, body)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true, data: { count: 1 } })
    expect(env.received).toHaveBeenCalledTimes(1)
    expect(env.received).toHaveBeenCalledWith(body)
  })

  it('accepts the full image count together with text and references', async () => {
    const body = { ...message(MAX_IMAGES), references: [{ source: { kind: 'path', path: '/fixture.txt', isDirectory: false } }] }
    expect((await post('/api/agent/message', body)).status).toBe(200)
    expect(env.received).toHaveBeenCalledTimes(1)
    expect(env.received).toHaveBeenCalledWith(body)
  })

  it('sizes the parser for the composer limits and base64 overhead', () => {
    const encodedBytes = Math.max(MAX_IMAGE_SIZE, MAX_IMAGE_DIMENSION ** 2 * 4 + 64 * 1024)
    expect(CHAT_BODY_LIMIT).toBeGreaterThanOrEqual(MAX_IMAGES * Math.ceil(encodedBytes / 3) * 4 + 1024 * 1024)
    expect(Number.isFinite(CHAT_BODY_LIMIT)).toBe(true)
  })

  it.each(['/api/agent/message', '/api/apps/assistant/chat/send', '/api/teams/office/members/assistant/send'])(
    'authenticates %s before parsing even malformed or large JSON', async path => {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' + 'x'.repeat(128 * 1024),
      })
      expect(response.status).toBe(401)
      expect(await response.json()).toMatchObject({ success: false, error: 'No authorization token' })
      expect(env.received).not.toHaveBeenCalled()
    },
  )

  it('returns a JSON 413 for a declared body above the bound', async () => {
    // Drive the real parser without allocating a hundreds-of-MiB test payload.
    const req = Object.assign(new PassThrough(), {
      method: 'POST', path: '/api/agent/message',
      headers: { 'content-type': 'application/json', 'content-length': String(CHAT_BODY_LIMIT + 1) },
    })
    const next = vi.fn()
    let status = 0
    const body = await new Promise(resolve => {
      const res = {
        status(code: number) { status = code; return res },
        json(value: unknown) { resolve(value) },
      }
      parseChatBody(req as unknown as Request, res as unknown as Response, next)
      req.end('{}')
    })
    expect(status).toBe(413)
    expect(body).toEqual({
      success: false, code: 'PAYLOAD_TOO_LARGE', error: 'Request is too large. Reduce the attachment size or shorten the text.',
    })
    expect(next).not.toHaveBeenCalled()
  })

  it('returns JSON for malformed chat input without leaking its contents', async () => {
    const response = await fetch(`${baseUrl}/api/agent/message`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: '{"message":private-input',
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ success: false, code: 'INVALID_JSON', error: 'Invalid JSON request body' })
    expect(console.warn).toHaveBeenCalledWith('[HTTP] Chat request body rejected: entity.parse.failed')
    expect(env.received).not.toHaveBeenCalled()
  })

  it('accepts compressed and chunked chat requests using the same parser', async () => {
    const body = message(1)
    const compressed = await fetch(`${baseUrl}/api/agent/message`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', Authorization: `Bearer ${token}` },
      body: gzipSync(JSON.stringify(body)),
    })
    expect(compressed.status).toBe(200)
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${baseUrl}/api/agent/message`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)) })
      req.on('error', reject)
      const serialized = JSON.stringify(body)
      req.write(serialized.slice(0, 512))
      req.end(serialized.slice(512))
    })
    expect(status).toBe(200)
    expect(env.received).toHaveBeenCalledTimes(2)
    expect(env.received).toHaveBeenLastCalledWith(body)
  })

  it.each(['/api/config', '/api/agent/inject-message', '/api/apps/assistant/config', '/api/remote/login'])(
    'keeps the existing small request limit for %s', async path => {
      expect((await post(path, { text: 'x'.repeat(101 * 1024) })).status).toBe(413)
      expect(env.received).not.toHaveBeenCalled()
    },
  )

  it('leaves ordinary messages, login and skill imports working', async () => {
    expect((await post('/api/agent/message', { message: 'hello' })).status).toBe(200)
    expect((await post('/api/config', { setting: true })).status).toBe(200)
    expect((await post('/api/remote/login', { token }, false)).status).toBe(200)
    expect((await post('/api/skills/import', { data: 'x'.repeat(256 * 1024) })).status).toBe(200)
  })

  it('preserves the independent unauthenticated webhook body limit', async () => {
    const allowed = await post('/hooks/chat-body-test', { text: 'x'.repeat(128 * 1024) }, false)
    expect(allowed.status).toBe(200)
    expect(await allowed.json()).toMatchObject({ success: true, length: 128 * 1024 })
    const oversized = await post('/hooks/chat-body-test', { text: 'x'.repeat(257 * 1024) }, false)
    expect(oversized.status).toBe(413)
    expect(await oversized.json()).toEqual({ error: 'Invalid webhook request' })
  })

  it('does not broaden parsing to adjacent routes or other methods', () => {
    expect(isChatRequest('PUT', '/api/agent/message')).toBe(false)
    expect(isChatRequest('POST', '/api/agent/message/extra')).toBe(false)
    expect(isChatRequest('POST', '/api/apps/assistant/chat/send-other')).toBe(false)
    expect(isChatRequest('POST', '/api/teams/office/members/assistant/stop')).toBe(false)
  })
})
