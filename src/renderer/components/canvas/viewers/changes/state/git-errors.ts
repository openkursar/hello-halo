/**
 * What to tell the user when a git request fails: a translated sentence for
 * every known `GitErrorCode`. Git's own text is shown only where it is the
 * useful part (a hook's output, an unexpected failure), as `output`.
 */

import type { GitErrorCode } from '../../../../../../shared/types/git'
import type { Translate } from '../model/scope'

export interface GitFailure {
  code?: string
  error?: string
}

export interface GitErrorText {
  message: string
  /** Git's own output, shown on request in a monospaced block. */
  output?: string
}

export function describeGitError(failure: GitFailure, t: Translate, revision?: string): GitErrorText {
  const raw = failure.error?.trim() || ''
  switch (failure.code as GitErrorCode | undefined) {
    case 'GIT_UNAVAILABLE': return { message: t('Git isn\'t available on this computer.') }
    case 'GIT_NOT_A_REPOSITORY': return { message: t('This folder is no longer a Git repository.') }
    case 'GIT_REVISION_NOT_FOUND': return { message: t('Branch or commit not found: {{revision}}', { revision: revision ?? '' }) }
    case 'GIT_SNAPSHOT_MISSING': return { message: t('The last review\'s snapshot is no longer available. Review again to compare.') }
    case 'GIT_LOCKED': return { message: t('Another Git process is using this repository. Try again in a moment.') }
    case 'GIT_CONFLICTED': return { message: t('This file has merge conflicts. Resolve them in a terminal, or ask the AI to.') }
    case 'GIT_NOTHING_TO_COMMIT': return { message: t('Nothing to commit. Stage files first.') }
    case 'GIT_EMPTY_MESSAGE': return { message: t('Enter a commit message.') }
    case 'GIT_HOOK_FAILED': return { message: t('A commit hook rejected the commit.'), output: raw || undefined }
    case 'GIT_IDENTITY_UNKNOWN': return { message: t('Git doesn\'t know who you are yet. Set user.name and user.email in a terminal, then try again.') }
    case 'GIT_DETACHED_HEAD': return { message: t('You\'re not on a branch, so there\'s nothing to push. Switch to a branch in a terminal, or ask the AI to.') }
    case 'GIT_NO_REMOTE': return { message: t('This repository has no remote to push to.') }
    case 'GIT_AUTH_REQUIRED': return { message: t('Git needs you to sign in. Push once from a terminal, then try again.') }
    case 'GIT_NEEDS_MERGE': return { message: t('Can\'t fast-forward. Merge in a terminal, or ask the AI to.') }
    case 'GIT_PUSH_REJECTED': return { message: t('The remote has commits you don\'t have yet. Sync first, then push.') }
    case 'GIT_LOCAL_CHANGES': return { message: t('Pulling would overwrite your uncommitted changes. Commit them first, or sync from a terminal.') }
    case 'GIT_NETWORK': return { message: t('Couldn\'t reach the remote. Check your connection and try again.') }
    case 'GIT_TIMEOUT': return { message: t('Git took too long to respond. Try again.') }
    case 'GIT_BUSY': return { message: t('Too many files are loading at once. Try again in a moment.') }
    case 'GIT_INVALID_ARGUMENT':
    case 'GIT_FAILED':
    default:
      return { message: t('Git failed: {{reason}}', { reason: firstLine(raw) || t('unknown error') }), output: raw.includes('\n') ? raw : undefined }
  }
}

/** The message alone, for places with no room for git's output. */
export function gitErrorMessage(failure: GitFailure, t: Translate, revision?: string): string {
  return describeGitError(failure, t, revision).message
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0].trim()
  return line.length > 200 ? `${line.slice(0, 200)}…` : line
}
