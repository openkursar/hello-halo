import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AISourcesConfig, OAuthCompleteResult, OAuthSourceConfig } from '../../../../src/shared/types'

const { proxyFetch, open, getConfig, saveConfig } = vi.hoisted(() => ({
  proxyFetch: vi.fn(),
  open: vi.fn(),
  getConfig: vi.fn(),
  saveConfig: vi.fn()
}))
vi.mock('../../../../src/main/services/proxy-fetch', () => ({ proxyFetch }))
vi.mock('../../../../src/main/foundation/config.service', () => ({ getConfig, saveConfig }))
vi.mock('open', () => ({ default: open }))

import { getGitHubCopilotProvider } from '../../../../src/main/services/ai-sources/providers/github-copilot.provider'

const TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token'
const DEVICE_URL = 'https://github.com/login/device/code'
const ACCESS_URL = 'https://github.com/login/oauth/access_token'
const USER_URL = 'https://api.github.com/user'

function configWith(sourceId: string | undefined = 'account-a', overrides: Partial<OAuthSourceConfig> = {}): AISourcesConfig {
  return {
    'github-copilot': {
      sourceId,
      loggedIn: true,
      accessToken: `github-${sourceId}`,
      refreshToken: `github-${sourceId}`,
      tokenExpires: Date.now() + 60 * 60 * 1000,
      model: 'gpt-4o',
      availableModels: [`stored-${sourceId}`],
      user: { name: sourceId || 'Legacy account', uid: sourceId || 'legacy-login' },
      ...overrides
    }
  } as unknown as AISourcesConfig
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function copilotResponse(githubToken: string, overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    token: `copilot-${githubToken}`,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    endpoints: { api: `https://${githubToken}.githubcopilot.test` },
    ...overrides
  })
}

function sessionResponse(copilotToken: string, model: string, overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    session_token: `session-${copilotToken}-${model}`,
    selected_model: model,
    available_models: ['gpt-4o', 'claude-sonnet-4.6'],
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    ...overrides
  })
}

function deviceResponse(code = 'code-a'): Response {
  return Response.json({
    device_code: `device-${code}`,
    user_code: code,
    verification_uri: 'https://github.com/login/device',
    expires_in: 300,
    interval: 5
  })
}

function tokenFrom(options: RequestInit): string {
  return new Headers(options.headers).get('Authorization')!.split(' ')[1]
}

function respond(url: string, options: RequestInit = {}): Response {
  if (url === TOKEN_URL) return copilotResponse(tokenFrom(options))
  if (url.endsWith('/models/session')) {
    const model = JSON.parse(options.body as string).auto_mode.model_hints[0]
    return sessionResponse(tokenFrom(options), model)
  }
  if (url.endsWith('/models')) {
    return Response.json({ data: [{ id: `catalog-${tokenFrom(options)}`, model_picker_enabled: true, capabilities: { type: 'chat' } }] })
  }
  if (url === DEVICE_URL) return deviceResponse()
  if (url === ACCESS_URL) return Response.json({ access_token: 'github-login' })
  if (url === USER_URL) return Response.json({ id: 12345, login: 'original-login', name: 'User', avatar_url: 'https://example.com/avatar' })
  throw new Error(`Unexpected request: ${url}`)
}

function requestsTo(url: string) {
  return proxyFetch.mock.calls.filter(([requested]) => requested === url)
}

type LoginData = OAuthCompleteResult & {
  _tokenData: { accessToken: string; refreshToken: string; uid: string }
}

describe('GitHubCopilotProvider account isolation', () => {
  let provider: ReturnType<typeof getGitHubCopilotProvider>

  beforeEach(async () => {
    vi.resetModules()
    provider = (await import('../../../../src/main/services/ai-sources/providers/github-copilot.provider')).getGitHubCopilotProvider()
    proxyFetch.mockReset().mockImplementation(async (url, options) => respond(url, options))
    open.mockReset().mockResolvedValue(undefined)
    getConfig.mockReset().mockReturnValue({
      copilot: { identity: { machineId: 'a'.repeat(64), deviceId: '00000000-0000-4000-8000-000000000000' } }
    })
    saveConfig.mockReset()
  })

  afterEach(async () => {
    await provider.cancelLogin()
    vi.useRealTimers()
  })

  it('verifies legacy username identities using that account credential and the immutable numeric id', async () => {
    const config = configWith('legacy-source', { user: { uid: 'old-login', name: 'Old Login' } })
    expect(await provider.getAccountId(config)).toBe('12345')
    expect(requestsTo(USER_URL)[0][1].headers.Authorization).toBe('Bearer github-legacy-source')
    proxyFetch.mockResolvedValueOnce(Response.json({ login: 'old-login', id: 0 }))
    expect(await provider.getAccountId(config)).toBeNull()
    proxyFetch.mockResolvedValueOnce(new Response('', { status: 401 }))
    expect(await provider.getAccountId(config)).toBeNull()
  })

  it('isolates Copilot tokens, endpoints, session tokens and request IDs between two accounts', async () => {
    const a = configWith('account-a')
    const b = configWith('account-b')
    expect(provider.getBackendConfig(a)).toBeNull()
    expect(await provider.ensureCopilotTokenCached(a)).toBe(true)
    expect(provider.getBackendConfig(b)).toBeNull()
    expect(await provider.ensureCopilotTokenCached(b)).toBe(true)
    const backendA = provider.getBackendConfig(a)!
    const backendB = provider.getBackendConfig(b)!
    expect(backendA).toMatchObject({ sourceId: 'account-a', key: 'copilot-github-account-a', url: 'https://github-account-a.githubcopilot.test/chat/completions' })
    expect(backendB).toMatchObject({ sourceId: 'account-b', key: 'copilot-github-account-b', url: 'https://github-account-b.githubcopilot.test/chat/completions' })
    expect(backendA.headers?.['copilot-session-token']).toBe('session-copilot-github-account-a-gpt-4o')
    expect(backendB.headers?.['copilot-session-token']).toBe('session-copilot-github-account-b-gpt-4o')
    expect(backendA.headers?.['x-request-id']).not.toBe(backendB.headers?.['x-request-id'])
    expect(backendA.headers?.['x-interaction-id']).not.toBe(backendB.headers?.['x-interaction-id'])
    expect(backendA.headers?.['x-initiator']).toBe('user')
    expect(backendB.headers?.['x-initiator']).toBe('user')
    expect(provider.getBackendConfig(a)?.headers?.['x-initiator']).toBe('agent')
    expect(provider.checkTokenWithConfig(a).needsRefresh).toBe(false)
    expect(provider.checkTokenWithConfig(b).needsRefresh).toBe(false)
    expect(await provider.ensureCopilotTokenCached(a)).toBe(true)
    expect(requestsTo(TOKEN_URL)).toHaveLength(2)
    expect(saveConfig).not.toHaveBeenCalled()
  })

  it('keeps account/model sessions and model catalogs separate', async () => {
    const a = configWith('account-a')
    const aClaude = configWith('account-a', { model: 'claude-sonnet-4.6' })
    const b = configWith('account-b')
    await Promise.all([provider.ensureCopilotTokenCached(a), provider.ensureCopilotTokenCached(b)])
    expect(provider.getBackendConfig(aClaude)).toBeNull()
    expect(await provider.ensureCopilotTokenCached(aClaude)).toBe(true)
    expect(provider.getBackendConfig(aClaude)).toMatchObject({
      key: 'copilot-github-account-a', apiType: 'anthropic_passthrough',
      headers: { Authorization: 'Bearer copilot-github-account-a', 'copilot-session-token': 'session-copilot-github-account-a-claude-sonnet-4.6' }
    })
    expect(provider.getBackendConfig(a)?.headers?.['copilot-session-token']).toBe('session-copilot-github-account-a-gpt-4o')
    expect(provider.getBackendConfig(b)?.key).toBe('copilot-github-account-b')
    const [modelsA, modelsB] = await Promise.all([provider.getAvailableModels(a), provider.getAvailableModels(b)])
    expect(modelsA).toEqual(['catalog-copilot-github-account-a'])
    expect(modelsB).toEqual(['catalog-copilot-github-account-b'])
    expect(requestsTo(TOKEN_URL)).toHaveLength(2)
    expect(proxyFetch.mock.calls.filter(([url]) => url.endsWith('/models/session'))).toHaveLength(3)
  })

  it('single-flights token and model-session refresh for the same account', async () => {
    const token = deferred<Response>()
    const session = deferred<Response>()
    proxyFetch.mockImplementation((url, options) => {
      if (url === TOKEN_URL) return token.promise
      if (url.endsWith('/models/session')) return session.promise
      return Promise.resolve(respond(url, options))
    })
    const a = configWith()
    const first = provider.refreshTokenWithConfig(a)
    const second = provider.refreshTokenWithConfig(a)
    expect(requestsTo(TOKEN_URL)).toHaveLength(1)
    token.resolve(copilotResponse('github-account-a'))
    await vi.waitFor(() => expect(proxyFetch.mock.calls.filter(([url]) => url.endsWith('/models/session'))).toHaveLength(1))
    session.resolve(sessionResponse('copilot-github-account-a', 'gpt-4o'))
    const results = await Promise.all([first, second])
    expect(results.every(result => result.success)).toBe(true)
    expect(results[0].data?.accessToken).toBe('github-account-a')
    expect(results[1].data?.refreshToken).toBe('github-account-a')
    expect(saveConfig).not.toHaveBeenCalled()
  })

  it('refreshes each account independently rather than single-flighting across accounts', async () => {
    const aToken = deferred<Response>()
    proxyFetch.mockImplementation((url, options) => {
      if (url === TOKEN_URL && tokenFrom(options) === 'github-account-a') return aToken.promise
      return Promise.resolve(respond(url, options))
    })
    const refreshA = provider.ensureCopilotTokenCached(configWith('account-a'))
    expect(await provider.ensureCopilotTokenCached(configWith('account-b'))).toBe(true)
    expect(provider.getBackendConfig(configWith('account-b'))?.key).toBe('copilot-github-account-b')
    aToken.resolve(copilotResponse('github-account-a'))
    expect(await refreshA).toBe(true)
    expect(requestsTo(TOKEN_URL)).toHaveLength(2)
  })

  it.each(['copilot', 'session'])('does not resurrect %s tokens after logout and recreation', async stage => {
    const obsolete = deferred<Response>()
    let blocked = false
    proxyFetch.mockImplementation((url, options) => {
      if (!blocked && (stage === 'copilot' ? url === TOKEN_URL : url.endsWith('/models/session'))) {
        blocked = true
        return obsolete.promise
      }
      return Promise.resolve(respond(url, options))
    })
    const a = configWith()
    const old = provider.ensureCopilotTokenCached(a)
    await vi.waitFor(() => expect(blocked).toBe(true))
    await provider.logout(a)
    expect(await provider.ensureCopilotTokenCached(a)).toBe(true)
    obsolete.resolve(stage === 'copilot'
      ? copilotResponse('github-account-a', { token: 'obsolete-copilot' })
      : sessionResponse('copilot-github-account-a', 'gpt-4o', { session_token: 'obsolete-session' }))
    expect(await old).toBe(false)
    const backend = provider.getBackendConfig(a)!
    expect(backend.key).toBe('copilot-github-account-a')
    expect(backend.headers?.['copilot-session-token']).toBe('session-copilot-github-account-a-gpt-4o')
  })

  it('discards an obsolete credential exchange after targeted reauthentication', async () => {
    const obsolete = deferred<Response>()
    proxyFetch.mockImplementation((url, options) => {
      if (url === TOKEN_URL && tokenFrom(options) === 'github-account-a') return obsolete.promise
      return Promise.resolve(respond(url, options))
    })
    const oldConfig = configWith()
    const replacement = configWith('account-a', { accessToken: 'github-replacement' })
    const old = provider.ensureCopilotTokenCached(oldConfig)
    expect(await provider.ensureCopilotTokenCached(replacement)).toBe(true)
    obsolete.resolve(copilotResponse('github-account-a'))
    expect(await old).toBe(false)
    expect(provider.getBackendConfig(oldConfig)).toBeNull()
    expect(provider.getBackendConfig(replacement)?.key).toBe('copilot-github-replacement')
  })

  it('logout invalidates only the selected source even when two sources share a credential', async () => {
    const a = configWith('account-a', { accessToken: 'github-shared' })
    const b = configWith('account-b', { accessToken: 'github-shared' })
    await Promise.all([provider.ensureCopilotTokenCached(a), provider.ensureCopilotTokenCached(b)])
    const before = provider.getBackendConfig(b)!
    await provider.logout(a)
    expect(provider.getBackendConfig(a)).toBeNull()
    expect(provider.getBackendConfig(b)?.headers?.['x-request-id']).toBe(before.headers?.['x-request-id'])
    expect(provider.checkTokenWithConfig(b).needsRefresh).toBe(false)
    expect(requestsTo(TOKEN_URL)).toHaveLength(2)
  })

  it('supports legacy configs without a sourceId without mixing distinct tokens', async () => {
    const a = configWith('', { sourceId: undefined, accessToken: 'github-legacy-a' })
    const b = configWith('', { sourceId: undefined, accessToken: 'github-legacy-b' })
    await Promise.all([provider.ensureCopilotTokenCached(a), provider.ensureCopilotTokenCached(b)])
    await provider.logout(a)
    expect(provider.getBackendConfig(a)).toBeNull()
    expect(provider.getBackendConfig(b)?.key).toBe('copilot-github-legacy-b')
  })

  it('returns a legacy catalog refresh slice without writing or replacing another account', async () => {
    const result = await provider.refreshConfig(configWith('account-b'))
    expect(result.data).toMatchObject({ 'github-copilot': {
      sourceId: 'account-b', accessToken: 'github-account-b', availableModels: ['catalog-copilot-github-account-b']
    } })
    expect(saveConfig).not.toHaveBeenCalled()
  })

  it('falls back only to the selected catalog if a late response follows logout', async () => {
    const catalog = deferred<Response>()
    proxyFetch.mockImplementation((url, options) => url.endsWith('/models') ? catalog.promise : Promise.resolve(respond(url, options)))
    const a = configWith()
    const old = provider.getAvailableModels(a)
    await vi.waitFor(() => expect(proxyFetch.mock.calls.some(([url]) => url.endsWith('/models'))).toBe(true))
    await provider.logout(a)
    catalog.resolve(Response.json({ data: [{ id: 'obsolete-model' }] }))
    expect(await old).toEqual(['stored-account-a'])
    expect(provider.getBackendConfig(a)).toBeNull()
  })

  it('discards catalog results tied to a replaced Copilot token', async () => {
    vi.useFakeTimers()
    const catalog = deferred<Response>()
    proxyFetch.mockImplementation((url, options) => url.endsWith('/models') ? catalog.promise : Promise.resolve(respond(url, options)))
    const a = configWith()
    await provider.ensureCopilotTokenCached(a)
    const old = provider.getAvailableModels(a)
    await vi.waitFor(() => expect(proxyFetch.mock.calls.some(([url]) => url.endsWith('/models'))).toBe(true))
    vi.setSystemTime(Date.now() + 56 * 60 * 1000)
    expect(await provider.ensureCopilotTokenCached(a)).toBe(true)
    catalog.resolve(Response.json({ data: [{ id: 'obsolete-model' }] }))
    expect(await old).toEqual(['stored-account-a'])
    expect(requestsTo(TOKEN_URL)).toHaveLength(2)
  })

  it.each([
    { token: '' }, { expires_at: 1 }, { error_details: { message: 'Unavailable' } }
  ])('fails closed on an unusable Copilot token %j', async invalid => {
    proxyFetch.mockResolvedValueOnce(copilotResponse('github-account-a', invalid))
    expect(await provider.ensureCopilotTokenCached(configWith())).toBe(false)
    expect(provider.getBackendConfig(configWith())).toBeNull()
  })

  it('does not use a session issued for a different selected model', async () => {
    proxyFetch.mockImplementation(async (url, options) => url.endsWith('/models/session')
      ? sessionResponse('copilot-github-account-a', 'wrong-model') : respond(url, options))
    expect(await provider.ensureCopilotTokenCached(configWith())).toBe(false)
    expect(provider.getBackendConfig(configWith())).toBeNull()
  })

  it('bounds model-session and account caches with LRU eviction and idle expiry', async () => {
    vi.useFakeTimers()
    const a = configWith('account-a', { model: 'model-8' })
    for (let index = 0; index < 9; index++) {
      expect(await provider.ensureCopilotTokenCached(configWith('account-a', { model: `model-${index}` }))).toBe(true)
    }
    expect(provider.getBackendConfig(configWith('account-a', { model: 'model-0' }))).toBeNull()
    expect(provider.getBackendConfig(a)).not.toBeNull()
    for (let index = 0; index < 31; index++) {
      await provider.ensureCopilotTokenCached(configWith(`other-${index}`))
    }
    expect(provider.getBackendConfig(a)).not.toBeNull()
    await provider.ensureCopilotTokenCached(configWith('other-31'))
    expect(provider.getBackendConfig(configWith('other-0'))).toBeNull()
    expect(provider.getBackendConfig(a)).not.toBeNull()
    await provider.ensureCopilotTokenCached(configWith('other-32'))
    const latest = configWith('other-32')
    expect(provider.getBackendConfig(latest)).not.toBeNull()
    vi.setSystemTime(Date.now() + 60 * 60 * 1000)
    expect(provider.getBackendConfig(latest)).toBeNull()
  })

  it('keeps pending authorization independent of logout and stored tokens independent of cancelLogin', async () => {
    const a = configWith('account-a')
    const b = configWith('account-b')
    await Promise.all([provider.ensureCopilotTokenCached(a), provider.ensureCopilotTokenCached(b)])
    const start = await provider.startLogin()
    await provider.logout(a)
    expect((await provider.completeLogin(start.data!.state)).success).toBe(true)
    expect(provider.getBackendConfig(b)?.key).toBe('copilot-github-account-b')
    const next = await provider.startLogin()
    await provider.cancelLogin()
    expect((await provider.completeLogin(next.data!.state)).success).toBe(false)
    expect(provider.getBackendConfig(b)?.key).toBe('copilot-github-account-b')
  })

  it('uses the numeric GitHub uid as stable identity across login renames', async () => {
    const startA = await provider.startLogin()
    const first = await provider.completeLogin(startA.data!.state)
    proxyFetch.mockImplementation(async (url, options) => url === USER_URL
      ? Response.json({ id: 12345, login: 'renamed-login', name: 'Renamed User' }) : respond(url, options))
    const startB = await provider.startLogin()
    const second = await provider.completeLogin(startB.data!.state)
    expect(first.data?.user?.uid).toBe('12345')
    expect(second.data?.user?.uid).toBe('12345')
    expect((second.data as LoginData)._tokenData.uid).toBe('12345')
    expect(second.data?.user?.name).toBe('Renamed User')
    expect(proxyFetch.mock.calls.filter(([url]) => url === USER_URL).every(([, options]) => options.signal instanceof AbortSignal)).toBe(true)
  })

  it('does not treat a username or invalid numeric uid as a verified identity', async () => {
    proxyFetch.mockImplementation(async (url, options) => url === USER_URL
      ? Response.json({ id: '12345', login: 'username' }) : respond(url, options))
    const start = await provider.startLogin()
    const result = await provider.completeLogin(start.data!.state)
    expect(result.success).toBe(true)
    expect(result.data?.user?.uid).toBe('')
  })

  it('rejects the wrong completion state without consuming a valid login', async () => {
    const start = await provider.startLogin()
    expect((await provider.completeLogin('wrong-code')).success).toBe(false)
    expect(requestsTo(ACCESS_URL)).toHaveLength(0)
    expect((await provider.completeLogin(start.data!.state)).success).toBe(true)
  })

  it('replacement start invalidates the previous completion before the new device request finishes', async () => {
    const polling = deferred<Response>()
    const replacementDevice = deferred<Response>()
    const first = await provider.startLogin()
    proxyFetch.mockImplementation((url, options) => {
      if (url === ACCESS_URL) return polling.promise
      if (url === DEVICE_URL) return replacementDevice.promise
      return Promise.resolve(respond(url, options))
    })
    const old = provider.completeLogin(first.data!.state)
    const replacement = provider.startLogin()
    polling.resolve(Response.json({ access_token: 'github-obsolete' }))
    expect(await old).toMatchObject({ success: false, error: 'Authentication cancelled' })
    expect(requestsTo(USER_URL)).toHaveLength(0)
    replacementDevice.resolve(deviceResponse('code-b'))
    const startB = await replacement
    proxyFetch.mockImplementation(async (url, options) => respond(url, options))
    expect((await provider.completeLogin(startB.data!.state)).success).toBe(true)
    expect((proxyFetch.mock.calls.find(([, options]) => options.body instanceof URLSearchParams && options.body.get('device_code') === 'device-code-b'))).toBeDefined()
  })

  it('an older start failure cannot clear a replacement authorization', async () => {
    const oldOpen = deferred<void>()
    open.mockReturnValueOnce(oldOpen.promise.then(() => { throw new Error('Browser launch failed') }))
    const first = provider.startLogin()
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    const second = await provider.startLogin()
    oldOpen.resolve(undefined)
    expect((await first).success).toBe(false)
    expect((await provider.completeLogin(second.data!.state)).success).toBe(true)
  })

  it('cancellation during a provisional token exchange never leaks a login cache', async () => {
    const exchange = deferred<Response>()
    let block = true
    proxyFetch.mockImplementation((url, options) => {
      if (url === TOKEN_URL && block) { block = false; return exchange.promise }
      return Promise.resolve(respond(url, options))
    })
    const start = await provider.startLogin()
    const old = provider.completeLogin(start.data!.state)
    await vi.waitFor(() => expect(requestsTo(TOKEN_URL)).toHaveLength(1))
    await provider.cancelLogin()
    exchange.resolve(copilotResponse('github-login'))
    expect(await old).toMatchObject({ success: false, error: 'Authentication cancelled' })
    const stored = configWith('stored-login', { accessToken: 'github-login' })
    expect(provider.getBackendConfig(stored)).toBeNull()
    expect(await provider.ensureCopilotTokenCached(stored)).toBe(true)
    expect(requestsTo(TOKEN_URL)).toHaveLength(2)
  })

  it('discarded session exchanges cannot overwrite a refreshed Copilot token', async () => {
    vi.useFakeTimers()
    const oldSession = deferred<Response>()
    let block = true
    proxyFetch.mockImplementation((url, options) => {
      if (url.endsWith('/models/session') && block) { block = false; return oldSession.promise }
      return Promise.resolve(respond(url, options))
    })
    const a = configWith()
    const old = provider.ensureCopilotTokenCached(a)
    await vi.waitFor(() => expect(proxyFetch.mock.calls.some(([url]) => url.endsWith('/models/session'))).toBe(true))
    vi.setSystemTime(Date.now() + 56 * 60 * 1000)
    expect(await provider.ensureCopilotTokenCached(a)).toBe(true)
    oldSession.resolve(sessionResponse('copilot-github-account-a', 'gpt-4o', { session_token: 'obsolete-session' }))
    expect(await old).toBe(false)
    expect(provider.getBackendConfig(a)?.headers?.['copilot-session-token']).toBe('session-copilot-github-account-a-gpt-4o')
  })

  it('discards cancelled login start without opening a browser or creating pending auth', async () => {
    const response = deferred<Response>()
    proxyFetch.mockReturnValueOnce(response.promise)
    const start = provider.startLogin()
    await provider.cancelLogin()
    response.resolve(deviceResponse())
    expect(await start).toMatchObject({ success: false, error: 'Authentication cancelled' })
    expect(open).not.toHaveBeenCalled()
    expect((await provider.completeLogin('code-a')).success).toBe(false)
  })

  it('an old completion during user enrichment cannot clear replacement pending auth', async () => {
    const user = deferred<Response>()
    proxyFetch.mockImplementation((url, options) => url === USER_URL ? user.promise : Promise.resolve(respond(url, options)))
    const first = await provider.startLogin()
    const old = provider.completeLogin(first.data!.state)
    await vi.waitFor(() => expect(requestsTo(USER_URL)).toHaveLength(1))
    const next = await provider.startLogin()
    user.resolve(Response.json({ id: 12345, login: 'obsolete' }))
    expect((await old).success).toBe(false)
    proxyFetch.mockImplementation(async (url, options) => respond(url, options))
    expect((await provider.completeLogin(next.data!.state)).success).toBe(true)
  })

  it.each([{ idReuseMin: 3 }, { idReuseMax: 3 }])('retains safe partial request-rotation defaults for %j', async simulation => {
    getConfig.mockReturnValue({ copilot: { simulation, identity: { machineId: 'a'.repeat(64), deviceId: '00000000-0000-4000-8000-000000000000' } } })
    const a = configWith()
    await provider.ensureCopilotTokenCached(a)
    const ids = Array.from({ length: 4 }, () => provider.getBackendConfig(a)!.headers!['x-request-id'])
    expect(ids[0]).toBe(ids[2])
    expect(ids[3]).not.toBe(ids[0])
  })
})
