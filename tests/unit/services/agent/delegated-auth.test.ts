/**
 * Delegated auth: the CLI subprocess owns the credential.
 *
 * Two invariants decide whether the whole mechanism works. The subprocess must
 * receive no API key — any value makes it authenticate as an API-key user and
 * ignore the credential it holds — and its backend identity must travel on a
 * separate header, because its own OAuth token occupies the auth channel.
 */

import { describe, expect, it, vi } from 'vitest'

// Newly reachable via ai-sources/manager.ts or mcp-manager.ts pulling in
// analytics.service.ts (which statically imports providers/baidu.ts's
// `BrowserWindow` from 'electron') — mock it out like every other test that
// touches this transitive chain, so this file's own module graph controls
// what it needs rather than the real telemetry provider stack.
vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn(), trackErrorSurface: vi.fn() }
}))

import { buildSdkEnv, computeCredentialsFingerprint } from '../../../../src/main/services/agent/sdk-config'
import { encodeBackendConfig, DELEGATED_ROUTING_HEADER } from '../../../../src/main/openai-compat-router'

function routingHeader(model: string): string {
  return `${DELEGATED_ROUTING_HEADER}: ${encodeBackendConfig({
    url: 'https://api.anthropic.com/v1/messages',
    key: '',
    model,
    apiType: 'anthropic_passthrough',
    delegatedAuth: true
  })}`
}

describe('buildSdkEnv (delegated)', () => {
  it('omits ANTHROPIC_API_KEY and carries the backend on the custom header', () => {
    const env = buildSdkEnv({
      anthropicApiKey: '',
      anthropicBaseUrl: 'http://127.0.0.1:60098',
      delegatedRoutingHeader: routingHeader('claude-sonnet-5')
    })

    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe(routingHeader('claude-sonnet-5'))
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:60098')
  })

  it('still sets ANTHROPIC_API_KEY for every other source', () => {
    const env = buildSdkEnv({
      anthropicApiKey: 'encoded-backend-config',
      anthropicBaseUrl: 'http://127.0.0.1:60098'
    })

    expect(env.ANTHROPIC_API_KEY).toBe('encoded-backend-config')
    expect(env).not.toHaveProperty('ANTHROPIC_CUSTOM_HEADERS')
  })
})

describe('computeCredentialsFingerprint (delegated)', () => {
  it('separates delegated sessions by their pinned model', () => {
    const sonnet = computeCredentialsFingerprint({
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:60098',
        ANTHROPIC_CUSTOM_HEADERS: routingHeader('claude-sonnet-5')
      }
    })
    const opus = computeCredentialsFingerprint({
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:60098',
        ANTHROPIC_CUSTOM_HEADERS: routingHeader('claude-opus-5')
      }
    })

    expect(sonnet).not.toBe(opus)
  })

  it('is stable across resolves of the same delegated source', () => {
    const options = {
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:60098',
        ANTHROPIC_CUSTOM_HEADERS: routingHeader('claude-sonnet-5')
      }
    }

    expect(computeCredentialsFingerprint(options)).toBe(computeCredentialsFingerprint(options))
  })
})
