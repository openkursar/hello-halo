import { beforeEach, describe, expect, it, vi } from 'vitest'

const { manager, getStoreIdentityProvider, serverRequiresIdentity } = vi.hoisted(() => ({
  manager: {
    getOAuthSource: vi.fn(), getOAuthAccessToken: vi.fn(), getOAuthIdentity: vi.fn(),
    startOAuthLogin: vi.fn(), completeOAuthLogin: vi.fn()
  },
  getStoreIdentityProvider: vi.fn(), serverRequiresIdentity: vi.fn()
}))

vi.mock('../../../src/main/services/ai-sources', () => ({ getAISourceManager: () => manager }))
vi.mock('../../../src/main/foundation/product-config', () => ({ getStoreIdentityProvider }))
vi.mock('../../../src/main/store/backend/capabilities', () => ({ serverRequiresIdentity }))

import { ensureStoreIdentity } from '../../../src/main/store/backend/identity'

describe('store OAuth identity', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    getStoreIdentityProvider.mockReturnValue('test-provider')
    manager.getOAuthSource.mockReturnValue({ id: 'selected-account' })
    manager.startOAuthLogin.mockResolvedValue({ success: true, data: { state: 'state', loginId: 'owned-login' } })
    manager.completeOAuthLogin.mockResolvedValue({ success: true })
  })

  it('targets the existing identity account and carries authorization ownership on forced sign-in', async () => {
    expect(await ensureStoreIdentity(true)).toBe(true)
    expect(manager.startOAuthLogin).toHaveBeenCalledWith('test-provider', 'selected-account')
    expect(manager.completeOAuthLogin).toHaveBeenCalledWith('test-provider', 'state', 'owned-login')
  })

  it('does not start a login when the selected account has a valid token', async () => {
    manager.getOAuthAccessToken.mockResolvedValue('valid-token')
    expect(await ensureStoreIdentity()).toBe(true)
    expect(manager.startOAuthLogin).not.toHaveBeenCalled()
  })

  it('creates an untargeted login only when no identity account exists', async () => {
    manager.getOAuthSource.mockReturnValue(null)
    expect(await ensureStoreIdentity()).toBe(true)
    expect(manager.startOAuthLogin).toHaveBeenCalledWith('test-provider', undefined)
  })

  it('does not treat an authorization rejection as signed-in', async () => {
    manager.completeOAuthLogin.mockResolvedValue({ success: false, error: 'Wrong account' })
    expect(await ensureStoreIdentity(true)).toBe(false)
  })
})
