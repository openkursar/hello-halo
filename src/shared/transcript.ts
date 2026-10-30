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

/**
 * Stored text of a `continuity-notice`. The chat shows its own translation;
 * this wording is what other readers of the record (exports, handoff) see.
 */
export const CONTINUITY_NOTICE_TEXT = 'Some earlier details could not be restored exactly; the conversation continues from its record.'

/** The role a message of this source is stored and shown with. */
export function roleForTranscriptSource(source: TranscriptSource | undefined): TranscriptRole {
  return source === 'cross-conversation' || source === 'cross-conversation-notice' || source === 'team-message'
    || source === 'continuity-notice'
    ? 'system'
    : 'user'
}

/** Team records without provenance stay visible as ordinary system messages. */
export function isTeamTranscriptMessage(message: TranscriptMessage): boolean {
  return message.role === 'system' && message.source === 'team-message' && !!message.metadata?.teamId
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
 *
 * `openTurnFrom` (the reader's first message of an unfinished engine turn) is
 * passed on to newest pages only; an older page holds no part of that turn.
 */
export function pageTranscript(
  messages: readonly TranscriptMessage[],
  request: TranscriptPageRequest = {},
  openTurnFrom?: string
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
    ...(openTurnFrom !== undefined && request.before === undefined ? { openTurnFrom } : {}),
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

/**
 * Match an accepted input to its persisted twin without relying on a provisional
 * id. The reply anchor and the outcome are learned after the input is announced,
 * so they never tell two inputs apart.
 */
export function sameTranscriptInput(left: TranscriptMessage, right: TranscriptMessage): boolean {
  return left.role === right.role && left.source === right.source
    && left.content.trim() === right.content.trim()
    && (left.images?.length ?? 0) === (right.images?.length ?? 0)
    && sameInputMetadata(left.metadata, right.metadata)
}

function sameInputMetadata(left: TranscriptMessage['metadata'], right: TranscriptMessage['metadata']): boolean {
  const comparable = (metadata: TranscriptMessage['metadata']) => Object.entries(metadata ?? {})
    .filter(([key, value]) => value !== undefined && key !== 'inputReplyId' && key !== 'inputOutcome')
  const leftEntries = comparable(left)
  const rightEntries = comparable(right)
  if (leftEntries.length !== rightEntries.length) return false
  const rightValues = new Map(rightEntries)
  return leftEntries.every(([key, value]) => rightValues.has(key) && canonicalJson(value) === canonicalJson(rightValues.get(key)))
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : item)
}
