/**
 * Work the AI operates reads as operated from its first call until a while
 * after its last, and only those two moments are reported: a busy stretch of
 * calls must not make a mark blink, nor cost an event per call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_OPERATING_HOLD_MS, createActivityHold } from '../../../src/shared/ai-operating'

let changes: Array<[string, boolean]>
const hold = () => createActivityHold<string>((key, active) => changes.push([key, active]))

beforeEach(() => {
  vi.useFakeTimers()
  changes = []
})
afterEach(() => { vi.useRealTimers() })

describe('holding the operating state', () => {
  it('uses the ten seconds the product promises', () => {
    expect(AI_OPERATING_HOLD_MS).toBe(10_000)
  })

  it('turns on at the first call and off ten seconds after the last one ends', () => {
    const h = hold()
    h.begin('a')
    expect(changes).toEqual([['a', true]])
    h.end('a')
    vi.advanceTimersByTime(AI_OPERATING_HOLD_MS - 1)
    expect(h.isActive('a')).toBe(true)
    vi.advanceTimersByTime(1)
    expect(changes).toEqual([['a', true], ['a', false]])
    expect(h.isActive('a')).toBe(false)
  })

  it('stays on, silently, while calls follow each other inside the hold', () => {
    const h = hold()
    for (let i = 0; i < 20; i++) {
      h.begin('a')
      vi.advanceTimersByTime(3000)
      h.end('a')
      vi.advanceTimersByTime(3000)
    }
    expect(changes).toEqual([['a', true]])
  })

  it('stays on through a call that runs longer than the hold, however long', () => {
    const h = hold()
    h.begin('a')
    vi.advanceTimersByTime(10 * 60_000)
    expect(changes).toEqual([['a', true]])
    h.end('a')
    vi.advanceTimersByTime(AI_OPERATING_HOLD_MS)
    expect(changes).toEqual([['a', true], ['a', false]])
  })

  it('waits for every overlapping call before starting the hold', () => {
    const h = hold()
    h.begin('a')
    h.begin('a')
    h.end('a')
    vi.advanceTimersByTime(AI_OPERATING_HOLD_MS * 2)
    expect(h.isActive('a')).toBe(true)
    h.end('a')
    vi.advanceTimersByTime(AI_OPERATING_HOLD_MS)
    expect(changes.at(-1)).toEqual(['a', false])
  })

  it('turns on again after it turned off', () => {
    const h = hold()
    h.begin('a')
    h.end('a')
    vi.advanceTimersByTime(AI_OPERATING_HOLD_MS)
    h.begin('a')
    expect(changes).toEqual([['a', true], ['a', false], ['a', true]])
  })

  it('keeps its keys apart', () => {
    const h = hold()
    h.begin('a')
    h.begin('b')
    h.end('a')
    vi.advanceTimersByTime(AI_OPERATING_HOLD_MS)
    expect(changes).toEqual([['a', true], ['b', true], ['a', false]])
    expect(h.isActive('b')).toBe(true)
  })

  it('forgets work that ended without reporting anything more', () => {
    const h = hold()
    h.begin('a')
    h.end('a')
    h.forget('a')
    vi.advanceTimersByTime(AI_OPERATING_HOLD_MS * 2)
    expect(changes).toEqual([['a', true]])
    expect(h.isActive('a')).toBe(false)
  })

  it('ignores an end it never saw begin', () => {
    const h = hold()
    h.end('ghost')
    vi.advanceTimersByTime(AI_OPERATING_HOLD_MS * 2)
    expect(changes).toEqual([])
  })
})
