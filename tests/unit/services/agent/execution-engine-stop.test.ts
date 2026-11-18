/**
 * A stop must reach an execution's engine even when the engine is silent: its
 * turn is interrupted, and it is closed when the turn has not ended within the
 * grace period (or at once when it cannot be interrupted).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ENGINE_STOP_GRACE_MS, createEngineStop } from '../../../../src/main/services/agent/execution/engine-stop'

function engine(interrupt?: () => Promise<unknown>, canInterrupt = true) {
  return { interrupt: vi.fn(interrupt ?? (() => Promise.resolve())), close: vi.fn(), canInterrupt }
}

describe('createEngineStop', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('does nothing until it is asked to stop', async () => {
    const session = engine()
    createEngineStop(session, { label: 'run' })

    await vi.advanceTimersByTimeAsync(ENGINE_STOP_GRACE_MS * 10)

    expect(session.interrupt).not.toHaveBeenCalled()
    expect(session.close).not.toHaveBeenCalled()
  })

  it('interrupts the turn, then closes an engine that is still going after the grace period', async () => {
    const session = engine(() => new Promise(() => {}))
    createEngineStop(session, { label: 'run' }).stop()

    await vi.advanceTimersByTimeAsync(0)
    expect(session.interrupt).toHaveBeenCalledTimes(1)
    expect(session.close).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(ENGINE_STOP_GRACE_MS)
    expect(session.close).toHaveBeenCalledTimes(1)
  })

  it('leaves the engine open when the read ends within the grace period', async () => {
    const session = engine()
    const stop = createEngineStop(session, { label: 'run' })

    stop.stop()
    await vi.advanceTimersByTimeAsync(ENGINE_STOP_GRACE_MS - 1)
    stop.release()
    await vi.advanceTimersByTimeAsync(ENGINE_STOP_GRACE_MS)

    expect(session.interrupt).toHaveBeenCalledTimes(1)
    expect(session.close).not.toHaveBeenCalled()
  })

  it('closes at once an engine that cannot interrupt a turn', () => {
    const session = engine(undefined, false)
    createEngineStop(session, { label: 'run' }).stop()

    expect(session.interrupt).not.toHaveBeenCalled()
    expect(session.close).toHaveBeenCalledTimes(1)
  })

  it('closes at once when the interrupt fails, and only once', async () => {
    const session = engine(() => Promise.reject(new Error('transport gone')))
    createEngineStop(session, { label: 'run' }).stop()

    await vi.advanceTimersByTimeAsync(0)
    expect(session.close).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(ENGINE_STOP_GRACE_MS)
    expect(session.close).toHaveBeenCalledTimes(1)
  })

  it('interrupts once however often a stop is asked for', async () => {
    const session = engine(() => new Promise(() => {}))
    const stop = createEngineStop(session, { label: 'run' })

    stop.stop()
    stop.stop()
    await vi.advanceTimersByTimeAsync(0)

    expect(session.interrupt).toHaveBeenCalledTimes(1)
  })

  it('ignores a stop that arrives after the read ended', async () => {
    const session = engine()
    const stop = createEngineStop(session, { label: 'run' })

    stop.release()
    stop.stop()
    await vi.advanceTimersByTimeAsync(ENGINE_STOP_GRACE_MS * 2)

    expect(session.interrupt).not.toHaveBeenCalled()
    expect(session.close).not.toHaveBeenCalled()
  })

  it('survives an engine whose close throws', () => {
    const session = { close: vi.fn(() => { throw new Error('already closed') }), canInterrupt: true }
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() => createEngineStop(session, { label: 'run' }).stop()).not.toThrow()
    expect(session.close).toHaveBeenCalledTimes(1)
  })
})
