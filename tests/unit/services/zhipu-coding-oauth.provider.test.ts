/**
 * Zhipu GLM Coding Plan OAuth Provider — Unit Tests
 *
 * Locks the load-bearing backend-config contract: the coding-plan key must route
 * to the OpenAI-compatible coding endpoint (`/api/coding/paas/v4/chat/completions`)
 * as a Bearer token, which the router adds when the provider omits an
 * `Authorization` header. The generic `/api/anthropic` endpoint does not draw
 * from the plan, so it must not be used.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { createHash } from 'crypto'
import type { EventEmitter } from 'events'
import { getZhipuCodingOAuthProvider } from '../../../src/main/services/ai-sources/providers/zhipu-coding-oauth.provider'
import type { AISourcesConfig, OAuthCompleteResult, OAuthStartResult } from '../../../src/shared/types'

interface TestServer extends EventEmitter {
  port: number
  listening: boolean
  close: () => unknown
}

const { proxyFetch, open, network } = vi.hoisted(() => ({
  proxyFetch: vi.fn(),
  open: vi.fn(),
  network: {
    servers: [] as TestServer[],
    delayBind: false,
    binds: [] as Array<() => void>
  }
}))
vi.mock('../../../src/main/services/proxy-fetch', () => ({ proxyFetch }))
vi.mock('open', () => ({ default: open }))
vi.mock('http', async () => {
  const { EventEmitter } = await import('events')
  class CallbackServer extends EventEmitter {
    port = 40000 + network.servers.length
    listening = false
    close = vi.fn(() => { this.listening = false; return this })
    setTimeout = vi.fn()
    address() { return { port: this.port } }
    listen(_port: number, _host: string, done: () => void) {
      const bind = () => { this.listening = true; done() }
      if (network.delayBind) network.binds.push(bind)
      else void Promise.resolve().then(bind)
      return this
    }
  }
  return {
    default: {
      createServer: () => {
        const server = new CallbackServer()
        network.servers.push(server)
        return server
      }
    }
  }
})

const PROVIDER = 'zhipu-coding-oauth'

/** Build the legacy v1 config shape the manager passes to provider methods. */
function cfg(slice: unknown): AISourcesConfig {
  return { [PROVIDER]: slice } as unknown as AISourcesConfig
}

describe('ZhipuCodingOAuthProvider', () => {
  const provider = getZhipuCodingOAuthProvider()

  it('exposes the zhipu-coding-oauth type', () => {
    expect(provider.type).toBe(PROVIDER)
  })

  describe('isConfigured', () => {
    it('is false without a logged-in token', () => {
      expect(provider.isConfigured(cfg(undefined))).toBe(false)
      expect(provider.isConfigured(cfg({ loggedIn: false }))).toBe(false)
      expect(provider.isConfigured(cfg({ loggedIn: true }))).toBe(false)
    })

    it('is true with a minted key', () => {
      expect(provider.isConfigured(cfg({ loggedIn: true, accessToken: 'abc.def' }))).toBe(true)
    })
  })

  it('migrates legacy organization identities only with the stored public key id', () => {
    const uid = `org-a:${createHash('sha256').update('public-a').digest('hex').slice(0, 32)}`
    expect(provider.getAccountId(cfg({ accessToken: 'public-a.secret', user: { uid: 'org-a' } }))).toBe(uid)
    expect(provider.getAccountId(cfg({ accessToken: 'public-a.changed-secret', user: { uid } }))).toBe(uid)
    expect(provider.getAccountId(cfg({ accessToken: 'public-b.secret', user: { uid: 'org-a' } }))).not.toBe(uid)
    expect(provider.getAccountId(cfg({ accessToken: '', user: { uid: 'org-a' } }))).toBeNull()
  })

  describe('getBackendConfig', () => {
    it('returns null when not configured', () => {
      expect(provider.getBackendConfig(cfg(undefined))).toBeNull()
      expect(provider.getBackendConfig(cfg({ loggedIn: true }))).toBeNull()
    })

    it('routes to the OpenAI-compatible coding endpoint via chat_completions', () => {
      const bc = provider.getBackendConfig(cfg({ loggedIn: true, accessToken: 'abc.def', model: 'glm-4.6' }))
      expect(bc).not.toBeNull()
      expect(bc!.url).toBe('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions')
      expect(bc!.apiType).toBe('chat_completions')
      expect(bc!.key).toBe('abc.def')
      expect(bc!.model).toBe('glm-4.6')
    })

    it('never injects an Authorization header (so the router adds Bearer)', () => {
      const bc = provider.getBackendConfig(cfg({ loggedIn: true, accessToken: 'k', model: 'glm-5.2' }))
      const hasAuth = bc!.headers && Object.keys(bc!.headers).some(h => h.toLowerCase() === 'authorization')
      expect(hasAuth).toBeFalsy()
    })

    it('falls back to the default model when none is selected', () => {
      const bc = provider.getBackendConfig(cfg({ loggedIn: true, accessToken: 'k' }))
      expect(bc!.model).toBe('glm-4.6')
    })
  })

  describe('models', () => {
    it('lists the GLM coding-plan catalog', async () => {
      const models = await provider.getAvailableModels(cfg(undefined))
      expect(models).toContain('glm-4.6')
      expect(models).toContain('glm-5.2')
    })

    it('reports the current model from config', () => {
      expect(provider.getCurrentModel(cfg({ loggedIn: true, accessToken: 'k', model: 'glm-5.1' }))).toBe('glm-5.1')
      expect(provider.getCurrentModel(cfg(undefined))).toBeNull()
    })
  })

  describe('token management', () => {
    it('treats the minted key as long-lived (never needs refresh)', () => {
      const status = provider.checkTokenWithConfig(cfg({ loggedIn: true, accessToken: 'k' }))
      expect(status.valid).toBe(true)
      expect(status.needsRefresh).toBe(false)
    })

    it('does not implement refreshTokenWithConfig (so the manager skips refresh)', () => {
      expect((provider as unknown as Record<string, unknown>).refreshTokenWithConfig).toBeUndefined()
    })
  })
})

interface OrganizationFixture {
  id: string
  label: string
  key: string
  secret?: string
}

type LoginData = OAuthCompleteResult & {
  _tokenData: { accessToken: string; refreshToken: string; uid: string }
  _accounts: Array<{ key: string; label: string; id: string; organizationId: string }>
}

function envelope(data: unknown): Response {
  return Response.json({ code: 0, data })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function callback(start: OAuthStartResult, server = network.servers[network.servers.length - 1], parameters: Record<string, string> = {}) {
  const redirect = new URL(new URL(start.loginUrl).searchParams.get('redirect')!)
  redirect.searchParams.set('authCode', 'authorization-code')
  redirect.searchParams.set('state', start.state)
  for (const [key, value] of Object.entries(parameters)) redirect.searchParams.set(key, value)
  const response = { statusCode: 200, setHeader: vi.fn(), end: vi.fn() }
  server.emit('request', { url: `${redirect.pathname}${redirect.search}` }, response)
  return response
}

describe('ZhipuCodingOAuthProvider account identity and pending ownership', () => {
  const provider = getZhipuCodingOAuthProvider()
  let organizations: OrganizationFixture[]

  function respond(url: string): Response {
    if (url.endsWith('/oauth/token')) return envelope({ access_token: 'bigmodel-token' })
    if (url.endsWith('/getCustomerInfo')) return envelope({
      organizations: organizations.map(org => ({
        organizationId: org.id, organizationName: org.label,
        projects: [{ projectId: 'project', projectName: 'Default project' }]
      }))
    })
    const org = organizations.find(org => url.includes(`/organization/${org.id}/`))
    if (org && url.includes('/copy/')) return envelope({ secretKey: org.secret })
    if (org && url.endsWith('/api_keys')) return envelope([{ name: 'member-test', apiKey: org.key }])
    throw new Error(`Unexpected request: ${url}`)
  }

  async function login(): Promise<LoginData> {
    const start = await provider.startLogin()
    expect(start.success).toBe(true)
    const completion = provider.completeLogin(start.data!.state)
    callback(start.data!)
    const result = await completion
    expect(result.success).toBe(true)
    return result.data as LoginData
  }

  beforeEach(async () => {
    await provider.cancelLogin()
    network.servers.length = 0
    network.binds.length = 0
    network.delayBind = false
    organizations = [{ id: 'old-org-id', label: 'Team', key: 'member-key-a', secret: 'secret-a' }]
    proxyFetch.mockReset().mockImplementation(async url => respond(url))
    open.mockReset().mockResolvedValue(undefined)
  })

  afterEach(async () => {
    await provider.cancelLogin()
    vi.useRealTimers()
  })

  it('keeps selected account tokens, model, user and logout independent, including legacy org uids', async () => {
    const a = cfg({ sourceId: 'source-a', loggedIn: true, accessToken: 'key-a.secret', model: 'glm-4.6', user: { uid: 'old-org-id', name: 'Team A' } })
    const b = cfg({ sourceId: 'source-b', loggedIn: true, accessToken: 'key-b.secret', model: 'glm-5.2', user: { uid: 'other-org-id', name: 'Team B' } })
    expect(provider.getBackendConfig(a)).toMatchObject({ sourceId: 'source-a', key: 'key-a.secret', model: 'glm-4.6' })
    expect(provider.getBackendConfig(b)).toMatchObject({ sourceId: 'source-b', key: 'key-b.secret', model: 'glm-5.2' })
    expect(provider.getUserInfo(a)?.uid).toBe('old-org-id')
    await provider.logout(a)
    await provider.cancelLogin()
    expect(provider.getBackendConfig(b)?.key).toBe('key-b.secret')
    expect(provider.getUserInfo(b)?.uid).toBe('other-org-id')
    expect(provider.checkTokenWithConfig(b)).toEqual({ valid: true, needsRefresh: false })
    expect(proxyFetch).not.toHaveBeenCalled()
  })

  it('returns key-bound identities and preserves the old organization id as migration metadata', async () => {
    organizations.push({ id: 'second-org', label: 'Second Team', key: 'member-key-b', secret: 'secret-b' })
    const result = await login()
    const fingerprint = createHash('sha256').update('member-key-a').digest('hex').slice(0, 32)
    expect(result._accounts[0]).toEqual({
      key: 'member-key-a.secret-a', label: 'Team', organizationId: 'old-org-id', id: `old-org-id:${fingerprint}`
    })
    expect(result._accounts[1].organizationId).toBe('second-org')
    expect(result._accounts[0].id).not.toBe(result._accounts[1].id)
    expect(result.user?.uid).toBe(result._accounts[0].id)
    expect(result._tokenData.uid).toBe(result.user?.uid)
    expect(network.servers[0].close).toHaveBeenCalledTimes(1)
    expect(proxyFetch.mock.calls.every(([, options]) => options.signal instanceof AbortSignal)).toBe(true)
  })

  it('keeps identity stable for the same key across labels, secret copies and repeated authorization', async () => {
    const first = await login()
    organizations[0].label = 'Renamed Team'
    organizations[0].secret = 'changed-secret'
    const second = await login()
    expect(second.user?.uid).toBe(first.user?.uid)
    expect(second.user?.name).toBe('Renamed Team')
    expect(second._tokenData.accessToken).not.toBe(first._tokenData.accessToken)
  })

  it('does not collapse two keys from the same organization into one account', async () => {
    const first = await login()
    organizations[0].key = 'different-member-key'
    const second = await login()
    expect(first._accounts[0].organizationId).toBe(second._accounts[0].organizationId)
    expect(first.user?.uid).not.toBe(second.user?.uid)
  })

  it('keeps key identity stable when copying a secret is temporarily unavailable', async () => {
    const first = await login()
    proxyFetch.mockImplementation(async url => url.includes('/copy/') ? Response.json({}, { status: 503 }) : respond(url))
    const second = await login()
    expect(second._tokenData.accessToken).toBe('member-key-a')
    expect(second.user?.uid).toBe(first.user?.uid)
  })

  it('logout does not close another pending callback server', async () => {
    const start = await provider.startLogin()
    await provider.logout(cfg({ sourceId: 'stored-account', loggedIn: true, accessToken: 'stored-key' }))
    expect(network.servers[0].close).not.toHaveBeenCalled()
    const completion = provider.completeLogin(start.data!.state)
    callback(start.data!)
    expect((await completion).success).toBe(true)
    expect(network.servers[0].close).toHaveBeenCalledTimes(1)
  })

  it('cancelLogin releases only pending resources and settles a waiting completion', async () => {
    const start = await provider.startLogin()
    const completion = provider.completeLogin(start.data!.state)
    await provider.cancelLogin()
    expect(await completion).toMatchObject({ success: false, error: 'Authentication cancelled' })
    expect(network.servers[0].close).toHaveBeenCalledTimes(1)
    expect(provider.getBackendConfig(cfg({ loggedIn: true, accessToken: 'stored-key' }))?.key).toBe('stored-key')
    expect(proxyFetch).not.toHaveBeenCalled()
  })

  it('rejects the wrong completion state without consuming the valid pending login', async () => {
    const start = await provider.startLogin()
    expect((await provider.completeLogin('wrong-state')).success).toBe(false)
    expect(network.servers[0].close).not.toHaveBeenCalled()
    const completion = provider.completeLogin(start.data!.state)
    callback(start.data!)
    expect((await completion).success).toBe(true)
  })

  it('an obsolete completion and callback cannot clear or settle a replacement authorization', async () => {
    const exchange = deferred<Response>()
    let delayFirst = true
    proxyFetch.mockImplementation(url => {
      if (url.endsWith('/oauth/token') && delayFirst) { delayFirst = false; return exchange.promise }
      return Promise.resolve(respond(url))
    })
    const first = await provider.startLogin()
    const old = provider.completeLogin(first.data!.state)
    callback(first.data!)
    await vi.waitFor(() => expect(proxyFetch.mock.calls.some(([url]) => url.endsWith('/oauth/token'))).toBe(true))
    const second = await provider.startLogin()
    const latest = provider.completeLogin(second.data!.state)
    callback(second.data!, network.servers[0])
    exchange.resolve(envelope({ access_token: 'obsolete-bigmodel-token' }))
    expect((await old).success).toBe(false)
    expect(network.servers[0].close).toHaveBeenCalledTimes(1)
    expect(network.servers[1].close).not.toHaveBeenCalled()
    callback(second.data!, network.servers[1])
    expect((await latest).success).toBe(true)
    expect(network.servers[1].close).toHaveBeenCalledTimes(1)
  })

  it('cancellation during loopback binding closes that server and does not publish pending state', async () => {
    network.delayBind = true
    const start = provider.startLogin()
    await provider.cancelLogin()
    network.binds[0]()
    expect(await start).toMatchObject({ success: false, error: 'Authentication cancelled' })
    expect(network.servers[0].close).toHaveBeenCalledTimes(1)
    expect(open).not.toHaveBeenCalled()
    expect((await provider.completeLogin('anything')).success).toBe(false)
  })

  it('a late bind from an older start cannot replace a newer loopback authorization', async () => {
    network.delayBind = true
    const first = provider.startLogin()
    const second = provider.startLogin()
    network.binds[1]()
    const latest = await second
    network.binds[0]()
    expect((await first).success).toBe(false)
    expect(network.servers[0].close).toHaveBeenCalledTimes(1)
    expect(network.servers[1].close).not.toHaveBeenCalled()
    const completion = provider.completeLogin(latest.data!.state)
    callback(latest.data!, network.servers[1])
    expect((await completion).success).toBe(true)
  })

  it('expires an abandoned loopback server even when completeLogin was never called', async () => {
    vi.useFakeTimers()
    const start = await provider.startLogin()
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(network.servers[0].close).toHaveBeenCalledTimes(1)
    expect(network.servers[0].listening).toBe(false)
    expect((await provider.completeLogin(start.data!.state)).success).toBe(false)
  })

  it('settles a waiting completion and closes its server on authorization timeout', async () => {
    vi.useFakeTimers()
    const start = await provider.startLogin()
    const completion = provider.completeLogin(start.data!.state)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(await completion).toMatchObject({ success: false, error: 'Authorization timed out' })
    expect(network.servers[0].close).toHaveBeenCalledTimes(1)
  })

  it('server errors clean up only their own pending resources', async () => {
    const first = await provider.startLogin()
    const old = provider.completeLogin(first.data!.state)
    const second = await provider.startLogin()
    network.servers[0].emit('error', new Error('Obsolete server failure'))
    expect((await old).success).toBe(false)
    expect(network.servers[1].close).not.toHaveBeenCalled()
    const latest = provider.completeLogin(second.data!.state)
    network.servers[1].emit('error', new Error('Current server failure'))
    expect(await latest).toMatchObject({ success: false, error: 'Loopback callback server failed' })
    expect(network.servers[1].close).toHaveBeenCalledTimes(1)
  })

  it('rejects a mismatched callback and cleans up without exchanging credentials', async () => {
    const start = await provider.startLogin()
    const completion = provider.completeLogin(start.data!.state)
    callback(start.data!, network.servers[0], { state: 'wrong-state' })
    expect((await completion).success).toBe(false)
    expect(proxyFetch).not.toHaveBeenCalled()
    expect(network.servers[0].close).toHaveBeenCalledTimes(1)
  })
})
