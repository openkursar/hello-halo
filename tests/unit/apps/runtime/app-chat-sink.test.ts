/**
 * Unit tests for apps/runtime/app-chat-sink — turn ownership.
 *
 * The bug this pins: digital-human chat used to read the SDK stream once per
 * user message. A turn CC produced between messages (a background task
 * finishing, a team agent reporting) stayed queued in the pipe, and the next
 * message consumed it as if it were its own answer — every later reply then
 * lagged one turn behind, permanently.
 *
 * With continuous consumption, ownership is decided by order: a round enqueued
 * before a turn starts is claimed by that turn; a turn starting with an empty
 * queue is autonomous and must never settle somebody's round.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── Collaborators the sink reaches for on delivery / persistence ──
const { pushToChat, findSession } = vi.hoisted(() => ({
  pushToChat: vi.fn(() => true),
  findSession: vi.fn(() => ({ instanceId: 'inst-1' })),
}))

vi.mock('../../../../src/main/apps/runtime/im-session-registry', () => ({
  getImSessionRegistry: () => ({ findSession, clearPendingResume: vi.fn() }),
}))

vi.mock('../../../../src/main/apps/runtime/im-channels', () => ({
  getActiveImChannelManager: () => ({ getInstance: () => ({ pushToChat }) }),
}))

vi.mock('../../../../src/main/apps/runtime/session-store', () => ({
  openSessionWriter: () => ({ writeEvent: vi.fn(), writeTrigger: vi.fn() }),
  saveChatSessionId: vi.fn(),
}))

import {
  getAppChatSink,
  hasActiveAppChatRound,
  disposeAppChatSink,
} from '../../../../src/main/apps/runtime/app-chat-sink'

// ============================================
// Helpers
// ============================================

const IM_KEY = 'app-chat:app-1:wecom-bot:group:room-1'

function makeSink(conversationId = IM_KEY) {
  return getAppChatSink({
    appId: 'app-1',
    conversationId,
    runId: 'chat-wecom-bot-group-room-1',
    spacePath: '/tmp/space',
  })
}

/** A minimal StreamResult carrying one assistant text block's worth of reply. */
function makeResult(overrides: Record<string, unknown> = {}) {
  return {
    finalContent: '',
    hasMeaningfulContent: true,
    thoughts: [],
    tokenUsage: null,
    isInterrupted: false,
    wasAborted: false,
    hasErrorThought: false,
    reachedMaxTurns: false,
    firstEventReceived: true,
    drainTimedOut: false,
    ...overrides,
  } as never
}

/** Feed the sink one assistant text block, as processStream would. */
function feedText(sink: ReturnType<typeof makeSink>, text: string) {
  sink.onRawMessage({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
}

/**
 * Feed a thinking-only assistant envelope. Gateways behind OpenAI-compat
 * engines can stream reasoning without ever emitting a text block; the answer
 * then only exists in the terminal result. Pins the #299 shape.
 */
function feedThinkingOnly(sink: ReturnType<typeof makeSink>) {
  sink.onRawMessage({
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: 'reasoning about the request' }] },
  })
}

// ============================================
// Tests
// ============================================

describe('app-chat sink turn ownership', () => {
  beforeEach(() => {
    disposeAppChatSink(IM_KEY)
    pushToChat.mockClear()
    findSession.mockClear()
  })

  it('settles the round with the reply of the turn that follows it', async () => {
    const sink = makeSink()
    const onReply = vi.fn()

    const round = sink.beginRound({ onReply })
    sink.onTurnStart()
    feedText(sink, 'the answer')
    sink.onTurnComplete(makeResult())

    await expect(round.done).resolves.toBeUndefined()
    expect(onReply).toHaveBeenCalledWith('the answer')
    expect(pushToChat).not.toHaveBeenCalled()
  })

  it('pushes an autonomous turn to the IM chat instead of settling a round', () => {
    const sink = makeSink()

    sink.onTurnStart()
    feedText(sink, 'background task finished')
    sink.onTurnComplete(makeResult())

    expect(pushToChat).toHaveBeenCalledWith('room-1', 'background task finished', 'group')
  })

  it('settles a thinking-only round from result.finalContent when no text block was streamed', async () => {
    const sink = makeSink()
    const onReply = vi.fn()

    const round = sink.beginRound({ onReply })
    sink.onTurnStart()
    feedThinkingOnly(sink)
    sink.onTurnComplete(makeResult({ finalContent: 'the real answer' }))

    await expect(round.done).resolves.toBeUndefined()
    expect(onReply).toHaveBeenCalledWith('the real answer')
  })

  it('pushes result.finalContent for a thinking-only autonomous turn', () => {
    const sink = makeSink()

    sink.onTurnStart()
    feedThinkingOnly(sink)
    sink.onTurnComplete(makeResult({ finalContent: 'background answer' }))

    expect(pushToChat).toHaveBeenCalledWith('room-1', 'background answer', 'group')
  })

  it('does not let an autonomous turn answer the next message', async () => {
    // The exact reported failure: an unsolicited turn lands first, then the
    // user sends. The user's round must be settled by the NEXT turn's text.
    const sink = makeSink()
    const onReply = vi.fn()

    sink.onTurnStart()
    feedText(sink, 'autonomous output')
    sink.onTurnComplete(makeResult())

    const round = sink.beginRound({ onReply })
    sink.onTurnStart()
    feedText(sink, 'answer to the user')
    sink.onTurnComplete(makeResult())

    await round.done
    expect(onReply).toHaveBeenCalledTimes(1)
    expect(onReply).toHaveBeenCalledWith('answer to the user')
  })

  it('cannot be claimed by a turn that was already running when it was enqueued', async () => {
    const sink = makeSink()
    const onReply = vi.fn()

    sink.onTurnStart()             // autonomous turn already in flight
    feedText(sink, 'in-flight output')

    const round = sink.beginRound({ onReply })
    sink.onTurnComplete(makeResult())   // finishes the in-flight turn

    expect(onReply).not.toHaveBeenCalled()
    expect(pushToChat).toHaveBeenCalledWith('room-1', 'in-flight output', 'group')

    sink.onTurnStart()
    feedText(sink, 'real answer')
    sink.onTurnComplete(makeResult())

    await round.done
    expect(onReply).toHaveBeenCalledWith('real answer')
  })

  it('reports an active round from enqueue until its turn completes', () => {
    const sink = makeSink()
    expect(hasActiveAppChatRound(IM_KEY)).toBe(false)

    sink.beginRound({})
    expect(hasActiveAppChatRound(IM_KEY)).toBe(true)

    sink.onTurnStart()
    expect(hasActiveAppChatRound(IM_KEY)).toBe(true)

    sink.onTurnComplete(makeResult())
    expect(hasActiveAppChatRound(IM_KEY)).toBe(false)
  })

  it('fires onMessageAccepted once, only for a solicited turn', () => {
    const sink = makeSink()
    const onMessageAccepted = vi.fn()

    sink.onTurnStart()
    feedText(sink, 'autonomous')
    sink.onTurnComplete(makeResult())

    sink.beginRound({ onMessageAccepted })
    sink.onTurnStart()
    feedText(sink, 'a')
    feedText(sink, 'b')
    sink.onTurnComplete(makeResult())

    expect(onMessageAccepted).toHaveBeenCalledTimes(1)
  })

  it('rejects the round when the turn fails, so the caller can close its transport', async () => {
    const sink = makeSink()
    const round = sink.beginRound({})

    sink.onTurnStart()
    sink.onTurnError(new Error('engine crashed'))

    await expect(round.done).rejects.toThrow('engine crashed')
  })

  it('rejects an empty interrupted turn rather than leaving the caller waiting', async () => {
    const sink = makeSink()
    const round = sink.beginRound({})

    sink.onTurnStart()
    sink.onTurnComplete(makeResult({ isInterrupted: true, hasMeaningfulContent: false }))

    await expect(round.done).rejects.toThrow(/interrupted/i)
  })

  it('resolves an aborted turn without replying — the caller stopped it on purpose', async () => {
    const sink = makeSink()
    const onReply = vi.fn()
    const round = sink.beginRound({ onReply })

    sink.onTurnStart()
    sink.onTurnComplete(makeResult({ wasAborted: true, isInterrupted: true, hasMeaningfulContent: false }))

    await expect(round.done).resolves.toBeUndefined()
    expect(onReply).not.toHaveBeenCalled()
  })

  it('settles every outstanding round when the consumer stops', async () => {
    const sink = makeSink()
    const first = sink.beginRound({})
    const second = sink.beginRound({})

    sink.onTurnStart()          // first is claimed
    sink.onConsumerStopped()

    await expect(first.done).rejects.toThrow(/session ended/i)
    await expect(second.done).rejects.toThrow(/session ended/i)
  })

  it('does not push an autonomous turn for a native session', () => {
    const nativeKey = 'app-chat:app-1'
    disposeAppChatSink(nativeKey)
    const sink = makeSink(nativeKey)

    sink.onTurnStart()
    feedText(sink, 'autonomous output')
    sink.onTurnComplete(makeResult())

    expect(pushToChat).not.toHaveBeenCalled()
  })
})
