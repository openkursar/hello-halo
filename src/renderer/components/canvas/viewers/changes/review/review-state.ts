/**
 * What the review card shows, derived from the repository's latest review
 * record and the progress of its conversation. Kept apart from the card so
 * every state can be produced (and checked) without a conversation.
 */

import type { CodeReviewRefusal } from '../../../../../../shared/types/code-review'
import type { GitReviewRecord } from '../../../../../../shared/types/git'
import type { ReviewProgress } from '../../../../../hooks/useReviewProgress'
import type { Translate } from '../model/scope'

export type ReviewVariant = GitReviewRecord['variant']

export type ReviewCardState =
  /** Nothing to show yet: no review was started, or its conversation was deleted. */
  | { kind: 'idle'; deleted: boolean }
  /** The review's conversation is being read. */
  | { kind: 'loading'; variant: ReviewVariant }
  | {
      kind: 'running'
      variant: ReviewVariant
      startedAt: number
      todos: ReviewProgress['todos']
      activity: ReviewProgress['activity']
      members: ReviewProgress['members']
    }
  | { kind: 'stopped'; variant: ReviewVariant }
  /** Ended without a report. */
  | { kind: 'failed'; variant: ReviewVariant; error: string | null }
  | {
      kind: 'done'
      variant: ReviewVariant
      finishedAt: number
      tookMs: number | null
      tokens: number | null
      report: NonNullable<ReviewProgress['report']>
      conversationTitle: string | null
      /** When the reviewed changes were taken. */
      basedOn: number
      /** Files changed since then; 0 when none or unknown. */
      changedSince: number
    }

export function reviewCardState(record: GitReviewRecord | null, progress: ReviewProgress, changedSince: number): ReviewCardState {
  if (!record) return { kind: 'idle', deleted: false }
  const variant = record.variant
  switch (progress.status) {
    case 'missing':
      return { kind: 'idle', deleted: true }
    case 'loading':
      return { kind: 'loading', variant }
    case 'running':
      return {
        kind: 'running',
        variant,
        startedAt: progress.startedAt ?? record.startedAt,
        todos: progress.todos,
        activity: progress.activity,
        members: progress.members,
      }
    case 'stopped':
      return { kind: 'stopped', variant }
    case 'error':
      return { kind: 'failed', variant, error: progress.error }
    case 'done': {
      if (!progress.report) return { kind: 'failed', variant, error: progress.error }
      const startedAt = progress.startedAt ?? record.startedAt
      return {
        kind: 'done',
        variant,
        finishedAt: progress.endedAt ?? startedAt,
        tookMs: progress.endedAt !== null ? Math.max(0, progress.endedAt - startedAt) : null,
        tokens: progress.tokens,
        report: progress.report,
        conversationTitle: progress.conversationTitle,
        basedOn: record.startedAt,
        changedSince,
      }
    }
  }
}

/** Why a review did not start, in the user's words. */
export function refusalText(reason: CodeReviewRefusal, message: string, t: Translate): string {
  switch (reason) {
    case 'team-unavailable': return t('Team review isn\'t available right now')
    case 'not-a-repository': return t('This folder is no longer a Git repository.')
    case 'git-unavailable': return t('Git isn\'t available on this computer.')
    case 'failed': return message || t('Something went wrong')
  }
}
