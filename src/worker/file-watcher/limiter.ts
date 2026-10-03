/**
 * Concurrency limiter for filesystem calls issued by the watcher.
 *
 * A single `git checkout` can deliver thousands of events in one batch; issuing
 * a stat per event all at once exhausts file descriptors and inflates the
 * worker heap. Slots are handed directly to the next waiter on release, so the
 * number of calls in flight never exceeds `max`, even across batches.
 */

export interface ConcurrencyLimiter {
  run<T>(task: () => Promise<T>): Promise<T>
  /** Calls currently executing (never above `max`). */
  readonly active: number
  /** Calls waiting for a slot. */
  readonly queued: number
}

export function createConcurrencyLimiter(max: number): ConcurrencyLimiter {
  let active = 0
  const waiters: Array<() => void> = []

  const acquire = (): Promise<void> => {
    if (active < max) {
      active++
      return Promise.resolve()
    }
    return new Promise<void>(resolve => waiters.push(resolve))
  }

  const release = (): void => {
    const next = waiters.shift()
    if (next) next()
    else active--
  }

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      await acquire()
      try {
        return await task()
      } finally {
        release()
      }
    },
    get active() { return active },
    get queued() { return waiters.length },
  }
}
