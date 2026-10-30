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
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AISource, BackendRequestConfig } from '../../../../src/shared/types/ai-sources'

const { sourceState, manager } = vi.hoisted(() => {
  const sourceState = {
    currentId: '',
    sources: new Map<string, AISource>(),
    backends: new Map<string, BackendRequestConfig>(),
  }
  const manager = {
    ensureInitialized: vi.fn(async () => {}),
    getCurrentSourceConfig: vi.fn(() => sourceState.sources.get(sourceState.currentId) ?? null),
    getSourceConfig: vi.fn((sourceId: string) => sourceState.sources.get(sourceId) ?? null),
    ensureValidToken: vi.fn(async () => ({ success: true })),
    getBackendConfigForSource: vi.fn((sourceId: string, modelId?: string) => {
      const backend = sourceState.backends.get(sourceId)
      return backend ? { ...backend, model: modelId ?? backend.model } : null
    }),
  }
  return { sourceState, manager }
})

vi.mock('../../../../src/main/services/ai-sources', () => ({ getAISourceManager: () => manager }))

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

import {
  inferOpenAIWireApi,
  getApiCredentials,
  getApiCredentialsForSelection,
  credentialsToBackendConfig,
  getDisabledMcpTools,
} from '../../../../src/main/services/agent/helpers'
import { getAppManager } from '../../../../src/main/services/app-bridge'
import { getConfig, resolveClaudeConfigDir } from '../../../../src/main/foundation/config.service'

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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

function addAccount(id: string, contextWindow: number): void {
  sourceState.sources.set(id, {
    id, name: id, provider: 'chatgpt', authType: 'oauth',
    apiUrl: 'https://example.invalid', accessToken: `test-${id}`,
    model: 'gpt-test', createdAt: '2026-01-01', updatedAt: '2026-01-01',
    availableModels: [{ id: 'gpt-test', name: id, capabilities: { contextWindow } }],
  })
  sourceState.backends.set(id, {
    sourceId: id, url: 'https://example.invalid', key: `test-${id}`, model: 'gpt-test',
    headers: { 'ChatGPT-Account-Id': id }, apiType: 'responses', adapterId: 'chatgpt-codex',
    profileArn: `test-profile-${id}`,
    codexModelCapabilities: {
      reasoningSummary: id === 'account-a', responsesLite: id === 'account-b',
      reasoningLevels: id === 'account-a' ? ['low', 'high'] : ['medium'],
    },
  })
}

describe('account-specific credential resolution', () => {
  beforeEach(() => {
    sourceState.sources.clear()
    sourceState.backends.clear()
    sourceState.currentId = 'account-a'
    addAccount('account-a', 100_000)
    addAccount('account-b', 150_000)
    manager.ensureValidToken.mockReset().mockResolvedValue({ success: true })
  })

  it('captures the global account before refresh and re-reads its refreshed metadata', async () => {
    const refresh = deferred<{ success: boolean }>()
    manager.ensureValidToken.mockReturnValueOnce(refresh.promise)
    const pending = getApiCredentials()
    await vi.waitFor(() => expect(manager.ensureValidToken).toHaveBeenCalledWith('account-a', 'gpt-test'))

    sourceState.currentId = 'account-b'
    addAccount('account-a', 300_000)
    sourceState.backends.set('account-a', {
      ...sourceState.backends.get('account-a')!, key: 'test-refreshed-a', profileArn: 'test-new-profile-a',
    })
    refresh.resolve({ success: true })
    const credentials = await pending
    expect(credentials).toMatchObject({
      sourceId: 'account-a', apiKey: 'test-refreshed-a', displayModel: 'account-a',
      profileArn: 'test-new-profile-a', capabilities: { contextWindow: 300_000 },
    })
    expect(manager.getBackendConfigForSource).toHaveBeenCalledWith('account-a', 'gpt-test')
  })

  it('keeps two accounts and their request capabilities independent', async () => {
    const first = await getApiCredentialsForSelection({ modelSourceId: 'account-a', modelId: 'gpt-test' })
    const second = await getApiCredentialsForSelection({ modelSourceId: 'account-b', modelId: 'gpt-test' })
    const firstBackend = credentialsToBackendConfig(first)
    const secondBackend = credentialsToBackendConfig(second)
    expect(firstBackend).toMatchObject({
      sourceId: 'account-a', key: 'test-account-a', profileArn: 'test-profile-account-a',
      headers: { 'ChatGPT-Account-Id': 'account-a' },
      codexModelCapabilities: { reasoningSummary: true, responsesLite: false, reasoningLevels: ['low', 'high'] },
    })
    expect(secondBackend).toMatchObject({
      sourceId: 'account-b', key: 'test-account-b', profileArn: 'test-profile-account-b',
      headers: { 'ChatGPT-Account-Id': 'account-b' },
      codexModelCapabilities: { reasoningSummary: false, responsesLite: true, reasoningLevels: ['medium'] },
    })
    expect(first.capabilities?.contextWindow).toBe(100_000)
    expect(second.capabilities?.contextWindow).toBe(150_000)
    expect(manager.ensureValidToken.mock.calls).toEqual([['account-a', 'gpt-test'], ['account-b', 'gpt-test']])
  })

  it('prepares a delegated source before a target engine is chosen', async () => {
    const directory = resolveClaudeConfigDir()
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, '.claude.json'), JSON.stringify({ oauthAccount: { displayName: 'test' } }))
    sourceState.backends.set('account-a', { ...sourceState.backends.get('account-a')!, delegatedAuth: true })
    await expect(getApiCredentialsForSelection({ modelSourceId: 'account-a' }))
      .resolves.toMatchObject({ sourceId: 'account-a', delegatedAuth: true })
  })

  it('prepares a conversation-pinned alternate model without changing the account default', async () => {
    const source = sourceState.sources.get('account-a')!
    source.availableModels.push({ id: 'alternate-model', name: 'Alternate', capabilities: { contextWindow: 200_000 } })
    const credentials = await getApiCredentialsForSelection({
      modelSourceId: 'account-a', modelId: 'alternate-model',
    })
    expect(manager.ensureValidToken).toHaveBeenCalledWith('account-a', 'alternate-model')
    expect(manager.getBackendConfigForSource).toHaveBeenCalledWith('account-a', 'alternate-model')
    expect(credentials).toMatchObject({ sourceId: 'account-a', model: 'alternate-model', capabilities: { contextWindow: 200_000 } })
    expect(source.model).toBe('gpt-test')
  })

  it('resolves a selection without a source to the selected account', async () => {
    await expect(getApiCredentialsForSelection(null)).resolves.toMatchObject({ sourceId: 'account-a', model: 'gpt-test' })
    await expect(getApiCredentialsForSelection({})).resolves.toMatchObject({ sourceId: 'account-a', model: 'gpt-test' })
  })

  it('uses the same captured model for preparation and backend resolution if the default changes', async () => {
    const refresh = deferred<{ success: boolean }>()
    manager.ensureValidToken.mockReturnValueOnce(refresh.promise)
    const pending = getApiCredentials()
    await vi.waitFor(() => expect(manager.ensureValidToken).toHaveBeenCalledWith('account-a', 'gpt-test'))
    sourceState.sources.get('account-a')!.model = 'new-default'
    refresh.resolve({ success: true })
    expect(await pending).toMatchObject({ sourceId: 'account-a', model: 'gpt-test' })
    expect(manager.getBackendConfigForSource).toHaveBeenCalledWith('account-a', 'gpt-test')
  })

  it('runs a selection whose account was removed on the selected account, with that account\'s own model', async () => {
    sourceState.currentId = 'account-b'
    const credentials = await getApiCredentialsForSelection({ modelSourceId: 'removed-account', modelId: 'old-model' })
    expect(credentials).toMatchObject({ sourceId: 'account-b', model: 'gpt-test', capabilities: { contextWindow: 150_000 } })
    expect(manager.ensureValidToken).toHaveBeenCalledWith('account-b', 'gpt-test')
    expect(manager.getBackendConfigForSource).toHaveBeenCalledWith('account-b', 'gpt-test')
    expect(manager.getBackendConfigForSource).not.toHaveBeenCalledWith('removed-account', expect.anything())
  })

  it('fails a selection whose account was removed when no account is selected either', async () => {
    sourceState.currentId = ''
    await expect(getApiCredentialsForSelection({ modelSourceId: 'removed-account', modelId: 'old-model' }))
      .rejects.toThrow('No AI source configured')
    expect(manager.getBackendConfigForSource).not.toHaveBeenCalled()
  })

  it('fails an unconfigured selected account rather than using the current account', async () => {
    sourceState.backends.delete('account-b')
    await expect(getApiCredentialsForSelection({ modelSourceId: 'account-b' })).rejects.toThrow('not configured')
    expect(manager.getCurrentSourceConfig).not.toHaveBeenCalled()
  })

  it('fails a signed-out selected account without preventing the other account from resolving', async () => {
    manager.ensureValidToken.mockResolvedValueOnce({ success: false })
    await expect(getApiCredentialsForSelection({ modelSourceId: 'account-a' })).rejects.toThrow('login again')
    expect(manager.getCurrentSourceConfig).not.toHaveBeenCalled()
    await expect(getApiCredentialsForSelection({ modelSourceId: 'account-b' })).resolves.toMatchObject({ sourceId: 'account-b' })
  })

  it('fails if the captured account is removed while refreshing', async () => {
    const refresh = deferred<{ success: boolean }>()
    manager.ensureValidToken.mockReturnValueOnce(refresh.promise)
    const pending = getApiCredentials()
    await vi.waitFor(() => expect(manager.ensureValidToken).toHaveBeenCalledWith('account-a', 'gpt-test'))
    sourceState.sources.delete('account-a')
    sourceState.currentId = 'account-b'
    refresh.resolve({ success: true })
    await expect(pending).rejects.toThrow('unavailable')
    expect(manager.getBackendConfigForSource).not.toHaveBeenCalled()
  })
})

describe('getDisabledMcpTools', () => {
  it('lists the tools turned off on each MCP server of the space, by server id', () => {
    const listEffectiveMcpApps = vi.fn(() => [
      { specId: 'gateway', userOverrides: { disabledTools: ['drop_table', 'run_sql'] } },
      { specId: 'filesystem', userOverrides: {} },
    ])
    vi.mocked(getAppManager).mockReturnValue({ listEffectiveMcpApps } as never)

    expect(getDisabledMcpTools('space-1')).toEqual({ gateway: ['drop_table', 'run_sql'] })
    expect(listEffectiveMcpApps).toHaveBeenCalledWith('space-1')
  })

  it('is null when no tool is turned off or the apps layer is not up', () => {
    vi.mocked(getAppManager).mockReturnValue({ listEffectiveMcpApps: () => [{ specId: 'filesystem', userOverrides: {} }] } as never)
    expect(getDisabledMcpTools('space-1')).toBeNull()

    vi.mocked(getAppManager).mockReturnValue(null as never)
    expect(getDisabledMcpTools('space-1')).toBeNull()
  })
})
