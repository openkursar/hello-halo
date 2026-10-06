import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Express } from 'express'
import { MODULE } from '../../../src/main/http/routes/system.routes.meta'

const env = vi.hoisted(() => ({
  manager: { startOAuthLogin: vi.fn(), completeOAuthLogin: vi.fn(), cancelOAuthLogin: vi.fn(), ensureValidToken: vi.fn(), logout: vi.fn() },
}))
vi.mock('../../../src/main/services/ai-sources', () => ({ getAISourceManager: () => env.manager }))
vi.mock('../../../src/main/http/routes/_shared', async () => ({
  authController: await import('../../../src/main/controllers/auth.controller'),
  getEnabledAuthProviderConfigs: () => [],
  analytics: { track: vi.fn() }, RENDERER_ALLOWED_EVENTS: new Set(), electronApp: { getVersion: () => 'test' },
}))

import { registerSystemRoutes } from '../../../src/main/http/routes/system.routes'

type Route = (req: any, res: any) => Promise<void>
const routes = new Map<string, Route>()
async function request(method: string, path: string, values: unknown = {}) {
  let body: any
  const res: any = { statusCode: 200, status: vi.fn((code: number) => { res.statusCode = code; return res }), json: vi.fn((value: any) => { body = value; return res }) }
  await routes.get(`${method} ${path}`)!({ body: values, query: values }, res)
  return { status: res.statusCode, body: JSON.parse(JSON.stringify(body)) }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  routes.clear()
  registerSystemRoutes({
    get: (path: string, handler: Route) => routes.set(`GET ${path}`, handler),
    post: (path: string, handler: Route) => routes.set(`POST ${path}`, handler),
  } as unknown as Express)
  env.manager.cancelOAuthLogin.mockResolvedValue({ success: true })
  env.manager.ensureValidToken.mockResolvedValue({ success: true, data: { accessToken: 'must-not-return' } })
  env.manager.logout.mockResolvedValue({ success: true, data: { refreshToken: 'must-not-return' } })
})

describe('remote OAuth lifecycle', () => {
  it('registers new auth surfaces in the existing system module and marks them internal', () => {
    for (const key of [
      'POST /api/auth/start-login', 'POST /api/auth/complete-login', 'POST /api/auth/cancel-login',
      'POST /api/auth/refresh-token', 'GET /api/auth/check-token', 'POST /api/auth/logout',
    ]) {
      expect(routes.has(key)).toBe(true)
      expect(MODULE.routes[key].expose).toBe('internal')
    }
    expect(MODULE.routes['GET /api/auth/providers'].expose).toBe('ai')
    expect(routes.has('POST /api/auth/open-login-window')).toBe(false)
  })

  it('starts a targeted reauthentication and allow-lists the public start fields', async () => {
    env.manager.startOAuthLogin.mockResolvedValue({ success: true, data: {
      loginId: 'own-flow', loginUrl: 'https://issuer.example/login', state: 'csrf', redirectUri: 'https://callback.example/login',
      accessToken: 'must-not-return', _tokenData: { refreshToken: 'must-not-return' },
    } })
    const result = await request('POST', '/api/auth/start-login', { providerType: 'external', sourceId: 'account-2' })
    expect(env.manager.startOAuthLogin).toHaveBeenCalledWith('external', 'account-2')
    expect(result.body).toEqual({ success: true, data: { loginId: 'own-flow', loginUrl: 'https://issuer.example/login', state: 'csrf', redirectUri: 'https://callback.example/login' } })
  })

  it('answers malformed identifiers with 400 before reaching the account manager', async () => {
    expect((await request('POST', '/api/auth/start-login', { providerType: 'external', sourceId: ' padded ' })).status).toBe(400)
    expect((await request('POST', '/api/auth/start-login', { providerType: '' })).status).toBe(400)
    expect(env.manager.startOAuthLogin).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledWith('[Auth] Rejected start-login: invalid request fields')
  })

  it('rejects an incomplete start result without granting an ownerless flow', async () => {
    env.manager.startOAuthLogin.mockResolvedValue({ success: true, data: { loginUrl: 'https://issuer.example/login', state: 'csrf' } })
    expect((await request('POST', '/api/auth/start-login', { providerType: 'external' })).body).toEqual({ success: false, error: 'Failed to start login' })
    expect(console.warn).toHaveBeenCalledWith('[Auth] Discarded login start without a login id: provider=external')
  })

  it('completes only with a login ID and never returns provider token payloads', async () => {
    env.manager.completeOAuthLogin.mockResolvedValue({ success: true, data: {
      success: true, sourceId: 'account-2', sourceIds: ['account-2'], user: { name: 'User', uid: 'user-2', accessToken: 'hidden' },
      accessToken: 'hidden', refreshToken: 'hidden', _tokenData: { accessToken: 'hidden' },
    } })
    const result = await request('POST', '/api/auth/complete-login', { providerType: 'external', state: 'code#csrf', loginId: 'own-flow' })
    expect(env.manager.completeOAuthLogin).toHaveBeenCalledWith('external', 'code#csrf', 'own-flow')
    expect(result.body).toEqual({ success: true, data: { success: true, sourceId: 'account-2', sourceIds: ['account-2'], user: { name: 'User', uid: 'user-2' } } })
    expect((await request('POST', '/api/auth/complete-login', { providerType: 'external', state: 'code' })).status).toBe(400)
    expect(env.manager.completeOAuthLogin).toHaveBeenCalledTimes(1)
  })

  it('rejects ownerless cancel without cancelling any provider pending login', async () => {
    expect((await request('POST', '/api/auth/cancel-login', { providerType: 'external' })).status).toBe(400)
    expect(env.manager.cancelOAuthLogin).not.toHaveBeenCalled()
    await request('POST', '/api/auth/cancel-login', { providerType: 'external', loginId: 'own-flow' })
    expect(env.manager.cancelOAuthLogin).toHaveBeenCalledWith('external', 'own-flow')
  })

  it('uses source IDs for refresh, check and logout and sanitizes all three responses', async () => {
    expect((await request('POST', '/api/auth/refresh-token', { sourceId: 'account-2' })).body).toEqual({ success: true })
    expect((await request('GET', '/api/auth/check-token', { sourceId: 'account-3' })).body).toEqual({ success: true, data: { valid: true, needsRefresh: false } })
    expect((await request('POST', '/api/auth/logout', { sourceId: 'account-4' })).body).toEqual({ success: true })
    expect(env.manager.ensureValidToken.mock.calls).toEqual([['account-2'], ['account-3']])
    expect(env.manager.logout).toHaveBeenCalledWith('account-4')
    expect(env.manager.cancelOAuthLogin).not.toHaveBeenCalled()
    expect((await request('POST', '/api/auth/logout', { providerType: 'external' })).status).toBe(400)
    expect((await request('GET', '/api/auth/check-token', { sourceId: ['one', 'two'] })).status).toBe(400)
  })

  it('preserves login failures and reports authentication failures as invalid status', async () => {
    env.manager.startOAuthLogin.mockResolvedValue({ success: false, error: 'Provider unavailable' })
    expect((await request('POST', '/api/auth/start-login', { providerType: 'external' })).body).toEqual({ success: false, error: 'Provider unavailable' })
    expect(console.warn).not.toHaveBeenCalled()
    env.manager.ensureValidToken.mockResolvedValue({ success: false, error: 'Expired' })
    expect((await request('GET', '/api/auth/check-token', { sourceId: 'account-2' })).body).toEqual({ success: true, data: { valid: false, reason: 'Expired' } })
  })

  it('does not return exception details that could contain OAuth secrets', async () => {
    env.manager.completeOAuthLogin.mockRejectedValue(new Error('Request failed with code=secret&accessToken=secret'))
    expect((await request('POST', '/api/auth/complete-login', { providerType: 'external', state: 'code', loginId: 'owned' })).body).toEqual({ success: false, error: 'Login failed' })
  })
})
