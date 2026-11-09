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
  app: { getPath: vi.fn(() => '/tmp'), getAppPath: vi.fn(() => '/tmp/halo-test-app'), getVersion: vi.fn(() => '0.0.0'), isPackaged: false }
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
const { toolsetRebuild } = vi.hoisted(() => ({ toolsetRebuild: { listener: null as ((id: string) => void) | null } }))
vi.mock('../../../../src/main/services/agent/toolsets/broker', () => ({
  setSessionInvalidator: (listener: (id: string) => void) => { toolsetRebuild.listener = listener },
  buildCreationTimeServers: vi.fn(() => ({})),
  publishToolsetContextMode: vi.fn(),
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
  acquireV2Session,
  closeAllV2Sessions,
  closeV2Session,
  evictIdleSession,
  stopSessionCleanup,
  consumePendingRebuild,
  noteSessionMcpStatus,
  handleMcpAppsChange,
  invalidateAllSessions,
  invalidateImSessions,
  registerActiveSession,
  unregisterActiveSession,
  createSessionState,
  markTurnDispatched,
  markTurnInitReceived,
  activeSessions,
  v2Sessions,
} from '../../../../src/main/services/agent/session-manager'
import { sendIntoLiveTurn } from '../../../../src/main/services/agent/live-turn'
import { markInstalledMcpContext } from '../../../../src/main/services/agent/tool-discovery'
import type { InstalledApp } from '../../../../src/shared/apps/app-types'
import { applyCapabilityPolicy } from '../../../../src/main/apps/runtime/capability-policy'
import { buildImSessionKey } from '../../../../src/shared/apps/im-keys'

function fakeSession() {
  return {
    query: { transport: { isReady: () => true, onExit: () => () => {} } },
    sendIntoLiveTurn: vi.fn((_message: unknown) => true),
    close: vi.fn(),
  }
}

interface ConsumerState { isRunning: boolean; turn: unknown }

/** Opens a session whose consumer the test controls: idle by default. */
async function open(conversationId: string, consumer: ConsumerState = { isRunning: true, turn: null },
  engineId?: string, spaceId = 'space', options: Record<string, any> = {}) {
  const session = fakeSession()
  createSession.mockResolvedValueOnce(session)
  startConsumer.mockReturnValueOnce({
    get isRunning() { return consumer.isRunning },
    getActiveSessionState: () => consumer.turn,
    getTeamLifecycleThoughts: () => [],
    stop: vi.fn(),
  })
  await getOrCreateV2Session(spaceId, conversationId, { ...options, systemPrompt: 'p', model: 'm', ...(engineId ? { engineId } : {}) }, undefined, undefined, {} as never)
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
  activeSessions.clear()
  createSession.mockReset()
  startConsumer.mockReset()
  handleMcpAppsChange(null)
})

afterAll(() => {
  stopSessionCleanup()
})

describe('MCP context preference changes', () => {
  const server = (appId: string) => markInstalledMcpContext({ command: 'fixture' }, { id: appId, spec: { type: 'mcp' }, userOverrides: {} } as InstalledApp)
  const contextOptions = () => ({ mcpServers: { customer: server('installed') } })
  const change = { appId: 'installed', specId: 'customer', action: 'context' as const }

  it('rebuilds only Halo sessions in the changed scope', async () => {
    const halo = await open('halo', undefined, 'halo', 'space', contextOptions())
    const otherSpace = await open('other-space', undefined, 'halo', 'elsewhere', contextOptions())
    const cc = await open('cc', undefined, 'anthropic', 'space', contextOptions())
    const codex = await open('codex', undefined, 'codex', 'space', contextOptions())
    const dsh = await open('dsh', undefined, 'dsh', 'space', contextOptions())
    handleMcpAppsChange('space', change)
    expect(halo.close).toHaveBeenCalledOnce()
    for (const session of [otherSpace, cc, codex, dsh]) expect(session.close).not.toHaveBeenCalled()
    handleMcpAppsChange(null, change)
    expect(otherSpace.close).toHaveBeenCalledOnce()
    for (const session of [cc, codex, dsh]) expect(session.close).not.toHaveBeenCalled()
  })

  it('keeps the running turn accepting input and applies the new preference at its safe boundary', async () => {
    const session = await open('halo-live', { isRunning: true, turn: { thoughts: [] } }, 'halo', 'space', contextOptions())
    handleMcpAppsChange('space', change)
    expect(session.close).not.toHaveBeenCalled()
    expect(sendIntoLiveTurn('halo-live', 'additional instruction', undefined, { onWithdrawn: () => {} })).toBe(true)
    expect(session.sendIntoLiveTurn).toHaveBeenCalledOnce()
    expect(consumePendingRebuild('halo-live')).toBe(true)
  })

  it.each(['halo', 'codex'])('handles an %s session still being created', async engineId => {
    let finish!: (session: ReturnType<typeof fakeSession>) => void
    const preparing = new Promise<ReturnType<typeof fakeSession>>(resolve => { finish = resolve })
    createSession.mockImplementationOnce(() => preparing)
    startConsumer.mockReturnValueOnce({
      isRunning: true, getActiveSessionState: () => null,
      getTeamLifecycleThoughts: () => [], stop: vi.fn(),
    })
    const pending = getOrCreateV2Session('space', 'preparing', { ...contextOptions(), engineId, systemPrompt: 'p', model: 'm' }, undefined, undefined, {} as never)
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledOnce())
    handleMcpAppsChange('space', change)
    const session = fakeSession()
    finish(session)
    await pending
    expect(session.close).not.toHaveBeenCalled()
    expect(consumePendingRebuild('preparing')).toBe(engineId === 'halo')
  })

  it('matches exact installations, including a space override, and excludes explicit XML/JSON sessions', async () => {
    const native = await open('native', undefined, 'halo', 'space', contextOptions())
    const overridden = await open('overridden', undefined, 'halo', 'space', { mcpServers: { customer: server('space-override') } })
    const unrelated = await open('unrelated', undefined, 'halo', 'space', { mcpServers: { records: server('other-installation') } })
    const xml = await open('xml', undefined, 'halo', 'space', { ...contextOptions(), toolCallingMode: 'xml' })
    const json = await open('json', undefined, 'halo', 'space', { ...contextOptions(), toolCallingMode: 'json' })
    handleMcpAppsChange(null, change)
    expect(native.close).toHaveBeenCalledOnce()
    for (const session of [overridden, unrelated, xml, json]) expect(session.close).not.toHaveBeenCalled()
    handleMcpAppsChange('space', { ...change, appId: 'space-override' })
    expect(overridden.close).toHaveBeenCalledOnce()
    expect(unrelated.close).not.toHaveBeenCalled()
  })

  it('tracks the final MCP pool after a borrowed app-chat policy removes a service', async () => {
    const offered = { allowed: server('installed'), withheld: server('not-granted') }
    const options: Record<string, any> = { mcpServers: offered }
    applyCapabilityPolicy(options, { policy: { allowedTools: [], allowedUserMcp: ['allowed'] }, mode: 'strict', mcpServers: offered, dbMcpServers: offered })
    const session = await open('borrowed', undefined, 'halo', 'space', options)
    expect([...v2Sessions.get('borrowed')!.mcpContextAppIds!]).toEqual(['installed'])
    handleMcpAppsChange('space', { ...change, appId: 'not-granted' })
    expect(session.close).not.toHaveBeenCalled()
    handleMcpAppsChange('space', change)
    expect(session.close).toHaveBeenCalledOnce()
  })

  it.each([false, true])('narrows a materialized in-flight pool (lazy=%s)', async lazy => {
    let finish!: (session: ReturnType<typeof fakeSession>) => void
    const preparing = new Promise<ReturnType<typeof fakeSession>>(resolve => { finish = resolve })
    createSession.mockImplementationOnce(() => preparing)
    const mounted = { unrelated: server('other-installation') }
    const pending = getOrCreateV2Session('space', 'prepared-pool', { engineId: 'halo', ...(lazy ? {} : { mcpServers: mounted }) },
      undefined, undefined, undefined, undefined, lazy ? () => mounted : undefined)
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledOnce())
    handleMcpAppsChange('space', change)
    const session = fakeSession()
    finish(session)
    await pending
    expect(session.close).not.toHaveBeenCalled()
    expect(consumePendingRebuild('prepared-pool')).toBe(false)
    expect([...v2Sessions.get('prepared-pool')!.mcpContextAppIds!]).toEqual(['other-installation'])
  })

  it('conservatively defers a native creation whose lazy server pool is not yet materialized', async () => {
    let release!: () => void
    let entered!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const session = fakeSession()
    createSession.mockImplementationOnce(async (options, prepare) => {
      entered()
      await hold
      await prepare({ signal: options.abortController.signal })
      return session
    })
    const pending = getOrCreateV2Session('space', 'unmaterialized', { engineId: 'halo' }, undefined, undefined, undefined, undefined,
      () => ({ customer: server('installed') }), undefined, { toolsetInstructions: () => '' })
    await started
    handleMcpAppsChange('space', change)
    release()
    await pending
    expect(consumePendingRebuild('unmaterialized')).toBe(true)
  })
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

  it('keeps live input available while a recovered server waits for a safe rebuild', async () => {
    const first = await open('conv')
    noteSessionMcpStatus('conv', first as never, init(['local', 'failed']))
    const consumer: ConsumerState = { isRunning: true, turn: null }
    const second = await open('conv', consumer)
    noteSessionMcpStatus('conv', second as never, init(['local', 'failed']))
    consumer.turn = { thoughts: [] }

    recovered('local')

    expect(second.close).not.toHaveBeenCalled()
    expect(sendIntoLiveTurn('conv', 'recovery update', undefined, { onWithdrawn: () => {} })).toBe(true)
    expect(second.sendIntoLiveTurn.mock.calls.map((call: any[]) => call[0])).toEqual(['recovery update'])
    expect(consumePendingRebuild('conv')).toBe(true)
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

describe.each(['consumer', 'legacy'] as const)('live input during MCP reconnect (%s)', (lifecycle) => {
  async function openRunning(conversationId: string) {
    const session = await open(conversationId, {
      isRunning: true, turn: lifecycle === 'consumer' ? { thoughts: [] } : null,
    })
    if (lifecycle === 'legacy') {
      registerActiveSession(conversationId, createSessionState('space', conversationId, new AbortController()))
    }
    return session
  }

  it('delivers into the running session without cancelling its deferred reconnect', async () => {
    const session = await openRunning('conv')
    noteSessionMcpStatus('conv', session as never, init(['local', 'failed']))

    expect(sendIntoLiveTurn('conv', 'teammate update', undefined, { onWithdrawn: () => {} })).toBe(true)
    expect(session.sendIntoLiveTurn.mock.calls.map((call: any[]) => call[0])).toEqual(['teammate update'])
    expect(session.close).not.toHaveBeenCalled()
    if (lifecycle === 'consumer') {
      expect(consumePendingRebuild('conv')).toBe(true)
    } else {
      unregisterActiveSession('conv')
      expect(session.close).toHaveBeenCalledOnce()
      expect(v2Sessions.has('conv')).toBe(false)
    }
  })

  describe.each([
    { name: 'API configuration', invalidate: (_id: string) => invalidateAllSessions() },
    { name: 'MCP configuration', invalidate: (_id: string) => handleMcpAppsChange('space') },
    { name: 'IM permissions', invalidate: (_id: string) => invalidateImSessions() },
    { name: 'toolset selection', invalidate: (id: string) => toolsetRebuild.listener!(id) },
  ])('$name changes', ({ invalidate }) => {
    it.each(['before', 'after'] as const)('still joins the running turn and rebuilds after it when configuration changes %s the MCP failure', async (order) => {
      const id = buildImSessionKey('app', 'wecom-bot', 'direct', 'chat')
      const session = await openRunning(id)
      if (order === 'before') invalidate(id)
      noteSessionMcpStatus(id, session as never, init(['local', 'failed']))
      if (order === 'after') invalidate(id)

      // The running turn keeps the permissions it started with; an addition
      // joins it, exactly as before live delivery. The new envelope applies
      // from the next turn's session.
      expect(sendIntoLiveTurn(id, 'addition during the turn', undefined, { onWithdrawn: () => {} })).toBe(true)
      expect(session.sendIntoLiveTurn.mock.calls.map((call: any[]) => call[0])).toEqual(['addition during the turn'])
      expect(session.close).not.toHaveBeenCalled()

      if (lifecycle === 'legacy') {
        unregisterActiveSession(id)
        expect(session.close).toHaveBeenCalledOnce()
      } else {
        expect(consumePendingRebuild(id)).toBe(true)
        closeV2Session(id)
      }
      const replacement = await openRunning(id)
      expect(sendIntoLiveTurn(id, 'fresh session', undefined, { onWithdrawn: () => {} })).toBe(true)
      expect(replacement.sendIntoLiveTurn.mock.calls.map((call: any[]) => call[0])).toEqual(['fresh session'])
    })
  })
})

describe('acquisition while an MCP reconnect is pending', () => {
  it('does not treat a failure reported before turn init as a configuration change', async () => {
    const consumer: ConsumerState = { isRunning: true, turn: null }
    const session = await open('conv', consumer)
    markTurnDispatched('conv')
    noteSessionMcpStatus('conv', session as never, init(['local', 'failed']))
    expect(session.close).not.toHaveBeenCalled()
    expect(consumePendingRebuild('conv')).toBe(false)

    consumer.turn = { thoughts: [] }
    markTurnInitReceived('conv')
    expect(sendIntoLiveTurn('conv', 'startup update', undefined, { onWithdrawn: () => {} })).toBe(true)
    expect(session.sendIntoLiveTurn.mock.calls.map((call: any[]) => call[0])).toEqual(['startup update'])
    expect(consumePendingRebuild('conv')).toBe(true)
  })

  it('keeps joining the running turn when reuse defers a rebuild for changed session options', async () => {
    const session = await open('conv', { isRunning: true, turn: { thoughts: [] } })
    noteSessionMcpStatus('conv', session as never, init(['local', 'failed']))

    await getOrCreateV2Session('space', 'conv', { systemPrompt: 'changed', model: 'm' }, undefined, undefined, {} as never)

    expect(sendIntoLiveTurn('conv', 'addition', undefined, { onWithdrawn: () => {} })).toBe(true)
    expect(session.sendIntoLiveTurn.mock.calls.map((call: any[]) => call[0])).toEqual(['addition'])
    expect(session.close).not.toHaveBeenCalled()
    expect(consumePendingRebuild('conv')).toBe(true)
  })

  it('allows live additions and rebuilds before the next turn', async () => {
    const consumer: ConsumerState = { isRunning: true, turn: { thoughts: [] } }
    const first = await open('conv', consumer)
    noteSessionMcpStatus('conv', first as never, init(['local', 'failed']))
    const second = fakeSession()
    createSession.mockResolvedValueOnce(second)
    startConsumer.mockReturnValueOnce({
      isRunning: true, getActiveSessionState: () => null,
      getTeamLifecycleThoughts: () => [], stop: vi.fn(),
    })
    expect(sendIntoLiveTurn('conv', 'still working', undefined, { onWithdrawn: () => {} })).toBe(true)
    expect(first.sendIntoLiveTurn.mock.calls.map((call: any[]) => call[0])).toEqual(['still working'])
    consumer.turn = null
    expect(consumePendingRebuild('conv')).toBe(true)
    consumer.isRunning = false

    const lease = await acquireV2Session('space', 'conv', { systemPrompt: 'p', model: 'm' }, undefined, undefined, {} as never)
    try {
      expect(lease.session).toBe(second)
      expect(first.close).toHaveBeenCalledOnce()
    } finally {
      lease.release()
    }
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
    expect(sendIntoLiveTurn('conv', 'continue without that server', undefined, { onWithdrawn: () => {} })).toBe(true)
    expect(first.sendIntoLiveTurn.mock.calls.map((call: any[]) => call[0])).toEqual(['continue without that server'])
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
