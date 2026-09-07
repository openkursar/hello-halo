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

import { describe, it, expect, beforeEach, vi } from 'vitest'

const { v2Sessions } = vi.hoisted(() => ({ v2Sessions: new Map<string, any>() }))
const { writeTrigger } = vi.hoisted(() => ({ writeTrigger: vi.fn() }))
const { rounds, consumers } = vi.hoisted(() => ({
  rounds: new Set<string>(),
  consumers: new Map<string, any>(),
}))

vi.mock('../../../../src/main/services/agent/session-manager', () => ({
  v2Sessions,
  getConsumerHandle: (conversationId: string) => consumers.get(conversationId),
}))

vi.mock('../../../../src/main/apps/runtime/app-chat-sink', () => ({
  hasActiveAppChatRound: (conversationId: string) => rounds.has(conversationId),
  peekAppChatSink: (conversationId: string) =>
    conversationId === 'convo-with-sink' ? { writeUserMessage: writeTrigger } : undefined,
}))

import {
  injectIntoAppChat,
  isAppChatConversationGenerating,
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
