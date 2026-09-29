/**
 * Characterization tests for conversation-interop's delivery behavior across a
 * turn's whole lifecycle: turn-gate slot, mailbox, pending replies, circuit
 * breaker and cooldown notices, and the turn-end signal.
 *
 * Only the boundaries are faked — `sendMessage`, the conversation store, the
 * engine's turn-end event stream and busyness. Delivery, pending-wait, the
 * circuit breaker, the turn gate and turn-end-watch are all the real modules,
 * wired the way production wires them, so a refactor of the internals has to
 * keep the observable behavior pinned here.
 *
 * The fake `sendMessage` behaves like the real one where it matters: it
 * persists the input as a `role:'user'` message and starts a turn, i.e. the
 * conversation reads busy until the test ends that turn with `endTurn`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

interface FakeMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  source?: string
  metadata?: Record<string, unknown>
}
interface FakeConversation {
  id: string
  title: string
  messages: FakeMessage[]
}

type EngineListener = (event: { channel: string; conversationId: string }) => void

const h = vi.hoisted(() => {
  const store = new Map<string, FakeConversation>()
  const busy = new Set<string>()
  let nextId = 0
  const state: { listener: EngineListener | null } = { listener: null }
  const sendMessage = vi.fn(async (params: { spaceId: string; conversationId: string; message: string }) => {
    const conv = store.get(params.conversationId)
    if (!conv) throw new Error('conversation not found')
    conv.messages.push({ id: `m-${nextId++}`, role: 'user', content: params.message })
    busy.add(params.conversationId)
  })
  const hasLiveNativeSession = vi.fn((_id: string) => true)
  return { store, busy, state, sendMessage, hasLiveNativeSession }
})

vi.mock('../../../../src/main/services/agent/send-message', () => ({ sendMessage: h.sendMessage }))

// chat-source reaches the engine through the services/agent barrel; without this
// every module reset would load the whole engine graph.
vi.mock('../../../../src/main/services/agent', async () => ({
  onAgentEvent: (await import('../../../../src/main/services/agent/events')).onAgentEvent,
  sendMessage: (await import('../../../../src/main/services/agent/send-message')).sendMessage,
}))
vi.mock('../../../../src/main/services/agent/events', () => ({
  onAgentEvent: (listener: EngineListener) => {
    h.state.listener = listener
    return { dispose: () => { h.state.listener = null } }
  },
}))
vi.mock('../../../../src/main/services/conversation-interop/busy', () => ({
  isNativeConversationBusy: (id: string) => h.busy.has(id),
  hasLiveNativeSession: (id: string) => h.hasLiveNativeSession(id),
}))
vi.mock('../../../../src/main/services/conversation.service', () => ({
  getConversation: (_spaceId: string, id: string) => h.store.get(id) ?? null,
  updateMessageById: (_spaceId: string, id: string, messageId: string, patch: Partial<FakeMessage>) => {
    const conv = h.store.get(id)
    const index = conv?.messages.findIndex((m) => m.id === messageId) ?? -1
    if (!conv || index === -1) return null
    conv.messages[index] = { ...conv.messages[index], ...patch }
    return conv.messages[index]
  },
  addMessage: (_spaceId: string, id: string, message: Omit<FakeMessage, 'id'>) => {
    const conv = h.store.get(id)
    if (!conv) throw new Error('conversation not found')
    const withId = { id: `notice-${conv.messages.length}`, ...message }
    conv.messages.push(withId)
    return withId
  },
}))

type DeliveryModule = typeof import('../../../../src/main/services/conversation-interop/delivery')
type TurnEndModule = typeof import('../../../../src/main/services/conversation-interop/lifecycle')
type BreakerModule = typeof import('../../../../src/main/services/conversation-interop/circuit-breaker')

// The modules under test hold process-wide state (turn gate, mailbox counts,
// waits, rate windows); a fresh copy per test keeps cases independent.
let deliverToConversation: DeliveryModule['deliverToConversation']
let deliverToConversationAndWait: DeliveryModule['deliverToConversationAndWait']
let deliverExternalMessage: DeliveryModule['deliverExternalMessage']
let initConversationInterop: TurnEndModule['initConversationInterop']
let disposeConversationInterop: TurnEndModule['disposeConversationInterop']
let circuitBreaker: BreakerModule['circuitBreaker']

const SPACE = 'space-1'

function seed(id: string, title = id): FakeConversation {
  const conv: FakeConversation = { id, title, messages: [] }
  h.store.set(id, conv)
  return conv
}

function send(from: string, to: string, message = `${from}->${to}`, extra: { forwardDepth?: number } = {}) {
  return deliverToConversation({ spaceId: SPACE, fromConversationId: from, toConversationId: to, message, summary: 's', ...extra })
}

function ask(from: string, to: string, message = `${from}?${to}`, timeoutMs = 60_000) {
  return deliverToConversationAndWait({ spaceId: SPACE, fromConversationId: from, toConversationId: to, message, summary: 's', timeoutMs })
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** The engine finishes a turn: the conversation goes idle and the completion event fires. */
async function endTurn(id: string, channel: 'agent:complete' | 'agent:error' = 'agent:complete'): Promise<void> {
  h.busy.delete(id)
  h.state.listener?.({ channel, conversationId: id })
  await flush()
}

function sentTo(id: string): string[] {
  return h.sendMessage.mock.calls.filter((c) => c[0].conversationId === id).map((c) => c[0].message as string)
}

function noticesIn(conv: FakeConversation): FakeMessage[] {
  return conv.messages.filter((m) => m.source === 'cross-conversation-notice')
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  h.store.clear()
  h.busy.clear()
  h.sendMessage.mockClear()
  h.hasLiveNativeSession.mockReturnValue(true)
  ;({ deliverToConversation, deliverToConversationAndWait, deliverExternalMessage } = await import(
    '../../../../src/main/services/conversation-interop/delivery'
  ))
  ;({ initConversationInterop, disposeConversationInterop } = await import(
    '../../../../src/main/services/conversation-interop/lifecycle'
  ))
  ;({ circuitBreaker } = await import('../../../../src/main/services/conversation-interop/circuit-breaker'))
  initConversationInterop()
})

afterEach(() => {
  disposeConversationInterop()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('turn slot and mailbox', () => {
  it('queues mail behind a running turn and dispatches it FIFO, one turn at a time, as each turn ends', async () => {
    seed('s1'); seed('s2'); seed('s3'); seed('tgt')

    expect(await send('s1', 'tgt', 'first')).toMatchObject({ ok: true, status: 'delivered' })
    expect(await send('s2', 'tgt', 'second')).toEqual({ ok: true, status: 'queued' })
    expect(await send('s3', 'tgt', 'third')).toEqual({ ok: true, status: 'queued' })
    expect(sentTo('tgt')).toHaveLength(1)

    await endTurn('tgt')
    expect(sentTo('tgt')).toHaveLength(2)
    expect(sentTo('tgt')[1]).toContain('second')

    await endTurn('tgt')
    expect(sentTo('tgt')).toHaveLength(3)
    expect(sentTo('tgt')[2]).toContain('third')
  })

  it('treats an errored turn like a completed one: the slot frees and queued mail moves', async () => {
    seed('s1'); seed('s2'); seed('tgt')
    await send('s1', 'tgt', 'first')
    expect(await send('s2', 'tgt', 'second')).toEqual({ ok: true, status: 'queued' })

    await endTurn('tgt', 'agent:error')

    expect(sentTo('tgt')).toHaveLength(2)
  })

  it('never starts a second dispatch while the first is still mid-flight, even when the engine reports the turn ended from inside that very send', async () => {
    seed('s1'); seed('s2'); seed('tgt')

    let finishFirstSend: () => void = () => {}
    h.sendMessage.mockImplementationOnce(async (params: { conversationId: string; message: string }) => {
      h.store.get(params.conversationId)!.messages.push({ id: 'first-msg', role: 'user', content: params.message })
      // sendMessage swallowing its own failure: error + complete fire from
      // deep inside the still-unfinished call (after its first await).
      await Promise.resolve()
      h.state.listener?.({ channel: 'agent:error', conversationId: params.conversationId })
      h.state.listener?.({ channel: 'agent:complete', conversationId: params.conversationId })
      await new Promise<void>((resolve) => { finishFirstSend = resolve })
    })

    const first = send('s1', 'tgt', 'first')
    await flush()
    expect(await send('s2', 'tgt', 'second')).toEqual({ ok: true, status: 'queued' })
    await flush()
    // Release/drain are waiting for the in-flight dispatch to settle.
    expect(sentTo('tgt')).toHaveLength(1)

    finishFirstSend()
    await first
    await flush()
    expect(sentTo('tgt')).toHaveLength(2)
    expect(sentTo('tgt')[1]).toContain('second')
  })

  it('frees mailbox room as queued mail dispatches, so the cap is a live count and not a lifetime one', async () => {
    seed('tgt')
    h.busy.add('tgt')
    for (let i = 0; i < 50; i++) {
      seed(`src-${i}`)
      expect(await send(`src-${i}`, 'tgt')).toEqual({ ok: true, status: 'queued' })
    }
    seed('late-1'); seed('late-2')
    expect(await send('late-1', 'tgt')).toEqual({ ok: false, reason: 'queue_full' })

    await endTurn('tgt')
    expect(sentTo('tgt')).toHaveLength(1)

    // One slot opened up (the dispatched job left the mailbox) — exactly one.
    expect(await send('late-2', 'tgt')).toEqual({ ok: true, status: 'queued' })
    expect(await send('late-1', 'tgt')).toEqual({ ok: false, reason: 'queue_full' })
  })

  it('checks the mailbox cap before charging the breaker: rejected sends spend no rate budget and raise no notice', async () => {
    const source = seed('src')
    seed('tgt')
    h.busy.add('tgt')
    for (let i = 0; i < 50; i++) {
      seed(`filler-${i}`)
      await send(`filler-${i}`, 'tgt')
    }

    // Far more attempts than the pair limit (20) would allow if they counted.
    for (let i = 0; i < 30; i++) {
      expect(await send('src', 'tgt')).toEqual({ ok: false, reason: 'queue_full' })
    }
    expect(noticesIn(source)).toHaveLength(0)

    // Once there is room again, the pair is still untouched by the rejected attempts.
    h.busy.delete('tgt')
    await endTurn('tgt')
    seed('other')
    expect(await send('src', 'other')).toMatchObject({ ok: true, status: 'delivered' })
  })

  it('reclaims a reservation whose turn crashed before the engine ever reported one, then lets the next send through', async () => {
    seed('s1'); seed('s2'); seed('tgt')
    await send('s1', 'tgt', 'first')
    // Crash before system:init: no completion event ever fires, the session is gone and idle.
    h.busy.delete('tgt')
    h.hasLiveNativeSession.mockReturnValue(false)

    expect(await send('s2', 'tgt', 'second')).toMatchObject({ ok: true, status: 'delivered' })
    expect(sentTo('tgt')).toHaveLength(2)
  })

  it('does not reclaim while the engine still has a live session for the conversation', async () => {
    seed('s1'); seed('s2'); seed('tgt')
    await send('s1', 'tgt', 'first')
    h.busy.delete('tgt') // idle between turns, but the session is alive and the slot is still ours

    expect(await send('s2', 'tgt', 'second')).toEqual({ ok: true, status: 'queued' })
    expect(sentTo('tgt')).toHaveLength(1)
  })
})

describe('waitForReply lifecycle', () => {
  it('reports no_reply when the target finishes its turn without answering, and a later send from it is an ordinary delivery', async () => {
    const waiter = seed('waiter')
    seed('target')

    const pending = ask('waiter', 'target')
    await flush()
    expect(sentTo('target')).toHaveLength(1)

    await endTurn('target')
    await expect(pending).resolves.toEqual({ ok: true, outcome: { status: 'no_reply' } })

    // The turn is closed: whatever target sends afterwards must not be mistaken for a reply.
    h.busy.delete('waiter')
    const late = await send('target', 'waiter', 'too late')
    expect(late).toMatchObject({ ok: true, status: 'delivered' })
    expect(waiter.messages.at(-1)).toMatchObject({ role: 'system', source: 'cross-conversation', content: 'too late' })
  })

  it('reports no_reply for an errored turn as well', async () => {
    seed('waiter'); seed('target')
    const pending = ask('waiter', 'target')
    await flush()

    await endTurn('target', 'agent:error')

    await expect(pending).resolves.toEqual({ ok: true, outcome: { status: 'no_reply' } })
  })

  it('never fills the reply from the target turn itself — only an explicit send back resolves it', async () => {
    seed('waiter'); const target = seed('target')
    const pending = ask('waiter', 'target')
    await flush()
    target.messages.push({ id: 'assistant-final', role: 'assistant', content: 'a complete-sounding sign-off' })

    await endTurn('target')

    const result = await pending
    expect(result).toEqual({ ok: true, outcome: { status: 'no_reply' } })
  })

  it('times out when nothing arrives, and the closed wait cannot swallow a later send', async () => {
    seed('waiter'); seed('target')

    const pending = ask('waiter', 'target', 'q', 30_000)
    await flush()
    await vi.advanceTimersByTimeAsync(30_001)

    await expect(pending).resolves.toEqual({ ok: true, outcome: { status: 'timeout' } })

    h.busy.delete('waiter')
    expect(await send('target', 'waiter', 'after timeout')).toMatchObject({ ok: true, status: 'delivered' })
  })

  it('does not honor a reply while the ask is still queued behind the target’s own turn', async () => {
    seed('waiter'); seed('target')
    const waiterConv = h.store.get('waiter')!
    h.busy.add('target') // target is mid-turn on something unrelated

    const pending = ask('waiter', 'target', 'question')
    await flush()
    expect(sentTo('target')).toHaveLength(0)

    // The target's current turn was not started by this ask, so its send to the
    // waiter is an ordinary message, not the answer.
    h.busy.delete('waiter')
    expect(await send('target', 'waiter', 'unrelated update')).toMatchObject({ ok: true, status: 'delivered' })
    expect(waiterConv.messages.at(-1)?.content).toBe('unrelated update')

    // The unrelated turn ends; the ask dispatches and now arms the reply window.
    h.busy.add('target')
    await endTurn('target')
    expect(sentTo('target')).toHaveLength(1)
    expect(sentTo('target')[0]).toContain('question')

    h.busy.delete('waiter')
    expect(await send('target', 'waiter', 'the real answer')).toEqual({ ok: true, status: 'resolved_pending_wait' })
    await expect(pending).resolves.toEqual({ ok: true, outcome: { status: 'replied', message: 'the real answer' } })
  })

  it('a plain message from a third conversation queued behind the owed turn gets its own turn only after the waiter is told no_reply', async () => {
    seed('waiter'); seed('other'); seed('target')
    const pending = ask('waiter', 'target')
    await flush()
    expect(await send('other', 'target', 'unrelated')).toEqual({ ok: true, status: 'queued' })

    await endTurn('target')

    await expect(pending).resolves.toEqual({ ok: true, outcome: { status: 'no_reply' } })
    expect(sentTo('target')).toHaveLength(2)
    expect(sentTo('target')[1]).toContain('unrelated')
    // The second turn owes nobody an answer: a send from target to waiter is a normal delivery.
    h.busy.delete('waiter')
    expect(await send('target', 'waiter', 'chatter')).toMatchObject({ ok: true, status: 'delivered' })
  })

  it('abandons the wait immediately when the dispatch fails, with the real reason, and leaves nothing behind for the cycle guard to trip on', async () => {
    seed('waiter'); seed('target'); seed('third')
    h.sendMessage.mockRejectedValueOnce(new Error('spawn failed'))

    const failed = await ask('waiter', 'target')
    expect(failed).toEqual({ ok: true, outcome: { status: 'undelivered', reason: 'spawn failed' } })

    // If the failed wait were still registered, this would look like a cycle
    // (target -> waiter -> target) or leave waiter "waiting" forever.
    const pendingReverse = ask('target', 'waiter')
    await flush()
    expect(sentTo('waiter')).toHaveLength(1)
    await endTurn('waiter')
    await expect(pendingReverse).resolves.toEqual({ ok: true, outcome: { status: 'no_reply' } })
  })

  it('an ask that dispatches after its sender timed out arrives as a plain notice: nothing armed, no reply invited', async () => {
    seed('waiter'); const target = seed('target')
    h.busy.add('target')
    const pending = ask('waiter', 'target', 'still there?', 30_000)
    await flush()
    await vi.advanceTimersByTimeAsync(30_001)
    await expect(pending).resolves.toEqual({ ok: true, outcome: { status: 'timeout' } })

    await endTurn('target')

    const framed = sentTo('target').at(-1)!
    expect(framed).not.toContain('waiting for your answer')
    expect(framed).toContain('one-way notice')
    expect(target.messages.at(-1)!.metadata).not.toHaveProperty('correlationId')
    // Anything the target now sends back is an ordinary delivery, not a reply to a dead wait.
    h.busy.delete('waiter')
    expect(await send('target', 'waiter', 'yes')).toMatchObject({ ok: true, status: 'delivered' })
  })

  it('tells a waiting sender at once when the target\'s source is gone by the time its queued ask comes up', async () => {
    seed('waiter'); seed('target')
    h.busy.add('target')
    const pending = ask('waiter', 'target')
    await flush()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      disposeConversationInterop() // unregisters the space-conversation source
      h.busy.delete('target')
      const { drainConversationTurn } = await import('../../../../src/main/services/conversation-interop/delivery')
      drainConversationTurn('target')
      await flush()
      await expect(pending).resolves.toEqual({
        ok: true, outcome: { status: 'undelivered', reason: expect.stringContaining('no conversation source owns target') },
      })
    } finally {
      warn.mockRestore(); error.mockRestore()
      initConversationInterop()
    }
  })

  it('refuses a wait that would deadlock even when the intermediate hop was reached through the real pipeline', async () => {
    seed('a'); seed('b'); seed('c')
    const aOnB = ask('a', 'b')
    await flush()
    const bOnC = ask('b', 'c')
    await flush()

    expect(await ask('c', 'a')).toEqual({ ok: false, reason: 'mutual_wait' })

    await endTurn('c'); await endTurn('b')
    await expect(bOnC).resolves.toEqual({ ok: true, outcome: { status: 'no_reply' } })
    await expect(aOnB).resolves.toEqual({ ok: true, outcome: { status: 'no_reply' } })
  })

  it('records the correlation id and forward depth on the delivered message, and the inbound depth only once it actually dispatches', async () => {
    seed('waiter'); const target = seed('target')
    h.busy.add('target')

    const pending = deliverToConversationAndWait({
      spaceId: SPACE, fromConversationId: 'waiter', toConversationId: 'target',
      message: 'q', summary: 'sum', forwardDepth: 3, timeoutMs: 60_000,
    })
    await flush()
    // Queued behind the target's turn: nothing persisted, no inbound depth yet.
    expect(target.messages).toHaveLength(0)
    expect(circuitBreaker.getInboundForwardDepth('target')).toBe(0)

    await endTurn('target')

    expect(target.messages).toHaveLength(1)
    expect(target.messages[0]).toMatchObject({
      role: 'system',
      source: 'cross-conversation',
      content: 'q',
      metadata: {
        fromConversationId: 'waiter',
        fromConversationTitle: 'waiter',
        summary: 'sum',
        forwardDepth: 3,
        correlationId: expect.any(String),
      },
    })
    expect(circuitBreaker.getInboundForwardDepth('target')).toBe(3)

    await endTurn('target')
    await expect(pending).resolves.toEqual({ ok: true, outcome: { status: 'no_reply' } })
  })

  it('a dispatched delivery carries the sender depth into the target so its own sends continue the chain', async () => {
    seed('src'); seed('tgt')
    await send('src', 'tgt', 'hop', { forwardDepth: 4 })
    expect(circuitBreaker.getInboundForwardDepth('tgt')).toBe(4)
  })
})

describe('circuit breaker through delivery', () => {
  it('trips the per-source limit for fan-out to distinct targets, with one notice that names no single target', async () => {
    const source = seed('fan-src')
    let last
    for (let i = 0; i < 61; i++) {
      seed(`fan-tgt-${i}`)
      last = await send('fan-src', `fan-tgt-${i}`, `m-${i}`)
      if (i < 60) expect(last).toMatchObject({ ok: true })
    }
    expect(last).toEqual({ ok: false, reason: 'circuit_open' })

    // Repeats during the cooldown stay silent.
    seed('fan-extra')
    expect(await send('fan-src', 'fan-extra')).toEqual({ ok: false, reason: 'circuit_open' })

    const notices = noticesIn(source)
    expect(notices).toHaveLength(1)
    expect(notices[0].role).toBe('system')
    expect(notices[0].content).toContain('other conversations')
    expect(notices[0].content).toContain('5 minutes')
    expect(notices[0].content).not.toContain('fan-tgt-')
  })

  it('a pair cooldown pauses only that pair; the source can still reach other conversations', async () => {
    seed('pair-src'); seed('pair-tgt'); seed('pair-other')
    h.busy.add('pair-tgt')
    for (let i = 0; i < 21; i++) await send('pair-src', 'pair-tgt', `m-${i}`)
    expect(await send('pair-src', 'pair-tgt')).toEqual({ ok: false, reason: 'circuit_open' })

    expect(await send('pair-src', 'pair-other')).toMatchObject({ ok: true, status: 'delivered' })
  })

  it('holds the cooldown for its full five minutes, then admits sends once the sliding window has decayed', async () => {
    seed('cool-src'); seed('cool-tgt')
    h.busy.add('cool-tgt')
    for (let i = 0; i < 21; i++) await send('cool-src', 'cool-tgt', `m-${i}`)
    expect(await send('cool-src', 'cool-tgt')).toEqual({ ok: false, reason: 'circuit_open' })

    await vi.advanceTimersByTimeAsync(4 * 60_000 + 59_000)
    expect(await send('cool-src', 'cool-tgt')).toEqual({ ok: false, reason: 'circuit_open' })

    // Past both the cooldown and the 10-minute window that fed it.
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    h.busy.delete('cool-tgt')
    await endTurn('cool-tgt')
    expect(await send('cool-src', 'cool-tgt', 'back')).toMatchObject({ ok: true })
  })

  it('checks depth before rate: an over-deep hop is rejected on its own, spends no budget and writes no notice', async () => {
    const source = seed('deep-src')
    seed('deep-tgt')
    for (let i = 0; i < 30; i++) {
      expect(await send('deep-src', 'deep-tgt', 'x', { forwardDepth: 7 })).toEqual({ ok: false, reason: 'chain_too_deep' })
    }
    expect(noticesIn(source)).toHaveLength(0)
    expect(await send('deep-src', 'deep-tgt', 'fresh chain')).toMatchObject({ ok: true, status: 'delivered' })
  })

  it('an oversized message is refused before anything is charged or dispatched', async () => {
    seed('big-src'); seed('big-tgt')
    expect(await send('big-src', 'big-tgt', 'x'.repeat(32_001))).toEqual({ ok: false, reason: 'too_large' })
    expect(sentTo('big-tgt')).toHaveLength(0)
  })

  it('a reply that answers a pending wait is exempt from the breaker: the answering direction never accumulates budget', async () => {
    seed('w'); seed('t')
    // 19 ask/answer rounds: the waiter stays under its own pair limit (20),
    // while the answering side sends more messages than that would allow if they were charged.
    for (let i = 0; i < 19; i++) {
      const pending = ask('w', 't', `q-${i}`)
      await flush()
      expect(await send('t', 'w', `a-${i}`)).toEqual({ ok: true, status: 'resolved_pending_wait' })
      await expect(pending).resolves.toMatchObject({ outcome: { status: 'replied' } })
      await endTurn('t')
    }
    // 19 answers so far; pile up ordinary sends up to the pair limit and beyond to prove
    // the answers were not counted: 20 ordinary sends still succeed before the 21st trips.
    h.busy.add('w')
    for (let i = 0; i < 20; i++) expect(await send('t', 'w', `n-${i}`)).toMatchObject({ ok: true })
    expect(await send('t', 'w', 'n-21')).toEqual({ ok: false, reason: 'circuit_open' })
  })
})

describe('deliveries from non-conversation senders', () => {
  it('shares the slot and mailbox with cross-conversation mail, in arrival order', async () => {
    seed('s1'); seed('tgt')
    await send('s1', 'tgt', 'first')

    const queued = await deliverExternalMessage({
      spaceId: SPACE,
      toConversationId: 'tgt',
      turnInput: '[Team message]\n\nreport',
      persist: { content: 'report', source: 'team-message', metadata: {} },
    })
    expect(queued).toEqual({ ok: true, status: 'queued' })

    await endTurn('tgt')
    expect(sentTo('tgt')).toHaveLength(2)
    expect(sentTo('tgt')[1]).toBe('[Team message]\n\nreport')
  })

  it('is not rate-limited by the cross-conversation breaker', async () => {
    seed('tgt')
    for (let i = 0; i < 70; i++) {
      const result = await deliverExternalMessage({
        spaceId: SPACE,
        toConversationId: 'tgt',
        turnInput: `report ${i}`,
        persist: { content: `report ${i}`, source: 'team-message', metadata: {} },
      })
      expect(result).toMatchObject({ ok: true })
      await endTurn('tgt')
    }
  })

  it('shares the same mailbox cap', async () => {
    seed('tgt')
    h.busy.add('tgt')
    for (let i = 0; i < 50; i++) {
      expect(await deliverExternalMessage({
        spaceId: SPACE, toConversationId: 'tgt', turnInput: `r${i}`,
        persist: { content: `r${i}`, source: 'team-message', metadata: {} },
      })).toEqual({ ok: true, status: 'queued' })
    }
    expect(await deliverExternalMessage({
      spaceId: SPACE, toConversationId: 'tgt', turnInput: 'overflow',
      persist: { content: 'overflow', source: 'team-message', metadata: {} },
    })).toEqual({ ok: false, reason: 'queue_full' })
  })

  it('starting a turn on a conversation that owed a reply closes that wait as no_reply', async () => {
    seed('waiter'); seed('target')
    const pending = ask('waiter', 'target')
    await flush()
    await endTurn('target')
    await expect(pending).resolves.toEqual({ ok: true, outcome: { status: 'no_reply' } })

    const pendingAgain = ask('waiter', 'target')
    await flush()
    // An external turn takes the slot only after the owed turn is over.
    expect(await deliverExternalMessage({
      spaceId: SPACE, toConversationId: 'target', turnInput: 'ext',
      persist: { content: 'ext', source: 'team-message', metadata: {} },
    })).toEqual({ ok: true, status: 'queued' })
    await endTurn('target')
    await expect(pendingAgain).resolves.toEqual({ ok: true, outcome: { status: 'no_reply' } })
    expect(sentTo('target').at(-1)).toBe('ext')
  })
})
