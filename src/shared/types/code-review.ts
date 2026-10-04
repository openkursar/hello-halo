/**
 * Starting an AI review of a repository's changes from the changes view, and
 * reading back the latest one. The review itself is an ordinary conversation
 * of the space; these shapes only start it and point at it.
 */

import type { GitCompareScope, GitReviewRecord } from './git'

export interface CodeReviewStartRequest {
  spaceId: string
  /** A repository the space discovered (absolute root). */
  repoRoot: string
  variant: 'quick' | 'team'
  scope: GitCompareScope
  /** The compare scope as the user saw it. */
  scopeLabel: string
  /** Files the changes view listed; the main process recounts when it can. */
  fileCount: number
  /** UI language of the user (BCP 47); the report is written in it. */
  language: string
  /** Title of the review conversation, in the user's language; kept as given. */
  title: string
}

export type CodeReviewRefusal =
  /** The team tools are not available in this session of Halo. */
  | 'team-unavailable'
  /** The repository is not one this space discovered (any more). */
  | 'not-a-repository'
  /** Git is not installed or cannot run. */
  | 'git-unavailable'
  | 'failed'

export type CodeReviewStartResult =
  | { ok: true; conversationId: string; record: GitReviewRecord }
  | { ok: false; reason: CodeReviewRefusal; message: string }

export interface CodeReviewAvailability {
  team: { available: true } | { available: false; reason: 'team-unavailable' }
}
