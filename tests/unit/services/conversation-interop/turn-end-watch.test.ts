/**
 * Unit tests for conversation-interop/turn-end-watch — the `agent:complete`/
 * `agent:error` subscription that unsticks a conversation's turn-gate slot
 * (the P0 fix: this module previously did nothing but `noteTurnEnded`, so a
 * conversation's turn-gate reservation was never released and delivery to it
 * could only ever succeed once — see delivery.test.ts for that regression
 * from the delivery side).
 *
 * `onAgentEvent`, `noteTurnEnded`, and delivery's
 * `releaseConversationTurn`/`drainConversationTurn` are all mocked so this
 * file tests only the WIRING and ORDER: release (awaited to completion) →
 * this module's own bookkeeping (`noteTurnEnded`) → drain — mirroring team's
 * `completeTurn` shape. `releaseConversationTurn`'s own promise is held open
 * deliberately in most tests to prove `noteTurnEnded`/drain do not run until
 * it actually settles, not just until it is called.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type TurnEndListener = (event: { channel: string; conversationId: string }) => void

let capturedListener: TurnEndListener | null = null
const disposeSpy = vi.fn()
const onAgentEvent = vi.fn((listener: TurnEndListener) => {
  capturedListener = listener
  return { dispose: disposeSpy }
})
vi.mock('../../../../src/main/services/agent/events', () => ({
  onAgentEvent: (listener: TurnEndListener) => onAgentEvent(listener),
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

import { initConversationInterop, disposeConversationInterop } from '../../../../src/main/services/conversation-interop/turn-end-watch'

describe('turn-end-watch', () => {
  beforeEach(() => {
    calls.length = 0
    releaseResolve = null
    capturedListener = null
    onAgentEvent.mockClear()
    disposeSpy.mockClear()
    noteTurnEnded.mockClear()
    releaseConversationTurn.mockClear()
    drainConversationTurn.mockClear()
  })

  afterEach(() => {
    disposeConversationInterop()
  })

  it('is idempotent — a second init call does not add a second subscription', () => {
    initConversationInterop()
    initConversationInterop()
    expect(onAgentEvent).toHaveBeenCalledTimes(1)
  })

  it('ignores every channel other than agent:complete/agent:error', () => {
    initConversationInterop()
    capturedListener!({ channel: 'agent:message', conversationId: 'conv-1' })
    capturedListener!({ channel: 'agent:thought', conversationId: 'conv-1' })
    expect(releaseConversationTurn).not.toHaveBeenCalled()
    expect(noteTurnEnded).not.toHaveBeenCalled()
  })

  it.each(['agent:complete', 'agent:error'])(
    'on %s: awaits release to settle before running its own bookkeeping and draining — never in parallel with the still-in-flight dispatch',
    async (channel) => {
      initConversationInterop()
      capturedListener!({ channel, conversationId: 'conv-1' })

      // release() is invoked synchronously off the event, but noteTurnEnded/
      // drain must NOT run while it is still pending — this is the exact fix
      // for the reentrancy delivery.ts documents (sendMessage can emit this
      // very event synchronously from inside its own still-unfinished
      // dispatch call; draining before that call returns would start a
      // second dispatch on the same conversation).
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

  it('disposeConversationInterop unsubscribes; a later init re-subscribes fresh', () => {
    initConversationInterop()
    disposeConversationInterop()
    expect(disposeSpy).toHaveBeenCalledTimes(1)

    initConversationInterop()
    expect(onAgentEvent).toHaveBeenCalledTimes(2)
    capturedListener!({ channel: 'agent:complete', conversationId: 'conv-2' })
    expect(releaseConversationTurn).toHaveBeenCalledWith('conv-2')
  })
})
