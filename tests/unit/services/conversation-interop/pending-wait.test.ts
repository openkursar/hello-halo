/**
 * Unit tests for conversation-interop/pending-wait — the `waitForReply`
 * mechanism.
 *
 * Covers:
 * - a wait resolves ONLY via `tryResolveAsReply` for the correlation the
 *   target's CURRENT turn actually owes, never from an unrelated message
 *   between the same pair (the MISMATCH described in the module doc)
 * - registering a wait that would close a wait-for CYCLE back to the waiter
 *   is refused outright — both the direct 2-party case and a 3+ party ring
 *   (a direct-reverse-only guard misses the ring; this must not)
 * - `noteTurnEnded` produces `no_reply` and never carries content
 * - `abandonWait` fails a wait that never got dispatched
 * - `armActiveCorrelation`/`clearActiveCorrelation` settle a still-open STALE
 *   association as `no_reply` instead of silently orphaning it
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  registerWait,
  abandonWait,
  armActiveCorrelation,
  clearActiveCorrelation,
  tryResolveAsReply,
  noteTurnEnded,
} from '../../../../src/main/services/conversation-interop/pending-wait'

describe('pending-wait', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves via an explicit reply that matches the armed correlation', async () => {
    const registered = registerWait({ fromConversationId: 'A', toConversationId: 'B', timeoutMs: 5000 })
    expect(registered.ok).toBe(true)
    if (!registered.ok) return

    // The delivery dispatched: B's turn now owes this correlation an answer.
    armActiveCorrelation('B', registered.correlationId)

    const consumed = tryResolveAsReply('B', 'A', 'here is my answer')
    expect(consumed).toBe(true)

    const outcome = await registered.promise
    expect(outcome).toEqual({ status: 'replied', message: 'here is my answer' })
  })

  it('does NOT resolve from an unrelated message between the same pair (the mismatch bug)', async () => {
    const registered = registerWait({ fromConversationId: 'A', toConversationId: 'B', timeoutMs: 5000 })
    expect(registered.ok).toBe(true)
    if (!registered.ok) return

    // B's turn is NOT the one the delivery started (e.g. B is idle-chatting
    // with its own user, or answering someone else) — nothing armed it.
    const consumed = tryResolveAsReply('B', 'A', 'unrelated message')
    expect(consumed).toBe(false)

    // The wait is still open.
    abandonWait(registered.correlationId, { status: 'timeout' })
    const outcome = await registered.promise
    expect(outcome).toEqual({ status: 'timeout' })
  })

  it('does NOT resolve a reply aimed at someone other than the original waiter', async () => {
    const registered = registerWait({ fromConversationId: 'A', toConversationId: 'B', timeoutMs: 5000 })
    if (!registered.ok) throw new Error('expected registration to succeed')
    armActiveCorrelation('B', registered.correlationId)

    // B replies to C, not A — must not consume A's wait.
    const consumed = tryResolveAsReply('B', 'C', 'hello C')
    expect(consumed).toBe(false)

    abandonWait(registered.correlationId, { status: 'timeout' })
    await registered.promise
  })

  it('a later, unrelated turn on B cannot resolve a wait whose turn already ended', async () => {
    const registered = registerWait({ fromConversationId: 'A', toConversationId: 'B', timeoutMs: 5000 })
    if (!registered.ok) throw new Error('expected registration to succeed')
    armActiveCorrelation('B', registered.correlationId)

    // B's triggered turn ends without an explicit reply.
    noteTurnEnded('B')
    const outcome = await registered.promise
    expect(outcome).toEqual({ status: 'no_reply' })

    // A completely different, later turn on B (e.g. a plain delivery with no
    // wait) must not resolve anything — the correlation was already cleared.
    clearActiveCorrelation('B')
    const consumed = tryResolveAsReply('B', 'A', 'much later, unrelated')
    expect(consumed).toBe(false)
  })

  it('refuses a new wait when the target already has an unresolved wait on the source (direct 2-party cycle)', async () => {
    // B is already waiting on A.
    const bWaitsOnA = registerWait({ fromConversationId: 'B', toConversationId: 'A', timeoutMs: 5000 })
    expect(bWaitsOnA.ok).toBe(true)

    // A tries to wait on B in turn — this is the exact shape that deadlocks
    // (A blocked on B, B blocked on A) and must be refused, not queued.
    const aWaitsOnB = registerWait({ fromConversationId: 'A', toConversationId: 'B', timeoutMs: 5000 })
    expect(aWaitsOnB).toEqual({ ok: false, reason: 'mutual_wait' })

    if (bWaitsOnA.ok) abandonWait(bWaitsOnA.correlationId, { status: 'timeout' })
  })

  it('allows a wait once the reverse wait has already been resolved', async () => {
    const bWaitsOnA = registerWait({ fromConversationId: 'B', toConversationId: 'A', timeoutMs: 5000 })
    if (!bWaitsOnA.ok) throw new Error('expected registration to succeed')
    abandonWait(bWaitsOnA.correlationId, { status: 'timeout' })
    await bWaitsOnA.promise

    const aWaitsOnB = registerWait({ fromConversationId: 'A', toConversationId: 'B', timeoutMs: 5000 })
    expect(aWaitsOnB.ok).toBe(true)
    if (aWaitsOnB.ok) abandonWait(aWaitsOnB.correlationId, { status: 'timeout' })
  })

  it('refuses a wait that would close a 3-party ring (A waits on B, B waits on C, C tries to wait on A)', async () => {
    // A direct-reverse-only guard would miss this: registering C's wait on A
    // never looks at what B is doing. The fix walks the whole chain.
    const aOnB = registerWait({ fromConversationId: 'A', toConversationId: 'B', timeoutMs: 5000 })
    const bOnC = registerWait({ fromConversationId: 'B', toConversationId: 'C', timeoutMs: 5000 })
    expect(aOnB.ok).toBe(true)
    expect(bOnC.ok).toBe(true)

    const cOnA = registerWait({ fromConversationId: 'C', toConversationId: 'A', timeoutMs: 5000 })
    expect(cOnA).toEqual({ ok: false, reason: 'mutual_wait' })

    if (aOnB.ok) abandonWait(aOnB.correlationId, { status: 'timeout' })
    if (bOnC.ok) abandonWait(bOnC.correlationId, { status: 'timeout' })
  })

  it('does not over-reject a wait that shares a participant but does not close a cycle', async () => {
    // A waits on B, B waits on C — a legitimate chain. D waiting on A is
    // unrelated to it (D is not reachable by following A's own chain) and
    // must be allowed.
    const aOnB = registerWait({ fromConversationId: 'A', toConversationId: 'B', timeoutMs: 5000 })
    const bOnC = registerWait({ fromConversationId: 'B', toConversationId: 'C', timeoutMs: 5000 })
    expect(aOnB.ok).toBe(true)
    expect(bOnC.ok).toBe(true)

    const dOnA = registerWait({ fromConversationId: 'D', toConversationId: 'A', timeoutMs: 5000 })
    expect(dOnA.ok).toBe(true)

    if (aOnB.ok) abandonWait(aOnB.correlationId, { status: 'timeout' })
    if (bOnC.ok) abandonWait(bOnC.correlationId, { status: 'timeout' })
    if (dOnA.ok) abandonWait(dOnA.correlationId, { status: 'timeout' })
  })

  it('times out on its own when nothing resolves it', async () => {
    vi.useFakeTimers()
    try {
      const registered = registerWait({ fromConversationId: 'A', toConversationId: 'B', timeoutMs: 1000 })
      if (!registered.ok) throw new Error('expected registration to succeed')
      armActiveCorrelation('B', registered.correlationId)

      await vi.advanceTimersByTimeAsync(1001)
      const outcome = await registered.promise
      expect(outcome).toEqual({ status: 'timeout' })

      // The timeout also clears the armed correlation — a late reply attempt
      // after this point must not resolve anything (already settled).
      const consumed = tryResolveAsReply('B', 'A', 'too late')
      expect(consumed).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('abandonWait fails a wait that never got dispatched, without leaving it to the timeout', async () => {
    const registered = registerWait({ fromConversationId: 'A', toConversationId: 'B', timeoutMs: 120_000 })
    if (!registered.ok) throw new Error('expected registration to succeed')

    abandonWait(registered.correlationId, { status: 'timeout' })
    const outcome = await registered.promise
    expect(outcome).toEqual({ status: 'timeout' })
  })

  it('clearActiveCorrelation settles a still-open stale wait as no_reply instead of orphaning it', async () => {
    const registered = registerWait({ fromConversationId: 'A', toConversationId: 'B', timeoutMs: 5000 })
    if (!registered.ok) throw new Error('expected registration to succeed')
    armActiveCorrelation('B', registered.correlationId)

    // A plain, non-wait delivery dispatches on B next — the dispatch hook
    // clears the association since this new turn owes no one an answer. The
    // still-pending wait must not be left to hang until its own timeout.
    clearActiveCorrelation('B')
    const outcome = await registered.promise
    expect(outcome).toEqual({ status: 'no_reply' })

    // Nothing left armed for B — a later reply attempt resolves nothing.
    const consumed = tryResolveAsReply('B', 'A', 'still tries to reply')
    expect(consumed).toBe(false)
  })

  it('armActiveCorrelation settles a still-open stale correlation before overwriting it', async () => {
    const first = registerWait({ fromConversationId: 'A', toConversationId: 'B', timeoutMs: 5000 })
    if (!first.ok) throw new Error('expected registration to succeed')
    armActiveCorrelation('B', first.correlationId)

    // A second, unrelated wait gets armed on B before the first was ever
    // resolved (e.g. a relayed turn landing between two dispatches) — the
    // stale first wait must resolve as no_reply now, not hang silently.
    const second = registerWait({ fromConversationId: 'D', toConversationId: 'B', timeoutMs: 5000 })
    if (!second.ok) throw new Error('expected registration to succeed')
    armActiveCorrelation('B', second.correlationId)

    const firstOutcome = await first.promise
    expect(firstOutcome).toEqual({ status: 'no_reply' })

    // The second wait is the one now live for B.
    const consumed = tryResolveAsReply('B', 'D', 'answering the second one')
    expect(consumed).toBe(true)
    expect(await second.promise).toEqual({ status: 'replied', message: 'answering the second one' })
  })
})
