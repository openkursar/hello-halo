/**
 * platform/background/keep-alive -- Process keep-alive manager
 *
 * Tracks reasons that prevent the Electron process from exiting
 * when all windows are closed. Each reason is identified by a unique
 * string key and has a registration timestamp for TTL-based pruning.
 */

import type { Unsubscribe } from './types'

/**
 * Maximum lifetime for a keep-alive reason before automatic pruning.
 * Default: 24 hours. This is a safety net for cases where the caller
 * crashes without calling the disposer function.
 */
const MAX_KEEP_ALIVE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Internal record for each registered reason.
 */
interface KeepAliveEntry {
  registeredAt: number
  ttlMs: number
}

/**
 * KeepAliveManager manages the set of reasons that prevent process exit.
 *
 * Thread-safety note: Electron main process is single-threaded (Node.js event loop),
 * so no locks are needed.
 */
export class KeepAliveManager {
  private reasons = new Map<string, KeepAliveEntry>()
  private ttlMs: number

  constructor(ttlMs: number = MAX_KEEP_ALIVE_TTL_MS) {
    this.ttlMs = ttlMs
  }

  /**
   * Register a reason to keep the process alive.
   *
   * If the same reason string is registered again, the timestamp is refreshed.
   * This is intentional: it allows callers to "renew" without explicitly
   * unregistering first.
   *
   * @param reason - Unique reason identifier (e.g. "app:jd-price-monitor")
   * @returns Unsubscribe function that removes this reason
   */
  register(reason: string, options: { ttlMs?: number } = {}): Unsubscribe {
    this.reasons.set(reason, { registeredAt: Date.now(), ttlMs: options.ttlMs ?? this.ttlMs })
    console.log(`[KeepAlive] Registered reason: "${reason}" (total: ${this.reasons.size})`)

    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.reasons.delete(reason)
      console.log(`[KeepAlive] Unregistered reason: "${reason}" (total: ${this.reasons.size})`)
    }
  }

  /**
   * Check whether any active (non-expired) reasons exist.
   *
   * Performs lazy TTL pruning: expired entries are removed during this check
   * rather than on a background timer.
   */
  shouldKeepAlive(): boolean {
    this.pruneExpired()
    return this.reasons.size > 0
  }

  /**
   * Get the count of active reasons (after pruning).
   */
  getActiveCount(): number {
    this.pruneExpired()
    return this.reasons.size
  }

  /**
   * Get a snapshot of all active reason keys (after pruning).
   * Useful for debugging and tray tooltip display.
   */
  getActiveReasons(): string[] {
    this.pruneExpired()
    return Array.from(this.reasons.keys())
  }

  /**
   * Remove all reasons. Called during shutdown to ensure clean exit.
   */
  clearAll(): void {
    const count = this.reasons.size
    this.reasons.clear()
    if (count > 0) {
      console.log(`[KeepAlive] Cleared all ${count} reason(s)`)
    }
  }

  /**
   * Remove entries that have exceeded the TTL.
   */
  private pruneExpired(): void {
    const now = Date.now()

    for (const [reason, entry] of this.reasons) {
      if (now - entry.registeredAt > entry.ttlMs) {
        this.reasons.delete(reason)
        console.warn(
          `[KeepAlive] Auto-pruned expired reason: "${reason}" ` +
          `(registered ${Math.round((now - entry.registeredAt) / 1000 / 60)} minutes ago)`
        )
      }
    }
  }
}
