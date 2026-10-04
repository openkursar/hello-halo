/**
 * The withheld-field check runs behind the scope gate, in the order the
 * self-API server installs them. Assembled here over a real socket with the
 * real generated tables: whatever spelling of a chat route a session tries —
 * letter case, a trailing slash, an encoded letter, a doubled slash — a
 * withheld field never reaches the handler.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import express from 'express'
import type { Server } from 'http'

// Only the location is stubbed; the tables served are the generated artifacts.
vi.mock('../../../../src/main/services/api-ref/resource-path', async () => {
  const { readFileSync } = await import('fs')
  const { join, dirname } = await import('path')
  const { fileURLToPath } = await import('url')
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../../../..', 'resources', 'api-ref')
  return {
    getApiRefPath: (file: string) => join(dir, file),
    readApiRefFile: (file: string) => readFileSync(join(dir, file), 'utf-8'),
    readApiRefJson: (file: string) => JSON.parse(readFileSync(join(dir, file), 'utf-8')),
  }
})

import { rejectNonApi, selfApiAuthMiddleware } from '../../../../src/main/http/self-api/middleware'
import { rejectWithheldFields } from '../../../../src/main/http/self-api/withheld-fields'
import { issueSelfApiToken, resetSelfApiTokens } from '../../../../src/main/http/self-api/token-store'
import { resetScopeCache } from '../../../../src/main/http/self-api/scope'

const ROUTES = ['/api/agent/message', '/api/apps/:appId/chat/send', '/api/apps/:appId/runs/:runId/inject']
const REQUESTS = ['/api/agent/message', '/api/apps/app-1/chat/send', '/api/apps/app-1/runs/run-1/inject']
const references = [{ id: 'r', source: { kind: 'path', path: '/tmp/a', isDirectory: false } }]

let server: Server
let base: string
let token: string
const reached: string[] = []

beforeAll(async () => {
  resetSelfApiTokens()
  resetScopeCache()
  token = issueSelfApiToken('space-a')

  const app = express()
  app.use(express.json())
  app.use(rejectNonApi)
  app.use('/api', selfApiAuthMiddleware)
  app.use('/api', rejectWithheldFields)
  for (const route of ROUTES) {
    app.post(route, (req, res) => {
      reached.push(req.originalUrl)
      res.json({ success: true })
    })
  }
  await new Promise<void>((done) => {
    server = app.listen(0, '127.0.0.1', () => done())
  })
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(() => new Promise<void>((done) => server.close(() => done())))

async function post(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

function otherSpellings(path: string): string[] {
  const cut = path.lastIndexOf('/') + 1
  const head = path.slice(0, cut)
  const last = path.slice(cut)
  return [
    `${path}/`,
    head + last.toUpperCase(),
    head + last[0].toUpperCase() + last.slice(1),
    path.replace(/^\/api\/([a-z]+)/, (_, segment: string) => `/api/${segment.toUpperCase()}`),
    `${head}%${last.charCodeAt(0).toString(16)}${last.slice(1)}`,
    path.replace('/api/', '/api//'),
  ]
}

describe('withheld fields behind the scope gate', () => {
  it('passes the documented spelling and refuses the field on it', async () => {
    reached.length = 0
    for (const path of REQUESTS) {
      expect((await post(path, { message: 'hi' })).status, path).toBe(200)
      const refused = await post(path, { message: 'hi', references })
      expect(refused.status, path).toBe(400)
      expect(refused.body.code, path).toBe('halo.self_api.field_not_accepted')
    }
    expect(reached).toEqual(REQUESTS)
  })

  it('never lets the field reach the handler under another spelling', async () => {
    reached.length = 0
    for (const path of REQUESTS.flatMap(otherSpellings)) {
      const { status } = await post(path, { message: 'hi', references })
      expect([400, 404], path).toContain(status)
    }
    expect(reached).toEqual([])
  })
})
