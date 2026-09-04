/**
 * Cross-Conversation Interop — listing and bounded reading.
 *
 * Reads `{id}.json`'s `messages` only — never `{id}.thoughts.json`. That
 * split is the entire reason this feature is affordable: a clean transcript
 * costs nothing extra to hand to another conversation, while the thinking/
 * tool-call stream is expensive and was never meant to leave its own turn.
 */

import { listConversations, getConversation } from '../conversation.service'
import { isNativeConversationBusy } from './busy'
import type {
  ConversationListPage,
  ConversationReadPage,
  ListConversationsResult,
  ReadConversationResult,
  TranscriptLine,
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

  const all = listConversations(spaceId).filter((c) => c.id !== callerConversationId)
  const slice = all.slice(offset, offset + pageSize)

  const page: ConversationListPage = {
    items: slice.map((meta) => ({
      id: meta.id,
      title: meta.title,
      updatedAt: meta.updatedAt,
      messageCount: meta.messageCount,
      running: isNativeConversationBusy(meta.id),
    })),
    total: all.length,
  }
  const consumed = offset + slice.length
  if (consumed < all.length) page.nextCursor = String(consumed)

  return { ok: true, page }
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
  const conversation = getConversation(spaceId, conversationId)
  if (!conversation) return { ok: false, reason: 'not_found' }

  // The cursor is "how many trailing messages have already been shown";
  // this page continues from just before them.
  const alreadyShown = parseCursor(cursor)
  if (alreadyShown === null || alreadyShown > conversation.messages.length) {
    return { ok: false, reason: 'invalid_cursor' }
  }

  const endExclusive = conversation.messages.length - alreadyShown
  let start = endExclusive
  let chars = 0
  while (start > 0) {
    const next = conversation.messages[start - 1]
    const nextLen = next.content.length
    // Always include at least one message per page, even if it alone exceeds
    // the budget — an empty page would be a worse answer than an oversized one.
    if (chars > 0 && chars + nextLen > charBudget) break
    chars += nextLen
    start -= 1
  }

  const lines: TranscriptLine[] = conversation.messages.slice(start, endExclusive).map((m) => ({
    role: m.role,
    content: m.content,
    timestamp: m.timestamp,
    source: m.source,
  }))

  const page: ConversationReadPage = {
    id: conversation.id,
    title: conversation.title,
    running: isNativeConversationBusy(conversation.id),
    updatedAt: conversation.updatedAt,
    lines,
    totalMessages: conversation.messages.length,
    hiddenBefore: start,
  }
  if (start > 0) page.nextCursor = String(conversation.messages.length - start)

  return { ok: true, page }
}
