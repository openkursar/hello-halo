/**
 * Transcript helpers shared by every reader: paging over an ordered message
 * list, the list-view projection (thoughts not loaded) and the source → role
 * rule. Pure functions (renderer-safe, no Electron/Node).
 */

import type {
  Thought,
  ThoughtsSummary,
  TranscriptMessage,
  TranscriptPage,
  TranscriptPageRequest,
  TranscriptRole,
  TranscriptSource,
} from './types/transcript'

export const DEFAULT_TRANSCRIPT_PAGE_SIZE = 50
export const MAX_TRANSCRIPT_PAGE_SIZE = 200
/** Most messages a `through` page may span. */
export const MAX_TRANSCRIPT_THROUGH = 2000
/** Messages kept above a `through` target so it does not sit at the very top edge. */
const THROUGH_CONTEXT = 5

/** The role a message of this source is stored and shown with. */
export function roleForTranscriptSource(source: TranscriptSource | undefined): TranscriptRole {
  return source === 'cross-conversation' || source === 'cross-conversation-notice' || source === 'team-message'
    ? 'system'
    : 'user'
}

export function clampTranscriptLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1) return DEFAULT_TRANSCRIPT_PAGE_SIZE
  return Math.min(Math.floor(limit), MAX_TRANSCRIPT_PAGE_SIZE)
}

/**
 * Slice the newest `limit` messages, the `limit` messages just older than
 * `before`, or (`through`) the newest page widened back to a given message.
 *
 * An unknown `before` (the message is gone — history was cleared) yields an
 * empty page rather than restarting from the newest, so a caller walking
 * backwards never re-receives messages it already has. A `through` message
 * further back than `MAX_TRANSCRIPT_THROUGH` is out of reach and leaves the page
 * as it is: widening to the cap would ship that many messages without holding
 * the one asked for.
 */
export function pageTranscript(
  messages: readonly TranscriptMessage[],
  request: TranscriptPageRequest = {}
): TranscriptPage {
  const limit = clampTranscriptLimit(request.limit)
  let end = messages.length
  let start = Math.max(0, end - limit)
  if (request.before !== undefined) {
    const index = messages.findIndex(m => m.id === request.before)
    end = index < 0 ? 0 : index
    start = Math.max(0, end - limit)
  } else if (request.through !== undefined) {
    const index = messages.findIndex(m => m.id === request.through)
    if (index >= 0 && index < start && end - index <= MAX_TRANSCRIPT_THROUGH) {
      start = Math.max(0, index - THROUGH_CONTEXT, end - MAX_TRANSCRIPT_THROUGH)
    }
  }
  const slice = messages.slice(start, end)
  return {
    messages: slice,
    hasMoreBefore: start > 0,
    cursor: slice.length > 0 ? slice[0].id : null,
    total: messages.length,
  }
}

/** Digest of a thought process, for showing it collapsed without loading it. */
export function summarizeThoughts(thoughts: readonly Thought[]): ThoughtsSummary {
  const types: ThoughtsSummary['types'] = {}
  for (const t of thoughts) {
    types[t.type] = (types[t.type] || 0) + 1
  }
  let duration: number | undefined
  if (thoughts.length >= 2) {
    const first = new Date(thoughts[0].timestamp).getTime()
    const last = new Date(thoughts[thoughts.length - 1].timestamp).getTime()
    duration = (last - first) / 1000
  }
  return { count: thoughts.length, types, duration }
}

/**
 * List-view projection of a message: a loaded thought process is replaced by
 * `null` (its `thoughtsSummary` stays), so a page carries no tool output.
 * Messages without thoughts, and those already unloaded, are returned as-is.
 */
export function withThoughtsUnloaded(message: TranscriptMessage): TranscriptMessage {
  return Array.isArray(message.thoughts) ? { ...message, thoughts: null } : message
}

/**
 * Start index of the newest run of items ending just before `endExclusive`
 * whose sizes fit `budget`. At least one item is always taken (an empty page
 * would be a worse answer than an oversized one), so `start < endExclusive`
 * whenever `endExclusive > 0`.
 */
export function tailStartWithinBudget<T>(
  items: readonly T[],
  endExclusive: number,
  budget: number,
  sizeOf: (item: T) => number
): number {
  let start = endExclusive
  let used = 0
  while (start > 0) {
    const size = sizeOf(items[start - 1])
    if (used > 0 && used + size > budget) break
    used += size
    start -= 1
  }
  return start
}
