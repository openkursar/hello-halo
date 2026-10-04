/**
 * The git and code-review requests the changes view makes, in one place:
 * envelopes unwrapped, failures thrown as `ChangesRequestError` with the
 * service's stable code.
 */

import { api } from '../../../../../api'
import type { CodeReviewAvailability, CodeReviewStartRequest, CodeReviewStartResult } from '../../../../../../shared/types/code-review'
import type {
  GitChangeList,
  GitCommitRequest,
  GitCommitResult,
  GitCompareScope,
  GitFileContents,
  GitFileContentsRequest,
  GitRepositoryList,
  GitReviewRecord,
  GitRevisionOption,
  GitSyncResult,
  GitWorkingTreeStatus,
} from '../../../../../../shared/types/git'
import type { GitFailure } from './git-errors'

interface Envelope<T> {
  success: boolean
  data?: T
  error?: string
  code?: string
}

export class ChangesRequestError extends Error implements GitFailure {
  constructor(readonly code: string | undefined, readonly error: string | undefined) {
    super(error || code || 'Request failed')
    this.name = 'ChangesRequestError'
  }
}

async function unwrap<T>(request: Promise<Envelope<T>>): Promise<T> {
  const response = await request
  if (!response.success) throw new ChangesRequestError(response.code, response.error)
  return response.data as T
}

export function failureOf(error: unknown): GitFailure {
  if (error instanceof ChangesRequestError) return { code: error.code, error: error.error }
  return { error: error instanceof Error ? error.message : String(error) }
}

export const gitClient = {
  listRepositories: (spaceId: string): Promise<GitRepositoryList> =>
    unwrap(api.gitListRepositories(spaceId)),
  getStatus: (spaceId: string, repoRoot: string): Promise<GitWorkingTreeStatus> =>
    unwrap(api.gitGetStatus(spaceId, repoRoot)),
  getChanges: (spaceId: string, repoRoot: string, scope: GitCompareScope): Promise<GitChangeList> =>
    unwrap(api.gitGetChanges(spaceId, repoRoot, scope)),
  getFileContents: (spaceId: string, repoRoot: string, request: GitFileContentsRequest): Promise<GitFileContents> =>
    unwrap(api.gitGetFileContents(spaceId, repoRoot, request)),
  listRevisionOptions: (spaceId: string, repoRoot: string): Promise<GitRevisionOption[]> =>
    unwrap(api.gitListRevisionOptions(spaceId, repoRoot)),
  stage: (spaceId: string, repoRoot: string, paths: string[]): Promise<void> =>
    unwrap(api.gitStage(spaceId, repoRoot, paths)),
  unstage: (spaceId: string, repoRoot: string, paths: string[]): Promise<void> =>
    unwrap(api.gitUnstage(spaceId, repoRoot, paths)),
  discard: (spaceId: string, repoRoot: string, paths: string[]): Promise<void> =>
    unwrap(api.gitDiscard(spaceId, repoRoot, paths)),
  commit: (spaceId: string, repoRoot: string, request: GitCommitRequest): Promise<GitCommitResult> =>
    unwrap(api.gitCommit(spaceId, repoRoot, request)),
  sync: (spaceId: string, repoRoot: string): Promise<GitSyncResult> =>
    unwrap(api.gitSync(spaceId, repoRoot)),
  countChangedSince: (spaceId: string, repoRoot: string, snapshot: string): Promise<number> =>
    unwrap(api.gitCountChangedSince(spaceId, repoRoot, snapshot)),
  latestReview: (spaceId: string, repoRoot: string): Promise<GitReviewRecord | null> =>
    unwrap(api.codeReviewGetLatest(spaceId, repoRoot)),
  /** A refusal (team tools unavailable, repository gone) is a result, not a failure. */
  startReview: (request: CodeReviewStartRequest): Promise<CodeReviewStartResult> =>
    unwrap(api.codeReviewStart(request)),
  reviewAvailability: (): Promise<CodeReviewAvailability> =>
    unwrap(api.codeReviewAvailability()),
}
