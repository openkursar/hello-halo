/**
 * How far an AI review has got, derived from its conversation: the live turn,
 * the stored transcript and — for a team review — the collaboration it ran.
 * Pure; `hooks/useReviewProgress` feeds it from the stores.
 *
 * A review is the conversation's task message and what follows it up to the
 * next message the user typed there: a user who keeps talking in the review
 * conversation afterwards does not replace its report.
 */

import type { CollabSummary, EpochEndReason } from '../../shared/apps/team-types'
import type { GitReviewRecord } from '../../shared/types/git'
import type { Message } from '../types'
import type { ThoughtActivity, TodoItem } from './thought-activity'

export type ReviewProgressStatus = 'loading' | 'running' | 'done' | 'error' | 'stopped' | 'missing'

export interface ReviewMember {
  name: string
  role?: string
  state: 'working' | 'idle' | 'waiting' | 'done' | 'failed'
}

export interface ReviewProgress {
  status: ReviewProgressStatus
  startedAt: number | null
  /** When the review stopped running (done, error or stopped). */
  endedAt: number | null
  /** The reviewer's latest todo list. */
  todos: TodoItem[] | null
  /** What the reviewer is doing right now, as an i18n key; only while a turn runs. */
  activity: ThoughtActivity | null
  /** Tokens the review conversation used (input, output and cache), when reported. */
  tokens: number | null
  /** The review's last reply, once it is done. */
  report: { messageId: string; content: string } | null
  conversationTitle: string | null
  /** Team reviews only, from the collaboration's own data; null when not known. */
  members: ReviewMember[] | null
  error: string | null
}

export const EMPTY_REVIEW_PROGRESS: ReviewProgress = Object.freeze({
  status: 'loading',
  startedAt: null,
  endedAt: null,
  todos: null,
  activity: null,
  tokens: null,
  report: null,
  conversationTitle: null,
  members: null,
  error: null,
}) as ReviewProgress

/** Messages a review's task message can be preceded by; a review is its conversation's first message. */
const TASK_SEARCH_LIMIT = 5

/**
 * Where the review's own messages are: [start, end) from its task message to
 * the next ordinary user message. Null when no task message is found.
 */
export function reviewSpan(messages: readonly Message[]): { start: number; end: number } | null {
  const limit = Math.min(messages.length, TASK_SEARCH_LIMIT)
  let start = -1
  for (let i = 0; i < limit; i++) {
    if (messages[i].role === 'user' && messages[i].metadata?.task) { start = i; break }
  }
  if (start < 0) return null
  let end = start + 1
  while (end < messages.length && !(messages[end].role === 'user' && !messages[end].source)) end++
  return { start, end }
}

export interface ReviewConversationView {
  title: string
  updatedAt: string
  messages: readonly Message[]
}

export interface ReviewProgressInput {
  record: GitReviewRecord
  /** Why the conversation could not be read, when it could not. */
  loadError: string | null
  conversation: ReviewConversationView | null
  isGenerating: boolean
  sessionError: string | null
  sessionErrorType: string | null
  /** Latest todo list among the running (or just finished) turn's steps. */
  liveTodos: TodoItem[] | null
  liveActivity: ThoughtActivity | null
  /** Todo list of an earlier turn, when its steps were read. */
  earlierTodos: TodoItem[] | null
  /** Team reviews: the collaboration; null when there is none, undefined until read. */
  collab: CollabSummary | null | undefined
  /**
   * Team reviews: how the collaboration's work ended, once it has and that was
   * read; null when its record is gone.
   */
  collabEnd: CollabEnd | null | undefined
}

export interface CollabEnd {
  reason: EpochEndReason | null
  /** What team_complete left; work closed without it was not finished by the team. */
  summary: string | null
}

function memberState(status: CollabSummary['members'][number]['status'], active: boolean): ReviewMember['state'] {
  switch (status) {
    case 'working': return 'working'
    case 'waiting_user': return 'waiting'
    case 'error': return 'failed'
    case 'idle': return active ? 'idle' : 'done'
  }
}

function sumTokens(messages: readonly Message[]): number | null {
  let total: number | null = null
  for (const message of messages) {
    const usage = message.role === 'assistant' ? message.tokenUsage : undefined
    if (!usage) continue
    total = (total ?? 0) + usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens
  }
  return total
}

export function deriveReviewProgress(input: ReviewProgressInput): ReviewProgress {
  const { record, conversation } = input
  if (input.loadError) {
    return { ...EMPTY_REVIEW_PROGRESS, status: 'missing', startedAt: record.startedAt, error: input.loadError }
  }
  if (!conversation) return { ...EMPTY_REVIEW_PROGRESS, startedAt: record.startedAt }

  const span = reviewSpan(conversation.messages) ?? { start: 0, end: conversation.messages.length }
  const own = conversation.messages.slice(span.start, span.end)
  let lastReply: Message | undefined
  for (let i = own.length - 1; i >= 0; i--) {
    if (own[i].role === 'assistant') { lastReply = own[i]; break }
  }

  const team = record.variant === 'team'
  const collab = team ? input.collab : null
  const members = collab
    ? collab.members.map((m): ReviewMember => ({ name: m.memberName, role: m.role || undefined, state: memberState(m.status, collab.active) }))
    : null

  const base: ReviewProgress = {
    ...EMPTY_REVIEW_PROGRESS,
    startedAt: record.startedAt,
    todos: input.liveTodos ?? input.earlierTodos,
    tokens: sumTokens(own),
    conversationTitle: conversation.title,
    members,
  }
  const ended = (status: ReviewProgressStatus, extra: Partial<ReviewProgress> = {}): ReviewProgress => {
    const at = Date.parse(conversation.updatedAt)
    return { ...base, status, endedAt: Number.isFinite(at) ? at : null, ...extra }
  }

  // A team review keeps running while its members work, between the
  // coordinator's turns, and its first reply only says the work was handed out.
  if (input.isGenerating || collab?.active) {
    return { ...base, status: 'running', activity: input.isGenerating ? input.liveActivity : null }
  }
  if (team && collab === undefined) return { ...base, status: 'loading' }
  if (input.sessionErrorType === 'interrupted') return ended('stopped')
  if (input.sessionError) return ended('error', { error: input.sessionError })
  if (collab && input.collabEnd !== null) {
    if (input.collabEnd === undefined) return { ...base, status: 'running' }
    const { reason, summary } = input.collabEnd
    if (reason === 'stopped' || reason === 'cleared' || (reason === 'completed' && !summary)) return ended('stopped')
    if (reason === 'timeout' || reason === 'error') return ended('error')
  }
  // The task is recorded before its turn starts.
  if (!lastReply) return { ...base, status: 'running' }
  if (lastReply.error) return ended('error', { error: lastReply.error })
  if (!lastReply.content.trim()) return ended('stopped')
  return ended('done', { report: { messageId: lastReply.id, content: lastReply.content } })
}
