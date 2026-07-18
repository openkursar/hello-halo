import { beforeEach, describe, expect, it, vi } from 'vitest'

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

  it('classifies request failures without exposing credentials', async () => {
    proxyFetchMock.mockRejectedValue(new TypeError('fetch failed for sk-test-placeholder'))

    await expect(fetchModelsFromApi({
      apiKey: 'sk-test-placeholder',
      apiUrl: 'https://example.com/v1'
    })).rejects.toMatchObject({
      code: 'MODEL_FETCH_NETWORK',
      detail: 'fetch failed for [REDACTED]'
    })
  })

  it('classifies request timeouts', async () => {
    const timeout = new Error('The operation was aborted')
    timeout.name = 'TimeoutError'
    proxyFetchMock.mockRejectedValue(timeout)

    await expect(fetchModelsFromApi({
      apiKey: 'sk-test-placeholder',
      apiUrl: 'https://example.com/v1'
    })).rejects.toMatchObject({ code: 'MODEL_FETCH_TIMEOUT' })
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
})
