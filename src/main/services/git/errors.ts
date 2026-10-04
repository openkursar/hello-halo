/**
 * Git failures as stable codes plus git's own text.
 *
 * The code is what the renderer branches on (and translates); the message is
 * shown verbatim for `GIT_FAILED`, where git's wording (a hook's output, a
 * remote's refusal) is the only useful explanation.
 */

import type { GitErrorCode } from '../../../shared/types/git'

export class GitError extends Error {
  readonly code: GitErrorCode

  constructor(code: GitErrorCode, message: string) {
    super(message)
    this.name = 'GitError'
    this.code = code
  }
}

export function isGitError(error: unknown): error is GitError {
  return error instanceof GitError
}

/**
 * Ordered: the first match wins. Credential failures come before network ones
 * because ssh reports a refused key as "Could not read from remote repository"
 * too, and that line alone would read as an unreachable host.
 */
const FAILURE_PATTERNS: Array<[GitErrorCode, RegExp]> = [
  ['GIT_LOCKED', /index\.lock'?: File exists|Unable to create '[^']*\.lock'|another git process seems to be running/i],
  [
    'GIT_AUTH_REQUIRED',
    /could not read (Username|Password)|terminal prompts disabled|Authentication failed|Permission denied \(publickey|Host key verification failed|HTTP Basic: Access denied|returned error: 40[13]|Invalid username or password/i,
  ],
  ['GIT_NEEDS_MERGE', /Not possible to fast-forward|Diverging branches can't be fast-forwarded|have diverged/i],
  ['GIT_PUSH_REJECTED', /\[rejected\]|Updates were rejected|failed to push some refs/i],
  ['GIT_LOCAL_CHANGES', /local changes to the following files would be overwritten|untracked working tree files would be (overwritten|removed)/i],
  ['GIT_IDENTITY_UNKNOWN', /Please tell me who you are|Author identity unknown|empty ident name|unable to auto-detect email address/i],
  ['GIT_CONFLICTED', /is unmerged|unmerged files|resolve your current index first|you have unmerged/i],
  ['GIT_EMPTY_MESSAGE', /Aborting commit due to empty commit message/i],
  ['GIT_NOTHING_TO_COMMIT', /nothing to commit|no changes added to commit|nothing added to commit/i],
  ['GIT_NO_REMOTE', /No configured push destination|does not appear to be a git repository|No such remote|no upstream configured/i],
  [
    'GIT_NETWORK',
    /Could not resolve host|Could not read from remote repository|unable to access|Connection (timed out|refused|reset)|Network is unreachable|Operation timed out|Could not connect/i,
  ],
  ['GIT_NOT_A_REPOSITORY', /not a git repository/i],
]

/** Longest message carried to the client; git's last lines hold the reason. */
const MAX_MESSAGE_CHARS = 4_000

/** Classify a failed git command from what it printed. */
export function classifyFailure(subcommand: string, stderr: string, stdout: string): GitError {
  const text = `${stderr}\n${stdout}`
  const match = FAILURE_PATTERNS.find(([, pattern]) => pattern.test(text))
  const detail = (stderr.trim() || stdout.trim() || `git ${subcommand} failed`).slice(-MAX_MESSAGE_CHARS)
  return new GitError(match ? match[0] : 'GIT_FAILED', detail)
}
