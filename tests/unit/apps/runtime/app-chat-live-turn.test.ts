/**
 * Unit tests for apps/runtime/app-chat-live-turn — whether a turn is running,
 * and adding a message to the one that is.
 *
 * What matters here is the contract its callers lean on, not the plumbing: the
 * probe must see BOTH windows of a turn (a round queued before the engine has
 * acknowledged it, and one the consumer is processing), and the delivery must
 * answer false rather than throw when there is nothing to deliver into — the
 * team bus holds a mailbox as the fallback, and a throw would surface as a
 * failed `team_send` instead.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { v2Sessions } = vi.hoisted(() => ({ v2Sessions: new Map<string, any>() }))
const { writeTrigger } = vi.hoisted(() => ({ writeTrigger: vi.fn() }))
const { rounds, consumers } = vi.hoisted(() => ({
  rounds: new Set<string>(),
  consumers: new Map<string, any>(),
}))
/** What the sink tells about its rounds: a turn began, a round settled or was dropped. */
const { sinkEvents } = vi.hoisted(() => ({
  sinkEvents: { emit: (_conversationId: string): void => {} },
}))

vi.mock('../../../../src/main/services/agent/session-manager', () => ({
  v2Sessions,
  getConsumerHandle: (conversationId: string) => consumers.get(conversationId),
}))

vi.mock('../../../../src/main/apps/runtime/app-chat-sink', () => ({
  hasActiveAppChatRound: (conversationId: string) => rounds.has(conversationId),
  peekAppChatSink: (conversationId: string) =>
    conversationId === 'convo-with-sink' ? { writeUserMessage: writeTrigger } : undefined,
  onAppChatRoundChange: (listener: (conversationId: string) => void) => {
    sinkEvents.emit = listener
    return () => {}
  },
}))

import {
  beginAppChatTurnStart,
  cancelAppChatTurnStarts,
  getStartingAppChatConversations,
  injectIntoAppChat,
  injectIntoAppChatWhenLive,
  isAppChatConversationGenerating,
  isAppChatTurnDispatched,
  onAppChatConversationChange,
} from '../../../../src/main/apps/runtime/app-chat-live-turn'

const CONVO = 'convo-with-sink'

/** A conversation with a live session AND a turn the consumer is processing. */
function liveTurn(conversationId: string, send: (text: string) => void): void {
  v2Sessions.set(conversationId, { session: { send }, spaceId: 'space-1' })
  consumers.set(conversationId, { isRunning: true, getActiveSessionState: () => ({}) })
}

describe('isAppChatConversationGenerating', () => {
  beforeEach(() => {
    rounds.clear()
    consumers.clear()
  })

  it('is false for a conversation with nothing in flight', () => {
    expect(isAppChatConversationGenerating(CONVO)).toBe(false)
  })

  it('sees a round that is queued but not yet acknowledged by the engine', () => {
    // The window the turn gate reserves for: a message is on its way in, and a
    // second turn started here would land on the same session.
    rounds.add(CONVO)
    expect(isAppChatConversationGenerating(CONVO)).toBe(true)
  })

  it('sees a turn the consumer is processing, including one nobody solicited', () => {
    consumers.set(CONVO, { isRunning: true, getActiveSessionState: () => ({}) })
    expect(isAppChatConversationGenerating(CONVO)).toBe(true)
  })

  it('is false for a consumer that is running but between turns', () => {
    // The session outlives its turns: alive is not the same as busy, and
    // treating it as busy would queue mail behind a session doing nothing.
    consumers.set(CONVO, { isRunning: true, getActiveSessionState: () => null })
    expect(isAppChatConversationGenerating(CONVO)).toBe(false)
  })

  it('goes back to false once the turn ends, with the session still alive', () => {
    // The FALSE side is the one everything downstream is built on: the gate's
    // watchdog only reclaims a stranded slot while this reads false, quiescence
    // only seals a run when it reads false for every member, and the mailbox
    // only drains into a session it reads as free. A probe stuck true is not a
    // wrong status light — it is a run that never ends and mail that never
    // arrives. Asserting only the true side leaves all of that uncovered.
    let turnRunning = true
    consumers.set(CONVO, {
      isRunning: true,
      getActiveSessionState: () => (turnRunning ? {} : null),
    })
    rounds.add(CONVO)
    expect(isAppChatConversationGenerating(CONVO)).toBe(true)

    // The round is claimed and settled, the turn ends — but the consumer stays
    // running and the session stays alive, which is the normal resting state.
    rounds.delete(CONVO)
    turnRunning = false

    expect(isAppChatConversationGenerating(CONVO)).toBe(false)
  })
})

describe('injectIntoAppChat', () => {
  beforeEach(() => {
    v2Sessions.clear()
    consumers.clear()
    rounds.clear()
    writeTrigger.mockReset()
  })

  it('sends into the live session and records the message in the transcript', () => {
    const send = vi.fn()
    liveTurn(CONVO, send)

    expect(injectIntoAppChat(CONVO, 'the plan changed')).toBe(true)
    expect(send).toHaveBeenCalledWith('the plan changed')
    expect(writeTrigger).toHaveBeenCalledWith('the plan changed')
  })

  it('records the provenance a caller supplies, so the user adding to their own turn reads as an injection', () => {
    liveTurn(CONVO, vi.fn())

    expect(injectIntoAppChat(CONVO, 'also this', { source: 'injection' })).toBe(true)

    expect(writeTrigger).toHaveBeenCalledWith('also this', undefined, undefined, { source: 'injection' }, undefined)
  })

  it('records the message only after the engine has taken it', () => {
    // The record is of what HAPPENED, and until the send returns nothing has.
    // Written first, a send that then threw left a transcript line for a
    // delivery that never occurred — while the caller, told false, re-delivered
    // through the mailbox. The member read the same message twice.
    const order: string[] = []
    writeTrigger.mockImplementation(() => order.push('transcript'))
    liveTurn(CONVO, () => order.push('send'))

    injectIntoAppChat(CONVO, 'x')

    expect(order).toEqual(['send', 'transcript'])
  })

  it('answers false — never throws — when there is no live session', () => {
    expect(injectIntoAppChat('convo-nobody-is-running', 'x')).toBe(false)
  })

  it('answers false when a live session has no turn in flight', () => {
    // A session outlives its turns. Between the engine emitting a result and the
    // consumer tearing the subprocess down, the session object is still here and
    // nothing is listening — text sent then goes nowhere while the caller is
    // told it arrived. Late is recoverable; "delivered but never arrived" is not.
    const send = vi.fn()
    v2Sessions.set(CONVO, { session: { send }, spaceId: 'space-1' })
    consumers.set(CONVO, { isRunning: true, getActiveSessionState: () => null })

    expect(injectIntoAppChat(CONVO, 'x')).toBe(false)
    expect(send).not.toHaveBeenCalled()
    expect(writeTrigger).not.toHaveBeenCalled()
  })

  it('answers false when the send fails, and leaves NOTHING in the transcript', () => {
    // Both halves matter: the caller needs its fallback, and the fallback must
    // not arrive as a second copy of a message already written down.
    liveTurn(CONVO, () => {
      throw new Error('stdin closed')
    })

    expect(injectIntoAppChat(CONVO, 'x')).toBe(false)
    expect(writeTrigger).not.toHaveBeenCalled()
  })

  it('still reports success when only the transcript write fails', () => {
    // The message did arrive. Reporting failure would hand the caller's fallback
    // a second copy of something the member is already reading — losing the
    // record is the smaller harm, and it is logged.
    const send = vi.fn()
    liveTurn(CONVO, send)
    writeTrigger.mockImplementation(() => {
      throw new Error('writer closed')
    })

    expect(injectIntoAppChat(CONVO, 'x')).toBe(true)
    expect(send).toHaveBeenCalledWith('x')
  })

  it('delivers even when no sink exists yet, rather than losing the message to bookkeeping', () => {
    const send = vi.fn()
    liveTurn('convo-no-sink', send)

    expect(injectIntoAppChat('convo-no-sink', 'x')).toBe(true)
    expect(send).toHaveBeenCalledWith('x')
  })
})

describe('a message on its way to the engine', () => {
  beforeEach(() => {
    rounds.clear()
    consumers.clear()
    v2Sessions.clear()
  })

  it('holds the conversation from the moment it is accepted until its round is queued', () => {
    const start = beginAppChatTurnStart(CONVO)
    expect(isAppChatConversationGenerating(CONVO)).toBe(true)
    // The engine does not know about it yet.
    expect(isAppChatTurnDispatched(CONVO)).toBe(false)
    expect(getStartingAppChatConversations()).toContain(CONVO)

    rounds.add(CONVO)
    start.end()
    expect(isAppChatConversationGenerating(CONVO)).toBe(true)
    rounds.delete(CONVO)
    expect(isAppChatConversationGenerating(CONVO)).toBe(false)
  })

  it('lets go only when the last of two overlapping starts ends, and ending twice changes nothing', () => {
    const first = beginAppChatTurnStart(CONVO)
    const second = beginAppChatTurnStart(CONVO)
    first.end()
    first.end()
    expect(isAppChatConversationGenerating(CONVO)).toBe(true)
    second.end()
    expect(isAppChatConversationGenerating(CONVO)).toBe(false)
    expect(getStartingAppChatConversations()).not.toContain(CONVO)
  })

  it('is told to send nothing when stopped, and keeps holding the conversation until it unwinds', () => {
    const start = beginAppChatTurnStart(CONVO)
    expect(cancelAppChatTurnStarts(CONVO)).toBe(true)
    expect(start.cancelled).toBe(true)
    // Whatever arrives meanwhile waits behind it instead of starting beside it.
    expect(isAppChatConversationGenerating(CONVO)).toBe(true)
    start.end()
    expect(isAppChatConversationGenerating(CONVO)).toBe(false)
    expect(cancelAppChatTurnStarts(CONVO)).toBe(false)
  })
})

describe('injectIntoAppChatWhenLive — a person adding to a turn that may not have begun', () => {
  beforeEach(() => {
    rounds.clear()
    consumers.clear()
    v2Sessions.clear()
    writeTrigger.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** The turn the sink queued a round for begins on the engine. */
  function turnBegins(send: (text: string) => void): void {
    liveTurn(CONVO, send)
    sinkEvents.emit(CONVO)
  }

  it('waits for a starting turn to begin, then adds to it', async () => {
    const start = beginAppChatTurnStart(CONVO)
    const send = vi.fn()
    const outcome = injectIntoAppChatWhenLive(CONVO, 'also check the totals')

    // Queued with the engine, not begun: still nothing to add to.
    rounds.add(CONVO)
    start.end()
    await Promise.resolve()
    expect(send).not.toHaveBeenCalled()

    turnBegins(send)

    expect(await outcome).toBe('delivered')
    expect(send).toHaveBeenCalledWith('also check the totals')
  })

  it('never gives up on a start that takes long: no answer until the turn begins', async () => {
    // Answering "nothing to add to" while the first message is still starting
    // has the text sent as a second turn, which the engine folds into the first.
    vi.useFakeTimers()
    const start = beginAppChatTurnStart(CONVO)
    const send = vi.fn()
    let settled: string | null = null
    const outcome = injectIntoAppChatWhenLive(CONVO, 'also check the totals').then((value) => {
      settled = value
      return value
    })

    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(settled).toBeNull()

    rounds.add(CONVO)
    start.end()
    turnBegins(send)

    expect(await outcome).toBe('delivered')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('answers no_turn once nothing is in flight, so the text becomes a turn of its own', async () => {
    const start = beginAppChatTurnStart(CONVO)
    const outcome = injectIntoAppChatWhenLive(CONVO, 'also check the totals')
    start.end()

    expect(await outcome).toBe('no_turn')
    expect(writeTrigger).not.toHaveBeenCalled()
  })

  it('answers no_turn when the queued round it waited for is given up on', async () => {
    const start = beginAppChatTurnStart(CONVO)
    const outcome = injectIntoAppChatWhenLive(CONVO, 'also check the totals')
    rounds.add(CONVO)
    start.end()

    // The sink's own deadline settles the round; nothing is in flight any more.
    rounds.delete(CONVO)
    sinkEvents.emit(CONVO)

    expect(await outcome).toBe('no_turn')
  })

  it('answers stopped when the turn it waited for is stopped, and sends nothing', async () => {
    // The person just stopped this work: their addition goes back to them
    // rather than starting it again as a turn of its own.
    const start = beginAppChatTurnStart(CONVO)
    const send = vi.fn()
    const outcome = injectIntoAppChatWhenLive(CONVO, 'also check the totals')

    cancelAppChatTurnStarts(CONVO)

    expect(await outcome).toBe('stopped')
    start.end()
    turnBegins(send)
    expect(send).not.toHaveBeenCalled()
    expect(writeTrigger).not.toHaveBeenCalled()
  })

  it('adds to a turn that is already running without waiting', async () => {
    const send = vi.fn()
    liveTurn(CONVO, send)

    expect(await injectIntoAppChatWhenLive(CONVO, 'one more thing')).toBe('delivered')
    expect(send).toHaveBeenCalledWith('one more thing')
  })
})

describe('onAppChatConversationChange', () => {
  beforeEach(() => {
    rounds.clear()
    consumers.clear()
  })

  it('is told when a start ends, a stop is asked for, and the sink reports a round change', () => {
    const changed: string[] = []
    const unsubscribe = onAppChatConversationChange((conversationId) => changed.push(conversationId))

    const start = beginAppChatTurnStart(CONVO)
    expect(changed).toEqual([])
    cancelAppChatTurnStarts(CONVO)
    start.end()
    start.end()
    sinkEvents.emit(CONVO)
    unsubscribe()
    sinkEvents.emit(CONVO)

    expect(changed).toEqual([CONVO, CONVO, CONVO])
  })

  it('keeps telling the others when one listener throws', () => {
    const changed: string[] = []
    const first = onAppChatConversationChange(() => {
      throw new Error('broken listener')
    })
    const second = onAppChatConversationChange((conversationId) => changed.push(conversationId))

    beginAppChatTurnStart(CONVO).end()
    first()
    second()

    expect(changed).toEqual([CONVO])
  })
})
