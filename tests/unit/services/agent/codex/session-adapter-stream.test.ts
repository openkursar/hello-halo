/**
 * Unit Tests: services/agent/codex — Session adapter stream() per-turn contract
 *
 * Halo's session-consumer expects `stream()` to return after each turn's
 * `result` frame. If stream() blocks waiting for "the next event" past the
 * result, the consumer's `for await` loop never exits, processStream never
 * resolves, the consumer's outer `while` never emits `agent:complete`, and
 * the renderer stays stuck in the "Thinking…" state forever — the visible smoke
 * regression we hit in production.
 *
 * This test directly drives the per-turn contract by reaching into the
 * adapter's notification plumbing (without spawning the codex binary) and
 * asserts:
 *
 *   1. stream() yields each pushed frame in order.
 *   2. stream() returns done=true immediately after a `result` frame.
 *   3. A second stream() invocation drains subsequent frames (cross-turn
 *      queue persistence).
 *   4. The terminal frame check is on `type === 'result'` specifically,
 *      not on any other type.
 */

import { describe, expect, it, vi } from 'vitest'

// Newly reachable via ai-sources/manager.ts or mcp-manager.ts pulling in
// analytics.service.ts (which statically imports providers/baidu.ts's
// `BrowserWindow` from 'electron') — mock it out like every other test that
// touches this transitive chain, so this file's own module graph controls
// what it needs rather than the real telemetry provider stack.
vi.mock('../../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn(), trackErrorSurface: vi.fn() }
}))

import { CodexAppServerSession } from '../../../../../src/main/services/agent/codex/session-adapter'

function makeAdapter(): CodexAppServerSession {
  const Ctor = CodexAppServerSession as unknown as new (
    options: any, sessionId: string, opts: any,
  ) => CodexAppServerSession
  return new Ctor(
    {
      env: {}, cwd: '/tmp', model: 'm', displayModel: 'm',
      threadParams: {}, mcpServers: {},
    },
    'session-id',
    { spaceId: undefined, conversationId: undefined, resume: undefined },
  )
}

/** Reach into the adapter's private push helper for testing. */
function push(adapter: any, msg: any): void {
  adapter.notificationQueue.push(msg)
  for (const w of adapter.notificationWaiters.splice(0)) w()
}

async function collectUntilDone(iter: AsyncIterator<any>): Promise<any[]> {
  const out: any[] = []
  while (true) {
    const { value, done } = await iter.next()
    if (done) return out
    out.push(value)
  }
}

describe('CodexAppServerSession.stream() per-turn contract', () => {
  it('yields all events of a turn in order, then returns on result', async () => {
    const a = makeAdapter()
    const iter = a.stream()[Symbol.asyncIterator]()

    // Pre-fill the queue with a complete turn worth of events.
    push(a, { type: 'system', subtype: 'init', session_id: 'x' })
    push(a, { type: 'stream_event', event: { type: 'message_start' } })
    push(a, { type: 'stream_event', event: { type: 'content_block_delta' } })
    push(a, { type: 'stream_event', event: { type: 'message_stop' } })
    push(a, { type: 'result', subtype: 'success' })

    const out = await collectUntilDone(iter)
    expect(out.map((m) => m.type)).toEqual([
      'system', 'stream_event', 'stream_event', 'stream_event', 'result',
    ])
  })

  it('REGRESSION: returns done=true IMMEDIATELY after the result frame', async () => {
    // The smoke regression: stream() that loops past `result` blocks
    // processStream forever, leaving the UI in the "Thinking…" state.
    const a = makeAdapter()
    const iter = a.stream()[Symbol.asyncIterator]()

    push(a, { type: 'result', subtype: 'success' })
    // Push something AFTER result to verify it doesn't get yielded in this
    // turn — it must wait for the next stream() invocation.
    push(a, { type: 'should-not-appear-this-turn' })

    const first = await iter.next()
    expect(first.done).toBe(false)
    expect(first.value).toMatchObject({ type: 'result' })

    const second = await iter.next()
    expect(second.done).toBe(true)
    expect(second.value).toBeUndefined()
  })

  it('cross-turn queue persistence: a second stream() drains leftover frames', async () => {
    const a = makeAdapter()

    // Turn 1: simple, ends with result.
    push(a, { type: 'result', subtype: 'success' })
    // Turn 2 frames pre-staged before the consumer asks for them.
    push(a, { type: 'system', subtype: 'init', session_id: 'turn2' })
    push(a, { type: 'result', subtype: 'success' })

    const turn1 = await collectUntilDone(a.stream()[Symbol.asyncIterator]())
    expect(turn1.map((m) => m.type)).toEqual(['result'])

    const turn2 = await collectUntilDone(a.stream()[Symbol.asyncIterator]())
    expect(turn2.map((m) => m.type)).toEqual(['system', 'result'])
  })

  it('intermediate non-result frames do NOT terminate the iterator', async () => {
    // Only `result` is terminal. system, stream_event, user, assistant
    // must all flow through without ending the iterator early.
    const a = makeAdapter()
    const iter = a.stream()[Symbol.asyncIterator]()

    push(a, { type: 'system', subtype: 'init' })
    const r1 = await iter.next()
    expect(r1.done).toBe(false)
    expect(r1.value.type).toBe('system')

    push(a, { type: 'stream_event', event: { type: 'message_start' } })
    const r2 = await iter.next()
    expect(r2.done).toBe(false)
    expect(r2.value.type).toBe('stream_event')

    push(a, { type: 'assistant', message: { role: 'assistant', content: [] } })
    const r3 = await iter.next()
    expect(r3.done).toBe(false)
    expect(r3.value.type).toBe('assistant')

    push(a, { type: 'result', subtype: 'success' })
    const r4 = await iter.next()
    expect(r4.done).toBe(false)
    expect(r4.value.type).toBe('result')

    const r5 = await iter.next()
    expect(r5.done).toBe(true)
  })
})

describe('Codex live input', () => {
  function wiredAdapter() {
    const adapter = makeAdapter() as any
    const handlers = new Map<string, (params: any) => void>()
    const request = vi.fn(async (_method: string, _params: any): Promise<any> => ({ turn: { id: 'turn-1' } }))
    adapter.threadId = 'thread-1'
    adapter.rpc = { request, isOpen: () => true, onNotification: (name: string, handler: (params: any) => void) => handlers.set(name, handler) }
    adapter.connection = { isAlive: () => true }
    adapter.subscribeNotifications(adapter.rpc)
    return { adapter, request, handlers }
  }

  async function flush() {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }

  it('steers the current turn without resetting its output state and batches ordered inputs', async () => {
    const { adapter, request, handlers } = wiredAdapter()
    adapter.send('start')
    await flush()
    handlers.get('turn/started')!({ threadId: 'thread-1', turn: { id: 'turn-1' } })
    const reset = vi.spyOn(adapter.normalizer, 'resetTurn')
    expect(adapter.sendIntoLiveTurn('first')).toBe(true)
    expect(adapter.sendIntoLiveTurn('second')).toBe(true)
    await flush()
    expect(request.mock.calls.map(([method]: any[]) => method)).toEqual(['turn/start', 'turn/steer'])
    expect(request.mock.calls[1]).toEqual(['turn/steer', {
      threadId: 'thread-1', expectedTurnId: 'turn-1',
      input: [{ type: 'text', text: 'first', text_elements: [] }, { type: 'text', text: 'second', text_elements: [] }],
    }])
    expect(reset).not.toHaveBeenCalled()
  })

  it('retains rejected steering and starts one combined continuation after completion', async () => {
    const { adapter, request, handlers } = wiredAdapter()
    adapter.send('start')
    await flush()
    request.mockRejectedValueOnce(new Error('No active turn supports steering'))
    adapter.send('first')
    await flush()
    adapter.send('second')
    await flush()
    expect(request).toHaveBeenCalledTimes(2)
    expect(adapter.hasPendingInput()).toBe(true)
    handlers.get('turn/completed')!({ threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } })
    await flush()
    expect(request).toHaveBeenCalledTimes(3)
    expect(request.mock.calls[2]).toEqual(['turn/start', {
      threadId: 'thread-1', input: [
        { type: 'text', text: 'first', text_elements: [] },
        { type: 'text', text: 'second', text_elements: [] },
      ],
    }])
  })

  it('does not dispatch a new turn while a steering response races completion', async () => {
    const { adapter, request, handlers } = wiredAdapter()
    adapter.send('start')
    await flush()
    let rejectSteer!: (error: Error) => void
    request.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSteer = reject }))
    adapter.send('during final answer')
    await flush()
    handlers.get('turn/completed')!({ threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } })
    await flush()
    expect(request).toHaveBeenCalledTimes(2)
    rejectSteer(new Error('No active turn'))
    await flush()
    expect(request.mock.calls.map(([method]: any[]) => method)).toEqual(['turn/start', 'turn/steer', 'turn/start'])
  })

  it('holds a terminal frame until an accepted steering response settles its ownership', async () => {
    const { adapter, request, handlers } = wiredAdapter()
    adapter.send('start')
    await flush()
    let acceptSteer!: (result: any) => void
    request.mockImplementationOnce(() => new Promise(resolve => { acceptSteer = resolve }))
    adapter.sendIntoLiveTurn('finishing input')
    await flush()
    handlers.get('turn/completed')!({ threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } })
    const stream = adapter.stream()[Symbol.asyncIterator]()
    let terminalReturned = false
    const result = (async () => {
      for (;;) {
        const frame = await stream.next()
        if (frame.value?.type === 'result') { terminalReturned = true; return frame.value }
      }
    })()
    await flush()
    expect(terminalReturned).toBe(false)
    acceptSteer({ turnId: 'turn-1' })
    await result
    expect(adapter.hasPendingInput()).toBe(false)
  })

  it('keeps a buffered fast continuation busy until its stream is consumed', async () => {
    const { adapter, handlers } = wiredAdapter()
    adapter.send('start')
    await flush()
    handlers.get('turn/started')!({ threadId: 'thread-1', turn: { id: 'turn-1' } })
    handlers.get('turn/completed')!({ threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } })
    adapter.sendIntoLiveTurn('late')
    await flush()
    handlers.get('turn/started')!({ threadId: 'thread-1', turn: { id: 'turn-2' } })
    handlers.get('turn/completed')!({ threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed' } })
    await collectUntilDone(adapter.stream()[Symbol.asyncIterator]())
    expect(adapter.hasPendingInput()).toBe(true)
    await collectUntilDone(adapter.stream()[Symbol.asyncIterator]())
    expect(adapter.hasPendingInput()).toBe(false)
  })

  it('keeps init pending until the reader resumes after its iterator.next handoff', async () => {
    const { adapter, handlers } = wiredAdapter()
    adapter.send('start')
    await flush()
    handlers.get('turn/started')!({ threadId: 'thread-1', turn: { id: 'turn-1' } })
    handlers.get('turn/completed')!({ threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } })
    const iterator = adapter.stream()[Symbol.asyncIterator]()
    const init = await iterator.next()
    expect(init.value).toMatchObject({ type: 'system', subtype: 'init' })
    await Promise.resolve()
    expect(adapter.hasPendingInput()).toBe(true)
    await iterator.next()
    expect(adapter.hasPendingInput()).toBe(false)
    await iterator.return()
  })

  it('keeps image content in steering requests', async () => {
    const { adapter, request } = wiredAdapter()
    adapter.send('start')
    await flush()
    adapter.sendIntoLiveTurn({ message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } }] } })
    await flush()
    expect(request.mock.calls[1][1].input).toEqual([{ type: 'image', url: 'data:image/png;base64,aW1hZ2U=' }])
  })
})

describe('Codex live-input withdrawal', () => {
  function wiredAdapter() {
    const adapter = makeAdapter() as any
    const handlers = new Map<string, (params: any) => void>()
    const request = vi.fn(async (_method: string, _params: any): Promise<any> => ({ turn: { id: 'turn-1' } }))
    adapter.threadId = 'thread-1'
    adapter.rpc = { request, isOpen: () => true, onNotification: (name: string, handler: (params: any) => void) => handlers.set(name, handler) }
    adapter.connection = { isAlive: () => true }
    adapter.subscribeNotifications(adapter.rpc)
    return { adapter, request, handlers }
  }

  async function flush() {
    for (let i = 0; i < 8; i++) await Promise.resolve()
  }

  it('withdraws steering the server refused and never starts it after completion', async () => {
    const { adapter, request, handlers } = wiredAdapter()
    adapter.send('start')
    await flush()
    request.mockRejectedValueOnce(new Error('No active turn supports steering'))
    const onWithdrawn = vi.fn()
    adapter.sendIntoLiveTurn('deferred addition', { onWithdrawn })
    await flush()
    expect(adapter.hasPendingInput()).toBe(true)
    expect(await adapter.withdrawUnreadInput()).toBe(1)
    expect(onWithdrawn).toHaveBeenCalledTimes(1)
    handlers.get('turn/completed')!({ threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } })
    await flush()
    expect(request.mock.calls.map(([method]: any[]) => method)).toEqual(['turn/start', 'turn/steer'])
    expect(adapter.hasPendingInput()).toBe(false)
  })

  it('withdraws live input before it is dispatched, but keeps ordinary sends', async () => {
    const { adapter, request, handlers } = wiredAdapter()
    adapter.send('start')
    await flush()
    handlers.get('turn/started')!({ threadId: 'thread-1', turn: { id: 'turn-1' } })
    const onWithdrawn = vi.fn()
    adapter.sendIntoLiveTurn('unread addition', { onWithdrawn })
    adapter.send('ordinary follow-up')
    expect(await adapter.withdrawUnreadInput()).toBe(1)
    expect(onWithdrawn).toHaveBeenCalledTimes(1)
    await flush()
    expect(request.mock.calls[1]).toEqual(['turn/steer', {
      threadId: 'thread-1', expectedTurnId: 'turn-1',
      input: [{ type: 'text', text: 'ordinary follow-up', text_elements: [] }],
    }])
  })

  it('treats steering the server accepted as read', async () => {
    const { adapter, request, handlers } = wiredAdapter()
    adapter.send('start')
    await flush()
    handlers.get('turn/started')!({ threadId: 'thread-1', turn: { id: 'turn-1' } })
    let acceptSteer!: (result: any) => void
    request.mockImplementationOnce(() => new Promise(resolve => { acceptSteer = resolve }))
    const onWithdrawn = vi.fn()
    adapter.sendIntoLiveTurn('in flight', { onWithdrawn })
    await flush()
    const withdrawal = adapter.withdrawUnreadInput()
    acceptSteer({ turnId: 'turn-1' })
    expect(await withdrawal).toBe(0)
    expect(onWithdrawn).not.toHaveBeenCalled()
  })

  it('withdraws an in-flight steer the server then refuses', async () => {
    const { adapter, request, handlers } = wiredAdapter()
    adapter.send('start')
    await flush()
    handlers.get('turn/started')!({ threadId: 'thread-1', turn: { id: 'turn-1' } })
    let rejectSteer!: (error: Error) => void
    request.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSteer = reject }))
    const onWithdrawn = vi.fn()
    adapter.sendIntoLiveTurn('in flight', { onWithdrawn })
    await flush()
    const withdrawal = adapter.withdrawUnreadInput()
    rejectSteer(new Error('No active turn'))
    expect(await withdrawal).toBe(1)
    expect(onWithdrawn).toHaveBeenCalledTimes(1)
    handlers.get('turn/completed')!({ threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } })
    await flush()
    expect(request.mock.calls.map(([method]: any[]) => method)).toEqual(['turn/start', 'turn/steer'])
  })
})
