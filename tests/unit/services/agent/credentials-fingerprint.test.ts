/**
 * computeCredentialsFingerprint: must be deterministic for unchanged
 * credentials. Router-encoded API keys embed per-resolution request headers
 * (e.g. a fresh x-client-request-id UUID per getBackendConfig call); hashing
 * the raw blob made the fingerprint change on every warm-up, which rebuilt the
 * session each time and tore down in-flight agent teams.
 */

import { describe, expect, it } from 'vitest'
import { computeCredentialsFingerprint } from '../../../../src/main/services/agent/sdk-config'
import { encodeBackendConfig } from '../../../../src/main/openai-compat-router'

function sdkOptionsWithEncodedKey(overrides: {
  headers?: Record<string, string>
  model?: string
  key?: string
  url?: string
  apiType?: 'chat_completions' | 'responses' | 'anthropic_passthrough' | 'kiro'
} = {}): Record<string, unknown> {
  return {
    env: {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:60098',
      ANTHROPIC_API_KEY: encodeBackendConfig({
        url: overrides.url ?? 'https://api.anthropic.com/v1/messages',
        key: overrides.key ?? 'sk-test-stable-token',
        model: overrides.model ?? 'claude-sonnet-4[1m]',
        apiType: overrides.apiType ?? 'anthropic_passthrough',
        headers: overrides.headers ?? {
          Authorization: 'Bearer sk-test-stable-token',
          'x-client-request-id': 'aaaaaaaa-0000-0000-0000-000000000001'
        }
      })
    }
  }
}

describe('computeCredentialsFingerprint', () => {
  it('is stable across resolves that only differ in volatile per-request headers', () => {
    const a = computeCredentialsFingerprint(
      sdkOptionsWithEncodedKey({
        headers: {
          Authorization: 'Bearer sk-test-stable-token',
          'x-client-request-id': 'aaaaaaaa-0000-0000-0000-000000000001'
        }
      })
    )
    const b = computeCredentialsFingerprint(
      sdkOptionsWithEncodedKey({
        headers: {
          Authorization: 'Bearer sk-test-stable-token',
          'x-client-request-id': 'bbbbbbbb-9999-9999-9999-999999999999'
        }
      })
    )
    expect(a).toBe(b)
  })

  it('changes when the pinned model changes', () => {
    const a = computeCredentialsFingerprint(sdkOptionsWithEncodedKey({ model: 'claude-sonnet-4[1m]' }))
    const b = computeCredentialsFingerprint(sdkOptionsWithEncodedKey({ model: 'claude-opus-4' }))
    expect(a).not.toBe(b)
  })

  it('changes when the access token changes (e.g. OAuth refresh)', () => {
    const a = computeCredentialsFingerprint(sdkOptionsWithEncodedKey({ key: 'sk-test-token-1' }))
    const b = computeCredentialsFingerprint(sdkOptionsWithEncodedKey({ key: 'sk-test-token-2' }))
    expect(a).not.toBe(b)
  })

  it('changes when the backend url or apiType changes', () => {
    const base = computeCredentialsFingerprint(sdkOptionsWithEncodedKey())
    const otherUrl = computeCredentialsFingerprint(
      sdkOptionsWithEncodedKey({ url: 'https://other-provider.example/v1/messages' })
    )
    const otherApiType = computeCredentialsFingerprint(
      sdkOptionsWithEncodedKey({ apiType: 'chat_completions' })
    )
    expect(base).not.toBe(otherUrl)
    expect(base).not.toBe(otherApiType)
  })

  it('handles direct (non-encoded) Anthropic keys as stable opaque values', () => {
    const opts = (key: string, model: string): Record<string, unknown> => ({
      model,
      env: { ANTHROPIC_API_KEY: key }
    })
    expect(computeCredentialsFingerprint(opts('sk-ant-plain', 'claude-sonnet-4')))
      .toBe(computeCredentialsFingerprint(opts('sk-ant-plain', 'claude-sonnet-4')))
    expect(computeCredentialsFingerprint(opts('sk-ant-plain', 'claude-sonnet-4')))
      .not.toBe(computeCredentialsFingerprint(opts('sk-ant-other', 'claude-sonnet-4')))
    expect(computeCredentialsFingerprint(opts('sk-ant-plain', 'claude-sonnet-4')))
      .not.toBe(computeCredentialsFingerprint(opts('sk-ant-plain', 'claude-opus-4')))
  })
})
