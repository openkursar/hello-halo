/**
 * idle-queue unit tests.
 *
 * The module holds singleton state (queue / draining / idle), so each test
 * loads a fresh copy via vi.resetModules() + dynamic import. Fake timers drive
 * the setImmediate-based sequential drain deterministically.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

type IdleModule = typeof import('../../../src/main/bootstrap/idle-queue')

async function freshModule(): Promise<IdleModule> {
  vi.resetModules()
  return import('../../../src/main/bootstrap/idle-queue')
}

describe('idle-queue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('drains registered tasks sequentially in order', async () => {
    const { registerIdleTask, startIdleDrain } = await freshModule()
    const order: string[] = []

    registerIdleTask('a', async () => {
      order.push('a')
    })
    registerIdleTask('b', async () => {
      order.push('b')
    })

    startIdleDrain()
    await vi.runAllTimersAsync()

    expect(order).toEqual(['a', 'b'])
  })

  it('continues after a task throws (one failure does not abort the rest)', async () => {
    const { registerIdleTask, startIdleDrain } = await freshModule()
    const order: string[] = []

    registerIdleTask('boom', async () => {
      throw new Error('fail')
    })
    registerIdleTask('after', async () => {
      order.push('after')
    })

    startIdleDrain()
    await vi.runAllTimersAsync()

    expect(order).toEqual(['after'])
  })

  it('re-arms the drain for a task registered after going idle', async () => {
    const { registerIdleTask, startIdleDrain } = await freshModule()
    const order: string[] = []

    startIdleDrain()
    await vi.runAllTimersAsync() // queue empty → goes idle

    registerIdleTask('late', async () => {
      order.push('late')
    })
    await vi.runAllTimersAsync()

    expect(order).toEqual(['late'])
  })

  it('startIdleDrain is a no-op on the second call', async () => {
    const { registerIdleTask, startIdleDrain } = await freshModule()
    let runs = 0

    registerIdleTask('once', async () => {
      runs++
    })

    startIdleDrain()
    startIdleDrain() // second call must not re-enter the drain loop
    await vi.runAllTimersAsync()

    expect(runs).toBe(1)
  })
})
