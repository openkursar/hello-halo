/**
 * Home telemetry emitter: common props, exposure dedupe, intent attribution
 * and turn-outcome pairing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const trackEvent = vi.fn()

vi.mock('../../../src/renderer/api', () => ({ api: { trackEvent } }))
vi.mock('../../../src/renderer/api/transport', () => ({
  isElectron: () => true,
  isCapacitor: () => false,
}))

const telemetry = await import('../../../src/renderer/services/home-telemetry')

function emitted(event: string) {
  return trackEvent.mock.calls.filter(([name]) => name === event).map(([, props]) => props)
}

describe('home telemetry emitter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    trackEvent.mockClear()
    telemetry.resetHomeExposure()
    telemetry.takeEntry()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('injects the shell on every event', () => {
    telemetry.trackHome('home.chip.click', { chip: 'generate_code' })
    expect(emitted('home.chip.click')).toEqual([{ chip: 'generate_code', shell: 'wide' }])
  })

  it('emits an exposure once per home visit', () => {
    telemetry.trackHomeOnce('empty', 'home.empty_state.view', { chipCount: 5 })
    telemetry.trackHomeOnce('empty', 'home.empty_state.view', { chipCount: 5 })
    expect(emitted('home.empty_state.view')).toHaveLength(1)

    telemetry.resetHomeExposure()
    telemetry.trackHomeOnce('empty', 'home.empty_state.view', { chipCount: 5 })
    expect(emitted('home.empty_state.view')).toHaveLength(2)
  })

  it('credits an intent to one landing only, and only while fresh', () => {
    telemetry.markEntry('home_rail_dh')
    expect(telemetry.peekEntry()).toBe('home_rail_dh')
    expect(telemetry.takeEntry()).toBe('home_rail_dh')
    expect(telemetry.takeEntry()).toBe('direct')

    telemetry.markEntry('nav_rail')
    vi.advanceTimersByTime(30_001)
    expect(telemetry.takeEntry()).toBe('direct')
  })

  it('records navigation with its origin and carries the intent', () => {
    telemetry.setCurrentView('space')
    telemetry.trackNavigate('apps', 'rail', 'nav_rail')
    telemetry.trackNavigate('space', 'rail', 'nav_rail')

    expect(emitted('nav.navigate')).toEqual([
      { to: 'apps', from: 'space', surface: 'rail', shell: 'wide' },
    ])
    expect(telemetry.takeEntry()).toBe('nav_rail')
  })

  it('reports the first terminal outcome of a turn and ignores the rest', () => {
    telemetry.noteTurnSent('conv-1', 'halo')
    vi.advanceTimersByTime(4_000)
    telemetry.noteTurnEnded('conv-1', 'stopped')
    telemetry.noteTurnEnded('conv-1', 'ok')
    telemetry.noteTurnEnded('conv-unknown', 'error')

    expect(emitted('home.composer.reply')).toEqual([
      { outcome: 'stopped', recipient: 'halo', latencyBucket: '3-10s', shell: 'wide' },
    ])
  })

  it('lets an interruption that trails a completion override it', () => {
    telemetry.noteTurnSent('conv-2', 'halo')
    vi.advanceTimersByTime(12_000)
    telemetry.noteTurnEnded('conv-2', 'ok')
    vi.advanceTimersByTime(50)
    telemetry.noteTurnEnded('conv-2', 'error')
    vi.advanceTimersByTime(5_000)

    expect(emitted('home.composer.reply')).toEqual([
      { outcome: 'error', recipient: 'halo', latencyBucket: '10-30s', shell: 'wide' },
    ])
  })

  it('reports a completion as a success once the grace window passes quietly', () => {
    telemetry.noteTurnSent('conv-3', 'digital_human')
    vi.advanceTimersByTime(2_000)
    telemetry.noteTurnEnded('conv-3', 'ok')
    expect(emitted('home.composer.reply')).toEqual([])

    vi.advanceTimersByTime(3_000)
    telemetry.noteTurnEnded('conv-3', 'error')
    expect(emitted('home.composer.reply')).toEqual([
      { outcome: 'ok', recipient: 'digital_human', latencyBucket: '0-3s', shell: 'wide' },
    ])
  })

  it('settles a completed turn as a success when the next turn starts inside the grace window', () => {
    telemetry.noteTurnSent('conv-4', 'halo')
    telemetry.noteTurnEnded('conv-4', 'ok')
    telemetry.noteTurnSent('conv-4', 'halo')
    telemetry.noteTurnEnded('conv-4', 'stopped')

    expect(emitted('home.composer.reply').map((p) => p.outcome)).toEqual(['ok', 'stopped'])
  })

  it('reports cold paint once, then only paints that follow a navigation home', () => {
    const first = telemetry.takeHomePaintTiming()
    expect(first?.cold).toBe(true)
    expect(telemetry.takeHomePaintTiming()).toBeNull()

    telemetry.setCurrentView('apps')
    telemetry.trackNavigate('space', 'rail', 'nav_rail')
    vi.advanceTimersByTime(300)
    expect(telemetry.takeHomePaintTiming()).toEqual({ cold: false, ms: 300 })
  })

  it('buckets values without leaking raw numbers', () => {
    expect(telemetry.msBucket(150)).toBe('0-200')
    expect(telemetry.msBucket(4_000)).toBe('3000+')
    expect(telemetry.replyLatencyBucket(61_000)).toBe('60s+')
    expect(telemetry.lenBucket(120)).toBe('100-500')
    expect(telemetry.capCount(5_000)).toBe(999)
  })

  it('buckets counts by inclusive upper bounds', () => {
    const rank = (n: number) => telemetry.countBucket(n, [1, 3, 10])
    expect([1, 2, 3, 4, 10, 11].map(rank)).toEqual(['1', '2-3', '2-3', '4-10', '4-10', '10+'])

    const results = (n: number) => telemetry.countBucket(n, [0, 5, 20, 100])
    expect([0, 1, 5, 6, 21, 100, 101].map(results)).toEqual(['0', '1-5', '1-5', '6-20', '21-100', '21-100', '100+'])

    const activity = (n: number) => telemetry.countBucket(n, [0, 1, 5, 20])
    expect([0, 1, 2, 6, 20, 21].map(activity)).toEqual(['0', '1', '2-5', '6-20', '6-20', '20+'])
  })
})
