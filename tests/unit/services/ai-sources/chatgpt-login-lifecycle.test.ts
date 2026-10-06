import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { servers, proxyFetch } = vi.hoisted(() => ({ servers: [] as any[], proxyFetch: vi.fn() }))
vi.mock('http', async () => {
  const { EventEmitter } = await import('events')
  return { default: { createServer: () => {
    const server = Object.assign(new EventEmitter(), {
      listen: vi.fn(() => { queueMicrotask(() => server.emit('listening')) }),
      close: vi.fn(), setTimeout: vi.fn()
    })
    servers.push(server)
    return server
  } } }
})
vi.mock('open', () => ({ default: vi.fn(async () => undefined) }))
vi.mock('../../../../src/main/services/proxy-fetch', () => ({ proxyFetch }))

import { ChatGPTProvider } from '../../../../src/main/services/ai-sources/providers/chatgpt.provider'

const jwt = (payload: object) => `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
const tokens = (userId = 'user-a', accountId = 'account-a') => ({
  access_token: jwt({ exp: 9999999999, 'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_user_id: userId } }),
  id_token: jwt({ email: 'a@example.com' }), refresh_token: 'fake-refresh'
})
function callback(server: any, state: string, path = '/auth/callback') {
  const res = { statusCode: 200, setHeader: vi.fn(), end: vi.fn() }
  server.emit('request', { url: `${path}?code=code&state=${state}` }, res)
  return res
}

beforeEach(() => {
  servers.length = 0
  vi.clearAllMocks()
  process.getSystemVersion = () => '15.1'
})
afterEach(async () => {
  await new ChatGPTProvider().cancelLogin()
})

describe('ChatGPT authorization ownership', () => {
  async function authorize(userId: string, accountId: string) {
    const provider = new ChatGPTProvider()
    const start = await provider.startLogin()
    const completion = provider.completeLogin(start.data!.state)
    proxyFetch.mockResolvedValueOnce(new Response(JSON.stringify(tokens(userId, accountId))))
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ slug: 'account-model' }] })))
    callback(servers.at(-1), start.data!.state)
    return completion
  }

  it('distinguishes users in the same workspace while routing catalogs to that workspace', async () => {
    const first = await authorize('user-a', 'shared-workspace')
    const second = await authorize('user-b', 'shared-workspace')
    expect(first.data?.user?.uid).toBe(JSON.stringify(['user-a', 'shared-workspace']))
    expect(second.data?.user?.uid).toBe(JSON.stringify(['user-b', 'shared-workspace']))
    expect((first.data as any)._accountId).toBe('shared-workspace')
    expect(proxyFetch.mock.calls[1][1].headers['ChatGPT-Account-ID']).toBe('shared-workspace')
    expect(proxyFetch.mock.calls[3][1].headers['ChatGPT-Account-ID']).toBe('shared-workspace')
  })

  it('keeps distinct workspaces independent and never treats a workspace-only claim as user identity', async () => {
    const first = await authorize('same-user', 'workspace-a')
    const second = await authorize('same-user', 'workspace-b')
    const unknown = await authorize('', 'workspace-a')
    expect(first.data?.user?.uid).not.toBe(second.data?.user?.uid)
    expect(unknown.success).toBe(true)
    expect(unknown.data?.user?.uid).toBe('')
    expect((unknown.data as any)._accountId).toBe('workspace-a')
  })

  it('verifies legacy identity from the stored access token, not email or workspace alone', () => {
    const provider = new ChatGPTProvider()
    const config = (userId: string) => ({ chatgpt: {
      accessToken: tokens(userId, 'shared-workspace').access_token,
      user: { uid: 'shared-workspace', name: 'same@example.com' }
    } } as any)
    expect(provider.getAccountId(config('user-a'))).toBe(JSON.stringify(['user-a', 'shared-workspace']))
    expect(provider.getAccountId(config('user-b'))).toBe(JSON.stringify(['user-b', 'shared-workspace']))
    expect(provider.getAccountId(config(''))).toBeNull()
    expect(provider.getAccountId({ chatgpt: { accessToken: jwt({
      'https://api.openai.com/auth': { user_id: 'legacy-user', chatgpt_account_id: 'workspace' }
    }) } } as any)).toBe(JSON.stringify(['legacy-user', 'workspace']))
  })

  it('keeps a pending login alive when another account logs out', async () => {
    const provider = new ChatGPTProvider()
    const start = await provider.startLogin()
    const completion = provider.completeLogin(start.data!.state)
    proxyFetch.mockResolvedValueOnce(new Response('{}'))
    await provider.logout({ chatgpt: { refreshToken: 'other-account-refresh' } } as any)
    expect(servers[0].close).not.toHaveBeenCalled()
    proxyFetch.mockResolvedValueOnce(new Response(JSON.stringify(tokens())))
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ slug: 'account-model' }] })))
    callback(servers[0], start.data!.state)
    expect((await completion).success).toBe(true)
    expect(servers[0].close).toHaveBeenCalledTimes(1)
  })

  it('a late callback from a canceled server cannot settle a newer authorization', async () => {
    const provider = new ChatGPTProvider()
    const first = await provider.startLogin()
    const old = provider.completeLogin(first.data!.state)
    await provider.cancelLogin()
    expect((await old).success).toBe(false)
    const second = await provider.startLogin()
    const current = provider.completeLogin(second.data!.state)
    callback(servers[0], first.data!.state)
    expect(proxyFetch).not.toHaveBeenCalled()
    proxyFetch.mockResolvedValueOnce(new Response(JSON.stringify(tokens())))
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ slug: 'account-model' }] })))
    callback(servers[1], second.data!.state)
    expect((await current).success).toBe(true)
  })

  it('rejects a callback path prefix and stops a canceled exchange before catalog fetching', async () => {
    const provider = new ChatGPTProvider()
    const start = await provider.startLogin()
    const completion = provider.completeLogin(start.data!.state)
    expect(callback(servers[0], start.data!.state, '/auth/callback/extra').statusCode).toBe(404)
    expect(proxyFetch).not.toHaveBeenCalled()
    let resolve!: (response: Response) => void
    proxyFetch.mockReturnValueOnce(new Promise<Response>(done => { resolve = done }))
    callback(servers[0], start.data!.state)
    await vi.waitFor(() => expect(proxyFetch).toHaveBeenCalledTimes(1))
    await provider.cancelLogin()
    resolve(new Response(JSON.stringify(tokens())))
    expect((await completion).success).toBe(false)
    expect(proxyFetch).toHaveBeenCalledTimes(1)
    expect(servers[0].close).toHaveBeenCalledTimes(1)
  })
})
