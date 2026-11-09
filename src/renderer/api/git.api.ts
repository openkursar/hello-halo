/**
 * gitApi — the changes view's git slice of the unified api object.
 *
 * Desktop goes over IPC, remote and mobile over `POST /api/git/*`; both return
 * the same envelope, with a stable `code` (GitErrorCode) on failure to pick a
 * translated message by.
 */
import { httpRequest, isElectron } from './_shared'
import type { ApiResponse } from './_shared'
import type {
  GitChangeList,
  GitCommitGraph,
  GitCommitRequest,
  GitCommitResult,
  GitCompareScope,
  GitFileContents,
  GitFileContentsRequest,
  GitGraphQuery,
  GitRepository,
  GitRepositoryDiscovery,
  GitRepositoryList,
  GitRepositoryListOptions,
  GitRevisionOption,
  GitSnapshot,
  GitSyncResult,
  GitWorkingTreeStatus,
} from '../../shared/types/git'

export const gitApi = {
  gitListRepositories: async (spaceId: string, options?: GitRepositoryListOptions): Promise<ApiResponse<GitRepositoryList>> => {
    if (isElectron()) return window.halo.gitListRepositories(spaceId, options)
    return httpRequest('POST', '/api/git/repositories', { spaceId, options })
  },

  gitDiscoverRepository: async (spaceId: string, filePath: string): Promise<ApiResponse<GitRepositoryDiscovery | null>> => {
    if (isElectron()) return window.halo.gitDiscoverRepository(spaceId, filePath)
    return httpRequest('POST', '/api/git/discover-repository', { spaceId, filePath })
  },

  gitOpenRepository: async (spaceId: string, repoRoot: string): Promise<ApiResponse<GitRepository>> => {
    if (isElectron()) return window.halo.gitOpenRepository(spaceId, repoRoot)
    return httpRequest('POST', '/api/git/open-repository', { spaceId, repoRoot })
  },

  gitGetStatus: async (spaceId: string, repoRoot: string, remember?: boolean): Promise<ApiResponse<GitWorkingTreeStatus>> => {
    if (isElectron()) return window.halo.gitGetStatus(spaceId, repoRoot, remember)
    return httpRequest('POST', '/api/git/status', { spaceId, repoRoot, remember })
  },

  gitGetChanges: async (spaceId: string, repoRoot: string, scope: GitCompareScope): Promise<ApiResponse<GitChangeList>> => {
    if (isElectron()) return window.halo.gitGetChanges(spaceId, repoRoot, scope)
    return httpRequest('POST', '/api/git/changes', { spaceId, repoRoot, scope })
  },

  gitGetFileContents: async (
    spaceId: string,
    repoRoot: string,
    request: GitFileContentsRequest,
  ): Promise<ApiResponse<GitFileContents>> => {
    if (isElectron()) return window.halo.gitGetFileContents(spaceId, repoRoot, request)
    return httpRequest('POST', '/api/git/file-contents', { spaceId, repoRoot, request })
  },

  gitListRevisionOptions: async (spaceId: string, repoRoot: string): Promise<ApiResponse<GitRevisionOption[]>> => {
    if (isElectron()) return window.halo.gitListRevisionOptions(spaceId, repoRoot)
    return httpRequest('POST', '/api/git/revision-options', { spaceId, repoRoot })
  },

  gitGetCommitGraph: async (spaceId: string, repoRoot: string, query: GitGraphQuery): Promise<ApiResponse<GitCommitGraph>> => {
    if (isElectron()) return window.halo.gitGetCommitGraph(spaceId, repoRoot, query)
    return httpRequest('POST', '/api/git/commit-graph', { spaceId, repoRoot, query })
  },

  gitStage: async (spaceId: string, repoRoot: string, paths: string[]): Promise<ApiResponse<void>> => {
    if (isElectron()) return window.halo.gitStage(spaceId, repoRoot, paths)
    return httpRequest('POST', '/api/git/stage', { spaceId, repoRoot, paths })
  },

  gitUnstage: async (spaceId: string, repoRoot: string, paths: string[]): Promise<ApiResponse<void>> => {
    if (isElectron()) return window.halo.gitUnstage(spaceId, repoRoot, paths)
    return httpRequest('POST', '/api/git/unstage', { spaceId, repoRoot, paths })
  },

  gitDiscard: async (spaceId: string, repoRoot: string, paths: string[]): Promise<ApiResponse<void>> => {
    if (isElectron()) return window.halo.gitDiscard(spaceId, repoRoot, paths)
    return httpRequest('POST', '/api/git/discard', { spaceId, repoRoot, paths })
  },

  gitCommit: async (spaceId: string, repoRoot: string, request: GitCommitRequest): Promise<ApiResponse<GitCommitResult>> => {
    if (isElectron()) return window.halo.gitCommit(spaceId, repoRoot, request)
    return httpRequest('POST', '/api/git/commit', { spaceId, repoRoot, request })
  },

  gitSync: async (spaceId: string, repoRoot: string): Promise<ApiResponse<GitSyncResult>> => {
    if (isElectron()) return window.halo.gitSync(spaceId, repoRoot)
    return httpRequest('POST', '/api/git/sync', { spaceId, repoRoot })
  },

  gitCreateSnapshot: async (spaceId: string, repoRoot: string): Promise<ApiResponse<GitSnapshot>> => {
    if (isElectron()) return window.halo.gitCreateSnapshot(spaceId, repoRoot)
    return httpRequest('POST', '/api/git/snapshot', { spaceId, repoRoot })
  },

  gitCountChangedSince: async (spaceId: string, repoRoot: string, snapshot: string): Promise<ApiResponse<number>> => {
    if (isElectron()) return window.halo.gitCountChangedSince(spaceId, repoRoot, snapshot)
    return httpRequest('POST', '/api/git/count-changed-since', { spaceId, repoRoot, snapshot })
  },
}
