/**
 * The sibling `scope.test.ts` proves `classify()` against a hand-written
 * fixture, which keeps it independent of how many routes are annotated — but
 * it means nothing in the suite ever loads the real `scope.json` /
 * `routes.json`. Those files ARE the exposure decision; with them mocked out,
 * the tests can only fail on the regex compiler, never on what is exposed.
 *
 * These assert properties rather than entries, so they neither churn as routes
 * are added nor go quiet when the tables change shape.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

import express from 'express'
import type { Server } from 'http'

// Only the LOCATION is stubbed, never the content: `getBundledRoot` resolves
// against `app.getAppPath()`, which under the test runner does not point at the
// checkout. The tables served below are the real generated artifacts, which is
// the entire point of this file.
vi.mock('../../../../src/main/services/api-ref/resource-path', async () => {
  const { readFileSync: read } = await import('fs')
  const { join: joinPath, dirname: dirName } = await import('path')
  const { fileURLToPath: toPath } = await import('url')
  const dir = joinPath(dirName(toPath(import.meta.url)), '../../../..', 'resources', 'api-ref')
  return {
    getApiRefPath: (file: string) => joinPath(dir, file),
    readApiRefFile: (file: string) => read(joinPath(dir, file), 'utf-8'),
    readApiRefJson: (file: string) => JSON.parse(read(joinPath(dir, file), 'utf-8')),
  }
})

import { classify } from '../../../../src/main/http/self-api/scope'
import { selfApiAuthMiddleware } from '../../../../src/main/http/self-api/middleware'
import { issueSelfApiToken } from '../../../../src/main/http/self-api/token-store'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const readTable = (name: string): Endpoint[] =>
  JSON.parse(readFileSync(join(repoRoot, 'resources', 'api-ref', name), 'utf-8'))

interface Endpoint {
  method: string
  path: string
  group?: string
}

const scope = readTable('scope.json')
const routes = readTable('routes.json')
const snapshot = JSON.parse(readFileSync(join(repoRoot, 'resources', 'api-ref', 'SNAPSHOT.json'), 'utf-8'))

const key = (e: Endpoint) => `${e.method} ${e.path}`
const scopeKeys = new Set(scope.map(key))

/** Express patterns carry `:param`; a concrete request never does. */
const concrete = (path: string) =>
  path
    .split('/')
    .map((segment) => (segment.startsWith(':') ? `real-${segment.slice(1)}-value` : segment))
    .join('/')

describe('the real generated tables', () => {
  it('are non-trivial, so a silently empty table cannot make the rest pass', () => {
    expect(scope.length).toBeGreaterThan(50)
    expect(routes.length).toBeGreaterThan(scope.length)
  })

  it('allows every endpoint scope.json lists, with params substituted', () => {
    // Catches a scope entry whose path shape does not match what the compiled
    // matcher accepts — it would 404 in production while looking exposed here.
    for (const endpoint of scope) {
      expect(classify(endpoint.method, concrete(endpoint.path)).decision, key(endpoint)).toBe('allowed')
    }
  })

  it('forbids every routed endpoint outside scope.json — never reports it as unknown', () => {
    // 403 and 404 send the agent down opposite recoveries: "ask the user to do
    // it in the app" vs "your path is wrong, look it up again".
    for (const endpoint of routes) {
      if (scopeKeys.has(key(endpoint))) continue
      expect(classify(endpoint.method, concrete(endpoint.path)).decision, key(endpoint)).toBe('forbidden')
    }
  })

  it('carries a group on exactly the forbidden routes whose 403 offers a redirect', () => {
    // notExposedBody() appends "other endpoints in this area are open: call
    // halo_api_ref('<group>')" from this field. A group on an internal route
    // would point the agent at a page that does not describe it.
    for (const endpoint of routes) {
      if (scopeKeys.has(key(endpoint))) continue
      const result = classify(endpoint.method, concrete(endpoint.path))
      if (endpoint.group === undefined) {
        expect(result.group, key(endpoint)).toBeUndefined()
      } else {
        expect(result.group, key(endpoint)).toBe(endpoint.group)
      }
    }
  })

  it('agrees with SNAPSHOT.json on how many routes are exposed', () => {
    // The two tables and the snapshot come from one generator run; a mismatch
    // means a partially regenerated tree is checked in.
    expect(routes.length).toBe(snapshot.totalRoutes)
    expect(scope.length).toBe(snapshot.expose.ai)
    expect(routes.length - scope.length).toBe(snapshot.expose.wrapped + snapshot.expose.internal)
    expect(snapshot.expose.unlabeled).toBe(0)
  })

})

/**
 * `applyDefaultSpaceId` rewrites `req.url` rather than assigning to `req.query`
 * — the only place in this module that leans on a framework implementation
 * detail (Express 5 recomputes `query` from the URL on access, so the obvious
 * assignment silently does nothing). Every other space-gate test asserts the
 * middleware's own output; this one asserts a handler actually receives it,
 * through the same `app.use('/api', ...)` mount the real server uses.
 */
describe('default spaceId survives the mount point', () => {
  const spaceId = 'space-under-test'
  let server: Server
  let base: string
  let token: string

  beforeAll(async () => {
    token = issueSelfApiToken(spaceId)

    const app = express()
    app.use(express.json())
    app.use('/api', selfApiAuthMiddleware)
    app.get('/api/apps', (req, res) => {
      res.json({ success: true, data: { sawSpaceId: req.query.spaceId } })
    })

    await new Promise<void>((done) => {
      server = app.listen(0, '127.0.0.1', () => done())
    })
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })

  afterAll(() => new Promise<void>((done) => server.close(() => done())))

  const get = (path: string) =>
    fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } })

  it('is readable as req.query.spaceId inside the handler', async () => {
    const res = await get('/api/apps')

    expect(res.status).toBe(200)
    expect((await res.json()).data.sawSpaceId).toBe(spaceId)
  })

  it('leaves an explicitly matching spaceId alone', async () => {
    const res = await get(`/api/apps?spaceId=${spaceId}`)

    expect(res.status).toBe(200)
    expect((await res.json()).data.sawSpaceId).toBe(spaceId)
  })
})
