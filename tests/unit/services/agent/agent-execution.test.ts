import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Emitter } from '../../../../src/main/platform/event'
import { registerAppBridge } from '../../../../src/main/services/app-bridge'
import type { RunTokenUsage } from '../../../../src/shared/apps/app-types'
import type {
  AgentExecutionOptions, AuthorizedInput, ExecutionEngineControl, ExecutionInputPort, ExecutionWorkHost, ExecutionWorkRequest,
} from '../../../../src/main/services/agent/execution'
import { ENGINE_STOP_GRACE_MS } from '../../../../src/main/services/agent/execution'

const settings = vi.hoisted(() => ({ enabled: true }))
vi.mock('../../../../src/main/services/agent/user-agent-settings', () => ({
  isCollaborationEnabled: (disabled?: readonly string[]) => settings.enabled && !disabled?.includes('Agent'),
}))

import { openAgentExecution } from '../../../../src/main/services/agent/execution'

const environment = { spaceId: 'space', spacePath: '/space', workDir: '/work', memoryDir: '/memory' }
const principal = { appId: 'app', permissions: { granted: [], denied: [] }, environment }
const tokens = (input: number, output = 0): RunTokenUsage =>
  ({ inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheCreationTokens: 0 })
const result = (input = 1, extra: Record<string, unknown> = {}) =>
  ({ type: 'result', usage: { input_tokens: input, output_tokens: 0 }, ...extra })
const grants = { engineId: 'halo' as const, collaborationEnabled: true, mcpServerNames: ['halo-report', 'halo-team'] }

/**
 * An engine session whose turns are scripted. Accepted live input is unread until
 * the next turn starts; `hold` keeps a turn open until it is released.
 */
function makeSession(cycles: unknown[][], hold?: Promise<void>) {
  let cycle = 0
  let unread = false
  return {
    send: vi.fn(),
    sendIntoLiveTurn: vi.fn((_message: string) => { unread = true; return true }),
    hasPendingInput: () => unread,
    streamCalls: () => cycle,
    stream() {
      const frames = cycles[cycle++] ?? []
      return (async function* () {
        unread = false
        for (const frame of frames) yield frame
        if (hold) await hold
      })()
    },
  }
}

function makeHost() {
  const state = {
    pending: false, ends: 0, usage: undefined as RunTokenUsage | undefined,
    requests: [] as ExecutionWorkRequest[], order: [] as string[],
  }
  const changed = new Emitter<void>()
  const host: ExecutionWorkHost = {
    open: request => {
      state.requests.push(request)
      return {
        tools: { 'halo-team': { name: 'team' } }, guidance: 'Delegate carefully.',
        hasPending: () => state.pending,
        onChanged: listener => changed.event(listener),
        end: async () => { state.ends++; state.order.push('end') },
        takeUsage: () => { state.order.push('usage'); const value = state.usage; state.usage = undefined; return value },
      }
    },
  }
  return { host, state, changed, settle() { state.pending = false; changed.fire() } }
}

function useHost(host: ExecutionWorkHost | undefined) {
  registerAppBridge({ getAppManager: () => null, createHaloAppsMcpServer: () => null, onMcpAppsChange: () => () => {}, executionWork: host })
}

function open(overrides: Partial<AgentExecutionOptions> = {}) {
  const controller = new AbortController()
  const execution = openAgentExecution({
    key: 'run-key', principal, modelSelection: { modelSourceId: 'source', modelId: 'model' },
    grants: () => grants, signal: controller.signal, ...overrides,
  })
  return { execution, controller }
}
const input = (text = '[Team] evidence'): AuthorizedInput =>
  ({ text, record: { content: 'evidence', provenance: { source: 'team-message', metadata: {} as any } } })
const reader = (seen: unknown[] = []) => ({ onMessage: (message: unknown) => { seen.push(message) } })
const inputPortOf = (state: { requests: ExecutionWorkRequest[] }): ExecutionInputPort => state.requests.at(-1)!.input
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

function engineControl(interrupt?: () => unknown, canInterrupt = true): ExecutionEngineControl & { interrupt: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  return { interrupt: vi.fn(interrupt ?? (() => {})), close: vi.fn(), canInterrupt }
}

beforeEach(() => { settings.enabled = true })
afterEach(() => useHost(undefined))

describe('an execution that delegates nothing', () => {
  it('sends once, reads one turn and finishes without owning anything', async () => {
    useHost(undefined)
    const { execution } = open()
    const session = makeSession([[{ type: 'assistant' }, result(5)]])
    execution.bind(session)
    const seen: unknown[] = []
    await execution.submit('hello', reader(seen))
    expect(session.send).toHaveBeenCalledTimes(1)
    expect(session.send).toHaveBeenCalledWith('hello')
    expect(session.streamCalls()).toBe(1)
    expect(seen).toHaveLength(2)
    expect(execution.tools).toEqual({})
    expect(execution.guidance).toBeUndefined()
    expect(execution.canComplete()).toBe(true)
    await execution.close()
    expect(execution.usage()).toEqual(tokens(5))
  })

  it('creates no member, request or subscription until work is delegated', async () => {
    const { host, state } = makeHost()
    useHost(host)
    const { execution } = open()
    execution.bind(makeSession([[result()]]))
    await execution.submit('hello', reader())
    await execution.close()
    expect(state.requests).toHaveLength(1)
    expect(state.ends).toBe(1)
  })
})

describe('delegated work that outlives the engine turn', () => {
  it('keeps reading until the work reports back, then finishes once it has settled', async () => {
    const { host, state, settle } = makeHost()
    useHost(host)
    state.pending = true
    const { execution } = open()
    const session = makeSession([[result(1)], [{ type: 'assistant' }, result(2)]])
    execution.bind(session)
    let finished = false
    const turn = execution.submit('review', reader()).then(() => { finished = true })
    await flush()
    expect(finished).toBe(false)
    expect(execution.canComplete()).toBe(false)

    expect(await inputPortOf(state).accept(input(), () => true)).toBe('mid_turn')
    settle()
    await turn
    expect(session.streamCalls()).toBe(2)
    expect(session.send).toHaveBeenCalledOnce()
    expect(execution.canComplete()).toBe(true)
    await execution.close()
    expect(execution.usage()).toEqual(tokens(3))
  })

  it('does not finish early when the report and the end of the work arrive together', async () => {
    const { host, state, settle } = makeHost()
    useHost(host)
    state.pending = true
    const { execution } = open()
    const session = makeSession([[result()], [result()]])
    const recorded = vi.fn()
    execution.bind(session, { record: recorded })
    const turn = execution.submit('review', reader())
    await flush()
    const accepted = inputPortOf(state).accept(input(), () => true)
    settle()
    expect(await accepted).toBe('mid_turn')
    await turn
    expect(session.streamCalls()).toBe(2)
    expect(session.sendIntoLiveTurn).toHaveBeenCalledOnce()
    expect(recorded).toHaveBeenCalledOnce()
  })

  it('stops waiting on owned work once the engine itself reported a failure', async () => {
    const { host, state } = makeHost()
    useHost(host)
    state.pending = true
    const { execution } = open()
    const session = makeSession([[result(1, { is_error: true })]])
    execution.bind(session)
    await execution.submit('review', reader())
    expect(session.streamCalls()).toBe(1)
  })

  it('reads the next turn when the session still holds unread input, with no owned work', async () => {
    const { execution } = open()
    const session = makeSession([[result()], [result()]])
    execution.bind(session)
    let typed = false
    await execution.submit('go', { onMessage: () => { if (!typed) { typed = true; session.sendIntoLiveTurn('typed meanwhile') } } })
    expect(session.streamCalls()).toBe(2)
  })

  it('surfaces an unreadable work state instead of calling the execution complete', async () => {
    const { host, state } = makeHost()
    useHost({ open: request => ({ ...host.open(request), hasPending: () => { throw new Error('runtime unavailable') } }) })
    const { execution } = open()
    execution.bind(makeSession([[result()]]))
    await expect(execution.submit('go', reader())).rejects.toThrow('runtime unavailable')
    expect(state.requests).toHaveLength(1)
  })
})

describe('input while the execution runs', () => {
  it('counts a person’s input through the session handle once and wakes a waiting execution', async () => {
    const { host, state, settle } = makeHost()
    useHost(host)
    state.pending = true
    const { execution } = open()
    const session = makeSession([[result()], [result()]])
    execution.bind(session)
    expect(execution.inputRevision).toBe(0)
    const turn = execution.submit('go', reader())
    await flush()
    expect(execution.session.sendIntoLiveTurn!('add this')).toBe(true)
    expect(execution.inputRevision).toBe(1)
    settle()
    await turn
    expect(session.streamCalls()).toBe(2)
    expect(execution.inputRevision).toBe(1)
  })

  it('does not count input the engine refused', () => {
    const { execution } = open()
    const session = makeSession([])
    session.sendIntoLiveTurn.mockReturnValueOnce(false)
    execution.bind(session)
    expect(execution.session.sendIntoLiveTurn!('late')).toBe(false)
    expect(execution.inputRevision).toBe(0)
  })

  it('falls back to a plain send between turns and records the input once, in order', async () => {
    const { host, state } = makeHost()
    useHost(host)
    const { execution } = open()
    const session = makeSession([])
    session.sendIntoLiveTurn.mockReturnValue(false)
    const order: string[] = []
    session.send.mockImplementation(async () => { order.push('send') })
    execution.bind(session, { record: () => { order.push('record') } })
    expect(await inputPortOf(state).accept(input(), () => true)).toBe('buffered')
    expect(order).toEqual(['send', 'record'])
    expect(execution.inputRevision).toBe(1)
  })

  it('discards input from a different authority without touching the session or deadlocking', async () => {
    const { host, state, settle } = makeHost()
    useHost(host)
    state.pending = true
    const { execution } = open()
    const session = makeSession([[result()]])
    execution.bind(session)
    const turn = execution.submit('go', reader())
    await flush()
    expect(await inputPortOf(state).accept(input(), () => false)).toBe('discarded')
    expect(session.sendIntoLiveTurn).not.toHaveBeenCalled()
    expect(execution.inputRevision).toBe(0)
    settle()
    await turn
  })

  it('drops queued input whose authority is withdrawn before its turn in the queue', async () => {
    const { host, state } = makeHost()
    useHost(host)
    const { execution } = open()
    const session = makeSession([])
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    session.sendIntoLiveTurn.mockReturnValue(false)
    session.send.mockImplementation(async () => { await held })
    execution.bind(session)
    let authorized = true
    const first = inputPortOf(state).accept(input('first'), () => true)
    const second = inputPortOf(state).accept(input('second'), () => authorized)
    expect(execution.canComplete()).toBe(false)
    authorized = false
    release()
    expect(await first).toBe('buffered')
    expect(await second).toBe('discarded')
    expect(session.send).toHaveBeenCalledOnce()
    expect(execution.canComplete()).toBe(true)
  })

  it('keeps a recording failure from replaying input the engine already accepted', async () => {
    const { host, state } = makeHost()
    useHost(host)
    const { execution } = open()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    execution.bind(makeSession([]), { record: () => { throw new Error('disk full') } })
    expect(await inputPortOf(state).accept(input(), () => true)).toBe('mid_turn')
    error.mockRestore()
  })

  it('admits nothing once the reader has ended the execution', async () => {
    const { host, state } = makeHost()
    useHost(host)
    const { execution } = open()
    const session = makeSession([[{ type: 'assistant' }, result()]])
    execution.bind(session)
    await execution.submit('go', { onMessage: () => 'stop' })
    expect(await inputPortOf(state).accept(input(), () => true)).toBe('discarded')
    expect(session.sendIntoLiveTurn).not.toHaveBeenCalled()
    expect(execution.mayDelegate()).toBe(false)
  })
})

describe('closing an execution', () => {
  it('closes admission first, ends what it holds once, and settles its usage after in-flight input', async () => {
    const { host, state } = makeHost()
    useHost(host)
    state.usage = tokens(4, 1)
    const { execution } = open()
    const session = makeSession([[result(2)]])
    session.sendIntoLiveTurn.mockReturnValue(false)
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    execution.bind(session)
    await execution.submit('go', reader())
    session.send.mockImplementation(async () => { state.order.push('send'); await held })
    const accepted = inputPortOf(state).accept(input(), () => true)
    await flush()
    const closing = execution.close()
    expect(state.ends).toBe(1)
    expect(await inputPortOf(state).accept(input(), () => true)).toBe('discarded')
    expect(execution.close()).toBe(closing)
    release()
    await accepted
    await closing
    expect(state.ends).toBe(1)
    expect(state.order).toEqual(['send', 'end', 'usage'])
    expect(execution.usage()).toEqual(tokens(6, 1))
  })

  it('ends what it holds and still settles usage when ending fails', async () => {
    const { host, state } = makeHost()
    useHost({ open: request => ({ ...host.open(request), end: async () => { throw new Error('end failed') } }) })
    state.usage = tokens(9)
    const { execution } = open()
    await expect(execution.close()).rejects.toThrow('end failed')
    expect(execution.usage()).toEqual(tokens(9))
  })

  it('does not interrupt the engine and does not wait for a message being read', async () => {
    const { host } = makeHost()
    useHost(host)
    const { execution } = open()
    const engine = engineControl()
    const gate = new Promise<void>(() => {})
    execution.bind(makeSession([[result()]], gate), { engine })
    void execution.submit('go', reader())
    await flush()
    await execution.close()
    expect(engine.interrupt).not.toHaveBeenCalled()
    expect(engine.close).not.toHaveBeenCalled()
  })

  it('refuses nothing for an execution closed before it started, and never sends', async () => {
    const { host, state } = makeHost()
    useHost(host)
    const { execution } = open()
    const session = makeSession([[result()]])
    execution.bind(session)
    await execution.close()
    await execution.submit('go', reader())
    expect(session.send).not.toHaveBeenCalled()
    expect(state.ends).toBe(1)
  })

  it('takes no input through the session handle once it has ended, but still reads what is unread', async () => {
    const { execution } = open()
    const session = makeSession([])
    execution.bind(session)
    const handle = execution.session
    expect(handle.sendIntoLiveTurn!('before')).toBe(true)
    await execution.close()
    expect(handle.sendIntoLiveTurn!('after')).toBe(false)
    expect(session.sendIntoLiveTurn).toHaveBeenCalledTimes(1)
    expect(() => handle.send('late')).toThrow(/no longer accepts input/)
    expect(session.send).not.toHaveBeenCalled()
    expect(handle.hasPendingInput!()).toBe(true)
  })

  it('does not let a closed execution’s input port reach a newer execution', async () => {
    const first = makeHost()
    useHost(first.host)
    const older = open()
    const olderSession = makeSession([])
    older.execution.bind(olderSession)
    const olderPort = inputPortOf(first.state)
    await older.execution.close()

    const second = makeHost()
    useHost(second.host)
    const newer = open()
    const newerSession = makeSession([])
    newer.execution.bind(newerSession)
    expect(await olderPort.accept(input(), () => true)).toBe('discarded')
    expect(newerSession.sendIntoLiveTurn).not.toHaveBeenCalled()
    expect(olderSession.sendIntoLiveTurn).not.toHaveBeenCalled()
    expect(newer.execution.inputRevision).toBe(0)
  })
})

describe('stopping an execution', () => {
  it('closes admission, interrupts the engine being read, ends what it owns, and resolves only once the read has ended', async () => {
    const { host, state } = makeHost()
    useHost(host)
    state.pending = true
    state.usage = tokens(3)
    const { execution } = open()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const engine = engineControl(() => { state.order.push('interrupt') })
    execution.bind(makeSession([[result(2)]], gate), { engine })
    const read = execution.submit('go', reader())
    await flush()

    let stopped = false
    const stopping = execution.stop().then(() => { stopped = true })
    expect(execution.mayDelegate()).toBe(false)
    await flush()
    expect(state.order).toEqual(expect.arrayContaining(['interrupt', 'end']))
    expect(stopped).toBe(false)

    release()
    await read
    await stopping
    expect(stopped).toBe(true)
    expect(engine.close).not.toHaveBeenCalled()
    expect(execution.usage()).toEqual(tokens(5))
  })

  it('is idempotent and reaches the engine once', async () => {
    const { host, state } = makeHost()
    useHost(host)
    const { execution } = open()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const engine = engineControl(() => { release() })
    execution.bind(makeSession([[result()]], gate), { engine })
    const read = execution.submit('go', reader())
    await flush()
    const first = execution.stop()
    expect(execution.stop()).toBe(first)
    await read
    await first
    expect(engine.interrupt).toHaveBeenCalledTimes(1)
    expect(state.ends).toBe(1)
  })

  it('leaves the engine alone when nothing is being read, and still ends what it owns', async () => {
    const { host, state } = makeHost()
    useHost(host)
    const { execution } = open()
    const engine = engineControl()
    execution.bind(makeSession([[result()]]), { engine })
    await execution.submit('go', reader())
    await execution.stop()
    expect(engine.interrupt).not.toHaveBeenCalled()
    expect(engine.close).not.toHaveBeenCalled()
    expect(state.ends).toBe(1)
  })

  it('closes the engine session when the interrupted turn does not end within the grace period', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { host } = makeHost()
      useHost(host)
      const { execution } = open()
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const engine = engineControl(() => new Promise(() => {}))
      engine.close.mockImplementation(() => release())
      execution.bind(makeSession([[result()]], gate), { engine })
      const read = execution.submit('go', reader())
      await vi.advanceTimersByTimeAsync(0)
      const stopping = execution.stop()
      await vi.advanceTimersByTimeAsync(0)
      expect(engine.interrupt).toHaveBeenCalledTimes(1)
      expect(engine.close).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(ENGINE_STOP_GRACE_MS)
      expect(engine.close).toHaveBeenCalledTimes(1)
      await read
      await stopping
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes at once an engine that cannot interrupt a turn', async () => {
    const { host } = makeHost()
    useHost(host)
    const { execution } = open()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const engine = engineControl(undefined, false)
    engine.close.mockImplementation(() => release())
    execution.bind(makeSession([[result()]], gate), { engine })
    const read = execution.submit('go', reader())
    await flush()
    const stopping = execution.stop()
    expect(engine.interrupt).not.toHaveBeenCalled()
    expect(engine.close).toHaveBeenCalledTimes(1)
    await read
    await stopping
  })

  it('treats aborting its signal as a stop, once, and never revives the execution', async () => {
    const { host, state } = makeHost()
    useHost(host)
    state.pending = true
    const { execution, controller } = open()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const engine = engineControl(() => { release() })
    const session = makeSession([[result()]], gate)
    execution.bind(session, { engine })
    const read = execution.submit('go', reader())
    await flush()
    controller.abort()
    await read
    await execution.close()
    expect(engine.interrupt).toHaveBeenCalledTimes(1)
    expect(state.ends).toBe(1)
    expect(execution.canComplete()).toBe(false)
    await execution.submit('again', reader())
    expect(session.send).toHaveBeenCalledTimes(1)
  })

  it('stops an execution aborted before it started: nothing is sent and what it owns is ended', async () => {
    const { host, state } = makeHost()
    useHost(host)
    const controller = new AbortController()
    controller.abort()
    const { execution } = open({ signal: controller.signal })
    const session = makeSession([[result()]])
    execution.bind(session)
    await execution.submit('go', reader())
    expect(session.send).not.toHaveBeenCalled()
    await execution.close()
    expect(state.ends).toBe(1)
  })

  it('ignores a stop that arrives after the execution was closed', async () => {
    const { host, state } = makeHost()
    useHost(host)
    const { execution, controller } = open()
    const engine = engineControl()
    execution.bind(makeSession([[result()]]), { engine })
    await execution.submit('go', reader())
    await execution.close()
    controller.abort()
    await flush()
    expect(engine.interrupt).not.toHaveBeenCalled()
    expect(state.ends).toBe(1)
  })
})

describe('what an execution tells its host', () => {
  it('passes the context its entry described, untouched', () => {
    const { host, state } = makeHost()
    useHost(host)
    const requester = { origin: 'guest' as const, delegation: { policy: { allowCollaboration: true }, mode: 'strict' as const } }
    const source = { kind: 'conversation' as const, requestId: 'request' }
    open({ key: 'chat', requester, source })
    expect(state.requests[0]).toMatchObject({
      key: 'chat', principal, requester, source, modelSelection: { modelSourceId: 'source', modelId: 'model' },
    })
  })

  it('is a headless run unless the entry says otherwise', () => {
    const { host, state } = makeHost()
    useHost(host)
    open()
    expect(state.requests[0].source).toEqual({ kind: 'run' })
  })

  it('reads the live grants when work is first delegated, not when the execution opened', () => {
    const { host, state } = makeHost()
    useHost(host)
    let current = grants
    open({ grants: () => current })
    current = { ...grants, mcpServerNames: ['halo-report', 'halo-team', 'ocr'] }
    expect(state.requests[0].grants().mcpServerNames).toEqual(['halo-report', 'halo-team', 'ocr'])
  })

  it('offers the host’s tools and guidance, which a conversation entry mounts without ever submitting', async () => {
    const { host, state } = makeHost()
    useHost(host)
    const { execution } = open({ source: { kind: 'conversation' } })
    expect(execution.tools).toEqual({ 'halo-team': { name: 'team' } })
    expect(execution.guidance).toBe('Delegate carefully.')
    expect(execution.canComplete()).toBe(true)
    await execution.close()
    expect(state.ends).toBe(1)
    expect(execution.usage()).toBeUndefined()
  })
})

describe('whether new work may be delegated', () => {
  it('is on by default and ruled out by the user, the digital human or the requester', () => {
    const { host } = makeHost()
    useHost(host)
    expect(open().execution.mayDelegate()).toBe(true)
    expect(open({ principal: { ...principal, disabledTools: ['Agent'] } }).execution.mayDelegate()).toBe(false)
    settings.enabled = false
    expect(open().execution.mayDelegate()).toBe(false)
    settings.enabled = true
    const strictNoGrant = { policy: { allowCollaboration: false }, mode: 'strict' as const }
    expect(open({ requester: { delegation: strictNoGrant } }).execution.mayDelegate()).toBe(false)
    expect(open({ requester: { delegation: { policy: { allowCollaboration: true }, mode: 'strict' } } }).execution.mayDelegate()).toBe(true)
    expect(open({ requester: { delegation: { policy: undefined, mode: 'strict' } } }).execution.mayDelegate()).toBe(false)
    expect(open({ requester: { delegation: { policy: undefined, mode: 'permissive' } } }).execution.mayDelegate()).toBe(true)
  })

  it('is judged live by the host’s request, and ends with the execution', async () => {
    const { host, state } = makeHost()
    useHost(host)
    const { execution } = open()
    expect(state.requests[0].isLive()).toBe(true)
    expect(state.requests[0].mayDelegate()).toBe(true)
    await execution.close()
    expect(state.requests[0].isLive()).toBe(false)
    expect(state.requests[0].mayDelegate()).toBe(false)
  })
})
