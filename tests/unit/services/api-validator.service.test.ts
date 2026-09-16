import { beforeEach, describe, expect, it, vi } from 'vitest'


// Newly reachable via ai-sources/manager.ts or mcp-manager.ts pulling in
// analytics.service.ts (which statically imports providers/baidu.ts's
// `BrowserWindow` from 'electron') — mock it out like every other test that
// touches this transitive chain, so this file's own module graph controls
// what it needs rather than the real telemetry provider stack.
vi.mock('../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn(), trackErrorSurface: vi.fn() }
}))

const { proxyFetchMock } = vi.hoisted(() => ({
  proxyFetchMock: vi.fn()
}))

vi.mock('../../../src/main/services/proxy-fetch', () => ({
  proxyFetch: proxyFetchMock
}))

vi.mock('../../../src/main/services/agent/resolved-sdk', () => ({
  getResolvedAgentSdk: vi.fn()
}))

import { fetchModelsFromApi } from '../../../src/main/services/api-validator.service'

describe('fetchModelsFromApi error details', () => {
  beforeEach(() => {
    proxyFetchMock.mockReset()
  })

  it.each([
    [401, 'MODEL_FETCH_UNAUTHORIZED'],
    [403, 'MODEL_FETCH_UNAUTHORIZED'],
    [404, 'MODEL_FETCH_NOT_FOUND'],
    [429, 'MODEL_FETCH_RATE_LIMITED'],
    [500, 'MODEL_FETCH_FAILED']
  ])('classifies an HTTP %i response as %s', async (status, code) => {
    proxyFetchMock.mockResolvedValue(new Response('{}', { status }))

    await expect(fetchModelsFromApi({
      apiKey: 'sk-test-placeholder',
      apiUrl: 'https://example.com/v1'
    })).rejects.toMatchObject({ code })
  })

  it('preserves an OpenAI-compatible provider detail', async () => {
    proxyFetchMock.mockResolvedValue(new Response(
      JSON.stringify({ error: { message: 'Invalid Authentication' } }),
      { status: 401 }
    ))

    await expect(fetchModelsFromApi({
      apiKey: 'sk-test-placeholder',
      apiUrl: 'https://example.com/v1'
    })).rejects.toMatchObject({
      code: 'MODEL_FETCH_UNAUTHORIZED',
      detail: 'Invalid Authentication'
    })
  })

  it('keeps HTML-looking provider details as plain strings', async () => {
    proxyFetchMock.mockResolvedValue(new Response(
      JSON.stringify({ error: { message: '<strong>Denied</strong>' } }),
      { status: 403 }
    ))

    await expect(fetchModelsFromApi({
      apiKey: 'sk-test-placeholder',
      apiUrl: 'https://example.com/v1'
    })).rejects.toMatchObject({
      detail: '<strong>Denied</strong>'
    })
  })

  it('redacts, normalizes, and truncates untrusted provider details', async () => {
    const apiKey = 'sk-test-placeholder'
    const message = `  Invalid\n${apiKey}\t${'x'.repeat(300)}<b>plain text</b>  `
    proxyFetchMock.mockResolvedValue(new Response(
      JSON.stringify({ error: { message } }),
      { status: 401 }
    ))

    let failure: unknown
    try {
      await fetchModelsFromApi({ apiKey, apiUrl: 'https://example.com/v1' })
    } catch (error) {
      failure = error
    }

    expect(failure).toMatchObject({ code: 'MODEL_FETCH_UNAUTHORIZED' })
    const detail = (failure as { detail: string }).detail
    expect(detail).not.toContain(apiKey)
    expect(detail).not.toMatch(/[\n\t]/)
    expect(Array.from(detail)).toHaveLength(200)
    expect(detail).toContain('[REDACTED]')
  })

  it('does not expose malformed or unknown response bodies', async () => {
    proxyFetchMock.mockResolvedValue(new Response('<html>proxy error</html>', { status: 404 }))

    await expect(fetchModelsFromApi({
      apiKey: 'sk-test-placeholder',
      apiUrl: 'https://example.com/v1'
    })).rejects.toMatchObject({
      code: 'MODEL_FETCH_NOT_FOUND',
      detail: undefined
    })
  })

  it('preserves an approved top-level provider detail', async () => {
    proxyFetchMock.mockResolvedValue(new Response(
      JSON.stringify({ message: 'Top-level provider detail' }),
      { status: 500 }
    ))

    await expect(fetchModelsFromApi({
      apiKey: 'sk-test-placeholder',
      apiUrl: 'https://example.com/v1'
    })).rejects.toMatchObject({
      code: 'MODEL_FETCH_FAILED',
      detail: 'Top-level provider detail'
    })
  })

  it('prefers nested provider details and ignores non-string messages', async () => {
    proxyFetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({
        error: { message: 'Nested detail' },
        message: 'Top-level detail'
      }),
      { status: 500 }
    ))

    await expect(fetchModelsFromApi({
      apiKey: 'sk-test-placeholder',
      apiUrl: 'https://example.com/v1'
    })).rejects.toMatchObject({ detail: 'Nested detail' })

    proxyFetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ error: { message: 42 }, message: 'Top-level fallback' }),
      { status: 500 }
    ))

    await expect(fetchModelsFromApi({
      apiKey: 'sk-test-placeholder',
      apiUrl: 'https://example.com/v1'
    })).rejects.toMatchObject({ detail: 'Top-level fallback' })

    proxyFetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ error: { message: { internal: true } }, message: 42 }),
      { status: 500 }
    ))

    await expect(fetchModelsFromApi({
      apiKey: 'sk-test-placeholder',
      apiUrl: 'https://example.com/v1'
    })).rejects.toMatchObject({ detail: undefined })
  })

  it('does not expose arbitrary request failure messages', async () => {
    proxyFetchMock.mockRejectedValue(new TypeError('fetch failed for proxy-user:proxy-pass'))

    await expect(fetchModelsFromApi({
      apiKey: 'sk-test-placeholder',
      apiUrl: 'https://example.com/v1'
    })).rejects.toMatchObject({
      code: 'MODEL_FETCH_NETWORK',
      detail: undefined
    })
  })

  it('classifies request timeouts without exposing diagnostics', async () => {
    const timeout = new Error('request to /Users/private/config timed out')
    timeout.name = 'TimeoutError'
    proxyFetchMock.mockRejectedValue(timeout)

    await expect(fetchModelsFromApi({
      apiKey: 'sk-test-placeholder',
      apiUrl: 'https://example.com/v1'
    })).rejects.toMatchObject({
      code: 'MODEL_FETCH_TIMEOUT',
      detail: undefined
    })
  })

  it('preserves successful model fetching', async () => {
    proxyFetchMock.mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'model-z' }, { id: 'model-a' }]
    }), { status: 200 }))

    await expect(fetchModelsFromApi({
      apiKey: 'sk-test-placeholder',
      apiUrl: 'https://example.com/v1'
    })).resolves.toEqual({
      models: [
        { id: 'model-a', name: 'model-a' },
        { id: 'model-z', name: 'model-z' }
      ]
    })
  })

  it('attaches provider-declared capabilities when the catalog states them', async () => {
    // OpenRouter-shaped fixture, matching the field set that caused the
    // reported bug for "~z-ai/glm-flash-latest".
    proxyFetchMock.mockResolvedValue(new Response(JSON.stringify({
      data: [
        {
          id: '~z-ai/glm-flash-latest',
          name: 'Z.ai: GLM Flash Latest',
          context_length: 1310720,
          architecture: { input_modalities: ['text', 'image', 'video'] },
          top_provider: { max_completion_tokens: 131072 }
        },
        { id: 'model-no-capabilities' }
      ]
    }), { status: 200 }))

    const result = await fetchModelsFromApi({
      apiKey: 'sk-test-placeholder',
      apiUrl: 'https://example.com/v1'
    })

    // Sorted independently of the service's own (locale-dependent) sort, so
    // this assertion does not depend on where "~" collates relative to "m".
    const byId = Object.fromEntries(result.models.map(m => [m.id, m]))
    expect(Object.keys(byId).sort()).toHaveLength(2)
    expect(byId['model-no-capabilities']).toEqual({
      id: 'model-no-capabilities',
      name: 'model-no-capabilities'
    })
    // The provider's display name is kept rather than echoing the id: both
    // fetch paths run through the same mapper now, the picker renders the id
    // underneath whenever it differs, and search matches either field.
    expect(byId['~z-ai/glm-flash-latest']).toEqual({
      id: '~z-ai/glm-flash-latest',
      name: 'Z.ai: GLM Flash Latest',
      supportsVision: true,
      capabilities: { contextWindow: 1310720, maxOutputTokens: 131072 }
    })
  })
})
