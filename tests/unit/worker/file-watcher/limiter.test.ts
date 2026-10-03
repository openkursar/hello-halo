/**
 * The watcher's stat limiter must never let more than `max` calls run at once,
 * including across separate batches that arrive while a slot is being handed
 * over — the unbounded version reached ~5000 concurrent stats on one checkout.
 */

import { describe, it, expect } from 'vitest'
import { createConcurrencyLimiter } from '../../../../src/worker/file-watcher/limiter'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

describe('createConcurrencyLimiter', () => {
  it('caps concurrent tasks and runs every task', async () => {
    const limiter = createConcurrencyLimiter(4)
    let running = 0
    let peak = 0
    const task = async (): Promise<number> => {
      running++
      peak = Math.max(peak, running)
      await new Promise(r => setTimeout(r, 1))
      running--
      return 1
    }

    const results = await Promise.all(Array.from({ length: 100 }, () => limiter.run(task)))

    expect(results).toHaveLength(100)
    expect(peak).toBe(4)
    expect(limiter.active).toBe(0)
    expect(limiter.queued).toBe(0)
  })

  it('does not let a new caller overtake the slot handed to a waiter', async () => {
    const limiter = createConcurrencyLimiter(1)
    const gate = deferred()
    let running = 0
    let peak = 0
    const tracked = (wait?: Promise<void>) => async (): Promise<void> => {
      running++
      peak = Math.max(peak, running)
      if (wait) await wait
      await Promise.resolve()
      running--
    }

    const first = limiter.run(tracked(gate.promise))
    const second = limiter.run(tracked())
    gate.resolve()
    // Arrives in the same tick the first slot is released.
    const third = limiter.run(tracked())

    await Promise.all([first, second, third])
    expect(peak).toBe(1)
  })

  it('releases the slot when a task throws', async () => {
    const limiter = createConcurrencyLimiter(1)
    await expect(limiter.run(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(limiter.run(async () => 'ok')).resolves.toBe('ok')
    expect(limiter.active).toBe(0)
  })
})
