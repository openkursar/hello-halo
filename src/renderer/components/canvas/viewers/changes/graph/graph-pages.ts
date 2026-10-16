/**
 * Paging of the commit graph: how a fetched page folds into the loaded list,
 * what a failed load leaves on screen, and the loads of one graph page, run one
 * at a time. Pure; no React, no IPC.
 */

import type { GitCommitGraph, GitGraphCommit } from '../../../../../../shared/types/git'

/** A new query's first page, the next page, or the first page again when the graph is shown again. */
export type GraphLoadMode = 'reset' | 'append' | 'refresh'

export interface GraphPages {
  commits: GitGraphCommit[]
  /** Commits of the query's history read so far: the next page skips this many. */
  read: number
  /** A later page may hold more commits. */
  more: boolean
}

export const NO_PAGES: GraphPages = { commits: [], read: 0, more: false }

/**
 * The list once `page`, fetched for `mode`, is in. Pages are point-in-time
 * snapshots, so a commit that arrived between two pages can repeat: it is kept once.
 */
export function mergePage(pages: GraphPages, mode: GraphLoadMode, page: GitCommitGraph): GraphPages {
  if (mode === 'append') {
    const known = new Set(pages.commits.map((c) => c.oid))
    const added = page.commits.filter((c) => !known.has(c.oid))
    return {
      commits: added.length > 0 ? [...pages.commits, ...added] : pages.commits,
      read: pages.read + page.commits.length,
      more: page.more,
    }
  }
  if (mode === 'refresh' && page.more) {
    // New commits on top push the loaded rows down. When every loaded row down to
    // where the fresh first page ends is still in it, the deeper loaded rows go on
    // from there. A loaded row it lacks was pushed further down (topo order moved
    // a branch line longer than a page to the top) or rewritten (amend, rebase):
    // the deeper rows can no longer be placed, and load again as the list scrolls.
    const last = page.commits.at(-1)
    const at = last ? pages.commits.findIndex((c) => c.oid === last.oid) : -1
    const fresh = new Set(page.commits.map((c) => c.oid))
    if (at !== -1 && pages.commits.slice(0, at + 1).every((c) => fresh.has(c.oid))) {
      const tail = pages.commits.slice(at + 1).filter((c) => !fresh.has(c.oid))
      if (tail.length > 0) {
        return { commits: [...page.commits, ...tail], read: page.commits.length + tail.length, more: pages.more }
      }
    }
  }
  // A new query, a first page that is the whole history, or one the loaded rows
  // cannot go on from: the page alone is the list.
  return { commits: page.commits, read: page.commits.length, more: page.more }
}

export type GraphLoadOutcome = { page: GitCommitGraph } | { error: unknown }

/** What the graph page shows: the loaded list, and the failure shown with it. */
export interface GraphView {
  pages: GraphPages
  /** A new query's first page that failed stands in for the list; a next page that failed ends it with a retry. */
  failure: { mode: 'reset' | 'append'; error: unknown } | null
}

export const EMPTY_VIEW: GraphView = { pages: NO_PAGES, failure: null }

/**
 * The view once a load settles. Reading the first page again (the graph shown
 * again) runs unasked, so its failure leaves the view as it was: the rows on
 * screen are still history, and the next showing reads it again.
 */
export function settleLoad(view: GraphView, mode: GraphLoadMode, outcome: GraphLoadOutcome): GraphView {
  if ('page' in outcome) return { pages: mergePage(view.pages, mode, outcome.page), failure: null }
  if (mode === 'refresh') return view
  return { pages: view.pages, failure: { mode, error: outcome.error } }
}

/**
 * The loads of one graph page, one at a time: each runs a `git log` that may
 * walk the whole history. A load asked for while another runs waits for it. An
 * append is dropped (the page asks again once the running load lands), a
 * refresh waits only behind an append, and a reset always waits, dropping what
 * the running load returns, which answers the previous query. The running git
 * process is not cancelled, but no second one starts beside it.
 */
export class GraphLoader {
  private running: GraphLoadMode | null = null
  private waiting: 'reset' | 'refresh' | null = null
  /** A reset was asked for after the running load started. */
  private superseded = false
  private disposed = false

  constructor(
    private readonly fetchPage: (mode: GraphLoadMode) => Promise<GitCommitGraph>,
    private readonly settle: (mode: GraphLoadMode, outcome: GraphLoadOutcome) => void,
  ) {}

  get busy(): boolean {
    return this.running !== null
  }

  load(mode: GraphLoadMode): void {
    if (this.disposed) return
    if (!this.running) {
      void this.run(mode)
    } else if (mode === 'reset') {
      this.superseded = true
      this.waiting = 'reset'
    } else if (mode === 'refresh' && this.running === 'append' && !this.waiting) {
      this.waiting = 'refresh'
    }
  }

  dispose(): void {
    this.disposed = true
    this.waiting = null
  }

  private async run(mode: GraphLoadMode): Promise<void> {
    this.running = mode
    this.superseded = false
    let outcome: GraphLoadOutcome
    try {
      outcome = { page: await this.fetchPage(mode) }
    } catch (error) {
      outcome = { error }
    }
    if (this.disposed) return
    const stale = this.superseded
    const next = this.waiting
    this.running = null
    this.waiting = null
    // The next load starts first, so nothing the outcome sets off can start one beside it.
    if (next) void this.run(next)
    if (!stale) this.settle(mode, outcome)
  }
}
