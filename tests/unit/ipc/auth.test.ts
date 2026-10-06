import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authRpc } from '../../../src/shared/rpc/contracts/auth.contract'

type Handler = (event: unknown, ...args: unknown[]) => Promise<any>
const env = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  windows: [] as any[],
  manager: {
    startOAuthLogin: vi.fn(), completeOAuthLogin: vi.fn(), cancelOAuthLogin: vi.fn(),
    getOAuthLoginContext: vi.fn(), getProvider: vi.fn(), ensureValidToken: vi.fn(),
    logout: vi.fn(), getSourceQuota: vi.fn(), upsertDelegatedSource: vi.fn(),
  },
  send: vi.fn(),
}))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('events')
  class LoginWindow extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn(), session: { clearStorageData: vi.fn().mockResolvedValue(undefined) } })
    loadURL = vi.fn().mockResolvedValue(undefined)
    show = vi.fn()
    destroyed = false
    constructor(public options: any) {
      super()
      this.webContents.setWindowOpenHandler = vi.fn()
      env.windows.push(this)
    }
    isDestroyed() { return this.destroyed }
    close() { this.destroyed = true; this.emit('closed') }
    static getAllWindows() { return [{ isDestroyed: () => false, webContents: { send: env.send } }] }
  }
  return {
    BrowserWindow: LoginWindow,
    nativeTheme: { shouldUseDarkColors: false },
    ipcMain: { handle: (channel: string, handler: Handler) => env.handlers.set(channel, handler) },
  }
})
vi.mock('../../../src/main/services/ai-sources', () => ({
  getAISourceManager: () => env.manager, getEnabledAuthProviderConfigs: () => [],
}))
vi.mock('../../../src/main/services/agent/cli-auth', () => ({ readCliAuthState: vi.fn() }))
vi.mock('../../../src/main/services/agent/sdk-config', () => ({ buildCliLoginCommand: vi.fn() }))
vi.mock('../../../src/main/services/browser-login-pages', () => ({
  loginPageBg: () => '', buildLoginLoadingPage: () => 'data:text/html,loading', buildLoginErrorPage: () => 'data:text/html,error',
}))

import { registerAuthHandlers } from '../../../src/main/ipc/auth'

const context = {
  loginId: 'owned-login', loginUrl: 'https://issuer.example/authorize?state=csrf',
  state: 'csrf', redirectUri: 'https://callback.example/oauth/callback',
}
const invoke = (channel: string, ...args: unknown[]) => env.handlers.get(channel)!({}, ...args)
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const redirect = (window: any, url: string) => {
  const event = { preventDefault: vi.fn() }
  window.webContents.emit('will-redirect', event, url)
  return event
}
async function open() {
  const result = invoke('auth:open-login-window', 'external-pkce', 'owned-login')
  await flush()
  return { result, window: env.windows[0] }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  env.handlers.clear()
  env.windows.length = 0
  env.manager.getOAuthLoginContext.mockReturnValue(context)
  env.manager.getProvider.mockReturnValue({ displayName: 'External provider' })
  env.manager.cancelOAuthLogin.mockResolvedValue({ success: true })
  env.manager.completeOAuthLogin.mockResolvedValue({ success: true, data: { success: true, sourceId: 'account-2', sourceIds: ['account-2'] } })
  env.manager.ensureValidToken.mockResolvedValue({ success: true })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  registerAuthHandlers()
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('auth IPC', () => {
  it('registers every contract channel, including cancellation', () => {
    expect([...env.handlers.keys()].sort()).toEqual(Object.values(authRpc).map(method => method.channel).sort())
  })

  it('forwards the target source and login ownership without broadcasting progress', async () => {
    env.manager.startOAuthLogin.mockResolvedValue({ success: true, data: { ...context, accessToken: 'never-return' } })
    const start = await invoke('auth:start-login', 'external-pkce', 'account-2')
    expect(env.manager.startOAuthLogin).toHaveBeenCalledWith('external-pkce', 'account-2')
    expect(start.data.loginId).toBe('owned-login')
    expect(start.data).not.toHaveProperty('accessToken')
    expect(await invoke('auth:complete-login', 'external-pkce', 'code#csrf', 'owned-login')).toMatchObject({ data: { sourceId: 'account-2' } })
    expect(env.manager.completeOAuthLogin).toHaveBeenCalledWith('external-pkce', 'code#csrf', 'owned-login')
    expect(env.send).not.toHaveBeenCalled()
  })

  it('logs a successful start missing ownership but does not relog a manager rejection', async () => {
    env.manager.startOAuthLogin.mockResolvedValueOnce({ success: true, data: { loginUrl: context.loginUrl } })
    expect(await invoke('auth:start-login', 'external-pkce')).toMatchObject({ success: false })
    expect(console.warn).toHaveBeenCalledWith('[Auth] Discarded login start without a login id: provider=external-pkce')
    vi.mocked(console.warn).mockClear()
    env.manager.startOAuthLogin.mockResolvedValueOnce({ success: false, error: 'Authorization refused' })
    expect(await invoke('auth:start-login', 'external-pkce')).toEqual({ success: false, error: 'Authorization refused' })
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('refuses a missing context or a renderer-supplied URL in place of a login ID', async () => {
    env.manager.getOAuthLoginContext.mockReturnValue(null)
    expect(await invoke('auth:open-login-window', 'external-pkce', 'https://untrusted.example', 'https://untrusted.example/callback')).toMatchObject({ success: false })
    expect(env.windows).toHaveLength(0)
  })

  it('isolates account cookies in a new nonpersistent partition per window', async () => {
    const first = await open()
    expect(first.window.options.webPreferences).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false })
    const partition = first.window.options.webPreferences.partition
    expect(partition).not.toMatch(/^persist:/)
    first.window.close()
    await first.result
    const second = invoke('auth:open-login-window', 'external-pkce', 'owned-login')
    await flush()
    expect(env.windows[1].options.webPreferences.partition).not.toBe(partition)
    env.windows[1].close()
    await second
  })

  it('reattaches the owned login window after reload instead of opening another window', async () => {
    const first = await open()
    const resumed = invoke('auth:open-login-window', 'external-pkce', 'owned-login')
    await flush()
    expect(env.windows).toHaveLength(1)
    redirect(first.window, 'https://callback.example/oauth/callback?code=own&state=csrf')
    expect(await resumed).toEqual(await first.result)
    expect(env.manager.completeOAuthLogin).toHaveBeenCalledTimes(1)
  })

  it('refuses ownerless IPC completion and cancellation without touching another login', async () => {
    expect((await invoke('auth:complete-login', 'external-pkce', 'code')).success).toBe(false)
    expect((await invoke('auth:cancel-login', 'external-pkce')).success).toBe(false)
    expect(env.manager.completeOAuthLogin).not.toHaveBeenCalled()
    expect(env.manager.cancelOAuthLogin).not.toHaveBeenCalled()
  })

  it('does not complete on a callback path prefix or a different origin', async () => {
    const { window, result } = await open()
    for (const url of [
      'https://callback.example/oauth/callback/extra?code=bad&state=csrf',
      'https://callback.example.evil/oauth/callback?code=bad&state=csrf',
      'http://callback.example/oauth/callback?code=bad&state=csrf',
    ]) expect(redirect(window, url).preventDefault).not.toHaveBeenCalled()
    expect(env.manager.completeOAuthLogin).not.toHaveBeenCalled()
    window.close()
    await result
  })

  it('waits for async completion after synchronous close and passes separate query state', async () => {
    let resolveCompletion!: (value: any) => void
    env.manager.completeOAuthLogin.mockReturnValue(new Promise(resolve => { resolveCompletion = resolve }))
    const { window, result } = await open()
    const resolved = vi.fn()
    void result.then(resolved)
    expect(redirect(window, `${context.redirectUri}?code=authorization&state=csrf`).preventDefault).toHaveBeenCalled()
    redirect(window, `${context.redirectUri}?code=authorization&state=csrf`)
    await flush()
    expect(window.destroyed).toBe(true)
    expect(resolved).not.toHaveBeenCalled()
    expect(env.manager.cancelOAuthLogin).not.toHaveBeenCalled()
    expect(env.manager.completeOAuthLogin).toHaveBeenCalledTimes(1)
    expect(env.manager.completeOAuthLogin).toHaveBeenCalledWith('external-pkce', 'authorization#csrf', 'owned-login')
    resolveCompletion({ success: true, data: { success: true, sourceId: 'account-2', sourceIds: ['account-2'] } })
    expect(await result).toMatchObject({ success: true, data: { sourceId: 'account-2' } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['wrong', ''])('rejects mismatched or missing callback state (%s)', async state => {
    const { window, result } = await open()
    redirect(window, `${context.redirectUri}?code=authorization${state ? `&state=${state}` : ''}`)
    expect(await result).toMatchObject({ success: false, error: 'Invalid OAuth state' })
    expect(env.manager.completeOAuthLogin).not.toHaveBeenCalled()
    expect(env.manager.cancelOAuthLogin).toHaveBeenCalledWith('external-pkce', 'owned-login')
  })

  it('accepts a code carrying its own echoed state without appending it twice', async () => {
    const { window, result } = await open()
    redirect(window, `${context.redirectUri}?code=${encodeURIComponent('authorization#csrf')}`)
    expect(await result).toMatchObject({ success: true })
    expect(env.manager.completeOAuthLogin).toHaveBeenCalledWith('external-pkce', 'authorization#csrf', 'owned-login')
  })

  it('cancels only the owned login on a genuine close or timeout', async () => {
    const first = await open()
    first.window.close()
    expect(await first.result).toMatchObject({ success: false, error: 'Login window closed' })
    expect(env.manager.cancelOAuthLogin).toHaveBeenCalledWith('external-pkce', 'owned-login')
    env.manager.cancelOAuthLogin.mockClear()
    const second = invoke('auth:open-login-window', 'external-pkce', 'owned-login')
    await flush()
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(await second).toMatchObject({ success: false, error: 'Login timed out' })
    expect(env.manager.cancelOAuthLogin).toHaveBeenCalledTimes(1)
    expect(env.manager.cancelOAuthLogin).toHaveBeenCalledWith('external-pkce', 'owned-login')
  })

  it('explicit cancellation closes its window and leaves stored account logout separate', async () => {
    const { window, result } = await open()
    await invoke('auth:cancel-login', 'external-pkce', 'owned-login')
    expect(await result).toMatchObject({ success: false, error: 'Login cancelled' })
    expect(window.destroyed).toBe(true)
    env.manager.logout.mockResolvedValue({ success: true, data: { accessToken: 'never-return' } })
    expect(await invoke('auth:logout', 'account-2')).toEqual({ success: true, error: undefined })
    expect(env.manager.logout).toHaveBeenCalledWith('account-2')
    expect(env.manager.cancelOAuthLogin).toHaveBeenCalledTimes(1)
  })
})
