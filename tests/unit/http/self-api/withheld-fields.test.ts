/**
 * An assistant session reaches the same send route as the Halo app, but may
 * not set the conversation goal through it: a set there would be recorded as
 * the user's own change. The field is refused out loud, never dropped silently.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import type { Server } from 'http'
import { rejectWithheldFields } from '../../../../src/main/http/self-api/withheld-fields'

let server: Server
let base: string
const received: unknown[] = []

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  // Mounted as the self-API server mounts it, so the route key is read the same way.
  app.use('/api', rejectWithheldFields)
  app.post('/api/agent/message', (req, res) => {
    received.push(req.body)
    res.json({ success: true })
  })
  app.post('/api/agent/goal/set', (req, res) => {
    received.push(req.body)
    res.json({ success: true })
  })
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

async function post(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

describe('self-API withheld body fields', () => {
  it('refuses a message that carries a goal, without reaching the handler', async () => {
    received.length = 0
    const { status, body } = await post('/api/agent/message', {
      spaceId: 's', conversationId: 'c', message: 'hi', goal: { objective: 'x' },
    })
    expect(status).toBe(400)
    expect(body).toMatchObject({ success: false, code: 'halo.self_api.field_not_accepted', field: 'goal' })
    expect(String(body.error)).toContain('Goal tool')
    expect(received).toHaveLength(0)
  })

  it('passes a message without a goal through untouched', async () => {
    received.length = 0
    const { status } = await post('/api/agent/message?x=1', { spaceId: 's', conversationId: 'c', message: 'hi' })
    expect(status).toBe(200)
    expect(received).toEqual([{ spaceId: 's', conversationId: 'c', message: 'hi' }])
  })

  it('leaves other routes alone', async () => {
    received.length = 0
    const { status } = await post('/api/agent/goal/set', { goal: { objective: 'x' } })
    expect(status).toBe(200)
    expect(received).toHaveLength(1)
  })
})

describe('withheld fields against the manual', () => {
  // The table and the route manual describe the same surface; a route renamed
  // in one, or a withheld field advertised in the other, must fail here.
  it('names only assistant-exposed routes, whose manual entry never offers the field', async () => {
    const { WITHHELD_FIELDS } = await import('../../../../src/main/http/self-api/withheld-fields')
    const { readdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = join(__dirname, '../../../../src/main/http/routes')
    const routes: Record<string, { expose: string; body?: string; notes?: string }> = {}
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.routes.meta.ts'))) {
      const { MODULE } = await import(join(dir, name))
      Object.assign(routes, MODULE.routes)
    }

    for (const [route, fields] of Object.entries(WITHHELD_FIELDS)) {
      expect(routes[route], route).toBeDefined()
      expect(routes[route].expose, route).toBe('ai')
      const manual = `${routes[route].body ?? ''}\n${routes[route].notes ?? ''}`
      for (const { field } of fields) {
        expect(manual, `${route} advertises "${field}"`).not.toMatch(new RegExp(`\\b${field}\\b`))
      }
    }
  })
})
