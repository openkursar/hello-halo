/**
 * An MCP server the engine failed to connect is never retried inside that
 * session, so the session manager rebuilds it — the same path an MCP toggle
 * takes, deferred past a running turn — once when the failure is reported and
 * once more when the server is seen connecting again. A server that keeps
 * failing in the engine cannot rebuild a conversation's session any further.
 * A tool call that finds its server gone mid-session counts as such a failure.
 */

import { describe, it, expect, vi, afterEach, afterAll } from 'vitest'

vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn(), trackErrorSurface: vi.fn() }
}))
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp'), getVersion: vi.fn(() => '0.0.0'), isPackaged: false }
}))
const { createSession } = vi.hoisted(() => ({ createSession: vi.fn() }))
vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  createSession,
  getActiveEngine: vi.fn(() => 'claude'),
}))
const { startConsumer } = vi.hoisted(() => ({ startConsumer: vi.fn() }))
vi.mock('../../../../src/main/services/agent/session-consumer', () => ({ startConsumer }))
vi.mock('../../../../src/main/services/agent/conversation-sink', () => ({ createConversationSink: vi.fn() }))
vi.mock('../../../../src/main/services/agent/mcp-auth-state', () => ({ purgeStaleMcpOAuth: vi.fn(async () => {}) }))
vi.mock('../../../../src/main/services/agent/events', () => ({ emitAgentEvent: vi.fn() }))
vi.mock('../../../../src/main/services/agent/reasoning-effort', () => ({ applySessionReasoningEffort: vi.fn(), pickReasoningEffort: vi.fn(() => undefined) }))
vi.mock('../../../../src/main/services/agent/knowledge-context', () => ({
  resolveConversationKnowledgeBases: vi.fn(() => []),
  resolveConversationKnowledgeBaseIds: vi.fn(() => []),
}))
vi.mock('../../../../src/main/services/agent/toolsets/broker', () => ({
  setSessionInvalidator: vi.fn(),
  buildCreationTimeServers: vi.fn(() => ({})),
}))
vi.mock('../../../../src/main/services/agent/toolsets/capability-index', () => ({ buildToolsetSection: vi.fn(() => '') }))
vi.mock('../../../../src/main/services/agent/toolsets/state', () => ({
  dropConversationState: vi.fn(),
  getOpenToolsets: vi.fn(() => []),
}))
vi.mock('../../../../src/main/services/api-ref', () => ({ HALO_API_TOOLSET_ID: 'halo-api-ref' }))
vi.mock('../../../../src/main/services/conversation.service', () => ({ getConversation: vi.fn(() => null) }))
vi.mock('../../../../src/main/services/health', () => ({
  registerProcess: vi.fn(),
  unregisterProcess: vi.fn(),
  getCurrentInstanceId: vi.fn(() => null),
}))
const { recovery } = vi.hoisted(() => ({ recovery: { listener: null as ((name: string) => void) | null } }))
vi.mock('../../../../src/main/services/agent/mcp-manager', () => ({
  onMcpServerRecovered: (listener: (name: string) => void) => {
    recovery.listener = listener
    return () => { recovery.listener = null }
  },
}))

import {
  getOrCreateV2Session,
  closeAllV2Sessions,
  closeV2Session,
  evictIdleSession,
  stopSessionCleanup,
  consumePendingRebuild,
  noteSessionMcpStatus,
  handleMcpAppsChange,
  v2Sessions,
} from '../../../../src/main/services/agent/session-manager'

function fakeSession() {
  return { query: { transport: { isReady: () => true, onExit: () => () => {} } }, close: vi.fn() }
}

interface ConsumerState { isRunning: boolean; turn: unknown }

/** Opens a session whose consumer the test controls: idle by default. */
async function open(conversationId: string, consumer: ConsumerState = { isRunning: true, turn: null }) {
  const session = fakeSession()
  createSession.mockResolvedValueOnce(session)
  startConsumer.mockReturnValueOnce({
    get isRunning() { return consumer.isRunning },
    getActiveSessionState: () => consumer.turn,
    getTeamLifecycleThoughts: () => [],
    hasRunningTasks: () => false,
    stop: vi.fn(),
  })
  await getOrCreateV2Session('space', conversationId, { systemPrompt: 'p', model: 'm' }, undefined, undefined, {} as never)
  return session
}

const init = (...servers: Array<[string, string]>) => ({
  type: 'system',
  subtype: 'init',
  mcp_servers: servers.map(([name, status]) => ({ name, status })),
})

const recovered = (name: string) => recovery.listener!(name)

afterEach(() => {
  closeAllV2Sessions()
  createSession.mockReset()
  startConsumer.mockReset()
  handleMcpAppsChange(null)
})

afterAll(() => {
  stopSessionCleanup()
})

describe('rebuild after an MCP server failed to connect', () => {
  it('rebuilds an idle session whose engine reported a server failed', async () => {
    const session = await open('conv')

    noteSessionMcpStatus('conv', session as never, init(['local', 'failed'], ['docs', 'connected']))

    expect(session.close).toHaveBeenCalled()
    expect(v2Sessions.has('conv')).toBe(false)
  })

  it('defers the rebuild until the running turn ends', async () => {
    const session = await open('conv', { isRunning: true, turn: { thoughts: [] } })

    noteSessionMcpStatus('conv', session as never, init(['local', 'failed']))

    expect(session.close).not.toHaveBeenCalled()
    expect(consumePendingRebuild('conv')).toBe(true)
  })

  it('keeps the second rebuild when the server recovers while the first is still pending', async () => {
    const consumer = { isRunning: true, turn: { thoughts: [] } as unknown }
    const first = await open('conv', consumer)
    noteSessionMcpStatus('conv', first as never, init(['local', 'failed']))

    recovered('local')
    expect(consumePendingRebuild('conv')).toBe(true)
    consumer.isRunning = false
    recovered('local')
    expect(first.close).not.toHaveBeenCalled()

    const second = await open('conv')
    expect(first.close).toHaveBeenCalled()
    noteSessionMcpStatus('conv', second as never, init(['local', 'failed']))
    recovered('local')
    expect(second.close).toHaveBeenCalled()
  })

  it('does not retry again when the rebuilt session still cannot connect', async () => {
    const first = await open('conv')
    noteSessionMcpStatus('conv', first as never, init(['local', 'failed']))

    const second = await open('conv')
    noteSessionMcpStatus('conv', second as never, init(['local', 'failed']))

    expect(second.close).not.toHaveBeenCalled()
    expect(v2Sessions.get('conv')?.session).toBe(second)
  })

  it('rebuilds once more when the server is seen connecting again, and no further', async () => {
    const first = await open('conv')
    noteSessionMcpStatus('conv', first as never, init(['local', 'failed']))
    const second = await open('conv')
    noteSessionMcpStatus('conv', second as never, init(['local', 'failed']))

    recovered('local')
    expect(second.close).toHaveBeenCalled()

    const third = await open('conv')
    noteSessionMcpStatus('conv', third as never, init(['local', 'failed']))
    recovered('local')
    expect(third.close).not.toHaveBeenCalled()
  })

  it('leaves sessions that could use the recovered server alone', async () => {
    const session = await open('conv')
    noteSessionMcpStatus('conv', session as never, init(['local', 'connected']))

    recovered('local')

    expect(session.close).not.toHaveBeenCalled()
  })

  it('starts over once the conversation connected the server', async () => {
    const first = await open('conv')
    noteSessionMcpStatus('conv', first as never, init(['local', 'failed']))
    const second = await open('conv')
    noteSessionMcpStatus('conv', second as never, init(['local', 'connected']))
    noteSessionMcpStatus('conv', second as never, init(['local', 'failed']))

    expect(second.close).toHaveBeenCalled()
  })

  it('gives every server a fresh retry after an MCP configuration change', async () => {
    const first = await open('conv')
    noteSessionMcpStatus('conv', first as never, init(['local', 'failed']))
    const second = await open('conv')
    noteSessionMcpStatus('conv', second as never, init(['local', 'failed']))

    handleMcpAppsChange('space')
    const third = await open('conv')
    noteSessionMcpStatus('conv', third as never, init(['local', 'failed']))

    expect(third.close).toHaveBeenCalled()
  })

  it('gives a conversation a fresh retry after its session was closed on purpose', async () => {
    const first = await open('conv')
    noteSessionMcpStatus('conv', first as never, init(['local', 'failed']))
    const second = await open('conv')
    noteSessionMcpStatus('conv', second as never, init(['local', 'failed']))

    closeV2Session('conv')
    const third = await open('conv')
    noteSessionMcpStatus('conv', third as never, init(['local', 'failed']))

    expect(third.close).toHaveBeenCalled()
  })

  it('starts over after a teardown the failure did not ask for', async () => {
    const first = await open('conv')
    noteSessionMcpStatus('conv', first as never, init(['local', 'failed']))
    const second = await open('conv')
    noteSessionMcpStatus('conv', second as never, init(['local', 'failed']))

    expect(evictIdleSession('conv', 'resident limit')).toBe(true)
    const third = await open('conv')
    noteSessionMcpStatus('conv', third as never, init(['local', 'failed']))

    expect(third.close).toHaveBeenCalled()
  })

  it('says once that a server still fails after its rebuild', async () => {
    const log = vi.spyOn(console, 'log')
    const first = await open('conv')
    noteSessionMcpStatus('conv', first as never, init(['local', 'failed']))
    const second = await open('conv')
    log.mockClear()

    noteSessionMcpStatus('conv', second as never, init(['local', 'failed']))
    noteSessionMcpStatus('conv', second as never, init(['local', 'failed']))

    const capped = log.mock.calls.filter(([line]) => String(line).includes('still failing after a rebuild'))
    expect(capped).toHaveLength(1)
    expect(String(capped[0][0])).toContain('local (rebuilds once more when seen connecting)')
    log.mockRestore()
  })

  it.each(['connected', 'pending', 'needs-auth'])('does nothing for a %s server', async (status) => {
    const session = await open('conv')

    noteSessionMcpStatus('conv', session as never, init(['local', status]))

    expect(session.close).not.toHaveBeenCalled()
    expect(v2Sessions.get('conv')?.failedMcpServers).toBeUndefined()
  })

  it('ignores frames other than an MCP status report', async () => {
    const session = await open('conv')

    noteSessionMcpStatus('conv', session as never, { type: 'stream_event', mcp_servers: [{ name: 'local', status: 'failed' }] })
    noteSessionMcpStatus('conv', session as never, { type: 'system', subtype: 'task_started' })
    noteSessionMcpStatus('conv', session as never, null)

    expect(session.close).not.toHaveBeenCalled()
  })

  it('ignores a report from a session that is no longer current', async () => {
    const current = await open('conv')

    noteSessionMcpStatus('conv', fakeSession() as never, init(['local', 'failed']))

    expect(current.close).not.toHaveBeenCalled()
    expect(v2Sessions.get('conv')?.failedMcpServers).toBeUndefined()
  })
})

/** A tool result frame as the engine emits it; the text is Claude Code CLI 2.1.89's. */
const toolResults = (...blocks: Array<{ is_error?: boolean; content: unknown }>) => ({
  type: 'user',
  message: { role: 'user', content: blocks.map((block, i) => ({ type: 'tool_result', tool_use_id: `toolu_${i}`, ...block })) },
  parent_tool_use_id: null,
})
const notConnected = (name: string) => ({ is_error: true, content: `MCP server "${name}" is not connected` })

describe('rebuild after a tool call found an MCP server gone mid-session', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('rebuilds the session before the next message once the turn that hit it ends', async () => {
    const consumer = { isRunning: true, turn: { thoughts: [] } as unknown }
    const first = await open('conv', consumer)
    noteSessionMcpStatus('conv', first as never, init(['local', 'connected']))

    noteSessionMcpStatus('conv', first as never, toolResults(notConnected('local'), notConnected('local')))

    expect(first.close).not.toHaveBeenCalled()
    expect(consumePendingRebuild('conv')).toBe(true)
    consumer.isRunning = false
    const second = await open('conv')
    expect(first.close).toHaveBeenCalled()
    expect(v2Sessions.get('conv')?.session).toBe(second)
  })

  it('recognizes the halo engine wording and text-block content', async () => {
    const session = await open('conv')
    noteSessionMcpStatus('conv', session as never, init(['local', 'connected']))

    noteSessionMcpStatus('conv', session as never,
      toolResults({ is_error: true, content: [{ type: 'text', text: 'MCP server "local" is not connected.' }] }))

    expect(session.close).toHaveBeenCalled()
  })

  it('does not rebuild again when the rebuilt session connects the server but its calls fail again soon', async () => {
    const first = await open('conv')
    noteSessionMcpStatus('conv', first as never, init(['local', 'connected']))
    noteSessionMcpStatus('conv', first as never, toolResults(notConnected('local')))
    expect(first.close).toHaveBeenCalled()

    const second = await open('conv')
    noteSessionMcpStatus('conv', second as never, init(['local', 'connected']))
    noteSessionMcpStatus('conv', second as never, toolResults(notConnected('local')))

    expect(second.close).not.toHaveBeenCalled()
    expect(v2Sessions.get('conv')?.session).toBe(second)
  })

  it('treats the server going away again later as a new outage', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const first = await open('conv')
    noteSessionMcpStatus('conv', first as never, init(['local', 'connected']))
    noteSessionMcpStatus('conv', first as never, toolResults(notConnected('local')))
    const second = await open('conv')
    noteSessionMcpStatus('conv', second as never, init(['local', 'connected']))

    now.mockReturnValue(1_000_000 + 5 * 60_000)
    noteSessionMcpStatus('conv', second as never, toolResults(notConnected('local')))

    expect(second.close).toHaveBeenCalled()
  })

  it('leaves a server still down at the rebuilt session to the existing retry: one more rebuild when seen connecting', async () => {
    const first = await open('conv')
    noteSessionMcpStatus('conv', first as never, init(['local', 'connected']))
    noteSessionMcpStatus('conv', first as never, toolResults(notConnected('local')))
    const second = await open('conv')

    noteSessionMcpStatus('conv', second as never, init(['local', 'failed']))
    expect(second.close).not.toHaveBeenCalled()

    recovered('local')
    expect(second.close).toHaveBeenCalled()
    const third = await open('conv')
    noteSessionMcpStatus('conv', third as never, init(['local', 'connected']))
    noteSessionMcpStatus('conv', third as never, toolResults(notConnected('local')))
    expect(third.close).toHaveBeenCalled()
  })

  it.each([
    ['another tool error', { is_error: true, content: 'MCP error -32000: Connection closed' }],
    ['the text in a successful result', { content: 'MCP server "local" is not connected' }],
    ['the text inside a longer error', { is_error: true, content: 'Error: MCP server "local" is not connected; retry later' }],
  ])('ignores %s', async (_label, block) => {
    const session = await open('conv')
    noteSessionMcpStatus('conv', session as never, init(['local', 'connected']))

    noteSessionMcpStatus('conv', session as never, toolResults(block))
    noteSessionMcpStatus('conv', session as never, { type: 'user', message: { role: 'user', content: 'MCP server "local" is not connected' } })

    expect(session.close).not.toHaveBeenCalled()
  })

  it('ignores a tool result from a session that is no longer current', async () => {
    const current = await open('conv')

    noteSessionMcpStatus('conv', fakeSession() as never, toolResults(notConnected('local')))

    expect(current.close).not.toHaveBeenCalled()
  })
})
