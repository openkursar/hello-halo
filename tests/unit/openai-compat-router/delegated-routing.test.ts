/**
 * Router handling of delegated callers.
 *
 * Those requests arrive without `x-api-key` — the caller authenticates itself
 * and its `Authorization` header belongs to the upstream — so the backend
 * config has to be recoverable from a dedicated header, and that header must
 * not leak upstream.
 */

import { describe, expect, it } from 'vitest'
import {
  decodeBackendConfig,
  encodeBackendConfig,
  DELEGATED_ROUTING_HEADER
} from '../../../src/main/openai-compat-router'

describe('decodeBackendConfig', () => {
  it('accepts a keyless config marked delegated', () => {
    const encoded = encodeBackendConfig({
      url: 'https://api.anthropic.com/v1/messages',
      key: '',
      model: 'claude-sonnet-5',
      apiType: 'anthropic_passthrough',
      delegatedAuth: true
    })

    const decoded = decodeBackendConfig(encoded)

    expect(decoded?.url).toBe('https://api.anthropic.com/v1/messages')
    expect(decoded?.delegatedAuth).toBe(true)
  })

  it('still rejects a keyless config that is not delegated', () => {
    const encoded = encodeBackendConfig({
      url: 'https://api.anthropic.com/v1/messages',
      key: ''
    })

    expect(decodeBackendConfig(encoded)).toBeNull()
  })
})

describe('DELEGATED_ROUTING_HEADER', () => {
  it('is lowercase so Express header lookup matches', () => {
    expect(DELEGATED_ROUTING_HEADER).toBe(DELEGATED_ROUTING_HEADER.toLowerCase())
  })
})
