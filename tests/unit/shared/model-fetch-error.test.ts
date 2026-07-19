import { describe, expect, it, vi } from 'vitest'
import { formatModelFetchError } from '../../../src/renderer/utils/model-fetch-error'

describe('formatModelFetchError', () => {
  it.each([
    ['MODEL_FETCH_UNAUTHORIZED', 'Invalid API Key or no permission'],
    ['MODEL_FETCH_NOT_FOUND', 'Endpoint not found, check the URL'],
    ['MODEL_FETCH_RATE_LIMITED', 'Rate limited or out of quota'],
    ['MODEL_FETCH_TIMEOUT', 'Request timed out, check the server or proxy'],
    ['MODEL_FETCH_NETWORK', 'Cannot reach server, check network or proxy'],
    ['MODEL_FETCH_FAILED', 'Failed to fetch models']
  ])('localizes %s with %s', (code, key) => {
    const translate = vi.fn((value: string) => `translated:${value}`)

    expect(formatModelFetchError(translate, code, 'Provider detail')).toBe(
      `translated:${key}: Provider detail`
    )
    expect(translate).toHaveBeenCalledWith(key)
  })

  it('uses the generic localized message for an unknown code without detail', () => {
    const translate = vi.fn((value: string) => `translated:${value}`)

    expect(formatModelFetchError(translate, 'UNKNOWN')).toBe(
      'translated:Failed to fetch models'
    )
  })
})
