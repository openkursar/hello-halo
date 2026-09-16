/**
 * ChatGPT subscription provider.
 *
 * The backend fingerprints the client, so the header set and the request target
 * are asserted literally rather than by shape — a renamed header or a stray
 * `OpenAI-Beta` is exactly the kind of drift this provider must not acquire.
 */

import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp/halo-test',
    getName: () => 'Halo',
    getVersion: () => '1.0.0-test'
  },
  session: {
    defaultSession: { resolveProxy: vi.fn(async () => 'DIRECT') },
    fromPartition: vi.fn(() => ({ setProxy: vi.fn(async () => undefined) }))
  }
}))

vi.mock('open', () => ({ default: vi.fn(async () => undefined) }))

const proxyFetch = vi.fn()
vi.mock('../../../../src/main/services/proxy-fetch', () => ({
  proxyFetch: (...args: unknown[]) => proxyFetch(...args)
}))

import { getChatGPTProvider } from '../../../../src/main/services/ai-sources/providers/chatgpt.provider'
import { CHATGPT_PROVIDER_ID } from '../../../../src/shared/constants'
import {
  CODEX_CLI_VERSION,
  CODEX_ADAPTER_ID,
  CODEX_SUBSCRIPTION_MODELS,
  CODEX_DEFAULT_MODEL
} from '../../../../src/shared/constants/codex-models'
import { getCodexModelCapability } from '../../../../src/main/openai-compat-router/server/codex-capabilities'
import type { AISourcesConfig } from '../../../../src/shared/types'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function configWith(overrides: Record<string, unknown> = {}): AISourcesConfig {
  return {
    current: CHATGPT_PROVIDER_ID,
    [CHATGPT_PROVIDER_ID]: {
      loggedIn: true,
      model: 'gpt-5.5',
      availableModels: CODEX_SUBSCRIPTION_MODELS.map((model) => model.slug),
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      tokenExpires: Date.now() + 60 * 60 * 1000,
      user: { name: 'user@example.com', uid: 'acct-1' },
      ...overrides
    }
  } as unknown as AISourcesConfig
}

// Electron supplies the host OS version; this suite runs under ELECTRON_RUN_AS_NODE,
// so it is provided here at a value whose padding is worth asserting.
const originalSystemVersion = process.getSystemVersion

describe('ChatGPTProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.getSystemVersion = () => '15.1'
  })

  afterAll(() => {
    process.getSystemVersion = originalSystemVersion
  })

  it('reports the provider id the product.json entry uses', () => {
    expect(getChatGPTProvider().type).toBe(CHATGPT_PROVIDER_ID)
  })

  it('returns no backend config when not logged in', () => {
    expect(getChatGPTProvider().getBackendConfig(configWith({ loggedIn: false }))).toBeNull()
    expect(getChatGPTProvider().getBackendConfig(configWith({ accessToken: undefined }))).toBeNull()
  })

  it('targets the Codex Responses endpoint with the subscription headers', () => {
    const config = getChatGPTProvider().getBackendConfig(configWith())
    expect(config).not.toBeNull()

    expect(config!.url).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(config!.apiType).toBe('responses')
    expect(config!.adapterId).toBe(CODEX_ADAPTER_ID)
    // The backend only serves streamed responses.
    expect(config!.forceStream).toBe(true)
    expect(config!.model).toBe('gpt-5.5')

    const headers = config!.headers!
    expect(headers['Authorization']).toBe('Bearer access-token')
    expect(headers['ChatGPT-Account-ID']).toBe('acct-1')
    expect(headers['originator']).toBe('codex_cli_rs')
    expect(headers['Accept']).toBe('text/event-stream')
    expect(headers['version']).toBe(CODEX_CLI_VERSION)
    // The CLI no longer sends this on HTTP; keeping it would be a deviation.
    expect(headers['OpenAI-Beta']).toBeUndefined()
  })

  /**
   * The CLI's own macOS test pins the user agent's shape:
   * `codex-rs/login/src/auth/default_client_tests.rs` asserts
   * `{originator}/{x.y.z} (Mac OS {x.y.z}; {arch}) {terminal}`. Asserting the same
   * shape here is what keeps the two from drifting — note "Mac OS", not "macOS",
   * and a three-component version.
   */
  it('builds the user agent in the shape the CLI asserts', () => {
    const headers = getChatGPTProvider().getBackendConfig(configWith())!.headers!
    const userAgent = headers['User-Agent']!

    const arch = process.arch === 'x64' ? 'x86_64' : process.arch
    // "15.1" is padded to three components, and macOS is spelled "Mac OS" —
    // both exactly as the CLI's own macOS test (`default_client_tests.rs`) asserts.
    const byPlatform: Partial<Record<NodeJS.Platform, string>> = {
      darwin: `codex_cli_rs/${CODEX_CLI_VERSION} (Mac OS 15.1.0; ${arch}) `,
      win32: `codex_cli_rs/${CODEX_CLI_VERSION} (Windows 15.1.0; ${arch}) `
    }
    const expected = byPlatform[process.platform]

    if (expected) {
      expect(userAgent).toMatch(new RegExp(`^${escapeRegExp(expected)}\\S+$`))
    } else {
      expect(userAgent).toMatch(
        new RegExp(String.raw`^codex_cli_rs/\d+\.\d+\.\d+ \(\S+( \S+)* 15\.1\.0; ${arch}\) \S+$`)
      )
    }
  })

  it('omits the account header rather than sending it empty', () => {
    const config = getChatGPTProvider().getBackendConfig(configWith({ user: undefined }))
    expect(config!.headers!['ChatGPT-Account-ID']).toBeUndefined()
  })

  it('falls back to the catalog default model', () => {
    const config = getChatGPTProvider().getBackendConfig(configWith({ model: '' }))
    expect(config!.model).toBe(CODEX_DEFAULT_MODEL)
  })

  it('offers the bundled CLI model catalog', async () => {
    await expect(getChatGPTProvider().getAvailableModels(configWith())).resolves.toEqual(
      CODEX_SUBSCRIPTION_MODELS.map((model) => model.slug)
    )
  })

  it('asks for a refresh inside the five-minute window before expiry', () => {
    const provider = getChatGPTProvider()

    const fresh = provider.checkTokenWithConfig(configWith({ tokenExpires: Date.now() + 60 * 60 * 1000 }))
    expect(fresh.valid).toBe(true)
    expect(fresh.needsRefresh).toBe(false)

    const expiring = provider.checkTokenWithConfig(configWith({ tokenExpires: Date.now() + 60 * 1000 }))
    expect(expiring.needsRefresh).toBe(true)

    const expired = provider.checkTokenWithConfig(configWith({ tokenExpires: Date.now() - 1000 }))
    expect(expired.valid).toBe(true)
    expect(expired.needsRefresh).toBe(true)
    expect(expired.expiresIn).toBe(0)
  })

  it('treats an unreadable expiry as needing a refresh', () => {
    // Same direction as the Claude provider: a refresh is cheap, an expired
    // token mid-conversation is not.
    const status = getChatGPTProvider().checkTokenWithConfig(configWith({ tokenExpires: 0 }))
    expect(status.valid).toBe(true)
    expect(status.needsRefresh).toBe(true)
  })

  it('reports invalid when there is no access token', () => {
    const status = getChatGPTProvider().checkTokenWithConfig(configWith({ accessToken: undefined }))
    expect(status.valid).toBe(false)
    expect(status.needsRefresh).toBe(false)
  })

  it('refuses to refresh without a refresh token', async () => {
    const result = await getChatGPTProvider().refreshTokenWithConfig(configWith({ refreshToken: '' }))
    expect(result.success).toBe(false)
  })

  /**
   * Deleting the local source leaves the refresh token live upstream otherwise,
   * which is what the CLI's revoke call exists to prevent.
   */
  describe('logout', () => {
    it('revokes the refresh token upstream', async () => {
      proxyFetch.mockResolvedValueOnce({ ok: true, status: 200 } as unknown as Response)

      await getChatGPTProvider().logout(configWith())

      const [url, init] = proxyFetch.mock.calls[0] as [string, { body: string }]
      expect(url).toBe('https://auth.openai.com/oauth/revoke')
      expect(JSON.parse(init.body)).toEqual({
        token: 'refresh-token',
        token_type_hint: 'refresh_token',
        client_id: 'app_EMoamEEZ73f0CkXaXp7hrann'
      })
    })

    it('succeeds without revoking when no config is supplied', async () => {
      const result = await getChatGPTProvider().logout()
      expect(result.success).toBe(true)
      expect(proxyFetch).not.toHaveBeenCalled()
    })

    it('still succeeds when the revoke call fails', async () => {
      proxyFetch.mockRejectedValueOnce(new Error('network down'))
      await expect(getChatGPTProvider().logout(configWith())).resolves.toEqual({ success: true })
    })
  })

  /**
   * The account's catalog comes from the backend, not from the shipped constant:
   * the plan decides which models exist, and the list moves (new slugs appear)
   * far more often than this client ships.
   */
  describe('refreshConfig', () => {
    function catalogResponse(models: unknown[]): Response {
      return {
        ok: true,
        status: 200,
        json: async () => ({ models })
      } as unknown as Response
    }

    function modelsOf(result: { data?: unknown }): { availableModels: string[]; modelNames: Record<string, string> } {
      const payload = (result.data as Record<string, { availableModels: string[]; modelNames: Record<string, string> }>)[CHATGPT_PROVIDER_ID]
      return { availableModels: payload.availableModels, modelNames: payload.modelNames }
    }

    it('records the catalog capabilities the request shape depends on', async () => {
      proxyFetch.mockResolvedValueOnce(
        catalogResponse([
          { slug: 'model-plain', visibility: 'list', priority: 0 },
          { slug: 'model-no-summary', visibility: 'list', priority: 1, supports_reasoning_summary_parameter: false },
          { slug: 'model-lite', visibility: 'list', priority: 2, use_responses_lite: true }
        ])
      )

      await getChatGPTProvider().refreshConfig(configWith())

      // Silence in the catalog is assent: the wire field only states a false.
      expect(getCodexModelCapability('model-plain')).toEqual({ reasoningSummary: true, responsesLite: false })
      expect(getCodexModelCapability('model-no-summary')).toEqual({ reasoningSummary: false, responsesLite: false })
      expect(getCodexModelCapability('model-lite')).toEqual({ reasoningSummary: true, responsesLite: true })
    })

    /**
     * The context window is the load-bearing one: it drives auto-compaction, and
     * Halo's model table has no entry for these slugs — without the catalog
     * value every Codex model is treated as 200K, compacting a 272K model early.
     */
    it('carries per-model capabilities the catalog states', async () => {
      proxyFetch.mockResolvedValueOnce(
        catalogResponse([
          {
            slug: 'sees',
            visibility: 'list',
            priority: 0,
            input_modalities: ['text', 'image'],
            context_window: 272000
          },
          { slug: 'blind', visibility: 'list', priority: 1, input_modalities: ['text'] },
          { slug: 'unstated', visibility: 'list', priority: 2 }
        ])
      )

      const payload = ((await getChatGPTProvider().refreshConfig(configWith())).data as Record<string, {
        modelCapabilities: Record<string, unknown>
        modelVision: Record<string, unknown>
        modelOverrides?: Record<string, unknown>
      }>)[CHATGPT_PROVIDER_ID]

      expect(payload.modelCapabilities).toEqual({ sees: { contextWindow: 272000 } })
      // The backend states modalities explicitly, so a negative is a real
      // statement here — unlike a generic gateway's optional modality list.
      expect(payload.modelVision).toEqual({ sees: true, blind: false })

      // What the catalog observed must not land in modelOverrides: that map is
      // the user's own edits, and writing to it would both mark every model as
      // user-customised and make "Reset to preset" unable to clear it.
      expect(payload.modelOverrides).toBeUndefined()
    })

    it('merges the overlay onto the shipped list instead of replacing it', async () => {
      // Synthetic slugs: which real models are list or hidden is the backend's
      // call and changes over time, so a fixture naming real ones would age
      // into a false claim about the live catalog.
      proxyFetch.mockResolvedValueOnce(
        catalogResponse([
          { slug: 'model-hidden', display_name: 'Hidden', visibility: 'hide', priority: 0 },
          { slug: 'model-second', display_name: 'Second', visibility: 'list', priority: 2 }
        ])
      )

      const result = await getChatGPTProvider().refreshConfig(configWith())
      const { availableModels, modelNames } = modelsOf(result)

      // The overlay entry joins the shipped ones and both sets order by
      // priority; the hidden entry is dropped and the shipped models the
      // backend did not mention survive.
      expect(availableModels).toEqual([
        'gpt-6-astra',
        'model-second',
        'gpt-5.6-sol',
        'gpt-5.6-terra',
        'gpt-5.6-luna',
        'gpt-5.5'
      ])
      expect(modelNames['model-second']).toBe('Second')
      expect(modelNames['gpt-6-astra']).toBe('GPT-6-Astra')
    })

    it('lets the backend hide a shipped model', async () => {
      proxyFetch.mockResolvedValueOnce(
        catalogResponse([{ slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'hide', priority: 12 }])
      )

      const { availableModels } = modelsOf(await getChatGPTProvider().refreshConfig(configWith()))

      expect(availableModels).toEqual(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])
    })

    it('queries the catalog endpoint with the CLI version and identity headers', async () => {
      proxyFetch.mockResolvedValueOnce(catalogResponse([{ slug: 'model-first', visibility: 'list', priority: 0 }]))

      await getChatGPTProvider().refreshConfig(configWith())

      const [url, init] = proxyFetch.mock.calls[0] as [string, { headers: Record<string, string> }]
      expect(url).toBe(`https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLI_VERSION}`)
      expect(init.headers['Authorization']).toBe('Bearer access-token')
      expect(init.headers['ChatGPT-Account-ID']).toBe('acct-1')
      expect(init.headers['originator']).toBe('codex_cli_rs')
      // The streaming accept header belongs to inference, not to the catalog.
      expect(init.headers['Accept']).toBeUndefined()
    })

    /**
     * A fetch that fails must not look like "this account has no models" — the
     * manager reads `degraded` and keeps what is already stored.
     */
    it('degrades instead of clearing the list when the catalog cannot be read', async () => {
      proxyFetch.mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'unavailable' } as unknown as Response)

      const result = await getChatGPTProvider().refreshConfig(configWith())

      expect(result.success).toBe(true)
      const payload = (result.data as Record<string, { degraded?: boolean; availableModels?: string[] }>)[CHATGPT_PROVIDER_ID]
      expect(payload.degraded).toBe(true)
      expect(payload.availableModels).toBeUndefined()
    })

    it('degrades when the catalog comes back empty', async () => {
      proxyFetch.mockResolvedValueOnce(catalogResponse([]))

      const payload = ((await getChatGPTProvider().refreshConfig(configWith())).data as Record<string, { degraded?: boolean }>)[CHATGPT_PROVIDER_ID]
      expect(payload.degraded).toBe(true)
    })

    it('refuses to fetch without a token', async () => {
      const result = await getChatGPTProvider().refreshConfig(configWith({ accessToken: undefined }))
      expect(result.success).toBe(false)
      expect(proxyFetch).not.toHaveBeenCalled()
    })
  })
})
