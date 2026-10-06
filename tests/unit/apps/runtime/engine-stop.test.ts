/**
 * A stop must reach an automation run's engine even when the engine is silent:
 * its turn is interrupted, and it is closed when the run has not ended within
 * the grace period (or at once when it cannot be interrupted).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ENGINE_STOP_GRACE_MS, stopEngineOnAbort } from '../../../../src/main/apps/runtime/engine-stop'

function engine(interrupt?: () => Promise<unknown>) {
  return { interrupt: vi.fn(interrupt ?? (() => Promise.resolve())), close: vi.fn() }
}

describe('stopEngineOnAbort', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('does nothing until the run is stopped', async () => {
    const controller = new AbortController()
    const session = engine()
    stopEngineOnAbort(controller.signal, session, { canInterrupt: true, runTag: 'run' })

    await vi.advanceTimersByTimeAsync(ENGINE_STOP_GRACE_MS * 10)

    expect(session.interrupt).not.toHaveBeenCalled()
    expect(session.close).not.toHaveBeenCalled()
  })

  it('interrupts the turn, then closes an engine that is still going after the grace period', async () => {
    const controller = new AbortController()
    const session = engine(() => new Promise(() => {}))
    stopEngineOnAbort(controller.signal, session, { canInterrupt: true, runTag: 'run' })

    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(session.interrupt).toHaveBeenCalledTimes(1)
    expect(session.close).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(ENGINE_STOP_GRACE_MS)
    expect(session.close).toHaveBeenCalledTimes(1)
  })

  it('leaves the engine open when the run ends within the grace period', async () => {
    const controller = new AbortController()
    const session = engine()
    const release = stopEngineOnAbort(controller.signal, session, { canInterrupt: true, runTag: 'run' })

    controller.abort()
    await vi.advanceTimersByTimeAsync(ENGINE_STOP_GRACE_MS - 1)
    release()
    await vi.advanceTimersByTimeAsync(ENGINE_STOP_GRACE_MS)

    expect(session.interrupt).toHaveBeenCalledTimes(1)
    expect(session.close).not.toHaveBeenCalled()
  })

  it('closes at once an engine that cannot interrupt a turn', async () => {
    const controller = new AbortController()
    const session = engine()
    stopEngineOnAbort(controller.signal, session, { canInterrupt: false, runTag: 'run' })

    controller.abort()

    expect(session.interrupt).not.toHaveBeenCalled()
    expect(session.close).toHaveBeenCalledTimes(1)
  })

  it('closes at once when the interrupt fails', async () => {
    const controller = new AbortController()
    const session = engine(() => Promise.reject(new Error('transport gone')))
    stopEngineOnAbort(controller.signal, session, { canInterrupt: true, runTag: 'run' })

    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(session.close).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(ENGINE_STOP_GRACE_MS)
    expect(session.close).toHaveBeenCalledTimes(1)
  })

  it('stops at once a run that was stopped before its engine existed', async () => {
    const controller = new AbortController()
    controller.abort()
    const session = engine(() => new Promise(() => {}))
    stopEngineOnAbort(controller.signal, session, { canInterrupt: true, runTag: 'run' })

    await vi.advanceTimersByTimeAsync(0)
    expect(session.interrupt).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(ENGINE_STOP_GRACE_MS)
    expect(session.close).toHaveBeenCalledTimes(1)
  })

  it('ignores a stop that arrives after the run ended', async () => {
    const controller = new AbortController()
    const session = engine()
    const release = stopEngineOnAbort(controller.signal, session, { canInterrupt: true, runTag: 'run' })

    release()
    controller.abort()
    await vi.advanceTimersByTimeAsync(ENGINE_STOP_GRACE_MS * 2)

    expect(session.interrupt).not.toHaveBeenCalled()
    expect(session.close).not.toHaveBeenCalled()
  })

  it('survives an engine whose close throws', async () => {
    const controller = new AbortController()
    const session = { close: vi.fn(() => { throw new Error('already closed') }) }
    vi.spyOn(console, 'error').mockImplementation(() => {})
    stopEngineOnAbort(controller.signal, session, { canInterrupt: true, runTag: 'run' })

    expect(() => controller.abort()).not.toThrow()
    expect(session.close).toHaveBeenCalledTimes(1)
  })
})
