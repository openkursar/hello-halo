/**
 * apps/runtime -- Concurrency Control
 *
 * Counting semaphore for limiting concurrent App runs.
 * Queued callers wait in FIFO order until a slot is released.
 */

// ============================================
// Types
// ============================================

interface QueuedWaiter {
  resolve: () => void
  reject: (err: Error) => void
}

// ============================================
// Semaphore
// ============================================

/**
 * Counting semaphore for concurrent run control.
 *
 * - `acquire()` returns immediately if slots are available, otherwise queues.
 * - `release()` frees a slot and wakes the next queued waiter.
 * - `tryAcquire()` returns false instead of blocking.
 */
export class Semaphore {
  private readonly max: number
  private current: number = 0
  private readonly queue: QueuedWaiter[] = []

  constructor(maxConcurrent: number) {
    if (maxConcurrent < 1) {
      throw new Error(`Semaphore max must be >= 1, got ${maxConcurrent}`)
    }
    this.max = maxConcurrent
  }

  /** Current number of acquired slots */
  get activeCount(): number {
    return this.current
  }

  /** Number of callers waiting in queue */
  get waitingCount(): number {
    return this.queue.length
  }

  /** Maximum concurrent slots */
  get maxConcurrent(): number {
    return this.max
  }

  /**
   * Acquire a slot. Resolves immediately if available,
   * otherwise waits in queue until released.
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('Queued execution cancelled')
    if (this.current < this.max) {
      this.current++
      return
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: QueuedWaiter = {
        resolve: () => { signal?.removeEventListener('abort', abort); resolve() },
        reject: error => { signal?.removeEventListener('abort', abort); reject(error) },
      }
      const abort = (): void => {
        const index = this.queue.indexOf(waiter)
        if (index !== -1) this.queue.splice(index, 1)
        waiter.reject(new Error('Queued execution cancelled'))
      }
      this.queue.push(waiter)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  /**
   * Try to acquire a slot without waiting.
   * Returns true if acquired, false if all slots are taken.
   */
  tryAcquire(): boolean {
    if (this.current < this.max) {
      this.current++
      return true
    }
    return false
  }

  /**
   * Release a slot. Wakes the next queued waiter if any.
   */
  release(): void {
    if (this.queue.length > 0) {
      const waiter = this.queue.shift()!
      // Slot transfers directly to the waiter (current stays the same)
      waiter.resolve()
    } else if (this.current > 0) {
      this.current--
    }
  }

  /**
   * Reject all waiting callers with an error.
   * Used during shutdown.
   */
  rejectAll(reason: string): void {
    const waiters = this.queue.splice(0, this.queue.length)
    const error = new Error(reason)
    for (const waiter of waiters) {
      waiter.reject(error)
    }
  }
}
