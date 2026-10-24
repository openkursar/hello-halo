/**
 * Unit tests for IM link signals (apps/runtime/im-channels/link-signals): the
 * process-wide moments that make every supervised link redial at once — wake
 * from sleep, a change of the machine's addresses (Wi-Fi switch, VPN), and a
 * change of where IM traffic goes — plus the shared tick.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { powerMonitor } from 'electron'

let addresses = ['192.0.2.24']
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    networkInterfaces: () => ({
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      en0: addresses.map((address) => ({ address, family: 'IPv4', internal: false })),
      utun0: [{ address: 'fe80::1', family: 'IPv6', internal: false }],
    }),
  }
})

const routeHandlers = new Set<() => void>()
vi.mock('../../../../../src/main/apps/runtime/im-channels/link-route', () => ({
  onLinkRouteChange: (handler: () => void) => {
    routeHandlers.add(handler)
    return () => { routeHandlers.delete(handler) }
  },
}))

import { watchLinkSignals } from '../../../../../src/main/apps/runtime/im-channels/link-signals'

/** powerMonitor.on is overloaded per event; the mock's calls are read untyped. */
function powerMonitorCalls(): [string, () => void][] {
  return vi.mocked(powerMonitor.on).mock.calls as unknown as [string, () => void][]
}

function resumeHandler(): () => void {
  return powerMonitorCalls().find(([event]) => event === 'resume')![1]
}

describe('link signals', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    addresses = ['192.0.2.24']
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('signals a wake a few seconds after the system resumes', () => {
    const listener = { onSignal: vi.fn(), onTick: vi.fn() }
    const stop = watchLinkSignals(listener)
    resumeHandler()()
    vi.advanceTimersByTime(4_999)
    expect(listener.onSignal).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(listener.onSignal).toHaveBeenCalledWith('resume')
    stop()
  })

  it('signals a network change when the external IPv4 addresses change, and ticks every 30 s', () => {
    const listener = { onSignal: vi.fn(), onTick: vi.fn() }
    const stop = watchLinkSignals(listener)

    vi.advanceTimersByTime(30_000)
    expect(listener.onTick).toHaveBeenCalledTimes(1)
    expect(listener.onSignal).not.toHaveBeenCalled()

    addresses = ['198.51.100.20']
    vi.advanceTimersByTime(30_000)
    expect(listener.onSignal).toHaveBeenCalledWith('network-changed')
    expect(listener.onSignal).toHaveBeenCalledTimes(1)
    stop()
  })

  it('folds several settings saves into one route change', () => {
    const listener = { onSignal: vi.fn(), onTick: vi.fn() }
    const stop = watchLinkSignals(listener)
    for (const handler of routeHandlers) { handler(); handler() }
    vi.advanceTimersByTime(1_000)
    expect(listener.onSignal).toHaveBeenCalledTimes(1)
    expect(listener.onSignal).toHaveBeenCalledWith('route-changed')
    stop()
  })

  it('holds nothing once the last link stops watching', () => {
    const first = { onSignal: vi.fn(), onTick: vi.fn() }
    const second = { onSignal: vi.fn(), onTick: vi.fn() }
    const stopFirst = watchLinkSignals(first)
    const stopSecond = watchLinkSignals(second)
    expect(powerMonitorCalls().filter(([e]) => e === 'resume')).toHaveLength(1)

    stopFirst()
    expect(powerMonitor.removeListener).not.toHaveBeenCalled()
    stopSecond()
    expect(powerMonitor.removeListener).toHaveBeenCalledWith('resume', expect.any(Function))
    expect(routeHandlers.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
