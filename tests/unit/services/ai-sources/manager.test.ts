/**
 * AISourceManager wiring tests. The manager is the seam between stored v2
 * sources and the router's BackendRequestConfig, so these pin the load-bearing
 * transforms callers depend on:
 *   - the API-key config gate (null when the secret is missing) and the
 *     openai-vs-anthropic URL normalization split;
 *   - buildLegacyOAuthConfig substituting an override model wholesale (the
 *     production 429 fix — derived fields must see the override, not source.model);
 *   - OAuth multi-account `_accounts` upsert keyed by user.uid;
 *   - single-source create/update, deleteSource current-id reassignment, and
 *     syncBuiltinModels skipping user-fetched lists.
 *
 * config.service is mocked with a mutable in-memory store; decryptString is the
 * identity so fixtures carry plaintext secrets; normalizeApiUrl / provider
 * constants stay REAL so URL/anthropic-detection behavior is exercised for real.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const store = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
const saveConfig = vi.hoisted(() => vi.fn())
const proxyFetch = vi.hoisted(() => vi.fn())
vi.mock('../../../../src/main/services/proxy-fetch', () => ({ proxyFetch }))
let uuidCounter = vi.hoisted(() => ({ n: 0 }))

vi.mock('../../../../src/main/foundation/config.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/foundation/config.service')>()
  return {
    ...actual,
    getConfig: vi.fn(() => store.value),
    saveConfig: (patch: Record<string, unknown>) => {
      store.value = { ...store.value, ...patch }
      saveConfig(patch)
    }
  }
})

// Identity decryption so plaintext fixture secrets survive getDecryptedAiSources.
vi.mock('../../../../src/main/foundation/secure-storage.service', () => ({
  decryptString: (s: string) => s
}))

vi.mock('../../../../src/main/services/ai-sources/auth-loader', () => ({
  loadAuthProvidersAsync: vi.fn(async () => [])
}))

vi.mock('../../../../src/main/foundation/product-config', () => ({
  loadProductConfig: vi.fn(() => ({ name: 'test', version: '0.0.0', authProviders: [] }))
}))

vi.mock('uuid', () => ({ v4: () => `uuid-${++uuidCounter.n}` }))

const { track } = vi.hoisted(() => ({ track: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track }
}))

import { AISourceManager } from '../../../../src/main/services/ai-sources/manager'
import type { AISource, AISourcesConfig, OAuthSourceConfig } from '../../../../src/shared/types'
import type { ProviderResult } from '../../../../src/shared/interfaces'

function seed(config: Partial<AISourcesConfig>): void {
  store.value = {
    aiSources: { version: 2, currentId: null, sources: [], ...config }
  }
}

function apiKeySource(over: Partial<AISource>): AISource {
  return {
    id: 's1',
    name: 'src',
    provider: 'openai',
    authType: 'api-key',
    apiUrl: 'https://api.example.com',
    apiKey: 'sk-test',
    model: 'gpt-4o',
    availableModels: [],
    createdAt: 't',
    updatedAt: 't',
    ...over
  } as AISource
}

function oauthSource(over: Partial<AISource>): AISource {
  return {
    id: 'o1',
    name: 'oauth-src',
    provider: 'zhipu-coding-oauth',
    authType: 'oauth',
    apiUrl: '',
    accessToken: 'tok',
    refreshToken: 'ref',
    model: 'glm-4.6',
    availableModels: [{ id: 'glm-4.6', name: 'GLM 4.6' }],
    createdAt: 't',
    updatedAt: 't',
    ...over
  } as AISource
}

beforeEach(() => {
  store.value = {}
  uuidCounter.n = 0
  saveConfig.mockClear()
  proxyFetch.mockReset()
  track.mockClear()
})

describe('getBackendConfig — API key path', () => {
  it('returns null when the current api-key source has no apiKey', () => {
    seed({ currentId: 's1', sources: [apiKeySource({ apiKey: undefined })] })
    expect(new AISourceManager().getBackendConfig()).toBeNull()
  })

  it('normalizes an openai host-only URL to /v1/chat/completions', () => {
    seed({ currentId: 's1', sources: [apiKeySource({ apiUrl: 'api.openai.com', model: 'gpt-4o' })] })
    const bc = new AISourceManager().getBackendConfig()
    expect(bc).not.toBeNull()
    expect(bc!.url).toBe('http://api.openai.com/v1/chat/completions')
    expect(bc!.key).toBe('sk-test')
    expect(bc!.model).toBe('gpt-4o')
  })

  it('skips URL normalization for native anthropic (SDK appends /v1/messages)', () => {
    seed({
      currentId: 's1',
      sources: [apiKeySource({ provider: 'anthropic', apiUrl: 'https://api.anthropic.com/', model: 'claude-opus-4-6' })]
    })
    const bc = new AISourceManager().getBackendConfig()
    // Anthropic skips normalizeApiUrl entirely (only a protocol prefix is added
    // when missing), so the URL is passed through verbatim — trailing slash and all.
    expect(bc!.url).toBe('https://api.anthropic.com/')
  })
})

describe('getBackendConfigForSource — override model', () => {
  it('returns null when the OAuth source has no accessToken', () => {
    seed({ currentId: 'o1', sources: [oauthSource({ accessToken: undefined })] })
    expect(new AISourceManager().getBackendConfigForSource('o1', 'glm-5.2')).toBeNull()
  })

  it('fully substitutes the override model so the provider derives fields against it', () => {
    seed({
      currentId: 'o1',
      sources: [oauthSource({ model: 'glm-4.6', availableModels: [{ id: 'glm-5.2', name: 'x' }] })]
    })
    // zhipu-coding-oauth provider is registered by the manager; it echoes the
    // effective model into BackendRequestConfig.model.
    const bc = new AISourceManager().getBackendConfigForSource('o1', 'glm-5.2')
    expect(bc).not.toBeNull()
    expect(bc!.model).toBe('glm-5.2')
  })

  it('prepares real Copilot sessions for alternate pinned models without mixing accounts or defaults', async () => {
    const sources = ['copilot-model-a', 'copilot-model-b'].map(id => oauthSource({
      id, provider: 'github-copilot', model: 'gpt-4o',
      accessToken: `github-${id}`, refreshToken: `github-${id}`, tokenExpires: Date.now() + 3_600_000,
      availableModels: [{ id: 'gpt-4o', name: 'GPT' }, { id: 'claude-sonnet-4.6', name: 'Claude' }]
    }))
    seed({ currentId: sources[1].id, sources })
    proxyFetch.mockImplementation(async (url: string, options: RequestInit) => {
      const token = new Headers(options.headers).get('Authorization')!.split(' ')[1]
      const expiresAt = Math.floor(Date.now() / 1000) + 3600
      if (url.endsWith('/copilot_internal/v2/token')) {
        return Response.json({ token: `copilot-${token}`, expires_at: expiresAt, endpoints: { api: `https://${token}.example.invalid` } })
      }
      if (url.endsWith('/models/session')) {
        const model = JSON.parse(options.body as string).auto_mode.model_hints[0]
        return Response.json({ session_token: `session-${token}-${model}`, selected_model: model,
          available_models: ['gpt-4o', 'claude-sonnet-4.6'], expires_at: expiresAt })
      }
      throw new Error(`Unexpected Copilot request: ${url}`)
    })
    const mgr = new AISourceManager()
    const prepared = await Promise.all([
      mgr.ensureValidToken(sources[0].id, 'gpt-4o'),
      mgr.ensureValidToken(sources[0].id, 'claude-sonnet-4.6'),
      mgr.ensureValidToken(sources[1].id, 'claude-sonnet-4.6')
    ])
    expect(prepared.every(result => result.success)).toBe(true)
    expect(mgr.getBackendConfigForSource(sources[0].id, 'gpt-4o')).toMatchObject({
      sourceId: sources[0].id, model: 'gpt-4o', key: `copilot-github-${sources[0].id}`,
      headers: { 'copilot-session-token': `session-copilot-github-${sources[0].id}-gpt-4o` }
    })
    expect(mgr.getBackendConfigForSource(sources[0].id, 'claude-sonnet-4.6')).toMatchObject({
      sourceId: sources[0].id, model: 'claude-sonnet-4.6', apiType: 'anthropic_passthrough',
      headers: { 'copilot-session-token': `session-copilot-github-${sources[0].id}-claude-sonnet-4.6` }
    })
    expect(mgr.getBackendConfigForSource(sources[1].id, 'claude-sonnet-4.6')).toMatchObject({
      sourceId: sources[1].id, key: `copilot-github-${sources[1].id}`,
      headers: { 'copilot-session-token': `session-copilot-github-${sources[1].id}-claude-sonnet-4.6` }
    })
    expect(mgr.getSourceConfig(sources[0].id)?.model).toBe('gpt-4o')
    expect((store.value.aiSources as AISourcesConfig).currentId).toBe(sources[1].id)
    expect(proxyFetch.mock.calls.filter(([url]) => url.endsWith('/copilot_internal/v2/token'))).toHaveLength(2)
    expect(proxyFetch.mock.calls.filter(([url]) => url.endsWith('/models/session'))).toHaveLength(3)
    expect((await mgr.ensureValidToken(sources[0].id, 'claude-sonnet-4.6')).success).toBe(true)
    expect(proxyFetch).toHaveBeenCalledTimes(5)
  })
})

describe('account-scoped persisted routing', () => {
  it('reconstructs each account catalog and identity without a shared startup cache', () => {
    vi.stubGlobal('process', { ...process, getSystemVersion: () => '15.1' })
    const make = (id: string, summary: boolean, lite: boolean) => oauthSource({
      id, provider: 'chatgpt', user: { name: id, uid: id }, model: 'same-model', accessToken: `token-${id}`,
      modelCatalogCache: { provider: 'chatgpt', version: 1, fetchedAt: '2026-01-01', entries: [{
        slug: 'same-model', supports_reasoning_summary_parameter: summary, use_responses_lite: lite
      }] }
    })
    seed({ currentId: 'b', sources: [make('a', false, true), make('b', true, false)] })
    for (const mgr of [new AISourceManager(), new AISourceManager()]) {
      const a = mgr.getBackendConfigForSource('a')!
      const b = mgr.getBackendConfigForSource('b')!
      expect(a).toMatchObject({ sourceId: 'a', key: 'token-a', codexModelCapabilities: { reasoningSummary: false, responsesLite: true } })
      expect(b).toMatchObject({ sourceId: 'b', key: 'token-b', codexModelCapabilities: { reasoningSummary: true, responsesLite: false } })
      expect(a.headers?.['ChatGPT-Account-ID']).toBe('a')
      expect(b.headers?.['ChatGPT-Account-ID']).toBe('b')
      expect(mgr.getBackendConfigForSource('a')!.codexModelCapabilities).toEqual(a.codexModelCapabilities)
    }
    vi.unstubAllGlobals()
  })
})

describe('vision capability on the backend config', () => {
  // OAuth branches delegate config building to the provider, which knows
  // nothing about per-model capability. When they returned that config
  // untouched, every OAuth source silently lost its vision setting: the input
  // area announced OCR while the request still carried image blocks, and a
  // text-only upstream rejected the whole turn with HTTP 400.
  it('stamps the per-model override onto an OAuth source config', () => {
    seed({
      currentId: 'o1',
      sources: [oauthSource({
        model: 'glm-4.6',
        modelOverrides: { 'glm-4.6': { vision: true } }
      })]
    })
    expect(new AISourceManager().getBackendConfig()!.visionOverride).toBe(true)
  })

  it('stamps the override for the effective model on the per-source path', () => {
    seed({
      currentId: 'o1',
      sources: [oauthSource({
        model: 'glm-4.6',
        availableModels: [{ id: 'glm-4.6', name: 'GLM 4.6' }, { id: 'glm-5.2', name: 'GLM 5.2' }],
        modelOverrides: { 'glm-4.6': { vision: true }, 'glm-5.2': { vision: false } }
      })]
    })
    const bc = new AISourceManager().getBackendConfigForSource('o1', 'glm-5.2')
    expect(bc!.visionOverride).toBe(false)
  })

  it('falls back to the id heuristic when the source declares nothing', () => {
    seed({ currentId: 'o1', sources: [oauthSource({ model: 'glm-4.6' })] })
    expect(new AISourceManager().getBackendConfig()!.visionOverride).toBe(false)
  })

  it('honors the provider-declared model flag on an api-key source', () => {
    seed({
      currentId: 's1',
      sources: [apiKeySource({
        model: 'minimax-m2',
        availableModels: [{ id: 'minimax-m2', name: 'MiniMax M2', supportsVision: true }]
      })]
    })
    expect(new AISourceManager().getBackendConfig()!.visionOverride).toBe(true)
  })
})

describe('OAuth multi-account _accounts upsert', () => {
  async function loginWithAccounts(mgr: AISourceManager, accounts: Array<{ key: string; label: string; id: string }>) {
    // Register a stub provider whose completeLogin returns the _accounts payload,
    // so completeOAuthLogin drives handleOAuthLoginSuccess without real OAuth.
    ;(mgr as unknown as { providers: Map<string, unknown> }).providers.set('acct-prov', {
      type: 'acct-prov',
      startLogin: vi.fn(async () => ({ success: true, data: { loginUrl: 'https://example.com/login', state: 'state' } })),
      completeLogin: vi.fn(async () => ({
        success: true,
        data: {
          _accounts: accounts,
          _availableModels: ['m1'],
          _defaultModel: 'm1',
          _tokenData: { expiresAt: 999 }
        }
      })),
      getBackendConfig: vi.fn()
    })
    const start = await mgr.startOAuthLogin('acct-prov')
    await mgr.completeOAuthLogin('acct-prov', 'state', start.data!.loginId)
  }

  it('creates one source per account, keyed by uid, and selects the first', async () => {
    seed({ currentId: null, sources: [] })
    const mgr = new AISourceManager()
    await loginWithAccounts(mgr, [
      { key: 'k-a', label: 'Org A', id: 'acc-a' },
      { key: 'k-b', label: 'Org B', id: 'acc-b' }
    ])
    const saved = store.value.aiSources as AISourcesConfig
    expect(saved.sources).toHaveLength(2)
    expect(saved.sources.map(s => s.user?.uid).sort()).toEqual(['acc-a', 'acc-b'])
    expect(saved.currentId).toBe(saved.sources[0].id)
  })

  it('updates the matching source (by uid) on re-login instead of duplicating', async () => {
    seed({
      currentId: 'existing',
      sources: [
        oauthSource({
          id: 'existing',
          provider: 'acct-prov' as never,
          user: { name: '', uid: 'acc-a' },
          name: 'Old Label',
          model: 'm1',
          availableModels: [{ id: 'm1', name: 'm1' }]
        })
      ]
    })
    const mgr = new AISourceManager()
    await loginWithAccounts(mgr, [{ key: 'k-a2', label: 'New Label', id: 'acc-a' }])
    const saved = store.value.aiSources as AISourcesConfig
    expect(saved.sources).toHaveLength(1)
    expect(saved.sources[0].id).toBe('existing')
    expect(saved.sources[0].name).toBe('Old Label')
    expect(saved.sources[0].accessToken).toBe('k-a2')
    // keepModel: current model still in the new list → preserved.
    expect(saved.sources[0].model).toBe('m1')
  })
})

describe('single-source create / update / delete', () => {
  async function login(mgr: AISourceManager, uid: string) {
    ;(mgr as unknown as { providers: Map<string, unknown> }).providers.set('single-prov', {
      type: 'single-prov',
      startLogin: vi.fn(async () => ({ success: true, data: { loginUrl: 'https://example.com/login', state: 'state' } })),
      completeLogin: vi.fn(async () => ({
        success: true,
        user: { name: 'U' },
        data: { _availableModels: ['m1'], _defaultModel: 'm1', _tokenData: { accessToken: 'at', refreshToken: 'rt', expiresAt: 1, uid } }
      })),
      getBackendConfig: vi.fn()
    })
    const start = await mgr.startOAuthLogin('single-prov')
    await mgr.completeOAuthLogin('single-prov', 'state', start.data!.loginId)
  }

  it('creates a new OAuth source when none exists for the provider', async () => {
    seed({ currentId: null, sources: [] })
    const mgr = new AISourceManager()
    await login(mgr, 'u1')
    const saved = store.value.aiSources as AISourcesConfig
    expect(saved.sources).toHaveLength(1)
    expect(saved.sources[0].provider).toBe('single-prov')
    expect(saved.currentId).toBe(saved.sources[0].id)
  })

  it('keeps a ChatGPT account overlay and selected model on offline re-login', async () => {
    const cache = { provider: 'chatgpt' as const, version: 1 as const, fetchedAt: '2026-01-01', entries: [
      { slug: 'gpt-6-sol', visibility: 'hide' }, { slug: 'account-only', display_name: 'Account model', visibility: 'list' }
    ] }
    seed({ currentId: 'ex', sources: [oauthSource({
      id: 'ex', provider: 'chatgpt', model: 'account-only', user: { name: 'U', uid: 'u' },
      availableModels: [{ id: 'account-only', name: 'Account model' }], modelCatalogCache: cache
    })] })
    const mgr = new AISourceManager()
    await (mgr as unknown as { ensureInitialized(): Promise<void> }).ensureInitialized()
    ;(mgr as unknown as { providers: Map<string, unknown> }).providers.set('chatgpt', {
      type: 'chatgpt',
      startLogin: vi.fn(async () => ({ success: true, data: { loginUrl: 'https://example.com/login', state: 'state' } })),
      completeLogin: vi.fn(async () => ({ success: true, data: { user: { name: 'U' },
        _availableModels: ['gpt-6-sol'], _catalogDegraded: true, _defaultModel: 'gpt-6-sol',
        _tokenData: { accessToken: 'new-token', refreshToken: 'rt', expiresAt: 1, uid: 'u' }
      } })),
      getOfflineConfig: vi.fn().mockReturnValue({ chatgpt: {
        availableModels: ['account-only', 'gpt-6-luna'], modelNames: { 'account-only': 'Account model' },
        degraded: true, catalogReconciled: true
      } }),
      getBackendConfig: vi.fn()
    })
    const start = await mgr.startOAuthLogin('chatgpt')
    await mgr.completeOAuthLogin('chatgpt', 'state', start.data!.loginId)
    const saved = (store.value.aiSources as AISourcesConfig).sources[0]
    expect(saved.model).toBe('account-only')
    expect(saved.availableModels.map(item => item.id)).toEqual(['account-only', 'gpt-6-luna'])
    expect(saved.modelCatalogCache).toEqual(cache)
    expect(saved.accessToken).toBe('new-token')
  })

  it('adds another account without replacing an unidentified existing account or selection', async () => {
    seed({ currentId: 'ex', sources: [oauthSource({ id: 'ex', provider: 'single-prov' as never })] })
    const mgr = new AISourceManager()
    await login(mgr, 'u2')
    const saved = store.value.aiSources as AISourcesConfig
    expect(saved.sources).toHaveLength(2)
    expect(saved.sources[0].id).toBe('ex')
    expect(saved.sources[0].accessToken).toBe('tok')
    expect(saved.sources[1].accessToken).toBe('at')
    expect(saved.currentId).toBe('ex')
  })

  it('reassigns currentId to the first remaining source when the current one is deleted', () => {
    seed({
      currentId: 's1',
      sources: [apiKeySource({ id: 's1' }), apiKeySource({ id: 's2' })]
    })
    const mgr = new AISourceManager()
    const cfg = mgr.deleteSource('s1')
    expect(cfg.sources.map(s => s.id)).toEqual(['s2'])
    expect(cfg.currentId).toBe('s2')
  })

  it('sets currentId to null when the last source is deleted', () => {
    seed({ currentId: 's1', sources: [apiKeySource({ id: 's1' })] })
    const cfg = new AISourceManager().deleteSource('s1')
    expect(cfg.sources).toEqual([])
    expect(cfg.currentId).toBeNull()
  })
})

describe('independent OAuth account lifecycle', () => {
  function provider(mgr: AISourceManager, uid = 'a') {
    const stub = {
      type: 'test-oauth', displayName: 'Test OAuth',
      startLogin: vi.fn(async () => ({ success: true, data: { loginUrl: 'https://example.com/login', state: 'state' } })),
      completeLogin: vi.fn(async () => ({ success: true, data: {
        success: true, user: { name: `${uid}@example.com`, uid },
        _tokenData: { accessToken: `token-${uid}`, refreshToken: `refresh-${uid}`, expiresAt: 100, uid },
        _availableModels: ['m1'], _defaultModel: 'm1'
      } })),
      cancelLogin: vi.fn(async () => ({ success: true })),
      logout: vi.fn(async () => ({ success: true })),
      getBackendConfig: vi.fn(),
      checkTokenWithConfig: vi.fn((_config: unknown) => ({ valid: true, needsRefresh: true })),
      refreshTokenWithConfig: vi.fn(async (_config: unknown): Promise<ProviderResult<{
        accessToken: string; refreshToken: string; expiresAt: number
      }>> => ({ success: true, data: {
        accessToken: 'rotated', refreshToken: 'rotated-refresh', expiresAt: 500
      } }))
    }
    mgr.registerProvider(stub as never)
    return stub
  }
  function account(uid: string, id = uid) {
    return oauthSource({ id, provider: 'test-oauth', user: { uid, name: `${uid}@example.com` },
      accessToken: `token-${uid}`, refreshToken: `refresh-${uid}`, tokenExpires: 100 })
  }
  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>(done => { resolve = done })
    return { promise, resolve }
  }

  it('a newer start supersedes a pending login and starts only after the old provider work drains', async () => {
    seed({ sources: [account('a')] })
    const mgr = new AISourceManager()
    const stub = provider(mgr)
    const started = deferred<Awaited<ReturnType<typeof stub.startLogin>>>()
    stub.startLogin.mockReturnValueOnce(started.promise)
    const first = mgr.startOAuthLogin('test-oauth', 'a')
    await vi.waitFor(() => expect(stub.startLogin).toHaveBeenCalledTimes(1))
    const second = mgr.startOAuthLogin('test-oauth')
    await vi.waitFor(() => expect(stub.cancelLogin).toHaveBeenCalledTimes(1))
    expect(stub.startLogin).toHaveBeenCalledTimes(1)
    started.resolve({ success: true, data: { loginUrl: 'https://example.com/login', state: 'state' } })
    expect((await first).success).toBe(false)
    const current = await second
    expect(current.success).toBe(true)
    expect(stub.startLogin).toHaveBeenCalledTimes(2)
    // The superseded start cleaned its own late slot before the new one opened.
    expect(stub.cancelLogin.mock.invocationCallOrder.at(-1)).toBeLessThan(stub.startLogin.mock.invocationCallOrder[1])
    expect(mgr.getOAuthLoginContext('test-oauth', current.data!.loginId)).not.toBeNull()
    await mgr.cancelOAuthLogin('test-oauth', current.data!.loginId)
  })

  it('joins a repeated completion of the same login and returns only public fields', async () => {
    seed({ sources: [account('a')] })
    const mgr = new AISourceManager()
    const stub = provider(mgr)
    const finished = deferred<Awaited<ReturnType<typeof stub.completeLogin>>>()
    const payload = await stub.completeLogin()
    stub.completeLogin.mockClear().mockReturnValueOnce(finished.promise)
    const start = await mgr.startOAuthLogin('test-oauth', 'a')
    const first = mgr.completeOAuthLogin('test-oauth', 'state', start.data!.loginId)
    await vi.waitFor(() => expect(stub.completeLogin).toHaveBeenCalledTimes(1))
    const repeated = mgr.completeOAuthLogin('test-oauth', 'state', start.data!.loginId)
    expect((await mgr.completeOAuthLogin('test-oauth', 'state', 'foreign-login')).success).toBe(false)
    finished.resolve(payload)
    const complete = await first
    expect(await repeated).toEqual(complete)
    expect(JSON.stringify(complete)).not.toContain('token-a')
    expect(stub.completeLogin).toHaveBeenCalledTimes(1)
    expect(saveConfig).toHaveBeenCalledTimes(1)
    expect(mgr.getOAuthLoginContext('test-oauth', start.data!.loginId)).toBeNull()
  })

  it('a new start waits for a cancelled login to finish its provider cleanup', async () => {
    seed({ sources: [] })
    const mgr = new AISourceManager()
    const stub = provider(mgr)
    const start = await mgr.startOAuthLogin('test-oauth')
    const cleanup = deferred<{ success: boolean }>()
    stub.cancelLogin.mockReturnValueOnce(cleanup.promise)
    const cancelling = mgr.cancelOAuthLogin('test-oauth', start.data!.loginId)
    const next = mgr.startOAuthLogin('test-oauth')
    await Promise.resolve()
    expect(stub.startLogin).toHaveBeenCalledTimes(1)
    cleanup.resolve({ success: true })
    await cancelling
    const started = await next
    expect(started.success).toBe(true)
    expect(started.data!.loginId).not.toBe(start.data!.loginId)
    expect(stub.startLogin).toHaveBeenCalledTimes(2)
    await mgr.cancelOAuthLogin('test-oauth', started.data!.loginId)
  })

  it('refuses an expired login and lets a fresh one complete', async () => {
    seed({ sources: [account('a')] })
    const mgr = new AISourceManager()
    const stub = provider(mgr)
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000)
    try {
      const start = await mgr.startOAuthLogin('test-oauth', 'a')
      now.mockReturnValue(1000 + 10 * 60_000)
      expect((await mgr.completeOAuthLogin('test-oauth', 'state', start.data!.loginId)).success).toBe(false)
      expect(stub.completeLogin).not.toHaveBeenCalled()
      const next = await mgr.startOAuthLogin('test-oauth', 'a')
      expect(next.data!.loginId).not.toBe(start.data!.loginId)
      expect((await mgr.completeOAuthLogin('test-oauth', 'state', next.data!.loginId)).success).toBe(true)
    } finally { now.mockRestore() }
  })

  it('uses the selected store identity account without substituting a sibling when it cannot authenticate', async () => {
    seed({ currentId: 'b', sources: [account('a'), { ...account('b'), accessToken: '' }] })
    const mgr = new AISourceManager()
    provider(mgr)
    expect(mgr.getOAuthSource('test-oauth')?.id).toBe('b')
    expect(await mgr.getOAuthAccessToken('test-oauth')).toBeNull()
    expect(mgr.getOAuthIdentity('test-oauth')?.uid).toBe('b')
  })

  it.each([
    { stage: 'start', success: false, reason: 'provider rejected authorization' },
    { stage: 'start', success: true, reason: 'missing authorization context' },
    { stage: 'completion', success: false, reason: 'provider rejected authorization' },
    { stage: 'completion', success: true, reason: 'missing account credentials' }
  ])('logs a $stage provider result with success=$success without exposing its error payload', async ({ stage, success, reason }) => {
    seed({ sources: [account('a')] })
    const mgr = new AISourceManager()
    const stub = provider(mgr)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const failure = vi.fn(async () => ({ success, error: 'fixture-provider-secret' }))
      Object.assign(stub, stage === 'start' ? { startLogin: failure } : { completeLogin: failure })
      const start = await mgr.startOAuthLogin('test-oauth', 'a')
      const result = stage === 'start' ? start : await mgr.completeOAuthLogin('test-oauth', 'state', start.data!.loginId)
      expect(result.success).toBe(false)
      expect(warning.mock.calls).toEqual([
        [`[AISourceManager] OAuth ${stage} failed: provider=test-oauth source=a ${reason}`]
      ])
      expect(JSON.stringify(warning.mock.calls)).not.toContain('fixture-provider-secret')
      expect(mgr.getOAuthLoginContext('test-oauth')).toBeNull()
      expect(mgr.getSourceConfig('a')?.accessToken).toBe('token-a')
    } finally {
      warning.mockRestore()
    }
  })

  it('logs unavailable OAuth providers at the owning start and completion decisions', async () => {
    seed({ sources: [] })
    const mgr = new AISourceManager()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect((await mgr.startOAuthLogin('unavailable')).success).toBe(false)
      expect((await mgr.completeOAuthLogin('unavailable', 'state')).success).toBe(false)
      expect(warning.mock.calls).toEqual([
        ['[AISourceManager] OAuth start refused: provider=unavailable source=new provider unavailable or unsupported'],
        ['[AISourceManager] OAuth completion refused: provider=unavailable provider unavailable or unsupported']
      ])
    } finally {
      warning.mockRestore()
    }
  })

  it('logs and discards a provider start that settles after cancellation', async () => {
    seed({ sources: [] })
    const mgr = new AISourceManager()
    const stub = provider(mgr)
    const pending = deferred<Awaited<ReturnType<typeof stub.startLogin>>>()
    stub.startLogin.mockReturnValueOnce(pending.promise)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const start = mgr.startOAuthLogin('test-oauth')
      await vi.waitFor(() => expect(stub.startLogin).toHaveBeenCalledTimes(1))
      await mgr.cancelOAuthLogin('test-oauth', 'uuid-1')
      pending.resolve({ success: true, data: { loginUrl: 'https://example.com/login', state: 'state' } })
      expect((await start).success).toBe(false)
      expect(warning.mock.calls).toEqual([
        ['[AISourceManager] Discarded OAuth start: provider=test-oauth source=new authorization cancelled']
      ])
      expect(mgr.getOAuthLoginContext('test-oauth')).toBeNull()
      expect((store.value.aiSources as AISourcesConfig).sources).toEqual([])
    } finally {
      warning.mockRestore()
    }
  })

  it.each([
    { state: 'missing source', source: null, reason: 'source not found' },
    { state: 'signed out', source: { ...account('a'), accessToken: '' }, reason: 'account is not signed in' },
    { state: 'missing provider', source: { ...account('a'), provider: 'unavailable' }, reason: 'provider=unavailable provider unavailable' }
  ])('logs token preparation refused for $state without credentials', async ({ source, reason }) => {
    seed({ sources: source ? [source] : [] })
    const mgr = new AISourceManager()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect((await mgr.ensureValidToken('a')).success).toBe(false)
      expect(warning.mock.calls).toEqual([
        [`[AISourceManager] Token preparation refused: source=a ${reason}`]
      ])
      expect(JSON.stringify(warning.mock.calls)).not.toMatch(/token-a|refresh-a/)
    } finally {
      warning.mockRestore()
    }
  })

  it('updates the matching verified account and returns no private token payload', async () => {
    seed({ currentId: 'b', sources: [account('a'), account('b')] })
    const mgr = new AISourceManager()
    provider(mgr)
    const start = await mgr.startOAuthLogin('test-oauth')
    const result = await mgr.completeOAuthLogin('test-oauth', 'state', start.data!.loginId)
    expect(result).toMatchObject({ success: true, data: { sourceId: 'a', sourceIds: ['a'] } })
    expect(JSON.stringify(result)).not.toContain('token-a')
    expect((store.value.aiSources as AISourcesConfig).currentId).toBe('b')
    expect((store.value.aiSources as AISourcesConfig).sources).toHaveLength(2)
  })

  it('keeps two users in a shared ChatGPT workspace independent and preserves account routing', async () => {
    seed({ sources: [] })
    const mgr = new AISourceManager()
    const stub = provider(mgr)
    for (const userId of ['user-a', 'user-b']) {
      const uid = JSON.stringify([userId, 'shared-workspace'])
      stub.completeLogin.mockResolvedValueOnce({ success: true, data: {
        success: true, user: { name: 'same@example.com', uid },
        _accountId: 'shared-workspace',
        _tokenData: { accessToken: userId, refreshToken: `refresh-${userId}`, expiresAt: 100, uid },
        _availableModels: ['same-model'], _defaultModel: 'same-model'
      } } as any)
      const start = await mgr.startOAuthLogin('test-oauth')
      expect((await mgr.completeOAuthLogin('test-oauth', 'state', start.data!.loginId)).success).toBe(true)
    }
    const sources = (store.value.aiSources as AISourcesConfig).sources
    expect(sources).toHaveLength(2)
    expect(sources.map(source => source.user?.uid)).toEqual([
      JSON.stringify(['user-a', 'shared-workspace']), JSON.stringify(['user-b', 'shared-workspace'])
    ])
    expect(sources.every(source => source.accountId === 'shared-workspace')).toBe(true)
    stub.getBackendConfig.mockImplementation((config: any) => ({
      url: 'https://example.com', key: config['test-oauth'].accessToken, model: 'same-model',
      headers: { 'ChatGPT-Account-ID': config['test-oauth'].accountId }
    }))
    expect(mgr.getBackendConfigForSource(sources[0].id)?.headers?.['ChatGPT-Account-ID']).toBe('shared-workspace')
    expect(mgr.getBackendConfigForSource(sources[1].id)?.key).toBe('user-b')
  })

  it('rejects a different verified account during targeted reauthentication', async () => {
    seed({ currentId: 'a', sources: [account('a'), account('b')] })
    const mgr = new AISourceManager()
    provider(mgr, 'b')
    const start = await mgr.startOAuthLogin('test-oauth', 'a')
    const before = structuredClone(store.value)
    expect((await mgr.completeOAuthLogin('test-oauth', 'state', start.data!.loginId)).success).toBe(false)
    expect(store.value).toEqual(before)
  })

  it('refuses an unverified identity when reauthenticating a known account', async () => {
    seed({ sources: [account('a')] })
    const mgr = new AISourceManager()
    provider(mgr, '')
    const start = await mgr.startOAuthLogin('test-oauth', 'a')
    expect((await mgr.completeOAuthLogin('test-oauth', 'state', start.data!.loginId)).success).toBe(false)
    expect(mgr.getSourceConfig('a')?.accessToken).toBe('token-a')
  })

  it('cannot bypass verified identity with an unchanged access token', async () => {
    seed({ sources: [account('a')] })
    const mgr = new AISourceManager()
    const stub = provider(mgr, '')
    stub.completeLogin.mockResolvedValueOnce({ success: true, data: {
      success: true, user: { name: 'Unknown', uid: '' },
      _tokenData: { accessToken: 'token-a', refreshToken: 'refresh-a', expiresAt: 100, uid: '' },
      _availableModels: ['m1'], _defaultModel: 'm1'
    } })
    const start = await mgr.startOAuthLogin('test-oauth', 'a')
    expect((await mgr.completeOAuthLogin('test-oauth', 'state', start.data!.loginId)).success).toBe(false)
    expect(mgr.getSourceConfig('a')?.user?.uid).toBe('a')
  })

  it('preserves source id, custom name, selected model and overrides on targeted reauthentication', async () => {
    const a = { ...account('a'), name: 'My account', model: 'chosen', modelOverrides: { chosen: { contextWindow: 200000 } } }
    seed({ currentId: 'b', sources: [a, account('b')] })
    const mgr = new AISourceManager()
    provider(mgr)
    const start = await mgr.startOAuthLogin('test-oauth', 'a')
    expect((await mgr.completeOAuthLogin('test-oauth', 'state', start.data!.loginId)).success).toBe(true)
    expect((store.value.aiSources as AISourcesConfig).sources[0]).toMatchObject({
      id: 'a', name: 'My account', model: 'chosen', modelOverrides: a.modelOverrides
    })
  })

  it('supersedes a pending login for the same provider and a cancelled login never saves', async () => {
    seed({ sources: [] })
    const mgr = new AISourceManager()
    const stub = provider(mgr)
    const start = await mgr.startOAuthLogin('test-oauth')
    const newer = await mgr.startOAuthLogin('test-oauth')
    expect(newer.success).toBe(true)
    expect((await mgr.completeOAuthLogin('test-oauth', 'state', start.data!.loginId)).success).toBe(false)
    await mgr.cancelOAuthLogin('test-oauth', newer.data!.loginId)
    expect((await mgr.completeOAuthLogin('test-oauth', 'state', newer.data!.loginId)).success).toBe(false)
    expect(stub.cancelLogin).toHaveBeenCalledTimes(2)
    expect(stub.completeLogin).not.toHaveBeenCalled()
    expect((store.value.aiSources as AISourcesConfig).sources).toEqual([])
  })

  it('discards a cancelled in-flight completion and starts the next login only after it drains', async () => {
    seed({ sources: [] })
    const mgr = new AISourceManager()
    const stub = provider(mgr)
    const pending = deferred<Awaited<ReturnType<typeof stub.completeLogin>>>()
    stub.completeLogin.mockReturnValueOnce(pending.promise)
    const start = await mgr.startOAuthLogin('test-oauth')
    const completion = mgr.completeOAuthLogin('test-oauth', 'state', start.data!.loginId)
    await vi.waitFor(() => expect(stub.completeLogin).toHaveBeenCalledTimes(1))
    await mgr.cancelOAuthLogin('test-oauth', start.data!.loginId)
    const next = mgr.startOAuthLogin('test-oauth')
    await Promise.resolve()
    expect(stub.startLogin).toHaveBeenCalledTimes(1)
    pending.resolve({ success: true, data: { success: true, user: { name: 'a', uid: 'a' },
      _tokenData: { accessToken: 'token-a', refreshToken: 'r', expiresAt: 1, uid: 'a' },
      _availableModels: ['m1'], _defaultModel: 'm1' } })
    expect((await completion).success).toBe(false)
    expect((store.value.aiSources as AISourcesConfig).sources).toEqual([])
    const started = await next
    expect(started.success).toBe(true)
    await mgr.cancelOAuthLogin('test-oauth', started.data!.loginId)
  })

  it('single-flights refresh only for the same account and rejects stale writes after reauthentication', async () => {
    seed({ currentId: 'b', sources: [account('a'), account('b')] })
    const mgr = new AISourceManager()
    const stub = provider(mgr)
    const pending = deferred<Awaited<ReturnType<typeof stub.refreshTokenWithConfig>>>()
    stub.refreshTokenWithConfig.mockReturnValueOnce(pending.promise)
    const first = mgr.ensureValidToken('a')
    const second = mgr.ensureValidToken('a')
    expect(stub.refreshTokenWithConfig).toHaveBeenCalledTimes(1)
    await mgr.ensureValidToken('b')
    expect(stub.refreshTokenWithConfig).toHaveBeenCalledTimes(2)
    const start = await mgr.startOAuthLogin('test-oauth', 'a')
    stub.completeLogin.mockResolvedValueOnce({ success: true, data: {
      success: true, user: { name: 'a@example.com', uid: 'a' },
      _tokenData: { accessToken: 'reauthenticated', refreshToken: 'new-refresh', expiresAt: 1000, uid: 'a' },
      _availableModels: ['m1'], _defaultModel: 'm1'
    } })
    await mgr.completeOAuthLogin('test-oauth', 'state', start.data!.loginId)
    pending.resolve({ success: true, data: { accessToken: 'obsolete', refreshToken: 'old', expiresAt: 500 } })
    await Promise.all([first, second])
    expect(mgr.getSourceConfig('a')?.accessToken).toBe('reauthenticated')
    expect(mgr.getSourceConfig('b')?.accessToken).toBe('rotated')
  })

  it('prepares different models serially per account using the rotated credential', async () => {
    seed({ sources: [account('a'), account('b')] })
    const mgr = new AISourceManager()
    const stub = provider(mgr)
    const firstRefresh = deferred<Awaited<ReturnType<typeof stub.refreshTokenWithConfig>>>()
    stub.refreshTokenWithConfig.mockReturnValueOnce(firstRefresh.promise)
    const first = mgr.ensureValidToken('a', 'model-one')
    const sameModel = mgr.ensureValidToken('a', 'model-one')
    const alternate = mgr.ensureValidToken('a', 'model-two')
    const sameAlternate = mgr.ensureValidToken('a', 'model-two')
    expect(stub.refreshTokenWithConfig).toHaveBeenCalledTimes(1)
    await mgr.ensureValidToken('b', 'model-two')
    expect(stub.refreshTokenWithConfig).toHaveBeenCalledTimes(2)
    firstRefresh.resolve({ success: true, data: { accessToken: 'rotated-a', refreshToken: 'rotated-refresh-a', expiresAt: 500 } })
    expect((await Promise.all([first, sameModel, alternate, sameAlternate])).every(result => result.success)).toBe(true)
    expect(stub.refreshTokenWithConfig).toHaveBeenCalledTimes(3)
    expect(stub.refreshTokenWithConfig.mock.calls.map(([config]) => {
      const source = (config as Record<string, OAuthSourceConfig>)['test-oauth']
      return [source.sourceId, source.model, source.accessToken]
    })).toEqual([
      ['a', 'model-one', 'token-a'], ['b', 'model-two', 'token-b'], ['a', 'model-two', 'rotated-a']
    ])
    expect(mgr.getSourceConfig('a')?.model).toBe('glm-4.6')
  })

  it('does not propagate a model-specific preparation failure to another model', async () => {
    seed({ sources: [account('a')] })
    const mgr = new AISourceManager()
    const stub = provider(mgr)
    const firstRefresh = deferred<Awaited<ReturnType<typeof stub.refreshTokenWithConfig>>>()
    stub.refreshTokenWithConfig.mockReturnValueOnce(firstRefresh.promise)
    const first = mgr.ensureValidToken('a', 'unavailable-model')
    const alternate = mgr.ensureValidToken('a', 'available-model')
    firstRefresh.resolve({ success: false, error: 'Model unavailable' })
    expect((await first).success).toBe(false)
    expect((await alternate).success).toBe(true)
    expect(stub.refreshTokenWithConfig).toHaveBeenCalledTimes(2)
    expect(stub.refreshTokenWithConfig.mock.calls[1][0]).toMatchObject({
      'test-oauth': { sourceId: 'a', model: 'available-model', accessToken: 'token-a' }
    })
  })

  it('rechecks the effective model after waiting instead of rotating a valid OAuth token again', async () => {
    seed({ sources: [account('a')] })
    const mgr = new AISourceManager()
    const stub = provider(mgr)
    stub.checkTokenWithConfig.mockImplementation(config => ({
      valid: true,
      needsRefresh: (config as Record<string, OAuthSourceConfig>)['test-oauth'].accessToken === 'token-a'
    }))
    const firstRefresh = deferred<Awaited<ReturnType<typeof stub.refreshTokenWithConfig>>>()
    stub.refreshTokenWithConfig.mockReturnValueOnce(firstRefresh.promise)
    const first = mgr.ensureValidToken('a', 'model-one')
    const alternate = mgr.ensureValidToken('a', 'model-two')
    firstRefresh.resolve({ success: true, data: { accessToken: 'rotated-a', refreshToken: 'rotated-refresh-a', expiresAt: 500 } })
    expect((await Promise.all([first, alternate])).every(result => result.success)).toBe(true)
    expect(stub.refreshTokenWithConfig).toHaveBeenCalledTimes(1)
    expect(stub.checkTokenWithConfig.mock.calls[1][0]).toMatchObject({
      'test-oauth': { sourceId: 'a', model: 'model-two', accessToken: 'rotated-a' }
    })
  })

  it('does not prepare a queued alternate model after the account is deleted', async () => {
    seed({ sources: [account('a'), account('b')] })
    const mgr = new AISourceManager()
    const stub = provider(mgr)
    const firstRefresh = deferred<Awaited<ReturnType<typeof stub.refreshTokenWithConfig>>>()
    stub.refreshTokenWithConfig.mockReturnValueOnce(firstRefresh.promise)
    const first = mgr.ensureValidToken('a', 'model-one')
    const alternate = mgr.ensureValidToken('a', 'model-two')
    mgr.deleteSource('a')
    firstRefresh.resolve({ success: true, data: { accessToken: 'obsolete', refreshToken: 'obsolete', expiresAt: 500 } })
    expect((await Promise.all([first, alternate])).every(result => !result.success)).toBe(true)
    expect(stub.refreshTokenWithConfig).toHaveBeenCalledTimes(1)
    expect(mgr.getSourceConfig('a')).toBeNull()
    expect(mgr.getSourceConfig('b')?.accessToken).toBe('token-b')
  })

  it('removes locally before async logout and a late refresh cannot restore the account', async () => {
    seed({ currentId: 'a', sources: [account('a'), account('b')] })
    const mgr = new AISourceManager()
    const stub = provider(mgr)
    const pending = deferred<Awaited<ReturnType<typeof stub.refreshTokenWithConfig>>>()
    stub.refreshTokenWithConfig.mockReturnValueOnce(pending.promise)
    const refreshing = mgr.ensureValidToken('a')
    await mgr.logout('a')
    pending.resolve({ success: true, data: { accessToken: 'obsolete', refreshToken: 'r', expiresAt: 500 } })
    expect((await refreshing).success).toBe(false)
    expect(mgr.getSourceConfig('a')).toBeNull()
    expect(mgr.getSourceConfig('b')?.accessToken).toBe('token-b')
    expect(stub.cancelLogin).not.toHaveBeenCalled()
  })

  it('reuses the provider\'s only unverified account instead of adding another', async () => {
    seed({ sources: [] })
    const mgr = new AISourceManager()
    provider(mgr, '')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (let index = 0; index < 2; index++) {
        const start = await mgr.startOAuthLogin('test-oauth')
        expect((await mgr.completeOAuthLogin('test-oauth', 'state', start.data!.loginId)).success).toBe(true)
      }
      const sources = (store.value.aiSources as AISourcesConfig).sources
      expect(sources).toHaveLength(1)
      expect(sources[0].name).toBe('test-oauth')
      expect(warning.mock.calls.at(-1)).toEqual([
        `[AISourceManager] OAuth login without verified account identity: provider=test-oauth reusing source=${sources[0].id}`
      ])
    } finally {
      warning.mockRestore()
    }
  })

  it('never overwrites a verified account with an unverified login', async () => {
    seed({ sources: [account('a')] })
    const mgr = new AISourceManager()
    provider(mgr, '')
    const start = await mgr.startOAuthLogin('test-oauth')
    expect((await mgr.completeOAuthLogin('test-oauth', 'state', start.data!.loginId)).success).toBe(true)
    const sources = (store.value.aiSources as AISourcesConfig).sources
    expect(sources).toHaveLength(2)
    expect(mgr.getSourceConfig('a')?.accessToken).toBe('token-a')
  })

  it('matches a stored account with a legacy identity on a fresh login instead of duplicating it', async () => {
    seed({ currentId: 'old', sources: [account('legacy-login', 'old'), account('other')] })
    const mgr = new AISourceManager()
    const stub = provider(mgr, 'stable-id')
    stub.checkTokenWithConfig.mockReturnValue({ valid: true, needsRefresh: false })
    const verify = vi.fn(async (config: unknown) => {
      const token = (config as Record<string, OAuthSourceConfig>)['test-oauth'].accessToken
      return token === 'token-legacy-login' ? 'stable-id' : 'someone-else'
    })
    Object.assign(stub, { getAccountId: verify })
    const start = await mgr.startOAuthLogin('test-oauth')
    const result = await mgr.completeOAuthLogin('test-oauth', 'state', start.data!.loginId)
    expect(result.data?.sourceIds).toEqual(['old'])
    expect(verify).toHaveBeenCalledTimes(2)
    const sources = (store.value.aiSources as AISourcesConfig).sources
    expect(sources).toHaveLength(2)
    expect(mgr.getSourceConfig('old')).toMatchObject({ user: { uid: 'stable-id' }, accessToken: 'token-stable-id' })
    expect(mgr.getSourceConfig('other')?.accessToken).toBe('token-other')
  })

  it('makes no identity request when the login matches a stored account exactly', async () => {
    seed({ sources: [account('a'), account('legacy', 'b')] })
    const mgr = new AISourceManager()
    const stub = provider(mgr)
    const verify = vi.fn(async () => 'a')
    Object.assign(stub, { getAccountId: verify })
    const start = await mgr.startOAuthLogin('test-oauth')
    expect((await mgr.completeOAuthLogin('test-oauth', 'state', start.data!.loginId)).data?.sourceIds).toEqual(['a'])
    expect(verify).not.toHaveBeenCalled()
  })

  it('a stale login id cannot complete or cancel a newer authorization', async () => {
    seed({ sources: [] })
    const mgr = new AISourceManager()
    const stub = provider(mgr)
    const old = await mgr.startOAuthLogin('test-oauth')
    await mgr.cancelOAuthLogin('test-oauth', old.data!.loginId)
    const current = await mgr.startOAuthLogin('test-oauth')
    await mgr.cancelOAuthLogin('test-oauth', old.data!.loginId)
    expect(mgr.getOAuthLoginContext('test-oauth', current.data!.loginId)).not.toBeNull()
    expect((await mgr.completeOAuthLogin('test-oauth', 'state', old.data!.loginId)).success).toBe(false)
    expect(stub.completeLogin).not.toHaveBeenCalled()
    expect((await mgr.completeOAuthLogin('test-oauth', 'state', current.data!.loginId)).success).toBe(true)
  })

  it('cannot restore a target account deleted during authorization', async () => {
    seed({ currentId: 'a', sources: [account('a'), account('b')] })
    const mgr = new AISourceManager()
    provider(mgr)
    const start = await mgr.startOAuthLogin('test-oauth', 'a')
    mgr.deleteSource('a')
    expect((await mgr.completeOAuthLogin('test-oauth', 'state', start.data!.loginId)).success).toBe(false)
    expect(mgr.getSourceConfig('a')).toBeNull()
    expect(mgr.getSourceConfig('b')?.accessToken).toBe('token-b')
  })

  it('migrates a legacy identity only after the provider verifies the old credential', async () => {
    seed({ sources: [account('legacy-name', 'a')] })
    const mgr = new AISourceManager()
    const stub = provider(mgr, 'stable-id')
    const verify = vi.fn(async () => 'stable-id')
    Object.assign(stub, { getAccountId: verify })
    const start = await mgr.startOAuthLogin('test-oauth', 'a')
    expect((await mgr.completeOAuthLogin('test-oauth', 'state', start.data!.loginId)).success).toBe(true)
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({
      'test-oauth': expect.objectContaining({ accessToken: 'token-legacy-name' })
    }))
    expect(mgr.getSourceConfig('a')).toMatchObject({ id: 'a', user: { uid: 'stable-id' } })
    expect((store.value.aiSources as AISourcesConfig).sources).toHaveLength(1)
  })

  it('rechecks target removal after awaiting legacy identity verification', async () => {
    seed({ sources: [account('legacy', 'a')] })
    const mgr = new AISourceManager()
    const stub = provider(mgr, 'stable')
    const pending = deferred<string>()
    const verify = vi.fn(() => pending.promise)
    Object.assign(stub, { getAccountId: verify })
    const start = await mgr.startOAuthLogin('test-oauth', 'a')
    const completion = mgr.completeOAuthLogin('test-oauth', 'state', start.data!.loginId)
    await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(1))
    mgr.deleteSource('a')
    pending.resolve('stable')
    expect((await completion).success).toBe(false)
    expect(mgr.getSourceConfig('a')).toBeNull()
  })

  it('reauthenticates only the targeted organization from a multi-account provider result', async () => {
    seed({ currentId: 'b', sources: [account('a'), account('b')] })
    const mgr = new AISourceManager()
    const stub = provider(mgr)
    stub.completeLogin.mockResolvedValueOnce({ success: true, data: {
      success: true, _accounts: [
        { id: 'b', label: 'Org B', key: 'new-b' }, { id: 'a', label: 'Org A', key: 'new-a' }
      ], _availableModels: ['m1'], _defaultModel: 'm1', _tokenData: { expiresAt: 500 }
    } } as any)
    const start = await mgr.startOAuthLogin('test-oauth', 'a')
    const result = await mgr.completeOAuthLogin('test-oauth', 'state', start.data!.loginId)
    expect(result.data?.sourceIds).toEqual(['a'])
    expect(mgr.getSourceConfig('a')?.accessToken).toBe('new-a')
    expect(mgr.getSourceConfig('b')?.accessToken).toBe('token-b')
  })

  it('does not retain failed synchronous refreshes in the single-flight map', async () => {
    seed({ sources: [account('a')] })
    const mgr = new AISourceManager()
    const stub = provider(mgr)
    stub.refreshTokenWithConfig.mockImplementationOnce(() => { throw new Error('Unavailable') })
    expect((await mgr.ensureValidToken('a')).success).toBe(false)
    expect((await mgr.ensureValidToken('a')).success).toBe(true)
    expect(stub.refreshTokenWithConfig).toHaveBeenCalledTimes(2)
  })

  it('preserves API-key sentinels and refuses duplicate ids or client-created managed accounts', () => {
    seed({ sources: [apiKeySource({})] })
    const mgr = new AISourceManager()
    mgr.updateSource('s1', { apiKey: '***', name: 'Renamed' })
    expect(mgr.getSourceConfig('s1')?.apiKey).toBe('sk-test')
    expect(() => mgr.addSource(apiKeySource({}))).toThrow('Source already exists')
    expect(() => mgr.addSource(account('a'))).toThrow('Managed accounts must be added')
  })

  it('metadata updates cannot replace managed credentials with stale values', () => {
    seed({ currentId: 'a', sources: [account('a')] })
    const mgr = new AISourceManager()
    mgr.updateSource('a', { name: 'Renamed', accessToken: 'stale', refreshToken: 'stale', user: { name: 'b', uid: 'b' } })
    expect(mgr.getSourceConfig('a')).toMatchObject({ name: 'Renamed', accessToken: 'token-a', user: { uid: 'a' } })
  })
})

describe('resolveRequestCredentials — the router\'s per-request credential', () => {
  function oauthProvider(mgr: AISourceManager) {
    const stub = {
      type: 'test-oauth', displayName: 'Test OAuth',
      startLogin: vi.fn(), completeLogin: vi.fn(), logout: vi.fn(),
      getBackendConfig: vi.fn((config: Record<string, OAuthSourceConfig>) => ({
        url: 'https://example.invalid/v1', key: config['test-oauth'].accessToken!, model: config['test-oauth'].model,
        headers: { Authorization: `Bearer ${config['test-oauth'].accessToken}` }
      })),
      checkTokenWithConfig: vi.fn((_config: unknown) => ({ valid: true, needsRefresh: false })),
      refreshTokenWithConfig: vi.fn(async (): Promise<ProviderResult<{ accessToken: string; refreshToken: string; expiresAt: number }>> => ({
        success: true, data: { accessToken: 'token-rotated', refreshToken: 'refresh-rotated', expiresAt: 900 }
      }))
    }
    mgr.registerProvider(stub as never)
    return stub
  }
  const source = (over: Partial<AISource> = {}) => oauthSource({ id: 'a', provider: 'test-oauth', accessToken: 'token-a', ...over })

  it('answers from memory within a minute and re-checks the account after it', async () => {
    seed({ sources: [source()] })
    const mgr = new AISourceManager()
    const stub = oauthProvider(mgr)
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      const first = await mgr.resolveRequestCredentials('a', 'm1')
      expect(first).toEqual({ key: 'token-a', headers: { Authorization: 'Bearer token-a' }, profileArn: undefined })
      expect(await mgr.resolveRequestCredentials('a', 'm1')).toBe(first)
      expect(stub.checkTokenWithConfig).toHaveBeenCalledTimes(1)
      now.mockReturnValue(61_000)
      stub.checkTokenWithConfig.mockReturnValueOnce({ valid: true, needsRefresh: true })
      expect((await mgr.resolveRequestCredentials('a', 'm1'))?.key).toBe('token-rotated')
      expect(mgr.getSourceConfig('a')?.accessToken).toBe('token-rotated')
    } finally { now.mockRestore() }
  })

  it('drops cached answers as soon as the account is written', async () => {
    seed({ sources: [source()] })
    const mgr = new AISourceManager()
    oauthProvider(mgr)
    expect((await mgr.resolveRequestCredentials('a'))?.key).toBe('token-a')
    store.value = { aiSources: { ...(store.value.aiSources as AISourcesConfig), sources: [source({ accessToken: 'token-relogin' })] } }
    expect((await mgr.resolveRequestCredentials('a'))?.key).toBe('token-a')
    mgr.updateSource('a', { name: 'Renamed' })
    expect((await mgr.resolveRequestCredentials('a'))?.key).toBe('token-relogin')
  })

  it('refuses a removed or signed-out account instead of reusing an encoded token', async () => {
    seed({ sources: [source(), source({ id: 'signed-out', accessToken: '' })] })
    const mgr = new AISourceManager()
    oauthProvider(mgr)
    await expect(mgr.resolveRequestCredentials('missing')).rejects.toThrow('This account was removed')
    await expect(mgr.resolveRequestCredentials('signed-out')).rejects.toThrow('signed out')
    await mgr.resolveRequestCredentials('a')
    mgr.deleteSource('a')
    await expect(mgr.resolveRequestCredentials('a')).rejects.toThrow('This account was removed')
  })

  it('keeps the session credential for API-key accounts and after a failed renewal, logging once per check', async () => {
    seed({ sources: [apiKeySource({ id: 'key' }), source()] })
    const mgr = new AISourceManager()
    const stub = oauthProvider(mgr)
    expect(await mgr.resolveRequestCredentials('key')).toBeNull()
    stub.checkTokenWithConfig.mockReturnValue({ valid: false, needsRefresh: true })
    stub.refreshTokenWithConfig.mockResolvedValue({ success: false, error: 'Network unavailable' } as never)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await mgr.resolveRequestCredentials('a')).toBeNull()
      expect(await mgr.resolveRequestCredentials('a')).toBeNull()
      expect(stub.refreshTokenWithConfig).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls.filter(([line]) => String(line).startsWith('[AISourceManager] Request credential not renewed'))).toHaveLength(1)
      expect(JSON.stringify(warn.mock.calls)).not.toContain('token-a')
    } finally { warn.mockRestore() }
  })
})

describe('refreshSourceConfig — token freshness and degraded catalogs', () => {
  interface CatalogProviderStub {
    refreshConfig: ReturnType<typeof vi.fn>
    checkTokenWithConfig: ReturnType<typeof vi.fn>
    refreshTokenWithConfig: ReturnType<typeof vi.fn>
    getOfflineConfig?: ReturnType<typeof vi.fn>
  }

  function registerProvider(
    mgr: AISourceManager,
    stub: Partial<CatalogProviderStub>
  ): CatalogProviderStub {
    const provider: CatalogProviderStub = {
      checkTokenWithConfig: vi.fn().mockReturnValue({ valid: true, needsRefresh: false }),
      refreshTokenWithConfig: vi.fn().mockResolvedValue({
        success: true,
        data: { accessToken: 'fresh-tok', refreshToken: 'fresh-ref', expiresAt: 999 }
      }),
      refreshConfig: vi.fn().mockResolvedValue({
        success: true,
        data: { 'catalog-prov': { availableModels: ['m1'], modelNames: { m1: 'M1' } } }
      }),
      ...stub
    }
    ;(mgr as unknown as { providers: Map<string, unknown> }).providers.set('catalog-prov', provider)
    return provider
  }

  function seedCatalogSource(over: Partial<AISource> = {}): void {
    seed({
      currentId: 'o1',
      sources: [
        oauthSource({
          provider: 'catalog-prov' as never,
          availableModels: [{ id: 'stored', name: 'Stored' }],
          modelOverrides: { stored: { contextWindow: 200000 } },
          ...over
        })
      ]
    })
  }

  it('renews an expired token before the provider calls its catalog endpoint', async () => {
    seedCatalogSource()
    const mgr = new AISourceManager()
    const provider = registerProvider(mgr, {
      checkTokenWithConfig: vi.fn().mockReturnValue({ valid: false, expiresIn: 0, needsRefresh: true })
    })

    await mgr.refreshSourceConfig('o1')

    expect(provider.refreshTokenWithConfig).toHaveBeenCalled()
    // The catalog call must see the rotated token, not the expired one on disk.
    expect(provider.refreshConfig).toHaveBeenCalled()
    const passedConfig = provider.refreshConfig.mock.calls[0][0] as Record<string, any>
    expect(passedConfig['catalog-prov'].accessToken).toBe('fresh-tok')
  })

  it('aborts without calling the provider when the token cannot be renewed', async () => {
    seedCatalogSource()
    const mgr = new AISourceManager()
    const provider = registerProvider(mgr, {
      checkTokenWithConfig: vi.fn().mockReturnValue({ valid: false, expiresIn: 0, needsRefresh: true }),
      refreshTokenWithConfig: vi.fn().mockResolvedValue({ success: false, error: 'refresh token revoked' })
    })

    const result = await mgr.refreshSourceConfig('o1')

    expect(result.success).toBe(false)
    expect(provider.refreshConfig).not.toHaveBeenCalled()
  })

  it('keeps stored models and capabilities when the provider served a fallback catalog', async () => {
    seedCatalogSource()
    const mgr = new AISourceManager()
    registerProvider(mgr, {
      refreshConfig: vi.fn().mockResolvedValue({
        success: true,
        data: {
          'catalog-prov': {
            availableModels: ['hardcoded'],
            modelNames: { hardcoded: 'Hardcoded' },
            modelOverrides: {},
            degraded: true
          }
        }
      })
    })

    const result = await mgr.refreshSourceConfig('o1')

    expect(result.success).toBe(true)
    const saved = store.value.aiSources as AISourcesConfig
    expect(saved.sources[0].availableModels.map(m => m.id)).toEqual(['stored'])
    expect(saved.sources[0].modelOverrides).toEqual({ stored: { contextWindow: 200000 } })
  })

  it('applies a reconciled offline catalog while preserving capabilities, selection and cache', async () => {
    const cache = { provider: 'chatgpt' as const, version: 1 as const, fetchedAt: '2026-01-01', entries: [{ slug: 'hidden', visibility: 'hide' }] }
    seedCatalogSource({
      model: 'stored',
      availableModels: [{ id: 'stored', name: 'Stored', supportsVision: false, capabilities: { contextWindow: 345678 } }],
      modelCatalogCache: cache
    })
    const mgr = new AISourceManager()
    const provider = registerProvider(mgr, {
      refreshConfig: vi.fn().mockResolvedValue({ success: true, data: { 'catalog-prov': {
        degraded: true, catalogReconciled: true, availableModels: ['stored', 'new-builtin'], model: 'new-builtin'
      } } })
    })
    const result = await mgr.refreshSourceConfig('o1')
    expect(result.data?.degraded).toBe(true)
    const saved = (store.value.aiSources as AISourcesConfig).sources[0]
    expect(saved.model).toBe('stored')
    expect(saved.availableModels[0]).toMatchObject({ supportsVision: false, capabilities: { contextWindow: 345678 } })
    expect(saved.availableModels.map(m => m.id)).toEqual(['stored', 'new-builtin'])
    expect(saved.modelCatalogCache).toEqual(cache)
    expect(saved.modelOverrides).toEqual({ stored: { contextWindow: 200000 } })
    const legacy = provider.refreshConfig.mock.calls[0][0]['catalog-prov']
    expect(legacy.modelCatalogCache).toEqual(cache)
    expect(legacy.modelVision).toEqual({ stored: false })
    expect(legacy.modelCapabilities).toEqual({ stored: { contextWindow: 345678 } })
  })

  it('reconstructs locally on token failure without calling the remote catalog', async () => {
    seedCatalogSource()
    const mgr = new AISourceManager()
    const provider = registerProvider(mgr, {
      checkTokenWithConfig: vi.fn().mockReturnValue({ valid: false, needsRefresh: true }),
      refreshTokenWithConfig: vi.fn().mockResolvedValue({ success: false, error: 'offline' }),
      getOfflineConfig: vi.fn().mockReturnValue({ 'catalog-prov': {
        degraded: true, catalogReconciled: true, availableModels: ['stored', 'new-builtin']
      } })
    })
    expect(await mgr.refreshSourceConfig('o1')).toEqual({ success: true, data: { degraded: true } })
    expect(provider.refreshConfig).not.toHaveBeenCalled()
    expect(provider.getOfflineConfig).toHaveBeenCalled()
    expect((store.value.aiSources as AISourcesConfig).sources[0].availableModels.map(m => m.id)).toContain('new-builtin')
  })

  it('persists a successful overlay and model metadata without turning capabilities into user overrides', async () => {
    seedCatalogSource()
    const cache = { provider: 'chatgpt' as const, version: 1 as const, fetchedAt: '2026-01-01', entries: [{ slug: 'hidden', visibility: 'hide' }] }
    const mgr = new AISourceManager()
    registerProvider(mgr, { refreshConfig: vi.fn().mockResolvedValue({ success: true, data: { 'catalog-prov': {
      availableModels: ['fetched'], modelNames: { fetched: 'Fetched' },
      modelCapabilities: { fetched: { contextWindow: 456789 } }, modelVision: { fetched: false }, modelCatalogCache: cache
    } } }) })
    expect((await mgr.refreshSourceConfig('o1')).data?.degraded).toBe(false)
    const saved = (store.value.aiSources as AISourcesConfig).sources[0]
    expect(saved.modelCatalogCache).toEqual(cache)
    expect(saved.availableModels).toEqual([{ id: 'fetched', name: 'Fetched', supportsVision: false, capabilities: { contextWindow: 456789 } }])
    expect(saved.modelOverrides).toEqual({ stored: { contextWindow: 200000 } })
  })

  it('reports degraded and failed sources independently in an aggregate refresh', async () => {
    seed({ sources: ['ok', 'cached', 'failed', 'threw'].map(id => oauthSource({ id })) })
    const mgr = new AISourceManager()
    vi.spyOn(mgr, 'refreshSourceConfig')
      .mockResolvedValueOnce({ success: true, data: { degraded: false } })
      .mockResolvedValueOnce({ success: true, data: { degraded: true } })
      .mockResolvedValueOnce({ success: false, error: 'offline' })
      .mockRejectedValueOnce(new Error('failed'))
    expect(await mgr.refreshAllConfigs()).toEqual({ degradedSourceIds: ['cached'], failedSourceIds: ['failed', 'threw'] })
  })

  it('discards a late catalog after credentials change without affecting another account', async () => {
    seedCatalogSource()
    const config = store.value.aiSources as AISourcesConfig
    config.sources.push(oauthSource({ id: 'other', provider: 'catalog-prov', accessToken: 'other-token' }))
    const mgr = new AISourceManager()
    let resolve!: (value: any) => void
    const pending = new Promise(done => { resolve = done })
    const provider = registerProvider(mgr, { refreshConfig: vi.fn().mockReturnValueOnce(pending) })
    const refresh = mgr.refreshSourceConfig('o1')
    await vi.waitFor(() => expect(provider.refreshConfig).toHaveBeenCalledTimes(1))
    ;(store.value.aiSources as AISourcesConfig).sources[0].accessToken = 'reauthenticated'
    resolve({ success: true, data: { 'catalog-prov': { availableModels: ['obsolete'], model: 'obsolete' } } })
    expect((await refresh).success).toBe(false)
    expect(mgr.getSourceConfig('o1')?.availableModels.map(model => model.id)).toEqual(['stored'])
    expect(mgr.getSourceConfig('other')?.accessToken).toBe('other-token')
  })

  it('single-flights concurrent catalog reads per source without blocking another account', async () => {
    seedCatalogSource()
    ;(store.value.aiSources as AISourcesConfig).sources.push(oauthSource({ id: 'other', provider: 'catalog-prov' }))
    const mgr = new AISourceManager()
    let resolve!: (value: any) => void
    const pending = new Promise(done => { resolve = done })
    const provider = registerProvider(mgr, { refreshConfig: vi.fn().mockReturnValueOnce(pending)
      .mockResolvedValue({ success: true, data: { 'catalog-prov': { availableModels: ['other-model'] } } }) })
    const first = mgr.refreshSourceConfig('o1')
    await vi.waitFor(() => expect(provider.refreshConfig).toHaveBeenCalledTimes(1))
    const second = mgr.refreshSourceConfig('o1')
    await mgr.refreshSourceConfig('other')
    expect(provider.refreshConfig).toHaveBeenCalledTimes(2)
    resolve({ success: true, data: { 'catalog-prov': { availableModels: ['latest'] } } })
    expect((await first).success).toBe(true)
    expect((await second).success).toBe(true)
    expect(mgr.getSourceConfig('o1')?.availableModels.map(model => model.id)).toEqual(['latest'])
    expect(mgr.getSourceConfig('other')?.availableModels.map(model => model.id)).toEqual(['other-model'])
    await mgr.refreshSourceConfig('o1')
    expect(provider.refreshConfig).toHaveBeenCalledTimes(3)
  })

  it('cannot save a catalog from an earlier authorization even when credentials are unchanged', async () => {
    seedCatalogSource({ user: { uid: 'account', name: 'Account' } })
    const mgr = new AISourceManager()
    let resolve!: (value: any) => void
    const pending = new Promise(done => { resolve = done })
    const provider = registerProvider(mgr, { refreshConfig: vi.fn().mockReturnValueOnce(pending) })
    Object.assign(provider, {
      startLogin: vi.fn(async () => ({ success: true, data: { state: 'state' } })),
      completeLogin: vi.fn(async () => ({ success: true, data: { success: true,
        user: { uid: 'account', name: 'Account' },
        _tokenData: { accessToken: 'tok', refreshToken: 'ref', expiresAt: 1, uid: 'account' },
        _availableModels: ['reauthenticated'], _defaultModel: 'reauthenticated'
      } }))
    })
    const refresh = mgr.refreshSourceConfig('o1')
    await vi.waitFor(() => expect(provider.refreshConfig).toHaveBeenCalledTimes(1))
    const start = await mgr.startOAuthLogin('catalog-prov', 'o1')
    expect((await mgr.completeOAuthLogin('catalog-prov', 'state', start.data!.loginId)).success).toBe(true)
    resolve({ success: true, data: { 'catalog-prov': {
      degraded: true, catalogReconciled: true, availableModels: ['obsolete']
    } } })
    expect((await refresh).success).toBe(false)
    expect(mgr.getSourceConfig('o1')?.availableModels.map(model => model.id)).toEqual(['reauthenticated'])
  })

  it('keeps user model and override edits made while a catalog request is in flight', async () => {
    seedCatalogSource({ model: 'stored' })
    const mgr = new AISourceManager()
    let resolve!: (value: any) => void
    const pending = new Promise(done => { resolve = done })
    const provider = registerProvider(mgr, { refreshConfig: vi.fn().mockReturnValueOnce(pending) })
    const refresh = mgr.refreshSourceConfig('o1')
    await vi.waitFor(() => expect(provider.refreshConfig).toHaveBeenCalledTimes(1))
    mgr.updateSource('o1', { model: 'chosen', modelOverrides: { chosen: { vision: true } } })
    resolve({ success: true, data: { 'catalog-prov': {
      availableModels: ['fetched'], model: 'fetched', modelOverrides: { fetched: { vision: false } }
    } } })
    expect((await refresh).success).toBe(true)
    expect(mgr.getSourceConfig('o1')).toMatchObject({ model: 'chosen', modelOverrides: { chosen: { vision: true } } })
  })

  it('writes the catalog when the provider reached its endpoint', async () => {
    seedCatalogSource()
    const mgr = new AISourceManager()
    registerProvider(mgr, {
      refreshConfig: vi.fn().mockResolvedValue({
        success: true,
        data: {
          'catalog-prov': {
            availableModels: ['fetched'],
            modelNames: { fetched: 'Fetched' },
            modelOverrides: { fetched: { contextWindow: 128000 } }
          }
        }
      })
    })

    await mgr.refreshSourceConfig('o1')

    const saved = store.value.aiSources as AISourcesConfig
    expect(saved.sources[0].availableModels.map(m => m.id)).toEqual(['fetched'])
    expect(saved.sources[0].modelOverrides).toEqual({ fetched: { contextWindow: 128000 } })
  })
})

describe('user-initiated switch telemetry', () => {
  it('reports settings.source_switch only on the tracked wrapper, not the raw setter', () => {
    seed({
      currentId: 's1',
      sources: [apiKeySource({ id: 's1' }), apiKeySource({ id: 's2', name: 'other' })]
    })
    const mgr = new AISourceManager()

    mgr.setCurrentSource('s2')
    expect(track).not.toHaveBeenCalled()

    mgr.switchCurrentSource('s1')
    expect(track).toHaveBeenCalledWith('settings.source_switch', expect.objectContaining({
      sourceId: 's1',
      sourceName: 'src',
      provider: 'openai',
    }))
  })

  it('does not report a switch when the source id is unknown', () => {
    seed({ currentId: 's1', sources: [apiKeySource({ id: 's1' })] })
    const mgr = new AISourceManager()

    const result = mgr.switchCurrentSource('does-not-exist')

    expect(result.currentId).toBe('s1')
    expect(track).not.toHaveBeenCalled()
  })

  it('reports settings.model_switch with the switching source attribution', () => {
    seed({ currentId: 's1', sources: [apiKeySource({ id: 's1' })] })
    const mgr = new AISourceManager()

    mgr.switchCurrentModel('gpt-5')

    expect(track).toHaveBeenCalledWith('settings.model_switch', expect.objectContaining({
      sourceId: 's1',
      sourceName: 'src',
      provider: 'openai',
      modelName: 'gpt-5',
    }))
  })

  it('does not auto-select-report the delegated source created during login', async () => {
    seed({ currentId: null, sources: [] })
    const mgr = new AISourceManager()

    await mgr.upsertDelegatedSource('user@example.com')

    // upsertDelegatedSource auto-selects the source it just created/refreshed
    // via the raw setCurrentSource — that's bookkeeping, not a user choosing
    // among alternatives, so it must not appear as a switch event.
    expect(track).not.toHaveBeenCalled()
  })
})

describe('syncBuiltinModels (constructor)', () => {
  it('injects newly-added builtin models into a purely-builtin saved list', () => {
    // Only two of openai's builtin models saved → sync fills in the rest.
    seed({
      currentId: 's1',
      sources: [apiKeySource({ provider: 'openai', availableModels: [{ id: 'gpt-4o', name: 'GPT-4o' }] })]
    })
    new AISourceManager()
    const saved = store.value.aiSources as AISourcesConfig
    const ids = saved.sources[0].availableModels.map(m => m.id)
    expect(ids).toContain('gpt-4o')
    expect(ids).toContain('o1')
    expect(saveConfig).toHaveBeenCalled()
  })

  it('leaves a user-fetched list untouched (contains a non-builtin model id)', () => {
    seed({
      currentId: 's1',
      sources: [apiKeySource({ provider: 'openai', availableModels: [{ id: 'gpt-4o', name: 'x' }, { id: 'my-custom-model', name: 'custom' }] })]
    })
    new AISourceManager()
    const saved = store.value.aiSources as AISourcesConfig
    expect(saved.sources[0].availableModels.map(m => m.id)).toEqual(['gpt-4o', 'my-custom-model'])
    // No dirty write from sync (constructor may still not save at all).
    expect(saveConfig).not.toHaveBeenCalled()
  })
})
