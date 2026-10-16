import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

const electron = vi.hoisted(() => ({ app: null as unknown, powerMonitor: null as unknown }))
vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('events')
  electron.app = new Emitter()
  electron.powerMonitor = new Emitter()
  return electron
})

import { watchCatalogSignals } from '../../../../src/main/services/ai-sources/catalog-signals'

const app = (): EventEmitter => electron.app as EventEmitter
const powerMonitor = (): EventEmitter => electron.powerMonitor as EventEmitter

describe('watchCatalogSignals', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('signals at once when a window gains focus', () => {
    const onSignal = vi.fn()
    const stop = watchCatalogSignals(onSignal)
    app().emit('browser-window-focus')
    expect(onSignal).toHaveBeenCalledWith('focus')
    stop()
  })

  it('waits for the network after wake and collapses repeated wakes into one signal', () => {
    const onSignal = vi.fn()
    const stop = watchCatalogSignals(onSignal)
    powerMonitor().emit('resume')
    vi.advanceTimersByTime(5_000)
    powerMonitor().emit('resume')
    vi.advanceTimersByTime(9_999)
    expect(onSignal).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onSignal).toHaveBeenCalledTimes(1)
    expect(onSignal).toHaveBeenCalledWith('resume')
    stop()
  })

  it('stops listening and drops a pending wake signal once stopped', () => {
    const onSignal = vi.fn()
    const stop = watchCatalogSignals(onSignal)
    powerMonitor().emit('resume')
    stop()
    app().emit('browser-window-focus')
    vi.advanceTimersByTime(60_000)
    expect(onSignal).not.toHaveBeenCalled()
    expect(app().listenerCount('browser-window-focus')).toBe(0)
    expect(powerMonitor().listenerCount('resume')).toBe(0)
  })
})
