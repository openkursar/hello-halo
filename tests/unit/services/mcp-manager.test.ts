/**
 * Unit Tests: services/agent — MCP Manager
 *
 * Tests the groupToolsByMcpServer helper that parses flat SDK tool names
 * into per-server groups.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'

// Mock heavy dependencies that mcp-manager.ts imports transitively
vi.mock('../../../src/main/services/agent/resolved-sdk', () => ({
  query: vi.fn()
}))
vi.mock('../../../src/main/foundation/config.service', () => ({
  getConfig: vi.fn(() => ({})),
  getTempSpacePath: vi.fn(() => '/tmp'),
  onAgentConfigChange: vi.fn(() => () => {})
}))
vi.mock('../../../src/main/openai-compat-router', () => ({
  ensureOpenAICompatRouter: vi.fn(),
  encodeBackendConfig: vi.fn()
}))
vi.mock('../../../src/main/services/agent/helpers', () => ({
  getHeadlessElectronPath: vi.fn(),
  getApiCredentials: vi.fn(),
  getEnabledMcpServers: vi.fn(),
  getDbMcpServers: vi.fn(),
  inferOpenAIWireApi: vi.fn(),
  credentialsToBackendConfig: vi.fn()
}))
vi.mock('../../../src/main/services/agent/events', () => ({
  emitAgentBroadcast: vi.fn()
}))
vi.mock('../../../src/main/services/agent/sdk-config', () => ({
  getCleanUserEnv: vi.fn(() => ({})),
  resolveCredentialsForSdk: vi.fn()
}))
const { track } = vi.hoisted(() => ({ track: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track }
}))

import {
  broadcastMcpStatus,
  getCachedMcpStatus,
  groupToolsByMcpServer,
  onMcpServerRecovered,
  removeServerStatus,
  testMcpConnections,
  updateServerStatus
} from '../../../src/main/services/agent/mcp-manager'
import { getApiCredentials, getDbMcpServers } from '../../../src/main/services/agent/helpers'
import { query } from '../../../src/main/services/agent/resolved-sdk'
import type { ApiCredentials } from '../../../src/main/services/agent/types'

describe('groupToolsByMcpServer', () => {
  it('groups MCP tools by server name', () => {
    const tools = [
      'Read', 'Write', 'Edit', // built-in, no prefix
      'mcp__web-search__web_search',
      'mcp__web-search__news_search',
      'mcp__halo-apps__create_automation_app',
      'mcp__halo-apps__list_automation_apps',
    ]
    const grouped = groupToolsByMcpServer(tools)
    expect(grouped).toEqual({
      'web-search': ['web_search', 'news_search'],
      'halo-apps': ['create_automation_app', 'list_automation_apps'],
    })
  })

  it('handles single-tool servers', () => {
    const grouped = groupToolsByMcpServer(['mcp__my-server__do_stuff'])
    expect(grouped).toEqual({
      'my-server': ['do_stuff'],
    })
  })

  it('ignores built-in tools without mcp__ prefix', () => {
    const grouped = groupToolsByMcpServer(['Read', 'Write', 'Bash', 'Glob', 'Grep'])
    expect(grouped).toEqual({})
  })

  it('ignores malformed tool names', () => {
    const grouped = groupToolsByMcpServer([
      'mcp__',            // no server or tool
      'mcp__server',      // no tool separator
      'mcp____bad',       // empty server name (sepIdx is 0)
      'mcp__server__',    // empty tool name
    ])
    expect(grouped).toEqual({})
  })

  it('returns empty record for empty input', () => {
    expect(groupToolsByMcpServer([])).toEqual({})
  })

  it('preserves tool names with underscores', () => {
    const grouped = groupToolsByMcpServer([
      'mcp__ai-browser__browser_navigate_to',
      'mcp__ai-browser__browser_take_screenshot',
    ])
    expect(grouped).toEqual({
      'ai-browser': ['browser_navigate_to', 'browser_take_screenshot'],
    })
  })
})

// ============================================
// Two-producer status model
// ============================================

describe('MCP status derivation', () => {
  const entry = (name: string) => getCachedMcpStatus().find(s => s.name === name)

  afterEach(() => {
    for (const s of [...getCachedMcpStatus()]) removeServerStatus(s.name)
  })

  it('reports the probe verdict while no session has spoken', () => {
    updateServerStatus('srv', { status: 'connected', tools: ['ping'] })

    expect(entry('srv')).toMatchObject({
      status: 'connected',
      probeStatus: 'connected',
      tools: ['ping']
    })
    expect(entry('srv')?.sessionStatus).toBeUndefined()
  })

  it('lets a session verdict outrank a passing probe instead of being overwritten by it', () => {
    updateServerStatus('srv', { status: 'connected', tools: ['ping'] })
    broadcastMcpStatus([{ name: 'srv', status: 'needs-auth' }])

    expect(entry('srv')).toMatchObject({
      status: 'needs-auth',
      probeStatus: 'connected',
      sessionStatus: 'needs-auth'
    })
  })

  it('drops the session verdict once a probe reconnects', () => {
    broadcastMcpStatus([{ name: 'srv', status: 'needs-auth' }])
    updateServerStatus('srv', { status: 'connected', tools: ['ping'] })

    expect(entry('srv')?.status).toBe('connected')
    expect(entry('srv')?.sessionStatus).toBeUndefined()
  })

  it('drops a stale session success when a fresh probe fails', () => {
    broadcastMcpStatus([{ name: 'srv', status: 'connected' }], ['mcp__srv__ping'])
    updateServerStatus('srv', { status: 'failed', errorDetail: 'ECONNREFUSED' })

    expect(entry('srv')).toMatchObject({
      status: 'failed',
      probeStatus: 'failed',
      errorDetail: 'ECONNREFUSED'
    })
    expect(entry('srv')?.sessionStatus).toBeUndefined()
  })

  it('keeps the session verdict when the probe also fails', () => {
    broadcastMcpStatus([{ name: 'srv', status: 'needs-auth' }])
    updateServerStatus('srv', { status: 'failed', errorDetail: 'ECONNREFUSED' })

    expect(entry('srv')).toMatchObject({
      status: 'needs-auth',
      probeStatus: 'failed',
      sessionStatus: 'needs-auth',
      errorDetail: 'ECONNREFUSED'
    })
  })

  it('preserves a probe verdict across session reports', () => {
    updateServerStatus('srv', { status: 'failed', errorDetail: 'ECONNREFUSED' })
    broadcastMcpStatus([{ name: 'srv', status: 'connected' }], ['mcp__srv__ping'])

    expect(entry('srv')).toMatchObject({
      status: 'connected',
      probeStatus: 'failed',
      sessionStatus: 'connected',
      tools: ['ping']
    })
  })

  it('leaves servers absent from a session report untouched', () => {
    updateServerStatus('other-space', { status: 'connected' })
    broadcastMcpStatus([{ name: 'srv', status: 'failed' }])

    expect(entry('other-space')?.status).toBe('connected')
  })
})

describe('MCP recovery notifications', () => {
  const recovered = vi.fn()
  let unsubscribe: () => void = () => {}

  afterEach(() => {
    unsubscribe()
    recovered.mockReset()
    for (const s of [...getCachedMcpStatus()]) removeServerStatus(s.name)
  })

  function listen(): void {
    unsubscribe = onMcpServerRecovered(recovered)
  }

  it('reports a failed server that a probe then connects', () => {
    broadcastMcpStatus([{ name: 'srv', status: 'failed' }])
    listen()

    updateServerStatus('srv', { status: 'connected' })

    expect(recovered).toHaveBeenCalledTimes(1)
    expect(recovered).toHaveBeenCalledWith('srv')
  })

  it('reports a failed server that another session connects, after the cache is updated', () => {
    broadcastMcpStatus([{ name: 'srv', status: 'failed' }])
    let statusSeen: string | undefined
    recovered.mockImplementation(() => {
      statusSeen = getCachedMcpStatus().find(s => s.name === 'srv')?.status
    })
    listen()

    broadcastMcpStatus([{ name: 'srv', status: 'connected' }, { name: 'down', status: 'failed' }])

    expect(recovered.mock.calls).toEqual([['srv']])
    expect(statusSeen).toBe('connected')
  })

  it('stays quiet while a server keeps its status or fails', () => {
    broadcastMcpStatus([{ name: 'srv', status: 'connected' }])
    listen()

    broadcastMcpStatus([{ name: 'srv', status: 'connected' }])
    updateServerStatus('srv', { status: 'connected' })
    updateServerStatus('srv', { status: 'failed', errorDetail: 'ECONNREFUSED' })

    expect(recovered).not.toHaveBeenCalled()
  })

  it('stops reporting after unsubscribe', () => {
    broadcastMcpStatus([{ name: 'srv', status: 'failed' }])
    listen()
    unsubscribe()

    updateServerStatus('srv', { status: 'connected' })

    expect(recovered).not.toHaveBeenCalled()
  })
})

// ============================================
// testMcpConnections() telemetry
// ============================================

describe('testMcpConnections telemetry', () => {
  const credentialsMock = getApiCredentials as ReturnType<typeof vi.fn>

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('forwards the captured account and capabilities to the query without reconstructing them', async () => {
    vi.useFakeTimers()
    const credentials: ApiCredentials = {
      provider: 'anthropic', sourceId: 'account-a', credentialsGeneration: 'captured-a',
      baseUrl: 'https://example.invalid/v1/messages', apiKey: 'test-account-a', model: 'test-model-a',
      customHeaders: { 'x-account-id': 'account-a' }, supportsVision: false,
      capabilities: { contextWindow: 100_000, maxOutputTokens: 64_000, maxOutputTokensConfigured: true },
    }
    credentialsMock.mockResolvedValue(credentials)
    vi.mocked(getDbMcpServers).mockReturnValue({ srv: { type: 'stdio', command: 'test-mcp' } })
    vi.mocked(query).mockImplementation(async function* () {
      yield { type: 'system', mcp_servers: [{ name: 'srv', status: 'connected' }] }
    })
    try {
      expect(await testMcpConnections()).toMatchObject({ success: true, servers: [{ name: 'srv', status: 'connected' }] })
      expect(credentialsMock).toHaveBeenCalledTimes(1)
      const options = vi.mocked(query).mock.calls[0][0].options
      expect(options.apiCredentials).toBe(credentials)
      expect(options.credentialsGeneration).toBe('captured-a')
    } finally {
      removeServerStatus('srv')
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('does not report any event when no API key is configured', async () => {
    credentialsMock.mockResolvedValue({ apiKey: '', provider: 'anthropic' })

    const result = await testMcpConnections()

    expect(result).toMatchObject({ success: false, servers: [] })
    expect(track).not.toHaveBeenCalled()
  })

  it('does not re-report the cached result when a test is already in progress', async () => {
    // Held open until the test explicitly resolves it, so the first call
    // stays "in progress" while the second call arrives concurrently.
    let releaseFirstCall: (() => void) | undefined
    credentialsMock.mockImplementation(
      () => new Promise(resolve => { releaseFirstCall = () => resolve({ apiKey: '', provider: 'anthropic' }) })
    )

    const firstCall = testMcpConnections()
    const secondCall = await testMcpConnections()

    // The concurrent guard must return before touching the credentials
    // resolver at all, so this call never emits telemetry — reporting here
    // would re-count whatever the still-running first call eventually finds.
    expect(secondCall).toMatchObject({ success: false, error: 'Test already in progress' })
    expect(track).not.toHaveBeenCalled()

    releaseFirstCall?.()
    await firstCall
  })
})
