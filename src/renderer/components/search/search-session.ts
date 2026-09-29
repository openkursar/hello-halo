/**
 * Telemetry for one command-palette session, from the panel opening to it
 * closing: what was picked, and how each message-content search ended.
 * Guarantees one close per open and one outcome per search run, whichever of
 * finishing, failing or being cancelled comes first.
 */

import { countBucket, lenBucket, msBucket, trackHome } from '../../services/home-telemetry'
import type { SearchOpenSurface, SearchScope } from '../../stores/search.store'

export type SearchPickKind = 'action' | 'recent' | 'quick_hit' | 'message_result' | 'search_messages'

const RANK_BOUNDS = [1, 3, 10]
const RESULT_BOUNDS = [0, 5, 20, 100]

interface SearchRun {
  scope: SearchScope
  queryLength: number
  startedAt: number
}

export function createSearchSession(now: () => number = Date.now) {
  let isOpen = false
  let picked = false
  let hadQuery = false
  let deepSearched = false
  let nextRunId = 0
  const runs = new Map<number, SearchRun>()

  const reportRun = (runId: number, outcome: 'done' | 'cancelled' | 'error', resultCount?: number) => {
    const run = runs.get(runId)
    if (!run) return
    runs.delete(runId)
    const done = outcome === 'done' && resultCount !== undefined
    trackHome('home.search.query', {
      scope: run.scope,
      outcome,
      zero: done ? resultCount === 0 : undefined,
      lenBucket: lenBucket(run.queryLength),
      resultBucket: done ? countBucket(resultCount, RESULT_BOUNDS) : undefined,
      latencyBucket: msBucket(now() - run.startedAt),
    })
  }

  return {
    open(surface: SearchOpenSurface, scope: SearchScope, query: string): void {
      if (isOpen) return
      isOpen = true
      picked = false
      hadQuery = query.trim().length > 0
      deepSearched = false
      trackHome('home.search.open', { surface, scope })
    },

    noteQuery(query: string): void {
      if (query.trim()) hadQuery = true
    },

    pick(kind: SearchPickKind, type: string, rank: number): void {
      // Searching messages only moves on to results; the session still has to end in one.
      if (kind !== 'search_messages') picked = true
      trackHome('home.search.pick', { kind, type, rank: countBucket(rank, RANK_BOUNDS) })
    },

    /** Returns the run's handle for `queryEnded`. */
    queryStarted(scope: SearchScope, queryLength: number): number {
      deepSearched = true
      hadQuery = true
      const runId = ++nextRunId
      runs.set(runId, { scope, queryLength, startedAt: now() })
      return runId
    },

    queryEnded(runId: number, outcome: 'done' | 'error', resultCount?: number): void {
      reportRun(runId, outcome, resultCount)
    },

    queryCancelled(): void {
      for (const runId of [...runs.keys()]) reportRun(runId, 'cancelled')
    },

    close(): void {
      if (!isOpen) return
      isOpen = false
      trackHome('home.search.close', { outcome: picked ? 'picked' : 'abandoned', hadQuery, deepSearched })
    },
  }
}

export const searchSession = createSearchSession()
