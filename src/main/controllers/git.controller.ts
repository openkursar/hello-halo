/**
 * Git Controller - the git service behind the IPC channels and the remote
 * HTTP routes, as envelopes carrying a stable error code.
 *
 * Arguments arrive untyped from either transport; the service validates every
 * one of them (space, repository, paths, scope, request), so they are passed
 * through as received.
 */

import {
  commitChanges,
  countChangedSince,
  createSnapshot,
  discardPaths,
  getChangeList,
  getCommitGraph,
  getWorkingTreeStatus,
  isGitError,
  listRepositories,
  listRevisionOptions,
  readFileContents,
  stagePaths,
  syncBranch,
  unstagePaths,
} from '../services/git'
import type { GitRpcResponse } from '../../shared/rpc/contracts/git.contract'
import type {
  GitChangeList,
  GitCommitGraph,
  GitCommitRequest,
  GitCommitResult,
  GitCompareScope,
  GitFileContents,
  GitFileContentsRequest,
  GitGraphQuery,
  GitRepositoryList,
  GitRevisionOption,
  GitSnapshot,
  GitSyncResult,
  GitWorkingTreeStatus,
} from '../../shared/types/git'

async function respond<T>(operation: string, task: () => Promise<T>): Promise<GitRpcResponse<T>> {
  try {
    return { success: true, data: await task() }
  } catch (error) {
    if (isGitError(error)) {
      console.warn(`[Git] ${operation} failed (${error.code}): ${error.message.split('\n')[0]}`)
      return { success: false, error: error.message, code: error.code }
    }
    console.error(`[Git] ${operation} failed unexpectedly:`, error)
    return { success: false, error: error instanceof Error ? error.message : String(error), code: 'GIT_FAILED' }
  }
}

export function listGitRepositories(spaceId: unknown): Promise<GitRpcResponse<GitRepositoryList>> {
  return respond('list repositories', () => listRepositories(spaceId as string))
}

export function getGitStatus(spaceId: unknown, repoRoot: unknown): Promise<GitRpcResponse<GitWorkingTreeStatus>> {
  return respond('status', () => getWorkingTreeStatus(spaceId as string, repoRoot as string))
}

export function getGitChanges(spaceId: unknown, repoRoot: unknown, scope: unknown): Promise<GitRpcResponse<GitChangeList>> {
  return respond('changes', () => getChangeList(spaceId as string, repoRoot as string, scope as GitCompareScope))
}

/** `signal`: the caller went away (a remote client disconnected); a read still waiting for its turn is dropped. */
export function getGitFileContents(spaceId: unknown, repoRoot: unknown, request: unknown, signal?: AbortSignal): Promise<GitRpcResponse<GitFileContents>> {
  return respond('file contents', () => readFileContents(spaceId as string, repoRoot as string, request as GitFileContentsRequest, signal))
}

export function listGitRevisionOptions(spaceId: unknown, repoRoot: unknown): Promise<GitRpcResponse<GitRevisionOption[]>> {
  return respond('revision options', () => listRevisionOptions(spaceId as string, repoRoot as string))
}

export function getGitCommitGraph(spaceId: unknown, repoRoot: unknown, query: unknown): Promise<GitRpcResponse<GitCommitGraph>> {
  return respond('commit graph', () => getCommitGraph(spaceId as string, repoRoot as string, query as GitGraphQuery))
}

export function stageGitPaths(spaceId: unknown, repoRoot: unknown, paths: unknown): Promise<GitRpcResponse<void>> {
  return respond('stage', () => stagePaths(spaceId as string, repoRoot as string, paths as string[]))
}

export function unstageGitPaths(spaceId: unknown, repoRoot: unknown, paths: unknown): Promise<GitRpcResponse<void>> {
  return respond('unstage', () => unstagePaths(spaceId as string, repoRoot as string, paths as string[]))
}

export function discardGitPaths(spaceId: unknown, repoRoot: unknown, paths: unknown): Promise<GitRpcResponse<void>> {
  return respond('discard', () => discardPaths(spaceId as string, repoRoot as string, paths as string[]))
}

export function commitGitChanges(spaceId: unknown, repoRoot: unknown, request: unknown): Promise<GitRpcResponse<GitCommitResult>> {
  return respond('commit', () => commitChanges(spaceId as string, repoRoot as string, request as GitCommitRequest))
}

export function syncGitBranch(spaceId: unknown, repoRoot: unknown): Promise<GitRpcResponse<GitSyncResult>> {
  return respond('sync', () => syncBranch(spaceId as string, repoRoot as string))
}

export function createGitSnapshot(spaceId: unknown, repoRoot: unknown): Promise<GitRpcResponse<GitSnapshot>> {
  return respond('snapshot', () => createSnapshot(spaceId as string, repoRoot as string))
}

export function countGitChangedSince(spaceId: unknown, repoRoot: unknown, snapshot: unknown): Promise<GitRpcResponse<number>> {
  return respond('count changed since', () => countChangedSince(spaceId as string, repoRoot as string, snapshot as string))
}
