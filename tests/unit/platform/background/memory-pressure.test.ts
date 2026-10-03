/**
 * Memory pressure levels: memory-only triggers, immediate escalation, recovery
 * after three calmer samples, and distrust of a lone fallback reading.
 */

import { describe, it, expect, vi } from 'vitest'
import { MemoryPressureTracker, type MemoryReading } from '../../../../src/main/platform/background/memory-pressure'

const reading = (availableRatio: number | null, rendererMb: number | null = 300, source: MemoryReading['availableSource'] = 'kernel'): MemoryReading =>
  ({ availableRatio, availableSource: source, rendererMb })

describe('MemoryPressureTracker.classify', () => {
  it.each([
    [0.5, 300, 'normal'],
    [0.15, 300, 'normal'],
    [0.149, 300, 'low'],
    [0.07, 300, 'low'],
    [0.069, 300, 'critical'],
    [0.5, 1024, 'normal'],
    [0.5, 1025, 'low'],
    [0.5, 1537, 'critical'],
    [null, null, 'normal'],
    [0.1, 1600, 'critical'],
  ] as const)('available=%s renderer=%sMB → %s', (ratio, renderer, expected) => {
    expect(new MemoryPressureTracker().classify(reading(ratio, renderer))).toBe(expected)
  })
})

describe('system-only tracker', () => {
  it('ignores renderer memory and still follows available system memory', () => {
    const t = new MemoryPressureTracker(false)
    expect(t.classify(reading(0.5, 1600))).toBe('normal')
    expect(t.classify(reading(0.1, 300))).toBe('low')
    expect(t.classify(reading(0.05, 2000))).toBe('critical')
  })
})

describe('process-wide levels', () => {
  it('a heavy renderer raises the combined level but not the system level', async () => {
    const mod = await import('../../../../src/main/platform/background/memory-pressure')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const combined: string[] = []
    const system: string[] = []
    const offCombined = mod.onMemoryPressure((level) => combined.push(level))
    const offSystem = mod.onSystemMemoryPressure((level) => system.push(level))

    mod.evaluateMemoryPressure(reading(0.5, 1200))
    expect(mod.getMemoryPressure()).toBe('low')
    expect(mod.getSystemMemoryPressure()).toBe('normal')

    mod.evaluateMemoryPressure(reading(0.05, 1200))
    expect(combined).toEqual(['low', 'critical'])
    expect(system).toEqual(['critical'])

    offCombined()
    offSystem()
    warn.mockRestore()
  })
})

describe('MemoryPressureTracker.evaluate', () => {
  it('escalates immediately and recovers only after three calmer samples', () => {
    const t = new MemoryPressureTracker()
    expect(t.evaluate(reading(0.05))).toBe('critical')
    expect(t.evaluate(reading(0.5))).toBe('critical')
    expect(t.evaluate(reading(0.5))).toBe('critical')
    expect(t.evaluate(reading(0.5))).toBe('normal')
  })

  it('a relapse during recovery restarts the count', () => {
    const t = new MemoryPressureTracker()
    t.evaluate(reading(0.1))
    t.evaluate(reading(0.5))
    t.evaluate(reading(0.5))
    expect(t.evaluate(reading(0.1))).toBe('low')
    t.evaluate(reading(0.5))
    t.evaluate(reading(0.5))
    expect(t.evaluate(reading(0.5))).toBe('normal')
  })

  it('settles on the highest level seen while recovering', () => {
    const t = new MemoryPressureTracker()
    t.evaluate(reading(0.05))
    t.evaluate(reading(0.5))
    t.evaluate(reading(0.1))
    expect(t.evaluate(reading(0.5))).toBe('low')
  })

  it('a fallback reading alone cannot raise pressure; three in a row can', () => {
    const t = new MemoryPressureTracker()
    expect(t.evaluate(reading(0.03, 300, 'fallback'))).toBe('normal')
    expect(t.evaluate(reading(0.03, 300, 'fallback'))).toBe('normal')
    expect(t.evaluate(reading(0.03, 300, 'fallback'))).toBe('critical')
  })

  it('a kernel reading between fallbacks resets the fallback streak', () => {
    const t = new MemoryPressureTracker()
    t.evaluate(reading(0.03, 300, 'fallback'))
    t.evaluate(reading(0.03, 300, 'fallback'))
    t.evaluate(reading(0.4, 300, 'kernel'))
    expect(t.evaluate(reading(0.03, 300, 'fallback'))).toBe('normal')
  })

  it('renderer memory still counts during fallback', () => {
    const t = new MemoryPressureTracker()
    expect(t.evaluate(reading(0.03, 1100, 'fallback'))).toBe('low')
  })
})
