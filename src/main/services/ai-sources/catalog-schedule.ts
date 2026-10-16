/**
 * When each source's model catalog is next worth fetching.
 *
 * Refreshes are driven by events (startup, window focus, wake from sleep, a
 * model picker opening), not a timer; this decides which of those events
 * actually reach the network. A catalog read successfully stays fresh for
 * CATALOG_FRESH_MS. A failed or fallback read is retried after
 * CATALOG_RETRY_MS, so a source that was offline at startup recovers at the
 * next event instead of at the next launch, without every focus change
 * hammering an unreachable server.
 */

export const CATALOG_FRESH_MS = 15 * 60_000
export const CATALOG_RETRY_MS = 2 * 60_000

export class CatalogSchedule {
  private readonly dueAt = new Map<string, number>()

  constructor(private readonly now: () => number = Date.now) {}

  /** A source never read in this process is due. */
  isDue(sourceId: string): boolean {
    const due = this.dueAt.get(sourceId)
    return due === undefined || this.now() >= due
  }

  record(sourceId: string, current: boolean): void {
    this.dueAt.set(sourceId, this.now() + (current ? CATALOG_FRESH_MS : CATALOG_RETRY_MS))
  }

  /** Forget sources that no longer exist. */
  retain(sourceIds: readonly string[]): void {
    const keep = new Set(sourceIds)
    for (const id of this.dueAt.keys()) {
      if (!keep.has(id)) this.dueAt.delete(id)
    }
  }
}
