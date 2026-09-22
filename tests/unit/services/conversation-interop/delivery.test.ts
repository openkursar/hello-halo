/**
 * Unit tests for conversation-interop/delivery — the turn-gate-backed
 * delivery gate and its persistence patch.
 *
 * `sendMessage` and `conversation.service` are mocked with a small in-memory
 * store that mimics the real shape closely enough to prove the sequence: the
 * mocked `sendMessage` itself appends a `role:'user'` message (exactly what
 * the real one does internally, id included), and the dispatch hook must
 * patch that exact message — by id, via a mocked `updateMessageById` that
 * mirrors the real one's "re-read then mutate in place" contract — into the
 * delivered shape afterward. `pending-wait` and `circuit-breaker` are the REAL
 * modules (pure, deterministic) — each test uses distinct conversation ids
 * so their shared module-level state never interferes across cases.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

interface FakeMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  source?: string
  metadata?: Record<string, unknown>
}
interface FakeConversation {
  id: string
  spaceId: string
  title: string
  messages: FakeMessage[]
}

const { store, sendMessage, isNativeConversationBusy, hasLiveNativeSession } = vi.hoisted(() => {
  const store = new Map<string, FakeConversation>()
  let nextMessageId = 0
  const sendMessage = vi.fn(async (params: { spaceId: string; conversationId: string; message: string }) => {
    const conv = store.get(params.conversationId)
    if (!conv) throw new Error('conversation not found')
    conv.messages.push({ id: `msg-${nextMessageId++}`, role: 'user', content: params.message })
  })
  const isNativeConversationBusy = vi.fn((_conversationId: string) => false)
  // Defaults to true so existing tests (none of which exercise the
  // crashed-before-init recovery path) never trip reclaimLeakedReservation.
  const hasLiveNativeSession = vi.fn((_conversationId: string) => true)
  return { store, sendMessage, isNativeConversationBusy, hasLiveNativeSession }
})

function seed(id: string, title: string): FakeConversation {
  const conv: FakeConversation = { id, spaceId: 'space-1', title, messages: [] }
  store.set(id, conv)
  return conv
}

vi.mock('../../../../src/main/services/agent/send-message', () => ({ sendMessage }))

vi.mock('../../../../src/main/services/conversation.service', () => ({
  getConversation: (_spaceId: string, id: string) => store.get(id) ?? null,
  updateMessageById: (_spaceId: string, id: string, messageId: string, patch: Partial<FakeMessage>) => {
    const conv = store.get(id)
    if (!conv) return null
    const index = conv.messages.findIndex((m) => m.id === messageId)
    if (index === -1) return null
    conv.messages[index] = { ...conv.messages[index], ...patch }
    return conv.messages[index]
  },
  addMessage: (_spaceId: string, id: string, message: Omit<FakeMessage, 'id'>) => {
    const conv = store.get(id)
    if (!conv) throw new Error('conversation not found')
    const withId = { id: `notice-${conv.messages.length}`, ...message }
    conv.messages.push(withId)
    return withId
  },
}))

vi.mock('../../../../src/main/services/conversation-interop/busy', () => ({ isNativeConversationBusy, hasLiveNativeSession }))

import {
  deliverToConversation,
  deliverToConversationAndWait,
  deliverExternalMessage,
  tryResolveAsReply,
  releaseConversationTurn,
  drainConversationTurn,
} from '../../../../src/main/services/conversation-interop/delivery'

describe('deliverToConversation', () => {
  beforeEach(() => {
    store.clear()
    sendMessage.mockClear()
    isNativeConversationBusy.mockReturnValue(false)
    hasLiveNativeSession.mockReturnValue(true)
  })

  it('refuses a self-targeted delivery', async () => {
    seed('A', 'Self')
    const result = await deliverToConversation({
      spaceId: 'space-1',
      fromConversationId: 'A',
      toConversationId: 'A',
      message: 'hi',
      summary: 's',
    })
    expect(result).toEqual({ ok: false, reason: 'self_target' })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('reports not_found for a target that does not exist', async () => {
    seed('A', 'Source')
    const result = await deliverToConversation({
      spaceId: 'space-1',
      fromConversationId: 'A',
      toConversationId: 'missing',
      message: 'hi',
      summary: 's',
    })
    expect(result).toEqual({ ok: false, reason: 'not_found' })
  })

  it('dispatches immediately on an idle target and patches the message into the delivered shape', async () => {
    seed('src-1', 'Source Thread')
    const target = seed('tgt-1', 'Target Thread')

    const result = await deliverToConversation({
      spaceId: 'space-1',
      fromConversationId: 'src-1',
      toConversationId: 'tgt-1',
      message: 'the exact words',
      summary: 'a short summary',
    })

    expect(result.ok).toBe(true)
    if (!result.ok || result.status !== 'delivered') throw new Error('expected a delivered result')
    expect(sendMessage).toHaveBeenCalledTimes(1)

    expect(target.messages).toHaveLength(1)
    const persisted = target.messages[0]
    // The result reports the message's REAL persisted id — not a
    // synthesized placeholder unrelated to anything on disk.
    expect(result.messageId).toBe(persisted.id)
    // Delivered shape: role/system, source, metadata — never role:'user' left over.
    expect(persisted.role).toBe('system')
    expect(persisted.source).toBe('cross-conversation')
    expect(persisted.content).toBe('the exact words')
    expect(persisted.metadata).toEqual({
      fromConversationId: 'src-1',
      fromConversationTitle: 'Source Thread',
      summary: 'a short summary',
      forwardDepth: 0,
    })

    // The model-facing text (what sendMessage actually received) carries the
    // non-authorization framing; the PERSISTED content stays the raw message.
    const sentText = sendMessage.mock.calls[0][0].message as string
    expect(sentText).toContain('the exact words')
    expect(sentText).toContain('not from your user')
    expect(sentText).not.toBe('the exact words')
  })

  it('does not lose a message the running turn concurrently appends while the delivery patch is in flight', async () => {
    // `sendMessage` "returns immediately" (per its own doc) while the turn it
    // started keeps running — the session consumer can append its own
    // assistant placeholder at any moment after that. This simulates the
    // worst case: it has ALREADY landed by the time this hook reads back.
    // A read-snapshot-then-write-the-whole-array approach would silently
    // revert it; id-keyed `updateMessageById` must not.
    seed('src-race', 'Source')
    const target = seed('tgt-race', 'Target')
    sendMessage.mockImplementationOnce(async (params: { conversationId: string; message: string }) => {
      const conv = store.get(params.conversationId)!
      conv.messages.push({ id: 'user-msg', role: 'user', content: params.message })
      conv.messages.push({ id: 'assistant-placeholder', role: 'assistant', content: '' })
    })

    const result = await deliverToConversation({
      spaceId: 'space-1',
      fromConversationId: 'src-race',
      toConversationId: 'tgt-race',
      message: 'hello',
      summary: 's',
    })

    expect(result).toMatchObject({ ok: true, status: 'delivered', messageId: 'user-msg' })
    expect(target.messages).toHaveLength(2)
    // The concurrently-appended message survives, completely untouched.
    expect(target.messages[1]).toEqual({ id: 'assistant-placeholder', role: 'assistant', content: '' })
    // Only the original message (found by id, not by array position) was patched.
    expect(target.messages[0].id).toBe('user-msg')
    expect(target.messages[0].role).toBe('system')
    expect(target.messages[0].source).toBe('cross-conversation')
  })

  it(
    'releases the turn-gate slot on turn-end so a SECOND delivery to the SAME recipient also ' +
      'dispatches immediately — the P0 regression: without releasing, turn-gate keeps the slot ' +
      'reserved forever after a successful dispatch (isBusy is already false again, but the ' +
      'reservation is a separate bit only release() clears), so every later delivery to that ' +
      'recipient would buffer, never dispatch',
    async () => {
      seed('src-twice', 'Source')
      seed('tgt-twice', 'Target')

      const first = await deliverToConversation({
        spaceId: 'space-1',
        fromConversationId: 'src-twice',
        toConversationId: 'tgt-twice',
        message: 'first',
        summary: 's',
      })
      expect(first).toMatchObject({ ok: true, status: 'delivered' })
      expect(sendMessage).toHaveBeenCalledTimes(1)

      // Without a release, the slot from the first dispatch is still held —
      // this is the bug in isolation: a second delivery right now only ever
      // buffers, exactly like a permanently busy target.
      const stillReserved = await deliverToConversation({
        spaceId: 'space-1',
        fromConversationId: 'src-twice',
        toConversationId: 'tgt-twice',
        message: 'would buffer forever pre-fix',
        summary: 's',
      })
      expect(stillReserved).toMatchObject({ ok: true, status: 'queued' })
      expect(sendMessage).toHaveBeenCalledTimes(1)

      // turn-end-watch.ts's fix: release (awaiting any in-flight dispatch),
      // then its own bookkeeping, then drain — draining now dispatches the
      // buffered message from the previous step.
      await releaseConversationTurn('tgt-twice')
      drainConversationTurn('tgt-twice')
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2))

      // And a THIRD delivery, after that turn also ends, dispatches immediately
      // again — proving this is not a one-time unstick but the slot genuinely
      // cycles free on every turn end, as it must for a long-lived conversation.
      await releaseConversationTurn('tgt-twice')
      drainConversationTurn('tgt-twice')
      const third = await deliverToConversation({
        spaceId: 'space-1',
        fromConversationId: 'src-twice',
        toConversationId: 'tgt-twice',
        message: 'third',
        summary: 's',
      })
      expect(third).toMatchObject({ ok: true, status: 'delivered' })
      expect(sendMessage).toHaveBeenCalledTimes(3)
    }
  )

  it(
    'reclaims a leaked reservation before a new delivery when the target has no live session and ' +
      'nothing of ours is in flight — the crashed-before-system:init case, where no ' +
      'agent:complete/agent:error ever fires so releaseConversationTurn is never called at all',
    async () => {
      seed('src-leak', 'Source')
      seed('tgt-leak', 'Target')

      const first = await deliverToConversation({
        spaceId: 'space-1',
        fromConversationId: 'src-leak',
        toConversationId: 'tgt-leak',
        message: 'first, then the target crashes before system:init',
        summary: 's',
      })
      expect(first).toMatchObject({ ok: true, status: 'delivered' })

      // Nothing ever tells turn-gate this turn ended — no release call
      // happens. The target's session is gone (crashed/torn down) and, in
      // this mock, its dispatch already settled, so nothing of ours is
      // in-flight for it either: exactly the two conditions that make the
      // reservation provably a phantom.
      hasLiveNativeSession.mockReturnValue(false)

      const second = await deliverToConversation({
        spaceId: 'space-1',
        fromConversationId: 'src-leak',
        toConversationId: 'tgt-leak',
        message: 'second, must not buffer behind a slot nobody will ever release',
        summary: 's',
      })
      expect(second).toMatchObject({ ok: true, status: 'delivered' })
      expect(sendMessage).toHaveBeenCalledTimes(2)
    }
  )

  it(
    'does NOT reclaim a reservation while a dispatch of ours is still genuinely in flight, even ' +
      'if the target reports no live session yet (the pre-system:init window)',
    async () => {
      seed('src-inflight', 'Source')
      seed('tgt-inflight', 'Target')

      let resolveSend: () => void = () => {}
      sendMessage.mockImplementationOnce(
        (params: { conversationId: string; message: string }) =>
          new Promise<void>((resolve) => {
            resolveSend = () => {
              store.get(params.conversationId)!.messages.push({ id: 'inflight-msg', role: 'user', content: params.message })
              resolve()
            }
          })
      )
      // The target has no live V2 session YET (this is the real window: a
      // session is only registered once the turn gets far enough) — this
      // must NOT be mistaken for a leak while our own dispatch is still
      // genuinely running.
      hasLiveNativeSession.mockReturnValue(false)

      const firstDelivery = deliverToConversation({
        spaceId: 'space-1',
        fromConversationId: 'src-inflight',
        toConversationId: 'tgt-inflight',
        message: 'still starting',
        summary: 's',
      })
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))

      // A second delivery attempt right now must queue, not steal the slot —
      // reclaimLeakedReservation must see inFlightDispatch still holds this
      // conversationId and refuse to touch it.
      const second = await deliverToConversation({
        spaceId: 'space-1',
        fromConversationId: 'src-inflight',
        toConversationId: 'tgt-inflight',
        message: 'must queue behind the still-starting turn',
        summary: 's',
      })
      expect(second).toMatchObject({ ok: true, status: 'queued' })
      expect(sendMessage).toHaveBeenCalledTimes(1)

      resolveSend()
      await firstDelivery
    }
  )

  it(
    'reclaiming a leaked reservation drains real mail buffered behind the phantom BEFORE the ' +
      "new delivery gets the slot — turnGate.deliver() never checks the mailbox, so release " +
      'without an immediate drain would let the new delivery cut ahead of mail that was already ' +
      'legitimately queued there',
    async () => {
      seed('src-fifo-1', 'First sender')
      seed('src-fifo-2', 'Second sender (queued behind the phantom)')
      seed('src-fifo-3', 'Third sender (triggers reclaim)')
      seed('tgt-fifo', 'Target')

      // First delivery dispatches and then the target "crashes" — nothing
      // ever releases this reservation.
      const first = await deliverToConversation({
        spaceId: 'space-1',
        fromConversationId: 'src-fifo-1',
        toConversationId: 'tgt-fifo',
        message: 'first, then crash',
        summary: 's',
      })
      expect(first).toMatchObject({ ok: true, status: 'delivered' })

      // A second delivery arrives while the (phantom) reservation still
      // holds — it queues, exactly as real mail arriving during the crash
      // window would.
      const second = await deliverToConversation({
        spaceId: 'space-1',
        fromConversationId: 'src-fifo-2',
        toConversationId: 'tgt-fifo',
        message: 'queued behind the phantom, must go out FIRST',
        summary: 's',
      })
      expect(second).toMatchObject({ ok: true, status: 'queued' })
      expect(sendMessage).toHaveBeenCalledTimes(1)

      // Now the crash is detected (no live session) and a third delivery
      // triggers reclaimLeakedReservation.
      hasLiveNativeSession.mockReturnValue(false)
      const third = await deliverToConversation({
        spaceId: 'space-1',
        fromConversationId: 'src-fifo-3',
        toConversationId: 'tgt-fifo',
        message: 'triggers reclaim — must NOT jump the queue',
        summary: 's',
      })

      // The second (older, legitimately queued) message must dispatch first —
      // reclaim's drain beat this delivery's own turnGate.deliver() to the slot.
      expect(sendMessage).toHaveBeenCalledTimes(2)
      expect(sendMessage.mock.calls[1][0].message).toContain('queued behind the phantom')
      // This delivery itself must have queued behind the just-drained mail,
      // not dispatched immediately — a real cut-the-line would show 'delivered' here.
      expect(third).toMatchObject({ ok: true, status: 'queued' })
    }
  )

  it(
    'drains mail buffered behind an ORDINARY turn once it ends — release for a conversation ' +
      'this module never dispatched to must still let drain go through, or mail queued behind ' +
      "a plain user turn (not a delivery) would be stuck forever, since drain is the ONLY thing " +
      'that ever re-attempts it',
    async () => {
      seed('src-ord', 'Source')
      seed('tgt-ord', 'Target')
      // Busy for a reason that has nothing to do with any delivery — an
      // ordinary user turn is already running on the target.
      isNativeConversationBusy.mockImplementation((id: string) => id === 'tgt-ord')

      const queued = await deliverToConversation({
        spaceId: 'space-1',
        fromConversationId: 'src-ord',
        toConversationId: 'tgt-ord',
        message: 'queued behind a plain user turn',
        summary: 's',
      })
      expect(queued).toMatchObject({ ok: true, status: 'queued' })
      expect(sendMessage).not.toHaveBeenCalled()

      // The ordinary turn ends. turn-end-watch.ts calls release then drain
      // for EVERY agent:complete on EVERY conversation, including this one,
      // even though this turn-gate instance never reserved tgt-ord for
      // anyone. Release must no-op (nothing here was ever "ours" to give
      // back) — but drain must still fire unconditionally, or this mail
      // never moves.
      isNativeConversationBusy.mockReturnValue(false)
      await releaseConversationTurn('tgt-ord')
      drainConversationTurn('tgt-ord')

      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    }
  )

  it(
    'releasing a conversation this module never dispatched to is a no-op that does not disturb ' +
      "a DIFFERENT conversation's own still-open reservation",
    async () => {
      seed('src-scope-a', 'A')
      seed('src-scope-b', 'B')
      const active = seed('tgt-scope-active', 'Active target')
      seed('tgt-scope-untouched', 'Untouched target') // no delivery has ever targeted this one

      const delivered = await deliverToConversation({
        spaceId: 'space-1',
        fromConversationId: 'src-scope-a',
        toConversationId: 'tgt-scope-active',
        message: 'still running',
        summary: 's',
      })
      expect(delivered).toMatchObject({ ok: true, status: 'delivered' })

      // turn-end-watch fires release+drain for every conversation's turns,
      // including ones with no delivery history at all.
      await releaseConversationTurn('tgt-scope-untouched')
      drainConversationTurn('tgt-scope-untouched')

      // tgt-scope-active's reservation must be untouched by the above: while
      // it still reads busy, a second delivery to it queues rather than
      // dispatching.
      isNativeConversationBusy.mockImplementation((id: string) => id === 'tgt-scope-active')
      const second = await deliverToConversation({
        spaceId: 'space-1',
        fromConversationId: 'src-scope-b',
        toConversationId: 'tgt-scope-active',
        message: 'must still queue',
        summary: 's',
      })
      expect(second).toMatchObject({ ok: true, status: 'queued' })
      expect(active.messages).toHaveLength(1)
    }
  )

  it('queues behind a busy target instead of dispatching, and reports status=queued', async () => {
    seed('src-2', 'Source')
    const target = seed('tgt-2', 'Busy Target')
    isNativeConversationBusy.mockImplementation((id: string) => id === 'tgt-2')

    const result = await deliverToConversation({
      spaceId: 'space-1',
      fromConversationId: 'src-2',
      toConversationId: 'tgt-2',
      message: 'queued message',
      summary: 's',
    })

    expect(result).toMatchObject({ ok: true, status: 'queued' })
    expect(sendMessage).not.toHaveBeenCalled()
    expect(target.messages).toHaveLength(0)
  })

  it('rejects a message over the size ceiling as too_large, without calling sendMessage', async () => {
    seed('src-3', 'Source')
    seed('tgt-3', 'Target')

    const result = await deliverToConversation({
      spaceId: 'space-1',
      fromConversationId: 'src-3',
      toConversationId: 'tgt-3',
      message: 'x'.repeat(32_001),
      summary: 's',
    })

    expect(result).toEqual({ ok: false, reason: 'too_large' })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('rejects a forward chain past the depth ceiling as circuit_open', async () => {
    seed('src-4', 'Source')
    seed('tgt-4', 'Target')

    const result = await deliverToConversation({
      spaceId: 'space-1',
      fromConversationId: 'src-4',
      toConversationId: 'tgt-4',
      message: 'deep',
      summary: 's',
      forwardDepth: 7,
    })

    expect(result).toEqual({ ok: false, reason: 'circuit_open' })
  })

  it('trips the pair rate limit as circuit_open after repeated sends', async () => {
    seed('src-5', 'Source')
    seed('tgt-5', 'Target')

    let lastResult
    for (let i = 0; i < 21; i++) {
      isNativeConversationBusy.mockReturnValue(true) // keep queuing so each attempt only charges the breaker, not exhausting the mailbox cap differently
      lastResult = await deliverToConversation({
        spaceId: 'space-1',
        fromConversationId: 'src-5',
        toConversationId: 'tgt-5',
        message: `msg-${i}`,
        summary: 's',
      })
    }
    expect(lastResult).toEqual({ ok: false, reason: 'circuit_open' })
  })

  it('rejects as queue_full once the target mailbox reaches its cap (50), never silently shedding', async () => {
    const target = seed('tgt-full', 'Target')
    isNativeConversationBusy.mockReturnValue(true)
    // Distinct source per send so neither the pair nor the per-source rate
    // limit trips before the mailbox cap does.
    for (let i = 0; i < 50; i++) {
      seed(`src-full-${i}`, `Source ${i}`)
      const result = await deliverToConversation({
        spaceId: 'space-1',
        fromConversationId: `src-full-${i}`,
        toConversationId: 'tgt-full',
        message: `msg-${i}`,
        summary: 's',
      })
      expect(result).toMatchObject({ ok: true, status: 'queued' })
    }

    seed('src-full-overflow', 'Overflow source')
    const overflow = await deliverToConversation({
      spaceId: 'space-1',
      fromConversationId: 'src-full-overflow',
      toConversationId: 'tgt-full',
      message: 'one too many',
      summary: 's',
    })
    expect(overflow).toEqual({ ok: false, reason: 'queue_full' })
    expect(target.messages).toHaveLength(0) // nothing dispatched yet — still parked behind the busy target
  })

  it('maps a dispatch failure to unreachable', async () => {
    seed('src-6', 'Source')
    seed('tgt-6', 'Target')
    sendMessage.mockRejectedValueOnce(new Error('spawn failed'))

    const result = await deliverToConversation({
      spaceId: 'space-1',
      fromConversationId: 'src-6',
      toConversationId: 'tgt-6',
      message: 'hello',
      summary: 's',
    })

    expect(result).toEqual({ ok: false, reason: 'unreachable' })
  })

  it('a plain send that answers an existing pending-wait is consumed as a reply — never persisted or queued', async () => {
    seed('waiter-p', 'Waiter')
    const target = seed('target-p', 'Target')

    const waitPromise = deliverToConversationAndWait({
      spaceId: 'space-1',
      fromConversationId: 'waiter-p',
      toConversationId: 'target-p',
      message: 'question',
      summary: 's',
      timeoutMs: 5000,
    })
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled())
    const messagesBeforeReply = target.messages.length

    // target-p answers with a plain, non-wait conversation_send.
    const replyResult = await deliverToConversation({
      spaceId: 'space-1',
      fromConversationId: 'target-p',
      toConversationId: 'waiter-p',
      message: 'the answer',
      summary: 's',
    })

    expect(replyResult).toEqual({ ok: true, status: 'resolved_pending_wait' })
    // Nothing new was persisted into target-p's OWN conversation by this check.
    expect(target.messages).toHaveLength(messagesBeforeReply)
    await expect(waitPromise).resolves.toEqual({ ok: true, outcome: { status: 'replied', message: 'the answer' } })
  })

  it('resolving a pending-wait is exempt from the circuit breaker even mid-cooldown', async () => {
    seed('waiter-q', 'Waiter')
    const target = seed('target-q', 'Target')

    // Trip the pair breaker from target-q back to waiter-q first, so a plain
    // send along that exact pair would normally be hard-rejected.
    for (let i = 0; i < 21; i++) {
      await deliverToConversation({
        spaceId: 'space-1',
        fromConversationId: 'target-q',
        toConversationId: 'waiter-q',
        message: `spam-${i}`,
        summary: 's',
      })
    }
    const tripped = await deliverToConversation({
      spaceId: 'space-1',
      fromConversationId: 'target-q',
      toConversationId: 'waiter-q',
      message: 'would be rejected',
      summary: 's',
    })
    expect(tripped).toEqual({ ok: false, reason: 'circuit_open' })

    // Now waiter-q asks target-q a question and blocks on it.
    const waitPromise = deliverToConversationAndWait({
      spaceId: 'space-1',
      fromConversationId: 'waiter-q',
      toConversationId: 'target-q',
      message: 'are you stuck?',
      summary: 's',
      timeoutMs: 5000,
    })
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'target-q' })))

    // target-q replies along the SAME cooling-down pair (target-q -> waiter-q)
    // — this must go through as a reply, not be caught by the breaker.
    const replyResult = await deliverToConversation({
      spaceId: 'space-1',
      fromConversationId: 'target-q',
      toConversationId: 'waiter-q',
      message: 'yes, blocked on X',
      summary: 's',
    })
    expect(replyResult).toEqual({ ok: true, status: 'resolved_pending_wait' })
    await expect(waitPromise).resolves.toEqual({
      ok: true,
      outcome: { status: 'replied', message: 'yes, blocked on X' },
    })
    void target
  })

  it('writes a one-time cooldown notice into the SOURCE conversation on the pair-limit transition, not on repeats', async () => {
    const source = seed('notice-src', 'Notice Source')
    seed('notice-tgt', 'Notice Target')

    let last
    for (let i = 0; i < 22; i++) {
      last = await deliverToConversation({
        spaceId: 'space-1',
        fromConversationId: 'notice-src',
        toConversationId: 'notice-tgt',
        message: `m-${i}`,
        summary: 's',
      })
    }
    expect(last).toEqual({ ok: false, reason: 'circuit_open' })

    const notices = source.messages.filter((m) => m.source === 'cross-conversation-notice')
    expect(notices).toHaveLength(1)
    expect(notices[0].role).toBe('system')
    expect(notices[0].content).toContain('Notice Target')
    expect(notices[0].content).toContain('5 minutes')
  })
})

describe('deliverToConversationAndWait', () => {
  beforeEach(() => {
    store.clear()
    sendMessage.mockClear()
    isNativeConversationBusy.mockReturnValue(false)
    hasLiveNativeSession.mockReturnValue(true)
  })

  it('resolves with the reply once the target explicitly sends one back', async () => {
    seed('waiter-1', 'Waiter')
    seed('target-1', 'Target')

    const waitPromise = deliverToConversationAndWait({
      spaceId: 'space-1',
      fromConversationId: 'waiter-1',
      toConversationId: 'target-1',
      message: 'what is the status?',
      summary: 'status check',
      timeoutMs: 5000,
    })

    // Let the dispatch (idle target) run and arm the correlation.
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled())

    const consumed = tryResolveAsReply('target-1', 'waiter-1', 'all good here')
    expect(consumed).toBe(true)

    const result = await waitPromise
    expect(result).toEqual({ ok: true, outcome: { status: 'replied', message: 'all good here' } })
  })

  it('a direct 2-party "mutual wait" is resolved as a reply, not rejected — see the next test for why', async () => {
    // With the reply-check running FIRST, a message B sends to A while B's
    // turn is the one A's delivery started is ALWAYS consumed as B's reply to
    // A, whether or not B tags it waitForReply:true — so the naive "both wait
    // on each other" shape can no longer even be constructed through
    // delivery.ts; it resolves cleanly instead of deadlocking OR erroring.
    // Genuine mutual-wait rejection is still reachable, just one hop further
    // out — see the ring test below.
    seed('a-1', 'A')
    seed('b-1', 'B')

    const bWaitsOnA = deliverToConversationAndWait({
      spaceId: 'space-1',
      fromConversationId: 'b-1',
      toConversationId: 'a-1',
      message: 'question from B',
      summary: 's',
      timeoutMs: 5000,
    })
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'a-1' })))

    const aRepliesWithWait = await deliverToConversationAndWait({
      spaceId: 'space-1',
      fromConversationId: 'a-1',
      toConversationId: 'b-1',
      message: 'question from A',
      summary: 's',
      timeoutMs: 5000,
    })

    expect(aRepliesWithWait).toEqual({ ok: true, status: 'resolved_pending_wait' })
    await expect(bWaitsOnA).resolves.toEqual({ ok: true, outcome: { status: 'replied', message: 'question from A' } })
  })

  it('still refuses a genuine ring through the full delivery pipeline (A waits on B, B asks C instead of replying, C tries to wait back on A)', async () => {
    seed('ring-a', 'A')
    seed('ring-b', 'B')
    seed('ring-c', 'C')

    const aWaitsOnB = deliverToConversationAndWait({
      spaceId: 'space-1',
      fromConversationId: 'ring-a',
      toConversationId: 'ring-b',
      message: 'question from A',
      summary: 's',
      timeoutMs: 5000,
    })
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'ring-b' })))

    // B does NOT reply to A — it asks C instead (a different target, so the
    // reply-check does not intercept it), and blocks on C.
    const bWaitsOnC = deliverToConversationAndWait({
      spaceId: 'space-1',
      fromConversationId: 'ring-b',
      toConversationId: 'ring-c',
      message: 'question from B',
      summary: 's',
      timeoutMs: 5000,
    })
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'ring-c' })))

    // C, instead of replying to B, tries to wait on A — closing the ring.
    const cWaitsOnA = await deliverToConversationAndWait({
      spaceId: 'space-1',
      fromConversationId: 'ring-c',
      toConversationId: 'ring-a',
      message: 'question from C',
      summary: 's',
      timeoutMs: 5000,
    })
    expect(cWaitsOnA).toEqual({ ok: false, reason: 'mutual_wait' })

    // Clean up: C replies to B, B replies to A.
    const cReplies = await deliverToConversation({
      spaceId: 'space-1',
      fromConversationId: 'ring-c',
      toConversationId: 'ring-b',
      message: 'answer from C',
      summary: 's',
    })
    expect(cReplies).toEqual({ ok: true, status: 'resolved_pending_wait' })
    await expect(bWaitsOnC).resolves.toEqual({ ok: true, outcome: { status: 'replied', message: 'answer from C' } })

    const bReplies = await deliverToConversation({
      spaceId: 'space-1',
      fromConversationId: 'ring-b',
      toConversationId: 'ring-a',
      message: 'answer from B',
      summary: 's',
    })
    expect(bReplies).toEqual({ ok: true, status: 'resolved_pending_wait' })
    await expect(aWaitsOnB).resolves.toEqual({ ok: true, outcome: { status: 'replied', message: 'answer from B' } })
  })

  it("a waitForReply call that itself answers an existing wait is treated as a pure reply — its own wait is never registered", async () => {
    seed('x-1', 'X')
    seed('y-1', 'Y')

    const xWaitsOnY = deliverToConversationAndWait({
      spaceId: 'space-1',
      fromConversationId: 'x-1',
      toConversationId: 'y-1',
      message: 'question from X',
      summary: 's',
      timeoutMs: 5000,
    })
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled())

    // Y answers X, but does so via waitForReply itself (e.g. it wants X's ack
    // too) — hitting X's existing wait wins; Y's own wait must be denied
    // outright, not queued behind the mutual-wait guard.
    const yRepliesWithWait = await deliverToConversationAndWait({
      spaceId: 'space-1',
      fromConversationId: 'y-1',
      toConversationId: 'x-1',
      message: 'the answer, also please ack',
      summary: 's',
      timeoutMs: 5000,
    })

    expect(yRepliesWithWait).toEqual({ ok: true, status: 'resolved_pending_wait' })
    await expect(xWaitsOnY).resolves.toEqual({
      ok: true,
      outcome: { status: 'replied', message: 'the answer, also please ack' },
    })
  })
})

describe('deliverExternalMessage (team → coordinating conversation)', () => {
  beforeEach(() => {
    store.clear()
    sendMessage.mockClear()
    isNativeConversationBusy.mockReturnValue(false)
    hasLiveNativeSession.mockReturnValue(true)
  })

  it('sends the framed turn input and persists the raw content with the given source/metadata', async () => {
    const target = seed('ext-tgt-1', 'Space Thread')

    const result = await deliverExternalMessage({
      spaceId: 'space-1',
      toConversationId: 'ext-tgt-1',
      turnInput: '[Team message from researcher]\n\nBrief ready',
      persist: {
        content: 'Brief ready',
        source: 'team-message',
        metadata: { teamId: 'team-1', fromMemberName: 'researcher' },
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.status).toBe('delivered')
    // The model read the framed input…
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ message: '[Team message from researcher]\n\nBrief ready' })
    )
    // …but the transcript keeps the raw body as a system team message.
    const persisted = target.messages[0]
    expect(persisted.role).toBe('system')
    expect(persisted.source).toBe('team-message')
    expect(persisted.content).toBe('Brief ready')
    expect(persisted.metadata).toMatchObject({ teamId: 'team-1', fromMemberName: 'researcher' })
  })

  it('still patches the delivered turn when a concurrent append shifts it past the captured index', async () => {
    const target = seed('ext-tgt-shift', 'Racy Thread')
    // The running turn appends something BEFORE sendMessage persists the
    // delivered turn — a pure index read would patch the wrong message.
    sendMessage.mockImplementationOnce(async (params: { conversationId: string; message: string }) => {
      const conv = store.get(params.conversationId)!
      conv.messages.push({ id: 'assistant-early', role: 'assistant', content: 'streamed first' })
      conv.messages.push({ id: 'ext-user-msg', role: 'user', content: params.message })
    })

    const result = await deliverExternalMessage({
      spaceId: 'space-1',
      toConversationId: 'ext-tgt-shift',
      turnInput: '[Team message]\n\nshifted',
      persist: { content: 'shifted', source: 'team-message', metadata: { teamId: 'team-1' } },
    })

    expect(result).toMatchObject({ ok: true, status: 'delivered' })
    const patched = target.messages.find((m) => m.id === 'ext-user-msg')!
    expect(patched.role).toBe('system')
    expect(patched.source).toBe('team-message')
    expect(patched.content).toBe('shifted')
    // The concurrently appended assistant message is untouched.
    expect(target.messages.find((m) => m.id === 'assistant-early')).toEqual({
      id: 'assistant-early',
      role: 'assistant',
      content: 'streamed first',
    })
  })

  it('warns instead of failing silently when the delivered turn cannot be located', async () => {
    const target = seed('ext-tgt-miss', 'Miss Thread')
    // sendMessage "succeeds" but persists nothing matchable — the patch has
    // no target and the framing text would survive as a plain user bubble.
    sendMessage.mockImplementationOnce(async () => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const result = await deliverExternalMessage({
        spaceId: 'space-1',
        toConversationId: 'ext-tgt-miss',
        turnInput: '[Team message]\n\ngone',
        persist: { content: 'gone', source: 'team-message', metadata: {} },
      })

      expect(result).toMatchObject({ ok: true, status: 'delivered' })
      expect(target.messages).toHaveLength(0)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('external delivery patch missed'))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ext-tgt-miss'))
    } finally {
      warn.mockRestore()
    }
  })

  it('queues behind a busy conversation instead of interrupting it', async () => {
    seed('ext-tgt-2', 'Busy Thread')
    isNativeConversationBusy.mockReturnValue(true)

    const result = await deliverExternalMessage({
      spaceId: 'space-1',
      toConversationId: 'ext-tgt-2',
      turnInput: 'x',
      persist: { content: 'x', source: 'team-message', metadata: {} },
    })

    expect(result).toEqual({ ok: true, status: 'queued' })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('reports not_found for a vanished conversation', async () => {
    const result = await deliverExternalMessage({
      spaceId: 'space-1',
      toConversationId: 'missing-ext',
      turnInput: 'x',
      persist: { content: 'x', source: 'team-message', metadata: {} },
    })
    expect(result).toEqual({ ok: false, reason: 'not_found' })
  })
})
