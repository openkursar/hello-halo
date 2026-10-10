/**
 * services/git — git for a space's repositories, run through the git CLI.
 *
 * Every function takes the space id first and serves only repositories found
 * in that space (its folder, or a direct sub-folder holding a `.git`); paths
 * are repository-relative and never leave the working tree. Failures throw
 * GitError with a stable GitErrorCode. Nothing runs at startup, nothing polls.
 *
 * Does NOT depend on the agent or conversation services. See DESIGN.md.
 */

export { GitError, isGitError } from './errors'
export { getGitAvailability } from './locate'
export { listRepositories, resolveRepository } from './repositories'
export { getWorkingTreeStatus } from './status'
/** `assertCompareScope` validates a scope from a client (throws GIT_INVALID_ARGUMENT), revision syntax included. */
export { getChangeList, assertCompareScope } from './changes'
export { readFileContents } from './contents'
export { listRevisionOptions } from './revisions'
/** `assertGraphQuery` validates a graph request from a client (throws GIT_INVALID_ARGUMENT). */
export { getCommitGraph, assertGraphQuery } from './graph'
export { createSnapshot, countChangedSince } from './snapshot'
export { stagePaths, unstagePaths, discardPaths, commitChanges, syncBranch } from './operations'
