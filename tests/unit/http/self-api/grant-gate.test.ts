import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest'
import express from 'express'
import { request as httpRequest, type Server } from 'http'
import type { AddressInfo } from 'net'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('../../../../src/main/services/api-ref/resource-path', async () => {
  const { readFileSync } = await import('fs')
  const { join, dirname } = await import('path')
  const { fileURLToPath } = await import('url')
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../../../..', 'resources', 'api-ref')
  return {
    getApiRefPath: (file: string) => join(dir, file),
    readApiRefJson: (file: string) => JSON.parse(readFileSync(join(dir, file), 'utf-8')),
  }
})

const runtime = vi.hoisted(() => ({ respondToEscalation: vi.fn(), injectIntoRun: vi.fn() }))
vi.mock('../../../../src/main/http/routes/_shared', () => ({
  getAppRuntime: () => runtime,
}))
vi.mock('../../../../src/main/apps/runtime', () => ({}))
vi.mock('../../../../src/main/apps/runtime/reminders', () => ({ getConversationReminders: () => null }))
vi.mock('../../../../src/main/controllers/app-chat-target.controller', () => ({}))
vi.mock('../../../../src/main/controllers/chat-turn-input', () => ({
  parseTurnReferences: () => ({ ok: true, references: undefined }),
}))

import { registerAppsRoutes } from '../../../../src/main/http/routes/apps.routes'
import { rejectNonApi, selfApiAuthMiddleware, selfApiErrorHandler } from '../../../../src/main/http/self-api/middleware'
import { redactResponses } from '../../../../src/main/http/self-api/redact'
import { rejectWithheldFields } from '../../../../src/main/http/self-api/withheld-fields'
import { issueSelfApiGrant, resetSelfApiGrants } from '../../../../src/main/http/self-api/grant-store'
import * as tokens from '../../../../src/main/http/self-api/token-store'
import * as scope from '../../../../src/main/http/self-api/scope'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import { migrations as managerMigrations } from '../../../../src/main/apps/manager/migrations'
import { migrations } from '../../../../src/main/apps/runtime/migrations'
import { ActivityStore } from '../../../../src/main/apps/runtime/store'
import { prepareRelayActions, setRelayActionAccess } from '../../../../src/main/apps/runtime/relay-actions'
import { ImSessionRegistry } from '../../../../src/main/apps/runtime/im-session-registry'

const PATH = '/api/apps/app-1/escalation/entry-1/respond'
const NOW = 1_800_000_000_000
let server: Server
let port: number
const reached = vi.fn()

beforeAll(async () => {
  const app = express()
  app.set('env', 'production')
  app.use(express.json())
  app.use(rejectNonApi)
  app.use(redactResponses)
  app.use('/api', selfApiAuthMiddleware)
  app.use('/api', rejectWithheldFields)
  app.use((_req, _res, next) => {
    reached()
    next()
  })
  app.post('/api/config', (_req, res) => res.json({ success: true }))
  app.get('/api/apps/:appId', (req, res) => res.json({ success: true, data: { id: req.params.appId } }))
  registerAppsRoutes(app)
  app.use(selfApiErrorHandler)
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  port = (server.address() as AddressInfo).port
})

beforeEach(() => {
  resetSelfApiGrants()
  tokens.resetSelfApiTokens()
  scope.resetScopeCache()
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  runtime.respondToEscalation.mockResolvedValue({ id: 'entry-1', status: 'resolved' })
  runtime.injectIntoRun.mockResolvedValue(undefined)
})

afterEach(() => { vi.restoreAllMocks() })
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

// Node's request path preserves traversal, percent encoding, and fragments verbatim.
function call(path: string, token?: string, method = 'POST', body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1', port, path, method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : undefined })
        } catch (error) {
          reject(error)
        }
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

function expectGrantGuidance(body: { error: string }) {
  expect(body.error).toContain('limited to the invited action')
  expect(body.error).toContain('24h')
  expect(body.error).toContain('Halo restart')
  expect(body.error).toContain('ask the owner to finish in Halo')
  expect(body.error).not.toMatch(/halo_api_ref|HALO_API_TOKEN/)
}

describe('invited answers through HTTP and the decision transaction', () => {
  let manager: DatabaseManager
  let store: ActivityStore

  beforeEach(() => {
    manager = createDatabaseManager(':memory:')
    const db = manager.getAppDatabase()
    manager.runMigrations(db, 'app_manager', managerMigrations)
    manager.runMigrations(db, 'app_runtime', migrations)
    db.prepare(`INSERT INTO installed_apps(id, spec_id, space_id, spec_json, installed_at) VALUES ('app-1', 'spec', 'space', '{"type":"automation"}', 1)`).run()
    store = new ActivityStore(db)
    store.insertRun({ runId: 'run-1', appId: 'app-1', sessionKey: 'session-1', status: 'waiting_user', triggerType: 'manual', startedAt: NOW })
    store.insertEntry({ id: 'entry-1', appId: 'app-1', runId: 'run-1', type: 'escalation', ts: NOW,
      content: { summary: 'Which region?', choices: ['华东', '华南'] } })
    runtime.respondToEscalation.mockImplementation(async (appId, entryId, response) => store.acceptDecision(appId, entryId, response))
    setRelayActionAccess({
      ensureServer: async () => ({ url: `http://127.0.0.1:${port}` }),
      issueGrant: async request => issueSelfApiGrant(request),
    }, store)
  })

  afterEach(() => {
    setRelayActionAccess(null, null)
    manager.closeAll()
  })

  async function invite(isAuthorized = () => true): Promise<string> {
    const actions = await prepareRelayActions([{
      kind: 'push', id: 'relay-1', at: NOW,
      source: { key: 'app-run:app-1:run-1', appId: 'app-1', runId: 'run-1', label: 'Release Bot' },
      sourceOwner: false, message: 'Which region?',
      action: { kind: 'answer-question', appId: 'app-1', entryId: 'entry-1' },
    }], isAuthorized)
    const token = actions.get('relay-1')?.match(/Authorization: Bearer (halo-grant-[a-f0-9]+)/)?.[1]
    expect(token).toBeDefined()
    return token!
  }

  it.each([
    { choice: 'A' },
    { choice: '华东吧' },
    { choice: '<exact choice selected by the owner>' },
    { text: '<the owner’s answer>' },
    { choice: '' },
    { choice: 1 },
    { text: { answer: '华东' } },
    { text: '华东', answers: null },
    { text: '华东', answers: false },
    { text: '华东', answers: '' },
    { text: '华东', answers: [] },
    { answers: [null] },
    { answers: [{ choice: '华东' }, { text: 'tomorrow' }] },
  ])('rejects %j without writing, then accepts a correction using the same invitation', async payload => {
    const token = await invite()
    const before = manager.getAppDatabase().prepare('SELECT total_changes() AS count').get()

    const rejected = await call(PATH, token, 'POST', payload)
    expect(rejected.status).toBe(200)
    expect(rejected.body).toEqual({ success: false, error: expect.any(String) })
    expect(manager.getAppDatabase().prepare('SELECT total_changes() AS count').get()).toEqual(before)
    expect(store.getEntry('entry-1')?.userResponse).toBeUndefined()
    expect(store.getQueuedContinuations()).toEqual([])

    const accepted = await call(PATH, token, 'POST', { choice: '华东' })
    expect(accepted.body.success).toBe(true)
    expect(store.getEntry('entry-1')?.userResponse).toMatchObject({ choice: '华东', ts: NOW })
    expect(store.getQueuedContinuations()).toHaveLength(1)

    const closed = await call(PATH, token, 'POST', { choice: '华南' })
    expect(closed.status).toBe(403)
    expect(closed.body.error).toContain('already been answered')
    expect(runtime.respondToEscalation).toHaveBeenCalledTimes(2)
    expect(store.getEntry('entry-1')?.userResponse?.choice).toBe('华东')
    expect(store.getQueuedContinuations()).toHaveLength(1)
  })

  it.each(['recreated', 'cleared', 'proactive restored'] as const)('refuses an unused invitation after the real session was %s', async change => {
    const dir = mkdtempSync(join(tmpdir(), 'grant-session-'))
    const registry = new ImSessionRegistry(join(dir, 'sessions.json'))
    const address = ['app-1', 'wecom-bot', 'owner-chat'] as const
    try {
      registry.register(...address, 'direct', 'bot-1', { contactId: 'owner-1' })
      registry.setProactive(...address, true)
      const revision = registry.getSessionRevision(...address)
      expect(revision).toBeDefined()
      const token = await invite(() => registry.getSessionRevision(...address) === revision)

      if (change === 'recreated') {
        registry.removeSession(...address)
        registry.register(...address, 'direct', 'bot-1', { contactId: 'owner-1' })
        registry.setProactive(...address, true)
      } else if (change === 'cleared') {
        registry.resetActivity(...address)
      } else {
        registry.setProactive(...address, false)
        registry.setProactive(...address, true)
      }

      const rejected = await call(PATH, token, 'POST', { choice: '华东' })
      expect(rejected.status).toBe(403)
      expect(rejected.body.success).toBe(false)
      expect(rejected.body.error).toContain('no longer authorized')
      expect(runtime.respondToEscalation).not.toHaveBeenCalled()
      expect(store.getEntry('entry-1')?.userResponse).toBeUndefined()
      expect(store.getQueuedContinuations()).toEqual([])
      expect((await call(PATH, token, 'POST', { choice: '华东' })).status).toBe(401)
    } finally {
      await new Promise(resolve => setTimeout(resolve, 20))
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('accepts the owner’s custom text even when preset choices exist', async () => {
    const token = await invite()
    const accepted = await call(PATH, token, 'POST', { text: '先只在华北灰度' })
    expect(accepted.body.success).toBe(true)
    expect(store.getEntry('entry-1')?.userResponse?.text).toBe('先只在华北灰度')
    expect(store.getQueuedContinuations()).toHaveLength(1)
  })
})

describe('temporary grants on the mounted HTTP gate', () => {
  it.each([{ choice: '华东' }, { text: 'Use the revised plan.' }])('forwards a single answer through the mounted respond route: %j', async payload => {
    const grant = issueSelfApiGrant({ method: 'POST', path: PATH })
    const res = await call(PATH, grant.token, 'POST', payload)
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(runtime.respondToEscalation).toHaveBeenCalledWith('app-1', 'entry-1', { ts: NOW, ...payload })
  })

  it('passes the real apps respond body through to runtime repeatedly', async () => {
    const validate = vi.fn(() => undefined)
    const grant = issueSelfApiGrant({ method: 'POST', path: PATH, validate })
    const payload = { answers: [{ choice: 'approve' }, { text: 'Use the revised plan.' }] }
    for (let i = 0; i < 2; i++) {
      const res = await call(PATH, grant.token, 'POST', payload)
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ success: true, data: { id: 'entry-1', status: 'resolved' } })
    }
    expect(runtime.respondToEscalation).toHaveBeenCalledTimes(2)
    expect(runtime.respondToEscalation).toHaveBeenLastCalledWith('app-1', 'entry-1', { ts: NOW, ...payload })
    expect(validate).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['GET', PATH], ['PUT', PATH], ['DELETE', PATH], ['HEAD', PATH], ['OPTIONS', PATH],
    ['POST', PATH + '/'], ['POST', PATH + '/extra'],
    ['POST', PATH.replace('respond', 'retry')],
    ['POST', PATH.replace('entry-1', 'entry-2')],
    ['POST', PATH.replace('app-1', 'app-2')],
    ['POST', PATH.replace('respond', 'RESPOND')],
    ['POST', PATH.replace('respond', '%72espond')],
    ['POST', PATH.replace('app-1', '%61pp-1')],
    ['POST', PATH.replace('/escalation/', '%2Fescalation/')],
    ['POST', PATH.replace('/escalation/', '%252Fescalation/')],
    ['POST', PATH.replace('/api/', '/api//')],
    ['POST', PATH.replace('/apps/', '/./apps/')],
    ['POST', PATH.replace('/apps/', '/unused/../apps/')],
    ['POST', PATH.replace('/apps/', '/%2E%2E/apps/')],
    ['POST', PATH.replace('entry-1', '%ZZ')],
    ['POST', PATH + '?other=1'], ['POST', PATH + '#fragment'],
  ])('never dispatches a non-literal request: %s %s', async (method, path) => {
    const grant = issueSelfApiGrant({ method: 'POST', path: PATH })
    const res = await call(path, grant.token, method)
    expect(res.status).toBe(403)
    if (method !== 'HEAD') expectGrantGuidance(res.body)
    expect(reached).not.toHaveBeenCalled()
    expect(runtime.respondToEscalation).not.toHaveBeenCalled()
  })

  it.each(['/apis/apps', '/api', '/API/apps', '/other/api/apps'])('refuses prefix lookalike %s', async (path) => {
    const grant = issueSelfApiGrant({ method: 'POST', path: PATH })
    const res = await call(path, grant.token)
    expect(res.status).toBe(404)
    expectGrantGuidance(res.body)
    expect(reached).not.toHaveBeenCalled()
  })

  it('does not let a grant turn HEAD into GET via Express fallback', async () => {
    const grant = issueSelfApiGrant({ method: 'GET', path: '/api/apps/app-1' })
    expect((await call('/api/apps/app-1', grant.token, 'HEAD')).status).toBe(403)
    expect(reached).not.toHaveBeenCalled()
  })

  it('keeps scope closed for an exact but unexposed action', async () => {
    const grant = issueSelfApiGrant({ method: 'POST', path: '/api/config' })
    const res = await call('/api/config', grant.token)
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('halo.self_api.not_exposed')
    expectGrantGuidance(res.body)
    expect(reached).not.toHaveBeenCalled()
  })

  it('keeps scope closed for an exact but unknown action', async () => {
    const grant = issueSelfApiGrant({ method: 'POST', path: '/api/does-not-exist' })
    const res = await call('/api/does-not-exist', grant.token)
    expect(res.status).toBe(404)
    expect(res.body.code).toBe('halo.self_api.unknown_endpoint')
    expectGrantGuidance(res.body)
    expect(reached).not.toHaveBeenCalled()
  })

  it.each(['raw', 'decoded'])('still requires the %s scope classification to allow the path', async (blocked) => {
    const path = '/api/apps/%E4%B8%AD'
    const grant = issueSelfApiGrant({ method: 'GET', path })
    const classify = vi.spyOn(scope, 'classify')
      .mockReturnValueOnce({ decision: blocked === 'raw' ? 'forbidden' : 'allowed' })
      .mockReturnValueOnce({ decision: blocked === 'decoded' ? 'forbidden' : 'allowed' })
    const res = await call(path, grant.token, 'GET')
    expect(res.status).toBe(403)
    expect(classify).toHaveBeenNthCalledWith(1, 'GET', path)
    expect(classify).toHaveBeenNthCalledWith(2, 'GET', '/api/apps/中')
    expect(reached).not.toHaveBeenCalled()
  })

  it('dispatches a canonical encoded object only with its exact raw spelling', async () => {
    const path = '/api/apps/%E4%B8%AD'
    const grant = issueSelfApiGrant({ method: 'GET', path })
    const res = await call(path, grant.token, 'GET')
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe('中')
    expect((await call('/api/apps/%e4%b8%ad', grant.token, 'GET')).status).toBe(403)
    expect(reached).toHaveBeenCalledTimes(1)
  })

  it('handles grant-prefixed tokens before checking normal tokens', async () => {
    const resolve = vi.spyOn(tokens, 'resolveSelfApiToken').mockReturnValue(true)
    const res = await call(PATH, 'halo-grant-unknown')
    expect(res.status).toBe(401)
    expect(res.body.code).toBe('halo.self_api.grant_unavailable')
    expectGrantGuidance(res.body)
    expect(resolve).not.toHaveBeenCalled()
    expect(reached).not.toHaveBeenCalled()
  })

  it('accepts a grant before expiry but rejects it at the boundary and after restart', async () => {
    const grant = issueSelfApiGrant({ method: 'POST', path: PATH })
    vi.mocked(Date.now).mockReturnValue(grant.expiresAt - 1)
    expect((await call(PATH, grant.token, 'POST', {})).status).toBe(200)
    vi.mocked(Date.now).mockReturnValue(grant.expiresAt)
    const expired = await call(PATH, grant.token, 'POST', {})
    expect(expired.status).toBe(401)
    expectGrantGuidance(expired.body)
    const other = issueSelfApiGrant({ method: 'POST', path: PATH })
    resetSelfApiGrants()
    const restarted = await call(PATH, other.token, 'POST', {})
    expect(restarted.status).toBe(401)
    expectGrantGuidance(restarted.body)
    expect(runtime.respondToEscalation).toHaveBeenCalledTimes(1)
  })

  it('irreversibly revokes a closed action and reports the callback reason', async () => {
    const validate = vi.fn<[], string | undefined>(() => 'This action has already closed.')
    const grant = issueSelfApiGrant({ method: 'POST', path: PATH, validate })
    const denied = await call(PATH, grant.token, 'POST', { text: 'private-body' })
    expect(denied.status).toBe(403)
    expect(denied.body.error).toContain('This action has already closed.')
    expectGrantGuidance(denied.body)
    validate.mockReturnValue(undefined)
    expect((await call(PATH, grant.token)).status).toBe(401)
    expect(validate).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledTimes(2)
    const logs = JSON.stringify(vi.mocked(console.warn).mock.calls)
    expect(logs).not.toContain(grant.token)
    expect(logs).not.toContain('private-body')
    expect(reached).not.toHaveBeenCalled()
  })

  it('fails closed on a callback exception without exposing its payload', async () => {
    const validate = vi.fn(() => { throw new Error('private-state-payload') })
    const grant = issueSelfApiGrant({ method: 'POST', path: PATH, validate })
    const denied = await call(PATH, grant.token)
    expect(denied.status).toBe(403)
    expectGrantGuidance(denied.body)
    expect(JSON.stringify(denied.body)).not.toContain('private-state-payload')
    expect((await call(PATH, grant.token)).status).toBe(401)
    expect(validate).toHaveBeenCalledTimes(1)
    expect(console.warn).toHaveBeenCalledTimes(2)
    expect(reached).not.toHaveBeenCalled()
  })

  it('never accepts a grant in the query string', async () => {
    const grant = issueSelfApiGrant({ method: 'POST', path: PATH })
    expect((await call(PATH + '?token=' + grant.token)).status).toBe(401)
    expect(reached).not.toHaveBeenCalled()
  })

  it('keeps withheld-field refusal and legitimate retry unchanged for grants', async () => {
    const path = '/api/apps/app-1/runs/run-1/inject'
    const grant = issueSelfApiGrant({ method: 'POST', path })
    const refused = await call(path, grant.token, 'POST', { text: 'hi', references: [] })
    expect(refused.status).toBe(400)
    expect(refused.body.code).toBe('halo.self_api.field_not_accepted')
    expect(runtime.injectIntoRun).not.toHaveBeenCalled()
    expect((await call(path, grant.token, 'POST', { text: 'hi' })).status).toBe(200)
    expect(runtime.injectIntoRun).toHaveBeenCalledWith('app-1', 'run-1', 'hi', undefined)
  })

  it('redacts the real handler response without changing the submitted body', async () => {
    const grant = issueSelfApiGrant({ method: 'POST', path: PATH })
    runtime.respondToEscalation.mockResolvedValue({ userConfig: { key: 'private-value' }, token: 'private-token', tokenCount: 3 })
    const res = await call(PATH, grant.token, 'POST', { text: 'the answer' })
    expect(res.body.data).toEqual({ userConfig: { key: '[redacted]' }, token: '[redacted]', tokenCount: 3 })
    expect(runtime.respondToEscalation).toHaveBeenCalledWith('app-1', 'entry-1', { ts: NOW, text: 'the answer' })
  })

  it('leaves regular-token scope, query handling, and action access unchanged', async () => {
    const token = tokens.issueSelfApiToken('space-a')
    resetSelfApiGrants()
    vi.mocked(Date.now).mockReturnValue(NOW + 48 * 60 * 60 * 1000)
    expect((await call(PATH + '?spaceId=space-b', token, 'POST', { text: 'hello' })).status).toBe(200)
    expect((await call(PATH.replace('app-1', 'app-2'), token, 'POST', {})).status).toBe(200)
    expect((await call('/api/config', token)).body.code).toBe('halo.self_api.not_exposed')
    const unknown = await call('/api/does-not-exist', token)
    expect(unknown.body.error).toContain('halo_api_ref')
    expect((await call(PATH, 'wrong-regular-token')).body.code).toBe('halo.self_api.unauthorized')
    expect(runtime.respondToEscalation).toHaveBeenCalledTimes(2)
    expect(tokens.issueSelfApiToken('space-a')).toBe(token)
  })
})
