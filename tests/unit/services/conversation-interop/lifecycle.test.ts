/**
 * Unit tests for conversation-interop/lifecycle — the wiring from every
 * registered source's turn-end signal to the turn-gate release, the pending
 * wait's `no_reply`, and the mailbox drain (the P0 fix: without releasing, a
 * conversation's turn-gate reservation was never freed and delivery to it
 * could only ever succeed once — see delivery.test.ts for that regression
 * from the delivery side).
 *
 * `noteTurnEnded` and delivery's `releaseConversationTurn`/
 * `drainConversationTurn` are mocked so this file tests only the WIRING and
 * ORDER: release (awaited to completion) → this module's own bookkeeping
 * (`noteTurnEnded`) → drain — mirroring team's `completeTurn` shape.
 * `releaseConversationTurn`'s own promise is held open deliberately in most
 * tests to prove `noteTurnEnded`/drain do not run until it actually settles,
 * not just until it is called.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ConversationSource } from '../../../../src/main/services/conversation-interop/source'

type EngineListener = (event: { channel: string; conversationId: string }) => void

const engine: { listener: EngineListener | null } = vi.hoisted(() => ({ listener: null }))
const engineDispose = vi.hoisted(() => vi.fn())
vi.mock('../../../../src/main/services/agent/events', () => ({
  onAgentEvent: (listener: EngineListener) => {
    engine.listener = listener
    return { dispose: engineDispose }
  },
}))
// The built-in source pulls in these engine-facing modules; only its turn-end signal is exercised here.
vi.mock('../../../../src/main/services/conversation.service', () => ({}))
vi.mock('../../../../src/main/services/agent/send-message', () => ({ sendMessage: vi.fn() }))

// chat-source reaches the engine through the services/agent barrel; without this
// every module reset would load the whole engine graph.
vi.mock('../../../../src/main/services/agent', async () => ({
  onAgentEvent: (await import('../../../../src/main/services/agent/events')).onAgentEvent,
  sendMessage: (await import('../../../../src/main/services/agent/send-message')).sendMessage,
}))
vi.mock('../../../../src/main/services/conversation-interop/busy', () => ({
  isNativeConversationBusy: () => false,
  hasLiveNativeSession: () => false,
}))

const calls: string[] = []

const noteTurnEnded = vi.fn((conversationId: string) => {
  calls.push(`noteTurnEnded:${conversationId}`)
})
vi.mock('../../../../src/main/services/conversation-interop/pending-wait', () => ({
  noteTurnEnded: (conversationId: string) => noteTurnEnded(conversationId),
}))

let releaseResolve: (() => void) | null = null
const releaseConversationTurn = vi.fn((conversationId: string) => {
  calls.push(`release:start:${conversationId}`)
  return new Promise<void>((resolve) => {
    releaseResolve = () => {
      calls.push(`release:settled:${conversationId}`)
      resolve()
    }
  })
})
const drainConversationTurn = vi.fn((conversationId: string) => {
  calls.push(`drain:${conversationId}`)
})
vi.mock('../../../../src/main/services/conversation-interop/delivery', () => ({
  releaseConversationTurn: (conversationId: string) => releaseConversationTurn(conversationId),
  drainConversationTurn: (conversationId: string) => drainConversationTurn(conversationId),
}))

import { initConversationInterop, disposeConversationInterop } from '../../../../src/main/services/conversation-interop/lifecycle'
import { getConversationSources, registerConversationSource } from '../../../../src/main/services/conversation-interop/source'

function fakeSource(kind: string) {
  let listener: ((conversationId: string) => void) | null = null
  const dispose = vi.fn(() => { listener = null })
  const source = {
    kind,
    capabilities: { readable: true, writable: true },
    owns: (id: string) => id.startsWith(`${kind}:`),
    onTurnEnd: (l: (conversationId: string) => void) => {
      listener = l
      return { dispose }
    },
  } as unknown as ConversationSource
  return { source, emit: (id: string) => listener?.(id), dispose, hasListener: () => listener !== null }
}

describe('lifecycle', () => {
  beforeEach(() => {
    calls.length = 0
    releaseResolve = null
    engine.listener = null
    engineDispose.mockClear()
    noteTurnEnded.mockClear()
    releaseConversationTurn.mockClear()
    drainConversationTurn.mockClear()
  })

  afterEach(() => {
    disposeConversationInterop()
  })

  it('registers the space conversation source, once, however often it is started', () => {
    initConversationInterop()
    initConversationInterop()
    expect(getConversationSources().map((s) => s.kind)).toEqual(['chat'])
  })

  it('unregisters what it registered and stops listening on dispose; a later init starts fresh', () => {
    initConversationInterop()
    expect(engine.listener).not.toBeNull()

    disposeConversationInterop()
    expect(getConversationSources()).toEqual([])
    expect(engineDispose).toHaveBeenCalledTimes(1)

    initConversationInterop()
    expect(getConversationSources().map((s) => s.kind)).toEqual(['chat'])
    engine.listener!({ channel: 'agent:complete', conversationId: 'conv-2' })
    expect(releaseConversationTurn).toHaveBeenCalledWith('conv-2')
  })

  it('the space source ignores every engine channel except agent:complete/agent:error', () => {
    initConversationInterop()
    engine.listener!({ channel: 'agent:message', conversationId: 'conv-1' })
    engine.listener!({ channel: 'agent:thought', conversationId: 'conv-1' })
    expect(releaseConversationTurn).not.toHaveBeenCalled()
    expect(noteTurnEnded).not.toHaveBeenCalled()
  })

  it('the space source leaves digital-human turn ends to the source that owns them', () => {
    initConversationInterop()
    engine.listener!({ channel: 'agent:complete', conversationId: 'app-chat:some-app' })
    expect(releaseConversationTurn).not.toHaveBeenCalled()
  })

  it.each(['agent:complete', 'agent:error'])(
    'on %s: awaits release to settle before running its own bookkeeping and draining — never in parallel with the still-in-flight dispatch',
    async (channel) => {
      initConversationInterop()
      engine.listener!({ channel, conversationId: 'conv-1' })

      // release() is invoked synchronously off the event, but noteTurnEnded/
      // drain must NOT run while it is still pending — this is the exact fix
      // for the reentrancy delivery.ts documents (a source's send can emit
      // this very event from inside its own still-unfinished dispatch call;
      // draining before that call returns would start a second dispatch on
      // the same conversation).
      expect(releaseConversationTurn).toHaveBeenCalledWith('conv-1')
      expect(noteTurnEnded).not.toHaveBeenCalled()
      expect(drainConversationTurn).not.toHaveBeenCalled()

      releaseResolve!()
      await vi.waitFor(() => expect(drainConversationTurn).toHaveBeenCalled())

      expect(calls).toEqual([
        'release:start:conv-1',
        'release:settled:conv-1',
        'noteTurnEnded:conv-1',
        'drain:conv-1',
      ])
    }
  )

  it('wires a source registered AFTER start, and a source registered before start', () => {
    const early = fakeSource('early')
    registerConversationSource(early.source)
    initConversationInterop()
    expect(early.hasListener()).toBe(true)

    const late = fakeSource('late')
    registerConversationSource(late.source)
    expect(late.hasListener()).toBe(true)

    late.emit('late:1')
    expect(releaseConversationTurn).toHaveBeenCalledWith('late:1')
    early.emit('early:1')
    expect(releaseConversationTurn).toHaveBeenCalledWith('early:1')
  })

  it('stops listening to a source when it is replaced or unregistered, and to all of them on dispose', () => {
    initConversationInterop()
    const first = fakeSource('digital-human')
    const registration = registerConversationSource(first.source)
    expect(first.hasListener()).toBe(true)

    const second = fakeSource('digital-human')
    registerConversationSource(second.source)
    expect(first.dispose).toHaveBeenCalledTimes(1)
    expect(second.hasListener()).toBe(true)

    registration.dispose() // the replaced registration must not tear down its successor
    expect(second.dispose).not.toHaveBeenCalled()

    disposeConversationInterop()
    expect(second.dispose).toHaveBeenCalledTimes(1)
  })

  it('drops the inbound forward depth recorded for a conversation when its turn ends, before anything queued behind it dispatches', async () => {
    const { circuitBreaker } = await import('../../../../src/main/services/conversation-interop/circuit-breaker')
    const fake = fakeSource('depth')
    registerConversationSource(fake.source)
    initConversationInterop()
    circuitBreaker.recordInboundForwardDepth('depth:1', 6)

    fake.emit('depth:1')
    await vi.waitFor(() => expect(releaseResolve).not.toBeNull())
    releaseResolve!()
    await vi.waitFor(() => expect(drainConversationTurn).toHaveBeenCalledWith('depth:1'))

    expect(circuitBreaker.getInboundForwardDepth('depth:1')).toBe(0)
  })

  it('a failure while handling one turn end is logged and does not stop later ones', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      releaseConversationTurn.mockImplementationOnce(() => Promise.reject(new Error('boom')))
      const fake = fakeSource('flaky')
      registerConversationSource(fake.source)
      initConversationInterop()

      fake.emit('flaky:1')
      await vi.waitFor(() => expect(error).toHaveBeenCalled())

      fake.emit('flaky:2')
      expect(releaseConversationTurn).toHaveBeenCalledWith('flaky:2')
    } finally {
      error.mockRestore()
    }
  })
})
