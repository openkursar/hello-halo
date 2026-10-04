/**
 * File contents a changes view has loaded, kept while it is mounted so
 * scrolling back does not ask git again. Bounded by text size (UTF-16 code
 * units, about two bytes each), least recently used first; a request for the
 * same file while one is in flight shares it.
 */

/** About 64 MB of text. A single side is at most GIT_LIMITS.maxFileBytes. */
export const CONTENT_CACHE_CHARS = 32 * 1024 * 1024

export interface SizedValue {
  /** Text the value holds, in UTF-16 code units. */
  size: number
}

export class ContentCache<T extends SizedValue> {
  private entries = new Map<string, T>()
  private inflight = new Map<string, Promise<T>>()
  private total = 0
  private generation = 0

  constructor(private readonly budget: number = CONTENT_CACHE_CHARS) {}

  get chars(): number {
    return this.total
  }

  get count(): number {
    return this.entries.size
  }

  peek(key: string): T | undefined {
    const value = this.entries.get(key)
    if (value) {
      // Re-insert: Map order is the LRU order.
      this.entries.delete(key)
      this.entries.set(key, value)
    }
    return value
  }

  /** The cached value, or `load()`'s, shared with any request already in flight. */
  get(key: string, load: () => Promise<T>): Promise<T> {
    const cached = this.peek(key)
    if (cached) return Promise.resolve(cached)
    const pending = this.inflight.get(key)
    if (pending) return pending
    const generation = this.generation
    const request = load().then(
      (value) => {
        this.inflight.delete(key)
        // Loaded before a clear: the caller gets it, the cache does not keep it.
        if (generation === this.generation) this.put(key, value)
        return value
      },
      (error: unknown) => {
        this.inflight.delete(key)
        throw error
      }
    )
    this.inflight.set(key, request)
    return request
  }

  private put(key: string, value: T): void {
    if (value.size > this.budget) return
    const old = this.entries.get(key)
    if (old) {
      this.total -= old.size
      this.entries.delete(key)
    }
    this.entries.set(key, value)
    this.total += value.size
    for (const [oldest, entry] of this.entries) {
      if (this.total <= this.budget) break
      this.entries.delete(oldest)
      this.total -= entry.size
    }
  }

  /** Drops everything, including what is still loading, e.g. when the files may have changed. */
  clear(): void {
    this.entries.clear()
    this.inflight.clear()
    this.total = 0
    this.generation++
  }
}
