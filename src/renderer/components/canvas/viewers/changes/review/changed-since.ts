/**
 * The review card's count of files changed since the reviewed snapshot, kept
 * for as long as the changes view is open: the card is unmounted whenever a
 * detail page or the Changes page is shown, and coming back to it must not
 * count again when nothing changed meanwhile.
 *
 * A count snapshots the whole working tree in the main process — every
 * untracked file hashed, objects written to `.git` — so one runs only when the
 * card first shows a finished review, when it shows again after files changed
 * meanwhile, and when the user refreshes or discards (`recount`); never on
 * window focus, staging, commits, or file events while the card is on screen.
 * Changes the file watcher does not report wait for a Refresh, as they do
 * while the card is on screen.
 */
export class ChangedSinceCounter {
  private key: string | null = null
  private pending: Promise<number> | null = null
  private last: { snapshot: string; count: number } | null = null

  /** The latest count for `snapshot`, shown while a newer one runs. */
  lastFor(snapshot: string): number | null {
    return this.last?.snapshot === snapshot ? this.last.count : null
  }

  /**
   * The count for a finished review's `snapshot` as of `recount` and of the
   * file changes the view had seen when the card appeared (`seen`): the one
   * made or in flight for the same three, otherwise a new one from `count`.
   */
  countFor(snapshot: string, recount: number, seen: number, count: () => Promise<number>): Promise<number> {
    const key = `${snapshot}|${recount}|${seen}`
    if (key === this.key && this.pending) return this.pending
    this.key = key
    const pending = count().then((value) => {
      // A count overtaken by a newer one does not replace it.
      if (this.pending === pending) this.last = { snapshot, count: value }
      return value
    })
    this.pending = pending
    return pending
  }
}
