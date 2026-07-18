/**
 * Unit tests for the Hybrid Logical Clock. The headline case is the causality
 * guarantee the previous "wall-clock primary + logical secondary" scheme failed:
 * a reply authored on a slow clock must still sort AFTER the message it replies
 * to. Also covers monotonicity, same-ms counter stepping, restart-seed
 * no-regress, bounded drift clamping, and encode/decode ordering.
 */

import { describe, it, expect } from 'vitest'
import {
  createHybridClock,
  encodeHlc,
  decodeHlc,
  compareHlc,
} from '../../../../../../src/main/apps/runtime/federation/log/hlc'

describe('HLC encoding', () => {
  it('round-trips parts and preserves numeric order lexicographically', () => {
    expect(decodeHlc(encodeHlc({ pt: 123456, c: 7 }))).toEqual({ pt: 123456, c: 7 })
    // Fixed width ⇒ string compare == numeric compare.
    expect(compareHlc(encodeHlc({ pt: 10, c: 5 }), encodeHlc({ pt: 10, c: 6 }))).toBe(-1)
    expect(compareHlc(encodeHlc({ pt: 9, c: 999 }), encodeHlc({ pt: 10, c: 0 }))).toBe(-1)
    expect(compareHlc(encodeHlc({ pt: 100, c: 0 }), encodeHlc({ pt: 100, c: 0 }))).toBe(0)
  })
})

describe('HLC causality (regression for the ts-primary sort bug)', () => {
  it('a reply on a slow clock still sorts after the message it replies to', () => {
    // B on a fast clock authors b at wall 10:00:05.
    let bWall = 5000
    const clockB = createHybridClock({ now: () => bWall })
    const hlcB = clockB.tick()

    // A on a clock 5s slow reads b, then authors the reply a.
    let aWall = 0
    const clockA = createHybridClock({ now: () => aWall })
    clockA.update(hlcB) // receive b — advances A's clock past b
    const hlcA = clockA.tick() // author the reply

    // Causal order holds even though A's wall time (0) < B's wall time (5000).
    expect(compareHlc(hlcA, hlcB)).toBe(1)
  })
})

describe('HLC local ticks', () => {
  it('is strictly monotonic and steps the counter within one ms', () => {
    let wall = 1000
    const clock = createHybridClock({ now: () => wall })
    const a = clock.tick()
    const b = clock.tick() // same ms → counter bumps
    wall = 1001
    const c = clock.tick() // ms advanced → counter resets, still greater
    expect(compareHlc(a, b)).toBe(-1)
    expect(compareHlc(b, c)).toBe(-1)
    expect(decodeHlc(a).c).toBe(0)
    expect(decodeHlc(b).c).toBe(1)
    expect(decodeHlc(c)).toEqual({ pt: 1001, c: 0 })
  })

  it('does not regress when wall clock moves backwards', () => {
    let wall = 2000
    const clock = createHybridClock({ now: () => wall })
    const a = clock.tick()
    wall = 1500 // clock jumped backwards
    const b = clock.tick()
    expect(compareHlc(b, a)).toBe(1) // pt held at 2000, counter bumped
    expect(decodeHlc(b).pt).toBe(2000)
  })
})

describe('HLC restart seed', () => {
  it('seeds from persisted high-water so a restart never regresses', () => {
    const seed = encodeHlc({ pt: 9_000, c: 3 })
    let wall = 1000 // wall is far behind the seed (e.g. persisted from earlier)
    const clock = createHybridClock({ now: () => wall, seed })
    const next = clock.tick()
    expect(compareHlc(next, seed)).toBe(1)
    expect(decodeHlc(next).pt).toBe(9_000)
  })
})

describe('HLC bounded drift', () => {
  it('clamps a remote clock that is implausibly far in the future', () => {
    let wall = 10_000
    let clamped = false
    const clock = createHybridClock({
      now: () => wall,
      maxDriftMs: 1000,
      onDriftClamp: () => {
        clamped = true
      },
    })
    const farFuture = encodeHlc({ pt: 10_000_000, c: 0 })
    const merged = clock.update(farFuture)
    expect(clamped).toBe(true)
    // Clamped to wall + maxDrift, not dragged to the remote's absurd time.
    expect(decodeHlc(merged).pt).toBeLessThanOrEqual(11_000)
  })
})
