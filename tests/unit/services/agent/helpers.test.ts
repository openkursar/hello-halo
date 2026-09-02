/**
 * inferOpenAIWireApi resolution order: env override (HALO_OPENAI_API_TYPE /
 * HALO_OPENAI_WIRE_API) wins, else the URL suffix decides, else the
 * chat_completions default. getDbMcpServers / getMcpServersForRequires are the
 * only other exports here and are already covered by mcp-helpers-blacklist.test.ts,
 * so they are not re-tested.
 *
 * product-config / app-bridge are mocked the same way as the blacklist test so
 * the module imports cleanly during config.service init.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'


// Newly reachable via ai-sources/manager.ts or mcp-manager.ts pulling in
// analytics.service.ts (which statically imports providers/baidu.ts's
// `BrowserWindow` from 'electron') — mock it out like every other test that
// touches this transitive chain, so this file's own module graph controls
// what it needs rather than the real telemetry provider stack.
vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn(), trackErrorSurface: vi.fn() }
}))

vi.mock('../../../../src/main/foundation/product-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/foundation/product-config')>()
  return {
    ...actual,
    loadProductConfig: vi.fn(() => ({ name: 'test', version: '0.0.0', authProviders: [] }))
  }
})

vi.mock('../../../../src/main/services/app-bridge', () => ({
  getAppManager: vi.fn()
}))

import { inferOpenAIWireApi } from '../../../../src/main/services/agent/helpers'

const ENV_KEYS = ['HALO_OPENAI_API_TYPE', 'HALO_OPENAI_WIRE_API'] as const

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
})
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
})

describe('inferOpenAIWireApi — env override', () => {
  it('honors HALO_OPENAI_API_TYPE=responses over a chat URL', () => {
    process.env.HALO_OPENAI_API_TYPE = 'responses'
    expect(inferOpenAIWireApi('https://x.test/v1/chat/completions')).toBe('responses')
  })

  it('honors HALO_OPENAI_WIRE_API=chat over a responses URL', () => {
    process.env.HALO_OPENAI_WIRE_API = 'chat_completions'
    expect(inferOpenAIWireApi('https://x.test/v1/responses')).toBe('chat_completions')
  })

  it('matches the override substring case-insensitively', () => {
    process.env.HALO_OPENAI_API_TYPE = 'RESPONSE'
    expect(inferOpenAIWireApi('')).toBe('responses')
  })

  it('falls through to URL inference when the override value is unrecognized', () => {
    process.env.HALO_OPENAI_API_TYPE = 'gibberish'
    expect(inferOpenAIWireApi('https://x.test/v1/responses')).toBe('responses')
  })
})

describe('inferOpenAIWireApi — URL inference', () => {
  it('infers chat_completions from a /chat/completions URL', () => {
    expect(inferOpenAIWireApi('https://x.test/v1/chat/completions')).toBe('chat_completions')
  })

  it('infers chat_completions from a /chat_completions URL variant', () => {
    expect(inferOpenAIWireApi('https://x.test/v1/chat_completions')).toBe('chat_completions')
  })

  it('infers responses from a /responses URL', () => {
    expect(inferOpenAIWireApi('https://x.test/v1/responses')).toBe('responses')
  })
})

describe('inferOpenAIWireApi — default', () => {
  it('defaults to chat_completions for an empty URL and no override', () => {
    expect(inferOpenAIWireApi('')).toBe('chat_completions')
  })

  it('defaults to chat_completions for a URL with no recognizable suffix', () => {
    expect(inferOpenAIWireApi('https://x.test/v1')).toBe('chat_completions')
  })
})
