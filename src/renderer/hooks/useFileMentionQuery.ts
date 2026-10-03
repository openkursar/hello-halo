/**
 * File candidates for the @ menu, fetched on demand.
 *
 * The space's paths live in the main process's background index; each query
 * returns only the best `limit` matches, so the renderer never holds or sorts
 * the whole file list. While mounted the space stays watched (and its index
 * current); queries run only while the menu is open.
 */

import { useEffect, useState } from 'react'
import { api } from '../api'
import { holdArtifactSpace } from '../services/artifact-space-holds'
import type { FileQueryItem } from '../../shared/types/artifact'

const QUERY_DEBOUNCE_MS = 50
/** Re-ask while the index is still being built, so late paths show up. */
const INDEXING_RETRY_MS = 500

export interface FileMentionQueryState {
  items: FileQueryItem[]
  /** More paths exist than the index holds; deep paths may be missing. */
  truncated: boolean
  indexing: boolean
  /** The space has at least one indexed path, whether or not any matched. */
  hasPaths: boolean
}

export interface FileMentionMenuState extends FileMentionQueryState {
  /**
   * The space has files to offer (any path indexed, or still indexing), so the
   * menu is worth showing even when the current query matches nothing.
   */
  available: boolean
}

const EMPTY: FileMentionQueryState = { items: [], truncated: false, indexing: false, hasPaths: false }

export function hasFilesToOffer(result: FileMentionQueryState): boolean {
  return result.hasPaths || result.indexing
}

export function useFileMentionQuery(
  spaceId: string | undefined,
  query: string,
  active: boolean,
  limit: number
): FileMentionMenuState {
  const [state, setState] = useState<FileMentionQueryState>(EMPTY)
  // Bumped by structural file changes so an open menu re-queries.
  const [changeTick, setChangeTick] = useState(0)

  useEffect(() => {
    if (!spaceId) return
    return holdArtifactSpace(spaceId)
  }, [spaceId])

  useEffect(() => {
    if (!spaceId || !active) return
    return api.onArtifactChangedBatch(batch => {
      if (batch.spaceId !== spaceId) return
      if (!batch.resync && batch.changes.every(change => change.type === 'change')) return
      setChangeTick(tick => tick + 1)
    })
  }, [spaceId, active])

  useEffect(() => {
    if (!spaceId || !active) {
      setState(EMPTY)
      return
    }
    return startFileQuery(
      () => api.queryArtifactFiles(spaceId, query, limit),
      setState
    )
  }, [spaceId, query, active, limit, changeTick])

  return { ...state, available: hasFilesToOffer(state) }
}

/**
 * Run one query after a short debounce and repeat it while the index reports
 * `indexing`, stopping as soon as a result is complete. Returns the cancel
 * function (menu closed, query changed, unmount).
 */
export function startFileQuery(
  fetch: () => Promise<{ success: boolean; data?: FileMentionQueryState; error?: string }>,
  onResult: (result: FileMentionQueryState) => void
): () => void {
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const run = async (): Promise<void> => {
    timer = null
    try {
      const response = await fetch()
      if (cancelled || !response.success || !response.data) return
      onResult(response.data)
      if (response.data.indexing) timer = setTimeout(run, INDEXING_RETRY_MS)
    } catch (error) {
      if (!cancelled) console.warn('[useFileMentionQuery] File query failed:', error)
    }
  }

  timer = setTimeout(run, QUERY_DEBOUNCE_MS)
  return () => {
    cancelled = true
    if (timer) clearTimeout(timer)
  }
}
