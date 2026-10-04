/**
 * A bound on how many requests of one kind run git at once.
 *
 * Over the bound a request waits its turn, first come first served. It leaves
 * the line when its caller gives up (abort) or after `maxWaitMs`, and a request
 * that finds the line full is refused at once. A refusal is GIT_BUSY: nothing
 * ran, so asking again later is safe.
 */

import { GitError } from './errors'

export interface GateOptions {
  /** Requests running at once. */
  concurrency: number
  /** Requests allowed to wait; one more is refused. */
  maxQueued: number
  /** Longest wait for a turn. */
  maxWaitMs: number
}

interface Waiter {
  grant: () => void
}

export class Gate {
  private running = 0
  private readonly waiting: Waiter[] = []

  constructor(private readonly options: GateOptions) {}

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.enter(signal)
    try {
      return await task()
    } finally {
      this.leave()
    }
  }

  private enter(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new GitError('GIT_BUSY', 'The request was cancelled before it ran'))
    if (this.running < this.options.concurrency && this.waiting.length === 0) {
      this.running++
      return Promise.resolve()
    }
    if (this.waiting.length >= this.options.maxQueued) {
      return Promise.reject(new GitError('GIT_BUSY', `Too many file reads are waiting (${this.waiting.length}); try again shortly`))
    }
    return new Promise<void>((resolve, reject) => {
      const quit = (message: string): void => {
        const index = this.waiting.indexOf(waiter)
        if (index === -1) return
        this.waiting.splice(index, 1)
        done()
        reject(new GitError('GIT_BUSY', message))
      }
      const onAbort = (): void => quit('The request was cancelled while waiting for its turn')
      const timer = setTimeout(() => quit(`No turn to read files within ${Math.round(this.options.maxWaitMs / 1000)} s`), this.options.maxWaitMs)
      const done = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      // The slot passes straight from the request leaving to this one.
      const waiter: Waiter = {
        grant: () => {
          done()
          resolve()
        },
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiting.push(waiter)
    })
  }

  private leave(): void {
    const next = this.waiting.shift()
    if (next) next.grant()
    else this.running--
  }
}
