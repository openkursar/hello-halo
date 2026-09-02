/**
 * Unit Tests: services/agent/codex — Session adapter stream() per-turn contract
 *
 * Halo's session-consumer expects `stream()` to return after each turn's
 * `result` frame. If stream() blocks waiting for "the next event" past the
 * result, the consumer's `for await` loop never exits, processStream never
 * resolves, the consumer's outer `while` never emits `agent:complete`, and
 * the renderer stays stuck in "思考中…" forever — the visible smoke
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

function makeAdapter(): InstanceType<typeof CodexAppServerSession> {
  const Ctor = CodexAppServerSession as unknown as new (
    options: any, sessionId: string, opts: any,
  ) => InstanceType<typeof CodexAppServerSession>
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
    // processStream forever, leaving the UI in 思考中.
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

    // Now terminate.
    push(a, { type: 'result', subtype: 'success' })
    const r4 = await iter.next()
    expect(r4.done).toBe(false)
    expect(r4.value.type).toBe('result')

    const r5 = await iter.next()
    expect(r5.done).toBe(true)
  })
})
