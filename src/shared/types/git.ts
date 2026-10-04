/**
 * Data the main process git service hands the renderer's changes view.
 *
 * Paths inside a repository are repository-relative with forward slashes;
 * repository roots are absolute. Every request names the space it comes from,
 * and the main process only serves repositories it discovered in that space.
 */

export type GitAvailability =
  | { available: true; version: string }
  | { available: false; reason: 'not-installed' | 'not-runnable'; detail?: string }

export interface GitRepository {
  /** Absolute root. */
  root: string
  /** Folder name, for display. */
  name: string
  /** Root relative to the space folder; '' for the space folder itself. */
  relativePath: string
  /** Current branch; null when HEAD is detached. */
  branch: string | null
  /** Abbreviated HEAD commit; null before the first commit. */
  head: string | null
  /** No commit yet. */
  unborn: boolean
  upstream: string | null
  /** Commits ahead of / behind the upstream, as last fetched (no network). */
  ahead: number
  behind: number
}

export interface GitRepositoryList {
  git: GitAvailability
  /** The space folder's own repository first, then nested ones by name. */
  repositories: GitRepository[]
}

export type GitFileState =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'type-changed'
  | 'untracked'
  | 'conflicted'

export interface GitChangedFile {
  path: string
  /** Previous path of a rename or copy. */
  oldPath?: string
  state: GitFileState
  /** Null when unknown: binary, over the size limit, or not counted. */
  additions: number | null
  deletions: number | null
  binary: boolean
  /** Marked generated in .gitattributes (`linguist-generated`). */
  generated?: true
}

export interface GitWorkingTreeStatus {
  repo: GitRepository
  staged: GitChangedFile[]
  /** Unstaged changes, untracked files included (state 'untracked'). */
  unstaged: GitChangedFile[]
  conflicted: GitChangedFile[]
  /** An operation git is in the middle of. */
  operation: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null
  /** A group was cut at GIT_LIMITS.maxListedFiles. */
  truncated: boolean
}

/** What a diff compares. The after side is the working tree unless stated. */
export type GitCompareScope =
  /** HEAD vs the working tree, untracked files included. */
  | { kind: 'uncommitted' }
  /** HEAD vs the index. */
  | { kind: 'staged' }
  /** The working tree when the last review started vs now. */
  | { kind: 'since-review'; snapshot: string }
  /** A branch or commit vs the working tree; `mergeBase` compares from where HEAD forked off it. */
  | { kind: 'revision'; revision: string; mergeBase: boolean }

export interface GitChangeList {
  scope: GitCompareScope
  /** Git object the before side resolved to (commit or tree); null for an unborn HEAD. */
  beforeRevision: string | null
  files: GitChangedFile[]
  truncated: boolean
}

/** One file of a change list, to load both sides of. */
export interface GitFileContentsRequest {
  scope: GitCompareScope
  /** The list's `beforeRevision`, so every file of one list shares its before side. */
  beforeRevision: string | null
  path: string
  oldPath?: string
}

export interface GitFileContents {
  path: string
  oldPath?: string
  /** Text of each side; null when the side does not exist, or when its text is omitted. */
  before: string | null
  after: string | null
  /** A side is binary; texts are omitted. */
  binary: boolean
  /** A side exceeds GIT_LIMITS.maxFileBytes; texts are omitted. */
  tooLarge: boolean
  /** Size of each side, present exactly when that side exists. */
  beforeBytes?: number
  afterBytes?: number
}

export interface GitRevisionOption {
  /** What to pass back as `revision`. */
  revision: string
  kind: 'branch' | 'remote-branch' | 'tag' | 'commit'
  /** Commit subject, for commits. */
  subject?: string
  /** ISO date of the commit. */
  date?: string
}

export interface GitCommitRequest {
  message: string
  amend: boolean
  /** Push after committing. */
  push: boolean
}

export interface GitCommitResult {
  /** Abbreviated id of the new commit. */
  commit: string
  pushed: boolean
  /** Set when the commit succeeded but the push did not. */
  pushError?: string
  pushErrorCode?: GitErrorCode
}

export interface GitSyncResult {
  /** The repository after syncing, ahead / behind refreshed. */
  repo: GitRepository
  /** Commits fast-forwarded from the upstream. */
  pulled: number
  /** Commits pushed to the upstream. */
  pushed: number
}

/**
 * Stable reason a git request failed, sent beside the error text so the
 * renderer can show a translated message; `GIT_FAILED` carries git's own text.
 */
export type GitErrorCode =
  /** Git is not installed or cannot run. */
  | 'GIT_UNAVAILABLE'
  /** Not a repository of this space (any more). */
  | 'GIT_NOT_A_REPOSITORY'
  /** A malformed request: path outside the repository, bad revision syntax, bad shape. */
  | 'GIT_INVALID_ARGUMENT'
  /** The branch or commit to compare with does not exist. */
  | 'GIT_REVISION_NOT_FOUND'
  /** The review snapshot was pruned by git gc; "since last review" no longer works. */
  | 'GIT_SNAPSHOT_MISSING'
  /** Another git process holds the index lock; try again. */
  | 'GIT_LOCKED'
  /** The paths or the repository have unresolved merge conflicts. */
  | 'GIT_CONFLICTED'
  | 'GIT_NOTHING_TO_COMMIT'
  | 'GIT_EMPTY_MESSAGE'
  /** A commit hook refused the commit; the error text is the hook's output. */
  | 'GIT_HOOK_FAILED'
  /** user.name / user.email are not configured. */
  | 'GIT_IDENTITY_UNKNOWN'
  /** HEAD is detached; there is no branch to push or sync. */
  | 'GIT_DETACHED_HEAD'
  | 'GIT_NO_REMOTE'
  /** The remote needs credentials; authenticate in a terminal. */
  | 'GIT_AUTH_REQUIRED'
  /** The upstream diverged; a merge or rebase is needed. */
  | 'GIT_NEEDS_MERGE'
  /** The remote has commits this branch lacks; sync first. */
  | 'GIT_PUSH_REJECTED'
  /** Pulling would overwrite uncommitted local changes. */
  | 'GIT_LOCAL_CHANGES'
  /** The remote could not be reached. */
  | 'GIT_NETWORK'
  | 'GIT_TIMEOUT'
  /** Too many file reads are already waiting; nothing was read. Try again shortly. */
  | 'GIT_BUSY'
  | 'GIT_FAILED'

export interface GitSnapshot {
  /** Tree object of the whole working tree (untracked files included, ignored excluded). */
  tree: string
  createdAt: number
}

/** The latest review started from the changes view, one per repository. */
export interface GitReviewRecord {
  repoRoot: string
  conversationId: string
  variant: 'quick' | 'team'
  scope: GitCompareScope
  scopeLabel: string
  /** Working tree when the review started; the base of "since last review" and of staleness. */
  snapshot: string
  fileCount: number
  startedAt: number
}

export const GIT_LIMITS = {
  /** Bytes of one side of a file the diff view will load. */
  maxFileBytes: 2 * 1024 * 1024,
  /** Files listed per group or change list. */
  maxListedFiles: 5_000,
  /** Choices returned for the compare picker. */
  maxRevisionOptions: 60,
} as const
