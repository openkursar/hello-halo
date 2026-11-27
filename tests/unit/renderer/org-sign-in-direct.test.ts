import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  enterpriseIdentitySignIn: vi.fn(),
  authStartLogin: vi.fn(),
  authOpenLoginWindow: vi.fn(),
  authCompleteLogin: vi.fn(),
  authCancelLogin: vi.fn(async () => ({ success: true })),
  getConfig: vi.fn(),
}))
const setConfig = vi.hoisted(() => vi.fn())

vi.mock('../../../src/renderer/api', () => ({ api }))
vi.mock('../../../src/renderer/api/transport', () => ({
  isElectron: () => true, onServerUrlChange: vi.fn(), onWsAuthenticated: vi.fn(), orgSignInOffered: () => true,
}))
vi.mock('../../../src/renderer/stores/app.store', () => ({ useAppStore: { getState: () => ({ setConfig }) } }))

const { useOrgSignInStore } = await import('../../../src/renderer/stores/org-sign-in.store')

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(settle => { resolve = settle })
  return { promise, resolve }
}

describe('organization sign-in followed by a direct account sign-in', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useOrgSignInStore.setState({ lastResult: null })
    api.authStartLogin.mockResolvedValue({ success: true, data: { loginId: 'login-1', loginUrl: 'https://cloud.example/login', state: 's', redirectUri: 'http://127.0.0.1:9/callback' } })
    api.getConfig.mockResolvedValue({ success: true, data: { aiSources: { version: 2, sources: [{ id: 'a' }] } } })
  })

  it('shares one run across callers and signs in to the chosen account in Halo\'s window', async () => {
    const window = deferred<{ success: boolean }>()
    api.enterpriseIdentitySignIn.mockResolvedValue({ success: true, data: { alternative: 'model-direct' } })
    api.authOpenLoginWindow.mockReturnValue(window.promise)
    const first = useOrgSignInStore.getState().signIn()
    const second = useOrgSignInStore.getState().signIn()
    expect(second).toBe(first)
    await vi.waitFor(() => expect(api.authOpenLoginWindow).toHaveBeenCalledWith('model-direct', 'login-1'))
    expect(useOrgSignInStore.getState().signIn()).toBe(first)
    window.resolve({ success: true })
    expect(await first).toEqual({ alternative: 'model-direct' })
    expect(api.enterpriseIdentitySignIn).toHaveBeenCalledOnce()
    expect(api.authStartLogin).toHaveBeenCalledOnce()
    expect(api.authCompleteLogin).not.toHaveBeenCalled()
    expect(setConfig).toHaveBeenCalledOnce()
    expect(useOrgSignInStore.getState().lastResult).toEqual({ alternative: 'model-direct' })
  })

  it('reports a closed account window as cancelled and releases that login', async () => {
    api.enterpriseIdentitySignIn.mockResolvedValue({ success: true, data: { alternative: 'model-direct' } })
    api.authOpenLoginWindow.mockResolvedValue({ success: false, error: 'Login window closed' })
    expect(await useOrgSignInStore.getState().signIn()).toBe('cancelled')
    expect(api.authCancelLogin).toHaveBeenCalledWith('model-direct', 'login-1')
    expect(setConfig).not.toHaveBeenCalled()
  })

  it('rereads settings after a saved account instead of signing in again', async () => {
    api.enterpriseIdentitySignIn.mockResolvedValue({ success: true, data: { alternative: 'model-direct' } })
    api.authOpenLoginWindow.mockResolvedValue({ success: true })
    api.getConfig.mockRejectedValueOnce(new Error('busy'))
    expect(await useOrgSignInStore.getState().signIn()).toEqual({ alternative: 'model-direct' })
    expect(api.getConfig).toHaveBeenCalledTimes(2)
    expect(api.authStartLogin).toHaveBeenCalledOnce()
    expect(setConfig).toHaveBeenCalledOnce()
  })

  it('leaves an organization result untouched', async () => {
    api.enterpriseIdentitySignIn.mockResolvedValue({ success: true, data: 'succeeded' })
    expect(await useOrgSignInStore.getState().signIn()).toBe('succeeded')
    expect(api.authStartLogin).not.toHaveBeenCalled()
  })
})
