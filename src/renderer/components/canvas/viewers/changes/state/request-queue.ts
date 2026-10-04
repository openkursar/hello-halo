/**
 * At most `limit` requests at once, newest first: the request made last is
 * for what the user is looking at now. A request whose signal aborts while it
 * waits is dropped without running, so scrolling past many files does not
 * leave a queue of reads behind.
 */

export function abortError(): DOMException {
  return new DOMException('The request was cancelled', 'AbortError')
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

interface Waiting {
  start: () => void
  drop: () => void
}

export class RequestQueue {
  private running = 0
  private readonly waiting: Waiting[] = []

  constructor(private readonly limit: number) {}

  get pending(): number {
    return this.waiting.length
  }

  get active(): number {
    return this.running
  }

  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError())
        return
      }
      const start = () => {
        signal?.removeEventListener('abort', onAbort)
        this.running++
        task().then(resolve, reject).finally(() => {
          this.running--
          this.next()
        })
      }
      const entry: Waiting = {
        start,
        drop: () => reject(abortError()),
      }
      const onAbort = () => {
        const index = this.waiting.indexOf(entry)
        if (index < 0) return
        this.waiting.splice(index, 1)
        entry.drop()
      }
      if (this.running < this.limit) {
        start()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiting.push(entry)
    })
  }

  private next(): void {
    while (this.running < this.limit && this.waiting.length > 0) {
      this.waiting.pop()!.start()
    }
  }
}
