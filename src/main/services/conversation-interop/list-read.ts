/**
 * Cross-Conversation Interop — listing and bounded reading.
 *
 * Works over every readable conversation source: one recency-ordered list and
 * one paging policy for all of them. A source only supplies conversations and
 * their clean transcripts; how they are cut into pages is this module's rule.
 */

import { tailStartWithinBudget } from '../../../shared/transcript'
import { admitRead } from './admission'
import { getReadableSources, listSourceConversations, sourceOfConversation } from './source'
import type { ConversationSource, SourceConversation } from './source'
import type {
  ConversationListPage,
  ConversationReadPage,
  ListConversationsResult,
  ReadConversationResult,
} from './types'

const DEFAULT_LIST_PAGE_SIZE = 20
const DEFAULT_READ_CHAR_BUDGET = 8_000

function parseCursor(cursor: string | undefined): number | null {
  if (cursor === undefined) return 0
  if (!/^\d+$/.test(cursor)) return null
  const offset = Number(cursor)
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : null
}

/**
 * Recency-ordered list of conversations in a space, excluding the caller's own
 * — self is never a valid target and has no reason to see itself in a list of
 * OTHER conversations to reach.
 */
export function listConversationsForInterop(
  spaceId: string,
  callerConversationId: string,
  cursor?: string,
  pageSize: number = DEFAULT_LIST_PAGE_SIZE
): ListConversationsResult {
  const offset = parseCursor(cursor)
  if (offset === null) return { ok: false, reason: 'invalid_cursor' }

  const all = listReadableConversations(spaceId).filter((c) => c.meta.id !== callerConversationId)
  const slice = all.slice(offset, offset + pageSize)

  const page: ConversationListPage = {
    items: slice.map(({ source, meta }) => ({
      id: meta.id,
      title: meta.title,
      updatedAt: meta.updatedAt,
      messageCount: meta.messageCount,
      running: source.isBusy(meta.id),
      ...(source.label ? { label: source.label } : {}),
    })),
    total: all.length,
  }
  const consumed = offset + slice.length
  if (consumed < all.length) page.nextCursor = String(consumed)

  return { ok: true, page }
}

/**
 * Every conversation of a space another conversation's AI may take part in,
 * most recently active first. The sort is stable, so a source that already lists
 * in recency order keeps its own order for ties.
 */
export function listReadableConversations(spaceId: string): { source: ConversationSource; meta: SourceConversation }[] {
  const rows = getReadableSources().flatMap((source) =>
    listSourceConversations(source, spaceId)
      .filter((meta) => admitRead(source, meta).ok)
      .map((meta) => ({ source, meta }))
  )
  return rows.sort((a, b) => new Date(b.meta.updatedAt).getTime() - new Date(a.meta.updatedAt).getTime())
}

/**
 * One bounded page of a conversation's own transcript, most recent content
 * first (paged backwards from the end), never the thinking/tool-call stream.
 */
export function readConversationForInterop(
  spaceId: string,
  conversationId: string,
  cursor?: string,
  charBudget: number = DEFAULT_READ_CHAR_BUDGET
): ReadConversationResult {
  const source = sourceOfConversation(conversationId)
  const meta = source?.getMeta(spaceId, conversationId)
  if (!source || !meta) return { ok: false, reason: 'not_found' }
  const admission = admitRead(source, meta)
  if (!admission.ok) return { ok: false, reason: 'unavailable', detail: admission.detail }
  const messages = source.readTranscript(spaceId, conversationId)
  if (!messages) return { ok: false, reason: 'not_found' }

  // The cursor is "how many trailing messages have already been shown";
  // this page continues from just before them.
  const alreadyShown = parseCursor(cursor)
  if (alreadyShown === null || alreadyShown > messages.length) {
    return { ok: false, reason: 'invalid_cursor' }
  }

  const endExclusive = messages.length - alreadyShown
  const start = tailStartWithinBudget(messages, endExclusive, charBudget, (m) => m.content.length)

  const page: ConversationReadPage = {
    id: meta.id,
    title: meta.title,
    running: source.isBusy(meta.id),
    updatedAt: meta.updatedAt,
    ...(source.label ? { label: source.label } : {}),
    lines: messages.slice(start, endExclusive),
    totalMessages: messages.length,
    hiddenBefore: start,
  }
  if (start > 0) page.nextCursor = String(messages.length - start)

  return { ok: true, page }
}
