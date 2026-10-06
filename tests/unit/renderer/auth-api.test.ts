import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ electron: false, httpRequest: vi.fn(), halo: {} as Record<string, ReturnType<typeof vi.fn>> }))
vi.mock('../../../src/renderer/api/_shared', () => ({
  isElectron: () => env.electron, isCapacitor: () => false, httpRequest: env.httpRequest,
  clearAuthToken: vi.fn(), getAuthToken: vi.fn(), setAuthToken: vi.fn(), connectWebSocket: vi.fn(), disconnectWebSocket: vi.fn(),
}))
import { authApi } from '../../../src/renderer/api/auth.api'

beforeEach(() => {
  vi.resetAllMocks()
  env.electron = false
  env.httpRequest.mockResolvedValue({ success: true })
  env.halo = Object.fromEntries(['authStartLogin', 'authOpenLoginWindow', 'authCompleteLogin', 'authCancelLogin', 'authRefreshToken', 'authCheckToken', 'authLogout'].map(name => [name, vi.fn().mockResolvedValue({ success: true })]))
  vi.stubGlobal('window', { halo: env.halo })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('auth API transport parity', () => {
  it('uses owned login IDs and target source IDs remotely', async () => {
    await authApi.authStartLogin('external', 'account-2')
    await authApi.authCompleteLogin('external', 'code#state', 'own-flow')
    await authApi.authCancelLogin('external', 'own-flow')
    expect(env.httpRequest.mock.calls).toEqual([
      ['POST', '/api/auth/start-login', { providerType: 'external', sourceId: 'account-2' }],
      ['POST', '/api/auth/complete-login', { providerType: 'external', state: 'code#state', loginId: 'own-flow' }],
      ['POST', '/api/auth/cancel-login', { providerType: 'external', loginId: 'own-flow' }],
    ])
  })

  it('keeps no client-side login state: every start is a plain request', async () => {
    await authApi.authStartLogin('external', 'a')
    await authApi.authStartLogin('external', 'a')
    expect(env.httpRequest.mock.calls).toEqual([
      ['POST', '/api/auth/start-login', { providerType: 'external', sourceId: 'a' }],
      ['POST', '/api/auth/start-login', { providerType: 'external', sourceId: 'a' }],
    ])
  })

  it('uses source IDs, not provider types, for source authentication operations', async () => {
    await authApi.authRefreshToken('account-2')
    await authApi.authCheckToken('account&two')
    await authApi.authLogout('account-3')
    expect(env.httpRequest.mock.calls).toEqual([
      ['POST', '/api/auth/refresh-token', { sourceId: 'account-2' }],
      ['GET', '/api/auth/check-token?sourceId=account%26two'],
      ['POST', '/api/auth/logout', { sourceId: 'account-3' }],
    ])
  })

  it('forwards all ownership arguments through the preload RPC client', async () => {
    env.electron = true
    await authApi.authStartLogin('external', 'account-2')
    await authApi.authCompleteLogin('external', 'code#state', 'own-flow')
    await authApi.authCancelLogin('external', 'own-flow')
    await authApi.authOpenLoginWindow('external', 'own-flow')
    expect(env.halo.authStartLogin).toHaveBeenCalledWith('external', 'account-2')
    expect(env.halo.authCompleteLogin).toHaveBeenCalledWith('external', 'code#state', 'own-flow')
    expect(env.halo.authCancelLogin).toHaveBeenCalledWith('external', 'own-flow')
    expect(env.halo.authOpenLoginWindow).toHaveBeenCalledWith('external', 'own-flow')
    expect(env.httpRequest).not.toHaveBeenCalled()
  })

  it('never tries an embedded browser over HTTP', async () => {
    expect(await authApi.authOpenLoginWindow('external', 'own-flow')).toEqual({ success: false, error: 'Login window not supported in web mode' })
    expect(env.httpRequest).not.toHaveBeenCalled()
  })
})
