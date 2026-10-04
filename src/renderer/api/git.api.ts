/**
 * gitApi — the changes view's git slice of the unified api object.
 *
 * Desktop goes over IPC, remote and mobile over `POST /api/git/*`; both return
 * the same envelope, with a stable `code` (GitErrorCode) on failure to pick a
 * translated message by.
 */
import { httpRequest, isElectron } from './_shared'
import type { GitRpcResponse } from '../../shared/rpc/contracts/git.contract'
import type {
  GitChangeList,
  GitCommitRequest,
  GitCommitResult,
  GitCompareScope,
  GitFileContents,
  GitFileContentsRequest,
  GitRepositoryList,
  GitRevisionOption,
  GitSnapshot,
  GitSyncResult,
  GitWorkingTreeStatus,
} from '../../shared/types/git'

export const gitApi = {
  gitListRepositories: async (spaceId: string): Promise<GitRpcResponse<GitRepositoryList>> => {
    if (isElectron()) return window.halo.gitListRepositories(spaceId)
    return httpRequest('POST', '/api/git/repositories', { spaceId })
  },

  gitGetStatus: async (spaceId: string, repoRoot: string): Promise<GitRpcResponse<GitWorkingTreeStatus>> => {
    if (isElectron()) return window.halo.gitGetStatus(spaceId, repoRoot)
    return httpRequest('POST', '/api/git/status', { spaceId, repoRoot })
  },

  gitGetChanges: async (spaceId: string, repoRoot: string, scope: GitCompareScope): Promise<GitRpcResponse<GitChangeList>> => {
    if (isElectron()) return window.halo.gitGetChanges(spaceId, repoRoot, scope)
    return httpRequest('POST', '/api/git/changes', { spaceId, repoRoot, scope })
  },

  gitGetFileContents: async (
    spaceId: string,
    repoRoot: string,
    request: GitFileContentsRequest,
  ): Promise<GitRpcResponse<GitFileContents>> => {
    if (isElectron()) return window.halo.gitGetFileContents(spaceId, repoRoot, request)
    return httpRequest('POST', '/api/git/file-contents', { spaceId, repoRoot, request })
  },

  gitListRevisionOptions: async (spaceId: string, repoRoot: string): Promise<GitRpcResponse<GitRevisionOption[]>> => {
    if (isElectron()) return window.halo.gitListRevisionOptions(spaceId, repoRoot)
    return httpRequest('POST', '/api/git/revision-options', { spaceId, repoRoot })
  },

  gitStage: async (spaceId: string, repoRoot: string, paths: string[]): Promise<GitRpcResponse<void>> => {
    if (isElectron()) return window.halo.gitStage(spaceId, repoRoot, paths)
    return httpRequest('POST', '/api/git/stage', { spaceId, repoRoot, paths })
  },

  gitUnstage: async (spaceId: string, repoRoot: string, paths: string[]): Promise<GitRpcResponse<void>> => {
    if (isElectron()) return window.halo.gitUnstage(spaceId, repoRoot, paths)
    return httpRequest('POST', '/api/git/unstage', { spaceId, repoRoot, paths })
  },

  gitDiscard: async (spaceId: string, repoRoot: string, paths: string[]): Promise<GitRpcResponse<void>> => {
    if (isElectron()) return window.halo.gitDiscard(spaceId, repoRoot, paths)
    return httpRequest('POST', '/api/git/discard', { spaceId, repoRoot, paths })
  },

  gitCommit: async (spaceId: string, repoRoot: string, request: GitCommitRequest): Promise<GitRpcResponse<GitCommitResult>> => {
    if (isElectron()) return window.halo.gitCommit(spaceId, repoRoot, request)
    return httpRequest('POST', '/api/git/commit', { spaceId, repoRoot, request })
  },

  gitSync: async (spaceId: string, repoRoot: string): Promise<GitRpcResponse<GitSyncResult>> => {
    if (isElectron()) return window.halo.gitSync(spaceId, repoRoot)
    return httpRequest('POST', '/api/git/sync', { spaceId, repoRoot })
  },

  gitCreateSnapshot: async (spaceId: string, repoRoot: string): Promise<GitRpcResponse<GitSnapshot>> => {
    if (isElectron()) return window.halo.gitCreateSnapshot(spaceId, repoRoot)
    return httpRequest('POST', '/api/git/snapshot', { spaceId, repoRoot })
  },

  gitCountChangedSince: async (spaceId: string, repoRoot: string, snapshot: string): Promise<GitRpcResponse<number>> => {
    if (isElectron()) return window.halo.gitCountChangedSince(spaceId, repoRoot, snapshot)
    return httpRequest('POST', '/api/git/count-changed-since', { spaceId, repoRoot, snapshot })
  },
}
