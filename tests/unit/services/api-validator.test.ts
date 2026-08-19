/**
 * Unit tests for normalizeApiUrl, re-exported by api-validator.service.ts
 * (real implementation lives in openai-compat-router/utils/url.ts).
 *
 * The api-validator module pulls in the SDK/router at import time, so those
 * heavy dependencies are stubbed here — only the pure URL normalizer is under
 * test. Behavior is wire-format dependent:
 *   - 'anthropic'             -> trim only (SDK appends /v1/messages)
 *   - 'anthropic_passthrough' -> ensure trailing /v1/messages (idempotent)
 *   - 'openai'                -> ensure /chat/completions, host-only gets /v1
 */

import { describe, it, expect, vi } from 'vitest'

// Stub the heavy transitive deps so importing the service doesn't spin up the
// SDK/router. Only the re-exported pure function is exercised.
vi.mock('../../../src/main/services/proxy-fetch', () => ({ proxyFetch: vi.fn() }))
vi.mock('../../../src/main/services/agent/resolved-sdk', () => ({ createSession: vi.fn() }))
vi.mock('../../../src/main/services/agent/sdk-config', () => ({ buildSdkEnv: vi.fn(() => ({})) }))
vi.mock('../../../src/main/services/agent/helpers', () => ({ getHeadlessElectronPath: vi.fn(() => '') }))

import { normalizeApiUrl } from '../../../src/main/services/api-validator.service'

describe('normalizeApiUrl — anthropic', () => {
  it('trims trailing slashes and whitespace, leaving the base URL', () => {
    expect(normalizeApiUrl('https://api.anthropic.com/', 'anthropic')).toBe('https://api.anthropic.com')
    expect(normalizeApiUrl('https://api.anthropic.com///', 'anthropic')).toBe('https://api.anthropic.com')
    expect(normalizeApiUrl(' https://api.anthropic.com ', 'anthropic')).toBe('https://api.anthropic.com')
  })
})

describe('normalizeApiUrl — anthropic_passthrough', () => {
  it('appends /v1/messages to a base URL', () => {
    expect(normalizeApiUrl('https://gateway.example.com', 'anthropic_passthrough'))
      .toBe('https://gateway.example.com/v1/messages')
  })

  it('is idempotent when the suffix is already present', () => {
    const full = 'https://gateway.example.com/v1/messages'
    expect(normalizeApiUrl(full, 'anthropic_passthrough')).toBe(full)
  })

  it('strips a trailing slash before appending', () => {
    expect(normalizeApiUrl('https://gateway.example.com/', 'anthropic_passthrough'))
      .toBe('https://gateway.example.com/v1/messages')
  })
})

describe('normalizeApiUrl — openai', () => {
  it('appends /v1/chat/completions for a host-only URL', () => {
    expect(normalizeApiUrl('https://api.openai.com', 'openai'))
      .toBe('https://api.openai.com/v1/chat/completions')
  })

  it('does not add /v1 when a path segment already exists', () => {
    expect(normalizeApiUrl('https://api.example.com/v4', 'openai'))
      .toBe('https://api.example.com/v4/chat/completions')
  })

  it('returns a full /chat/completions URL as-is', () => {
    const full = 'https://api.example.com/v1/chat/completions'
    expect(normalizeApiUrl(full, 'openai')).toBe(full)
  })

  it('returns a full /responses URL as-is', () => {
    const full = 'https://api.example.com/v1/responses'
    expect(normalizeApiUrl(full, 'openai')).toBe(full)
  })

  it('strips an incomplete /chat suffix before completing', () => {
    expect(normalizeApiUrl('https://api.example.com/v1/chat', 'openai'))
      .toBe('https://api.example.com/v1/chat/completions')
  })

  it('trims trailing slashes before completing', () => {
    expect(normalizeApiUrl('https://api.openai.com/', 'openai'))
      .toBe('https://api.openai.com/v1/chat/completions')
  })
})
