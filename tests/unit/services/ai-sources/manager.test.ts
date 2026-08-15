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

import { AISourceManager } from '../../../../src/main/services/ai-sources/manager'
import type { AISource, AISourcesConfig } from '../../../../src/shared/types'

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
      startLogin: vi.fn(),
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
    await mgr.completeOAuthLogin('acct-prov' as never, 'state')
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
    expect(saved.sources[0].name).toBe('New Label')
    expect(saved.sources[0].accessToken).toBe('k-a2')
    // keepModel: current model still in the new list → preserved.
    expect(saved.sources[0].model).toBe('m1')
  })
})

describe('single-source create / update / delete', () => {
  async function login(mgr: AISourceManager, uid: string) {
    ;(mgr as unknown as { providers: Map<string, unknown> }).providers.set('single-prov', {
      type: 'single-prov',
      startLogin: vi.fn(),
      completeLogin: vi.fn(async () => ({
        success: true,
        user: { name: 'U' },
        data: { _availableModels: ['m1'], _defaultModel: 'm1', _tokenData: { accessToken: 'at', refreshToken: 'rt', expiresAt: 1, uid } }
      })),
      getBackendConfig: vi.fn()
    })
    await mgr.completeOAuthLogin('single-prov' as never, 'state')
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

  it('updates the existing provider source instead of creating a second', async () => {
    seed({ currentId: 'ex', sources: [oauthSource({ id: 'ex', provider: 'single-prov' as never })] })
    const mgr = new AISourceManager()
    await login(mgr, 'u2')
    const saved = store.value.aiSources as AISourcesConfig
    expect(saved.sources).toHaveLength(1)
    expect(saved.sources[0].id).toBe('ex')
    expect(saved.sources[0].accessToken).toBe('at')
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
