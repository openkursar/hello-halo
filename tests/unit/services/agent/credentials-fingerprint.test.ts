/**
 * computeCredentialsFingerprint: must be deterministic for unchanged
 * credentials. Router-encoded API keys embed per-resolution request headers
 * (e.g. a fresh x-client-request-id UUID per getBackendConfig call); hashing
 * the raw blob made the fingerprint change on every warm-up, which rebuilt the
 * session each time and tore down in-flight agent teams.
 */

import { describe, expect, it, vi, afterEach } from 'vitest'
import type { BackendRequestConfig } from '../../../../src/shared/types/ai-sources'
import type { ApiCredentials } from '../../../../src/main/services/agent/types'

// Newly reachable via ai-sources/manager.ts or mcp-manager.ts pulling in
// analytics.service.ts (which statically imports providers/baidu.ts's
// `BrowserWindow` from 'electron') — mock it out like every other test that
// touches this transitive chain, so this file's own module graph controls
// what it needs rather than the real telemetry provider stack.
vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn(), trackErrorSurface: vi.fn() }
}))

vi.mock('../../../../src/main/openai-compat-router', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../src/main/openai-compat-router')>()
  return { ...actual, ensureOpenAICompatRouter: vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:60098' })) }
})

import {
  computeCredentialsFingerprint,
  getSdkSourceId,
  getSdkApiCredentials,
  getCleanUserEnv,
  buildSdkEnv,
  resolveCredentialsForSdk,
} from '../../../../src/main/services/agent/sdk-config'
import { encodeBackendConfig, decodeBackendConfig, DELEGATED_ROUTING_HEADER } from '../../../../src/main/openai-compat-router'

function sdkOptionsWithEncodedKey(overrides: {
  headers?: Record<string, string>
  model?: string
  key?: string
  url?: string
  apiType?: 'chat_completions' | 'responses' | 'anthropic_passthrough' | 'kiro'
  visionOverride?: boolean
  sourceId?: string
  profileArn?: string
  codexModelCapabilities?: BackendRequestConfig['codexModelCapabilities']
} = {}): Record<string, unknown> {
  return {
    env: {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:60098',
      ANTHROPIC_API_KEY: encodeBackendConfig({
        url: overrides.url ?? 'https://api.anthropic.com/v1/messages',
        key: overrides.key ?? 'sk-test-stable-token',
        model: overrides.model ?? 'claude-sonnet-4[1m]',
        apiType: overrides.apiType ?? 'anthropic_passthrough',
        visionOverride: overrides.visionOverride,
        sourceId: overrides.sourceId,
        profileArn: overrides.profileArn,
        codexModelCapabilities: overrides.codexModelCapabilities,
        headers: overrides.headers ?? {
          Authorization: 'Bearer sk-test-stable-token',
          'x-client-request-id': 'aaaaaaaa-0000-0000-0000-000000000001'
        }
      })
    }
  }
}

describe('getSdkApiCredentials', () => {
  it('uses the captured source snapshot with its account-local capabilities', () => {
    const apiCredentials: ApiCredentials = {
      sourceId: 'account-a', credentialsGeneration: 'captured-a', provider: 'oauth',
      baseUrl: 'https://example.invalid/v1/responses', apiKey: 'test-a', model: 'gpt-test',
      capabilities: { contextWindow: 272_000, maxOutputTokens: 64_000, maxOutputTokensConfigured: true },
    }
    expect(getSdkApiCredentials({ apiCredentials, ...sdkOptionsWithEncodedKey({ sourceId: 'account-b' }) })).toBe(apiCredentials)
  })

  it('reconstructs every routing field from a standalone encoded snapshot', () => {
    const backend: BackendRequestConfig = {
      sourceId: 'account-a', url: 'https://example.invalid/v1/responses', key: 'test-a', model: 'wire-model',
      apiType: 'responses', adapterId: 'chatgpt-codex', headers: { 'ChatGPT-Account-Id': 'workspace-a' },
      profileArn: 'profile-a', codexModelCapabilities: { reasoningSummary: true, responsesLite: false },
      visionOverride: false, forceStream: true, filterContent: true,
    }
    expect(getSdkApiCredentials({
      credentialsGeneration: 'captured-a', model: 'decorated-model[1m]',
      env: { ANTHROPIC_API_KEY: encodeBackendConfig(backend) },
    })).toMatchObject({
      sourceId: 'account-a', credentialsGeneration: 'captured-a', baseUrl: backend.url, apiKey: 'test-a',
      model: 'wire-model', customHeaders: backend.headers, profileArn: 'profile-a',
      codexModelCapabilities: backend.codexModelCapabilities, adapterId: 'chatgpt-codex',
      apiType: 'responses', visionOverride: false, forceStream: true, filterContent: true,
    })
  })

  it('rejects a missing or malformed managed snapshot instead of treating the router key as a real credential', () => {
    expect(() => getSdkApiCredentials({ env: { HALO_AI_SOURCE_ID: 'account-a' } })).toThrow('captured API credentials')
    expect(() => getSdkApiCredentials({ env: {
      HALO_AI_SOURCE_ID: 'account-a', ANTHROPIC_BASE_URL: 'http://127.0.0.1:60098', ANTHROPIC_API_KEY: 'malformed',
    } })).toThrow('captured API credentials')
  })

  it('does not let a delegated snapshot fall back to another credential channel', () => {
    expect(() => getSdkApiCredentials({ env: {
      ANTHROPIC_CUSTOM_HEADERS: `${DELEGATED_ROUTING_HEADER}: ${encodeBackendConfig({
        url: 'https://example.invalid/v1/messages', key: '', delegatedAuth: true,
      })}`,
    } })).toThrow('captured API credentials')
  })
})

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

  it('changes when the vision capability changes', () => {
    // The session's encoded key freezes the strip/keep decision, while the
    // image fallback re-resolves it per turn — they must not drift apart.
    const off = computeCredentialsFingerprint(sdkOptionsWithEncodedKey({ visionOverride: false }))
    const on = computeCredentialsFingerprint(sdkOptionsWithEncodedKey({ visionOverride: true }))
    expect(off).not.toBe(on)
  })

  it('changes when the thinking level changes', () => {
    // Claude's --effort and Codex's thread effort are fixed at spawn.
    const low = computeCredentialsFingerprint({ ...sdkOptionsWithEncodedKey(), reasoningEffort: 'low' })
    const high = computeCredentialsFingerprint({ ...sdkOptionsWithEncodedKey(), reasoningEffort: 'high' })
    expect(low).not.toBe(high)
  })

  it('changes when a level is picked that equals the Model Config one', () => {
    // The router clamps a pick but forwards Model Config verbatim, so the
    // encoded key differs even though the resolved level does not.
    const configured = computeCredentialsFingerprint({ ...sdkOptionsWithEncodedKey(), reasoningEffort: 'high' })
    const picked = computeCredentialsFingerprint({
      ...sdkOptionsWithEncodedKey(), reasoningEffort: 'high', pickedReasoningEffort: 'high',
    })
    expect(configured).not.toBe(picked)
  })

  it('changes for source identity even when two accounts have identical credentials', () => {
    const first = sdkOptionsWithEncodedKey({ sourceId: 'account-a' })
    const second = sdkOptionsWithEncodedKey({ sourceId: 'account-b' })
    expect(computeCredentialsFingerprint(first)).not.toBe(computeCredentialsFingerprint(second))
    expect(computeCredentialsFingerprint({ ...first, env: { ...first.env as object, HALO_AI_SOURCE_ID: 'account-a' } }))
      .not.toBe(computeCredentialsFingerprint({ ...first, env: { ...first.env as object, HALO_AI_SOURCE_ID: 'account-b' } }))
  })

  it('changes for stable account-auth headers but ignores case, order and request ids', () => {
    const first = sdkOptionsWithEncodedKey({ headers: { Authorization: 'Bearer test', 'ChatGPT-Account-Id': 'account-a' } })
    const reordered = sdkOptionsWithEncodedKey({ headers: { 'chatgpt-account-id': 'account-a', authorization: 'Bearer test', 'x-client-request-id': 'new' } })
    expect(computeCredentialsFingerprint(first)).toBe(computeCredentialsFingerprint(reordered))
    for (const headers of [
      { Authorization: 'Bearer changed', 'ChatGPT-Account-Id': 'account-a' },
      { Authorization: 'Bearer test', 'ChatGPT-Account-Id': 'account-b' },
    ]) {
      expect(computeCredentialsFingerprint(first)).not.toBe(computeCredentialsFingerprint(sdkOptionsWithEncodedKey({ headers })))
    }
  })

  it('ignores a sourced account\'s rotating credentials but not its account identity', () => {
    const options = (key: string, token: string, account = 'workspace-a') => sdkOptionsWithEncodedKey({
      sourceId: 'copilot-account-a', model: 'gpt-test', key,
      headers: { 'copilot-session-token': token, Authorization: `Bearer ${key}`, 'ChatGPT-Account-Id': account },
    })
    const first = computeCredentialsFingerprint(options('test-token-a', 'test-session-a'))
    expect(first).toBe(computeCredentialsFingerprint(options('test-token-b', 'test-session-b')))
    expect(first).not.toBe(computeCredentialsFingerprint(options('test-token-a', 'test-session-a', 'workspace-b')))
  })

  it('changes for profile routing and selected-model capabilities', () => {
    const first = sdkOptionsWithEncodedKey({
      profileArn: 'test-profile-a',
      codexModelCapabilities: { reasoningSummary: true, responsesLite: false, reasoningLevels: ['low', 'high'] },
    })
    const base = computeCredentialsFingerprint(first)
    for (const overrides of [
      { profileArn: 'test-profile-b', codexModelCapabilities: { reasoningSummary: true, responsesLite: false, reasoningLevels: ['low', 'high'] } },
      { profileArn: 'test-profile-a', codexModelCapabilities: { reasoningSummary: false, responsesLite: false, reasoningLevels: ['low', 'high'] } },
      { profileArn: 'test-profile-a', codexModelCapabilities: { reasoningSummary: true, responsesLite: true, reasoningLevels: ['low', 'high'] } },
      { profileArn: 'test-profile-a', codexModelCapabilities: { reasoningSummary: true, responsesLite: false, reasoningLevels: ['medium'] } },
    ]) {
      expect(base).not.toBe(computeCredentialsFingerprint(sdkOptionsWithEncodedKey(overrides)))
    }
  })

  it('is stable for unchanged capabilities regardless of object property order', () => {
    const first = sdkOptionsWithEncodedKey({ codexModelCapabilities: { reasoningSummary: true, responsesLite: false, reasoningLevels: ['high'] } })
    const reordered = sdkOptionsWithEncodedKey({ codexModelCapabilities: { reasoningLevels: ['high'], responsesLite: false, reasoningSummary: true } })
    expect(computeCredentialsFingerprint(first)).toBe(computeCredentialsFingerprint(reordered))
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

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('SDK source markers and request-local routing', () => {
  it('recovers source identity from the explicit marker, encoded key or delegated header', () => {
    const encoded = encodeBackendConfig({ sourceId: 'account-a', url: 'https://example.invalid', key: 'test' })
    expect(getSdkSourceId({ env: { HALO_AI_SOURCE_ID: 'account-b', ANTHROPIC_API_KEY: encoded } })).toBe('account-b')
    expect(getSdkSourceId({ env: { ANTHROPIC_API_KEY: encoded } })).toBe('account-a')
    expect(getSdkSourceId({ env: { ANTHROPIC_CUSTOM_HEADERS: `${DELEGATED_ROUTING_HEADER}: ${encoded}` } })).toBe('account-a')
    expect(getSdkSourceId({ env: { ANTHROPIC_API_KEY: 'plain-test-key' } })).toBeUndefined()
  })

  it('never inherits another session source marker from the process environment', () => {
    vi.stubEnv('HALO_AI_SOURCE_ID', 'ambient-account')
    expect(getCleanUserEnv()).not.toHaveProperty('HALO_AI_SOURCE_ID')
    const params = { anthropicApiKey: 'test', anthropicBaseUrl: 'https://example.invalid' }
    expect(buildSdkEnv(params)).not.toHaveProperty('HALO_AI_SOURCE_ID')
    expect(buildSdkEnv({ ...params, sourceId: 'account-a' }).HALO_AI_SOURCE_ID).toBe('account-a')
  })

  it.each(['oauth', 'anthropic', 'delegated'] as const)('forwards the %s snapshot before asynchronous router preparation', async (kind) => {
    const credentials: ApiCredentials = {
      sourceId: 'account-a', credentialsGeneration: 'snapshot-before-async',
      baseUrl: 'https://example.invalid', apiKey: 'test-account-a', model: 'test-model',
      provider: kind === 'anthropic' ? 'anthropic' : 'oauth', delegatedAuth: kind === 'delegated',
      profileArn: 'test-profile-a',
      codexModelCapabilities: { reasoningSummary: true, responsesLite: false, reasoningLevels: ['high'] },
    }
    const resolved = await resolveCredentialsForSdk(credentials)
    expect(resolved.sourceId).toBe('account-a')
    expect(resolved.credentialsGeneration).toBe('snapshot-before-async')
    expect(resolved.apiCredentials).toBe(credentials)
    const encoded = resolved.delegatedRoutingHeader?.replace(`${DELEGATED_ROUTING_HEADER}: `, '') ?? resolved.anthropicApiKey
    expect(decodeBackendConfig(encoded)).toMatchObject({
      sourceId: 'account-a', profileArn: 'test-profile-a',
      codexModelCapabilities: { reasoningSummary: true, responsesLite: false, reasoningLevels: ['high'] },
    })
    const env = buildSdkEnv({ ...resolved, anthropicApiKey: resolved.anthropicApiKey, anthropicBaseUrl: resolved.anthropicBaseUrl })
    expect(env.HALO_AI_SOURCE_ID).toBe('account-a')
    if (kind === 'delegated') expect(env).not.toHaveProperty('ANTHROPIC_API_KEY')
  })
})
