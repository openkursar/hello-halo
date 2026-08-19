/**
 * Unit tests for apps/runtime/im-channels/connection-arbiter.
 *
 * The arbiter is the pure decision core behind the WeCom "newest-connection-
 * wins" standby handling. These tests pin the contract the provider relies on:
 *
 *   1. Lone supersede → 'reconnect'; repeated supersedes within the window →
 *      'yield' (the storm breaker).
 *   2. Supersedes outside the window prune away and never accumulate to yield.
 *   3. Reconnect + probe delays grow exponentially, are capped, and are
 *      jittered within [0.5x, 1.5x) for symmetry breaking.
 *   4. reset / resetReconnectBackoff / resetProbeBackoff scope correctly.
 */

import { describe, it, expect } from 'vitest'
import {
  ConnectionArbiter,
  type ConnectionArbiterConfig,
} from '../../../../../src/main/apps/runtime/im-channels/connection-arbiter'

/** Deterministic config: threshold 3 within 60s, random fixed to 0.5 (→ 1.0x). */
function makeConfig(overrides: Partial<ConnectionArbiterConfig> = {}): ConnectionArbiterConfig {
  return {
    conflictWindowMs: 60_000,
    conflictThreshold: 3,
    reconnectBaseMs: 2_000,
    reconnectMaxMs: 15_000,
    probeBaseMs: 5_000,
    probeMaxMs: 900_000,
    random: () => 0.5, // jitter multiplier becomes 0.5 + 0.5 = 1.0 (no scaling)
    ...overrides,
  }
}

describe('ConnectionArbiter — supersede decisions', () => {
  it('returns reconnect for a lone supersede, yield once threshold is reached', () => {
    const a = new ConnectionArbiter(makeConfig())
    expect(a.recordSupersede(1_000)).toBe('reconnect') // 1
    expect(a.recordSupersede(2_000)).toBe('reconnect') // 2
    expect(a.recordSupersede(3_000)).toBe('yield')     // 3 → threshold
  })

  it('keeps yielding once the window stays saturated', () => {
    const a = new ConnectionArbiter(makeConfig())
    a.recordSupersede(1_000)
    a.recordSupersede(2_000)
    a.recordSupersede(3_000)
    expect(a.recordSupersede(4_000)).toBe('yield')
  })

  it('prunes supersedes older than the window so they never accumulate to yield', () => {
    const a = new ConnectionArbiter(makeConfig())
    // Two hits, then a long gap that pushes them out of the 60s window.
    expect(a.recordSupersede(0)).toBe('reconnect')
    expect(a.recordSupersede(10_000)).toBe('reconnect')
    // 100s later: both prior hits are stale, this is effectively the 1st again.
    expect(a.recordSupersede(110_000)).toBe('reconnect')
    expect(a.supersedeCount(110_000)).toBe(1)
  })

  it('honors a custom threshold', () => {
    const a = new ConnectionArbiter(makeConfig({ conflictThreshold: 2 }))
    expect(a.recordSupersede(1_000)).toBe('reconnect')
    expect(a.recordSupersede(2_000)).toBe('yield')
  })
})

describe('ConnectionArbiter — reconnect backoff', () => {
  it('grows exponentially from base and caps at max', () => {
    const a = new ConnectionArbiter(makeConfig())
    expect(a.nextReconnectDelay()).toBe(2_000)  // 2000 * 2^0
    expect(a.nextReconnectDelay()).toBe(4_000)  // 2^1
    expect(a.nextReconnectDelay()).toBe(8_000)  // 2^2
    expect(a.nextReconnectDelay()).toBe(15_000) // 2^3=16000 → capped
    expect(a.nextReconnectDelay()).toBe(15_000) // stays capped
  })

  it('resets reconnect backoff without touching probe backoff', () => {
    const a = new ConnectionArbiter(makeConfig())
    a.nextReconnectDelay() // → attempt 1
    a.nextProbeDelay()     // → probe attempt 1
    a.resetReconnectBackoff()
    expect(a.nextReconnectDelay()).toBe(2_000) // back to base
    expect(a.nextProbeDelay()).toBe(10_000)    // probe kept growing (5000 * 2^1)
  })
})

describe('ConnectionArbiter — probe backoff', () => {
  it('starts short and grows exponentially up to the cap', () => {
    const a = new ConnectionArbiter(makeConfig())
    expect(a.nextProbeDelay()).toBe(5_000)   // 2^0
    expect(a.nextProbeDelay()).toBe(10_000)  // 2^1
    expect(a.nextProbeDelay()).toBe(20_000)  // 2^2
    expect(a.nextProbeDelay()).toBe(40_000)  // 2^3
  })

  it('resetProbeBackoff makes the next probe fast again (fresh episode)', () => {
    const a = new ConnectionArbiter(makeConfig())
    a.nextProbeDelay()
    a.nextProbeDelay()
    a.resetProbeBackoff()
    expect(a.nextProbeDelay()).toBe(5_000)
  })

  it('full reset clears supersedes and both backoffs', () => {
    const a = new ConnectionArbiter(makeConfig())
    a.recordSupersede(1_000)
    a.nextReconnectDelay()
    a.nextProbeDelay()
    a.reset()
    expect(a.supersedeCount(1_000)).toBe(0)
    expect(a.nextReconnectDelay()).toBe(2_000)
    expect(a.nextProbeDelay()).toBe(5_000)
  })
})

describe('ConnectionArbiter — jitter', () => {
  it('scales delay within [0.5x, 1.5x) based on injected randomness', () => {
    const low = new ConnectionArbiter(makeConfig({ random: () => 0 }))
    expect(low.nextReconnectDelay()).toBe(1_000) // 2000 * 0.5

    const high = new ConnectionArbiter(makeConfig({ random: () => 0.999 }))
    // 2000 * (0.5 + 0.999) ≈ 2998
    expect(high.nextReconnectDelay()).toBe(Math.round(2_000 * 1.499))
  })
})
