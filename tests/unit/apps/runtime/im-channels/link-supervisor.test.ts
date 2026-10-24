/**
 * Unit tests for the IM link supervisor (apps/runtime/im-channels/link-supervisor).
 *
 * The supervisor's promise is that a link which is not up is always either
 * being dialled under a deadline or waiting for a scheduled redial — never
 * stuck. These tests drive it with fake timers and a captured signal listener
 * (wake, network change, route change, tick); no sockets are involved.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { LinkSignal, LinkSignalListener } from '../../../../../src/main/apps/runtime/im-channels/link-signals'

const signalListeners = new Set<LinkSignalListener>()
vi.mock('../../../../../src/main/apps/runtime/im-channels/link-signals', () => ({
  watchLinkSignals: (listener: LinkSignalListener) => {
    signalListeners.add(listener)
    return () => { signalListeners.delete(listener) }
  },
}))

import { CredentialRejectionBudget, LinkSupervisor } from '../../../../../src/main/apps/runtime/im-channels/link-supervisor'

function emit(signal: LinkSignal): void {
  for (const listener of signalListeners) listener.onSignal(signal)
}

function tick(): void {
  for (const listener of signalListeners) listener.onTick()
}

function makeSupervisor(overrides: { attemptTimeoutMs?: number; isUp?: () => boolean } = {}) {
  const dial = vi.fn()
  const logs: { level: string; event: string; fields: Record<string, unknown> }[] = []
  const supervisor = new LinkSupervisor({
    log: (level, event, fields) => logs.push({ level, event, fields }),
    dial,
    isUp: overrides.isUp ?? (() => true),
    attemptTimeoutMs: overrides.attemptTimeoutMs ?? 25_000,
    // Midpoint jitter: every delay is exactly its base.
    random: () => 0.5,
  })
  return { supervisor, dial, logs }
}

describe('LinkSupervisor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    signalListeners.clear()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('dials on start and reports online once the provider connects', () => {
    const { supervisor, dial } = makeSupervisor()
    supervisor.start()
    expect(dial).toHaveBeenCalledTimes(1)
    expect(supervisor.wasEverOnline()).toBe(false)

    supervisor.connected()
    expect(supervisor.wasEverOnline()).toBe(true)
    expect(supervisor.status()).toMatchObject({ attempt: 0, drops: 0 })
  })

  it('fails an attempt that never comes up within the deadline, then redials', () => {
    // The incident: a proxy that accepts the connection and then says nothing.
    const { supervisor, dial } = makeSupervisor()
    supervisor.start()

    vi.advanceTimersByTime(25_000)
    expect(supervisor.status().attempt).toBe(1)
    expect(supervisor.status().lastError).toContain('no connection within 25 s')
    expect(supervisor.status().nextRetryAt).toBeDefined()

    vi.advanceTimersByTime(1_000)
    expect(dial).toHaveBeenCalledTimes(2)
  })

  it('backs off 1 s doubling to a 30 s cap and never gives up on its own', () => {
    const { supervisor, dial } = makeSupervisor()
    supervisor.start()
    const delays: number[] = []
    for (let i = 0; i < 9; i++) {
      supervisor.lost('connect ETIMEDOUT')
      const status = supervisor.status()
      delays.push(status.nextRetryAt! - Date.now())
      vi.advanceTimersByTime(status.nextRetryAt! - Date.now())
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000])
    expect(dial).toHaveBeenCalledTimes(10)
  })

  it('resets the backoff once the link is back up', () => {
    const { supervisor } = makeSupervisor()
    supervisor.start()
    supervisor.lost('a')
    vi.advanceTimersByTime(1_000)
    supervisor.lost('b')
    vi.advanceTimersByTime(2_000)
    supervisor.connected()
    expect(supervisor.status().attempt).toBe(0)
    expect(supervisor.status().lastError).toBeUndefined()

    supervisor.lost('c')
    expect(supervisor.status().nextRetryAt! - Date.now()).toBe(1_000)
    expect(supervisor.status().drops).toBe(1)
  })

  it('gives a transport reconnecting on its own one deadline before taking over', () => {
    const { supervisor, dial } = makeSupervisor({ attemptTimeoutMs: 45_000 })
    supervisor.start()
    supervisor.connected()

    supervisor.dropped('long connection lost')
    vi.advanceTimersByTime(30_000)
    supervisor.connected()
    expect(dial).toHaveBeenCalledTimes(1)
    expect(supervisor.status().drops).toBe(1)

    supervisor.dropped('long connection lost')
    vi.advanceTimersByTime(45_000)
    vi.advanceTimersByTime(1_000)
    expect(dial).toHaveBeenCalledTimes(2)
  })

  it('redials at once on wake, network change and route change', () => {
    const { supervisor, dial } = makeSupervisor()
    supervisor.start()
    supervisor.lost('connect ETIMEDOUT')
    supervisor.lost('ignored while waiting')
    expect(dial).toHaveBeenCalledTimes(1)

    emit('resume')
    expect(dial).toHaveBeenCalledTimes(2)
    expect(supervisor.status().attempt).toBe(0)

    supervisor.connected()
    emit('network-changed')
    expect(dial).toHaveBeenCalledTimes(3)
    supervisor.connected()
    emit('route-changed')
    expect(dial).toHaveBeenCalledTimes(4)
    // Deliberate redials are not drops.
    expect(supervisor.status().drops).toBe(0)
  })

  it('leaves a caller-paced redial (standby probing) on its own schedule', () => {
    const { supervisor, dial } = makeSupervisor()
    supervisor.start()
    supervisor.connected()
    supervisor.redialIn(60_000, 'standby probe', false)

    emit('resume')
    emit('route-changed')
    expect(dial).toHaveBeenCalledTimes(1)
    expect(supervisor.status().drops).toBe(0)

    vi.advanceTimersByTime(60_000)
    expect(dial).toHaveBeenCalledTimes(2)
  })

  it('stops for good on halt until the user redials', () => {
    const { supervisor, dial } = makeSupervisor()
    supervisor.start()
    supervisor.halt('credential rejected')
    expect(supervisor.isHalted()).toBe(true)
    expect(supervisor.status().lastError).toBe('credential rejected')

    vi.advanceTimersByTime(10 * 60_000)
    emit('resume')
    supervisor.connected()
    expect(dial).toHaveBeenCalledTimes(1)
    expect(supervisor.isHalted()).toBe(true)

    supervisor.redialNow('manual reconnect')
    expect(supervisor.isHalted()).toBe(false)
    expect(dial).toHaveBeenCalledTimes(2)
  })

  it('notices on the tick a link reported up whose transport is down', () => {
    let up = true
    const { supervisor, dial, logs } = makeSupervisor({ isUp: () => up })
    supervisor.start()
    supervisor.connected()

    tick()
    expect(supervisor.status().drops).toBe(0)

    up = false
    tick()
    expect(logs.some((l) => l.event === 'link_stall_detected')).toBe(true)
    expect(supervisor.status().drops).toBe(1)
    vi.advanceTimersByTime(1_000)
    expect(dial).toHaveBeenCalledTimes(2)
  })

  it('does nothing after stop, and unsubscribes from signals', () => {
    const { supervisor, dial } = makeSupervisor()
    supervisor.start()
    expect(signalListeners.size).toBe(1)
    supervisor.stop()
    expect(signalListeners.size).toBe(0)
    expect(supervisor.isRunning()).toBe(false)

    supervisor.lost('late')
    supervisor.connected()
    vi.advanceTimersByTime(60_000)
    expect(dial).toHaveBeenCalledTimes(1)
  })
})

describe('CredentialRejectionBudget', () => {
  it('stops on five rejections only once the first is a minute old', () => {
    const budget = new CredentialRejectionBudget()
    const results = [0, 1_000, 3_000, 7_000, 15_000, 31_000, 61_000].map((at) => budget.record(at))
    expect(results).toEqual([false, false, false, false, false, false, true])
  })

  it('needs five rejections however long the first was ago', () => {
    const budget = new CredentialRejectionBudget()
    expect([0, 120_000, 240_000, 360_000].map((at) => budget.record(at))).toEqual([false, false, false, false])
    expect(budget.record(480_000)).toBe(true)
  })

  it('starts over after a reset', () => {
    const budget = new CredentialRejectionBudget()
    for (const at of [0, 1_000, 2_000, 3_000]) budget.record(at)
    budget.reset()
    expect([70_000, 71_000, 72_000, 73_000, 74_000].map((at) => budget.record(at))).toEqual([false, false, false, false, false])
    expect(budget.record(130_000)).toBe(true)
  })
})
