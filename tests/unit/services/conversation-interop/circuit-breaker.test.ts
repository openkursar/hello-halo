/**
 * Unit tests for conversation-interop/circuit-breaker.
 *
 * Its own sliding-window limiter — deliberately NOT the team's epoch-scoped
 * `chargeCircuit`, since an ordinary conversation has no run/epoch to reset
 * the budget on seal. Covers the pair limit, the per-source limit, forward
 * depth, message size, the sliding window actually sliding, the fixed
 * cooldown hard-stop (independent of window decay, `cooldownJustStarted`
 * fired exactly once per activation), and the inbound-forward-depth
 * bookkeeping used to carry depth across a delivery (native conversations
 * have no `TeamTriggerContext` equivalent).
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { createCircuitBreaker } from '../../../../src/main/services/conversation-interop/circuit-breaker'
import type { CircuitLimits } from '../../../../src/main/services/conversation-interop/circuit-breaker'

const BASE_LIMITS: CircuitLimits = {
  pairLimit: 100,
  sourceLimit: 100,
  windowMs: 60_000,
  cooldownMs: 5 * 60_000,
  maxForwardDepth: 6,
  maxMessageChars: 1000,
}

describe('circuit-breaker', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('allows sends under every limit', () => {
    const breaker = createCircuitBreaker({ ...BASE_LIMITS, pairLimit: 5, sourceLimit: 10, maxMessageChars: 100 })
    const result = breaker.checkAndCharge({
      fromConversationId: 'A',
      toConversationId: 'B',
      forwardDepth: 0,
      messageLength: 10,
    })
    expect(result).toEqual({ ok: true })
  })

  it('trips the PAIR limit before the source limit if the pair alone exceeds it', () => {
    const breaker = createCircuitBreaker({ ...BASE_LIMITS, pairLimit: 2 })
    const send = () => breaker.checkAndCharge({ fromConversationId: 'A', toConversationId: 'B', forwardDepth: 0, messageLength: 1 })
    expect(send()).toEqual({ ok: true })
    expect(send()).toEqual({ ok: true })
    expect(send()).toEqual({ ok: false, reason: 'pair_limit', cooldownJustStarted: true, cooldownMinutes: 5 })
  })

  it('trips the SOURCE limit for fan-out to many different targets (the pair limit alone would not catch it)', () => {
    const breaker = createCircuitBreaker({ ...BASE_LIMITS, sourceLimit: 2 })
    const sendTo = (target: string) =>
      breaker.checkAndCharge({ fromConversationId: 'A', toConversationId: target, forwardDepth: 0, messageLength: 1 })
    expect(sendTo('B')).toEqual({ ok: true })
    expect(sendTo('C')).toEqual({ ok: true })
    expect(sendTo('D')).toEqual({ ok: false, reason: 'source_limit', cooldownJustStarted: true, cooldownMinutes: 5 })
  })

  it('rejects a forward-chain deeper than the configured ceiling, with no cooldown', () => {
    const breaker = createCircuitBreaker(BASE_LIMITS)
    expect(
      breaker.checkAndCharge({ fromConversationId: 'A', toConversationId: 'B', forwardDepth: 6, messageLength: 1 })
    ).toEqual({ ok: true })
    expect(
      breaker.checkAndCharge({ fromConversationId: 'A', toConversationId: 'B', forwardDepth: 7, messageLength: 1 })
    ).toEqual({ ok: false, reason: 'forward_depth', cooldownJustStarted: false })

    // No cooldown state was established — an in-limit-depth send right after still succeeds.
    expect(
      breaker.checkAndCharge({ fromConversationId: 'A', toConversationId: 'B', forwardDepth: 0, messageLength: 1 })
    ).toEqual({ ok: true })
  })

  it('rejects an oversized message without charging any window', () => {
    const breaker = createCircuitBreaker({ ...BASE_LIMITS, pairLimit: 1, sourceLimit: 1, maxMessageChars: 10 })
    const result = breaker.checkAndCharge({
      fromConversationId: 'A',
      toConversationId: 'B',
      forwardDepth: 0,
      messageLength: 11,
    })
    expect(result).toEqual({ ok: false, reason: 'message_too_large', cooldownJustStarted: false })

    // The rejected oversized send did not consume the pair budget.
    expect(
      breaker.checkAndCharge({ fromConversationId: 'A', toConversationId: 'B', forwardDepth: 0, messageLength: 1 })
    ).toEqual({ ok: true })
  })

  it('the sliding window governs WHEN a breach trips, but the cooldown it starts does not decay early', async () => {
    vi.useFakeTimers()
    try {
      const breaker = createCircuitBreaker({ ...BASE_LIMITS, pairLimit: 1, windowMs: 1000, cooldownMs: 5000 })
      const send = () => breaker.checkAndCharge({ fromConversationId: 'A', toConversationId: 'B', forwardDepth: 0, messageLength: 1 })

      expect(send()).toEqual({ ok: true })
      expect(send()).toEqual({ ok: false, reason: 'pair_limit', cooldownJustStarted: true, cooldownMinutes: 5000 / 60_000 })

      // The 1s RATE window would have decayed by now, but the 5s COOLDOWN has not.
      await vi.advanceTimersByTimeAsync(1001)
      expect(send()).toEqual({ ok: false, reason: 'pair_limit', cooldownJustStarted: false })

      // Once the cooldown itself elapses, sends resume.
      await vi.advanceTimersByTimeAsync(4000)
      expect(send()).toEqual({ ok: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports cooldownJustStarted=false for every rejection after the first, so the caller writes the notice only once', () => {
    const breaker = createCircuitBreaker({ ...BASE_LIMITS, pairLimit: 1 })
    const send = () => breaker.checkAndCharge({ fromConversationId: 'A', toConversationId: 'B', forwardDepth: 0, messageLength: 1 })

    expect(send()).toEqual({ ok: true })
    expect(send()).toMatchObject({ ok: false, cooldownJustStarted: true })
    expect(send()).toMatchObject({ ok: false, cooldownJustStarted: false })
    expect(send()).toMatchObject({ ok: false, cooldownJustStarted: false })
  })

  it('a pair cooldown does not affect the source sending to a DIFFERENT target', () => {
    const breaker = createCircuitBreaker({ ...BASE_LIMITS, pairLimit: 1 })
    const sendToB = () => breaker.checkAndCharge({ fromConversationId: 'A', toConversationId: 'B', forwardDepth: 0, messageLength: 1 })
    const sendToC = () => breaker.checkAndCharge({ fromConversationId: 'A', toConversationId: 'C', forwardDepth: 0, messageLength: 1 })

    expect(sendToB()).toEqual({ ok: true })
    expect(sendToB()).toMatchObject({ ok: false, reason: 'pair_limit' }) // B is now cooling down

    expect(sendToC()).toEqual({ ok: true }) // unaffected — different pair
  })

  it('a source cooldown blocks ALL of that source\'s targets, not just the one that tripped it', () => {
    const breaker = createCircuitBreaker({ ...BASE_LIMITS, sourceLimit: 1 })
    const sendTo = (target: string) =>
      breaker.checkAndCharge({ fromConversationId: 'A', toConversationId: target, forwardDepth: 0, messageLength: 1 })

    expect(sendTo('B')).toEqual({ ok: true })
    expect(sendTo('C')).toMatchObject({ ok: false, reason: 'source_limit' })

    // A brand new target from the same source is blocked too — it's a source-wide cooldown.
    expect(sendTo('D')).toMatchObject({ ok: false, reason: 'source_limit', cooldownJustStarted: false })
  })

  it('fires onBreach with the reason and the (from, to) pair', () => {
    const breaker = createCircuitBreaker({ ...BASE_LIMITS, pairLimit: 1 })
    const breaches: Array<{ reason: string; fromConversationId: string; toConversationId: string }> = []
    breaker.onBreach((e) => breaches.push(e))

    breaker.checkAndCharge({ fromConversationId: 'A', toConversationId: 'B', forwardDepth: 0, messageLength: 1 })
    breaker.checkAndCharge({ fromConversationId: 'A', toConversationId: 'B', forwardDepth: 0, messageLength: 1 })

    expect(breaches).toEqual([{ reason: 'pair_limit', fromConversationId: 'A', toConversationId: 'B' }])
  })

  it('does not fire onBreach for an oversized message (checked before any window)', () => {
    const breaker = createCircuitBreaker({ ...BASE_LIMITS, maxMessageChars: 5 })
    const breaches: unknown[] = []
    breaker.onBreach((e) => breaches.push(e))
    breaker.checkAndCharge({ fromConversationId: 'A', toConversationId: 'B', forwardDepth: 0, messageLength: 999 })
    expect(breaches).toEqual([])
  })

  it('tracks and returns the inbound forward depth per conversation, defaulting to 0', () => {
    const breaker = createCircuitBreaker()
    expect(breaker.getInboundForwardDepth('B')).toBe(0)
    breaker.recordInboundForwardDepth('B', 3)
    expect(breaker.getInboundForwardDepth('B')).toBe(3)
    // Unrelated conversations are unaffected.
    expect(breaker.getInboundForwardDepth('C')).toBe(0)
  })
})
