/**
 * Git RPC contract (passthrough): the changes view's queries and writes on a
 * space's repositories. Every channel returns `GitRpcResponse`, the standard
 * envelope plus a stable `code` on failure; the remote HTTP routes
 * (`/api/git/*`) return the same shapes.
 */
import { rawRpcMethod, type RpcResponse } from '../define'
import type {
  GitChangeList,
  GitCommitGraph,
  GitCommitRequest,
  GitCommitResult,
  GitCompareScope,
  GitErrorCode,
  GitFileContents,
  GitFileContentsRequest,
  GitGraphQuery,
  GitRepositoryList,
  GitRevisionOption,
  GitSnapshot,
  GitSyncResult,
  GitWorkingTreeStatus,
} from '../../types/git'

export interface GitRpcResponse<T> extends RpcResponse<T> {
  code?: GitErrorCode
}

type InRepo = [spaceId: string, repoRoot: string]

export const gitRpc = {
  gitListRepositories: rawRpcMethod<[spaceId: string], GitRpcResponse<GitRepositoryList>>('git:list-repositories'),
  gitGetStatus: rawRpcMethod<InRepo, GitRpcResponse<GitWorkingTreeStatus>>('git:get-status'),
  gitGetChanges: rawRpcMethod<[...InRepo, scope: GitCompareScope], GitRpcResponse<GitChangeList>>('git:get-changes'),
  gitGetFileContents: rawRpcMethod<[...InRepo, request: GitFileContentsRequest], GitRpcResponse<GitFileContents>>('git:get-file-contents'),
  gitListRevisionOptions: rawRpcMethod<InRepo, GitRpcResponse<GitRevisionOption[]>>('git:list-revision-options'),
  gitGetCommitGraph: rawRpcMethod<[...InRepo, query: GitGraphQuery], GitRpcResponse<GitCommitGraph>>('git:get-commit-graph'),
  gitStage: rawRpcMethod<[...InRepo, paths: string[]], GitRpcResponse<void>>('git:stage'),
  gitUnstage: rawRpcMethod<[...InRepo, paths: string[]], GitRpcResponse<void>>('git:unstage'),
  gitDiscard: rawRpcMethod<[...InRepo, paths: string[]], GitRpcResponse<void>>('git:discard'),
  gitCommit: rawRpcMethod<[...InRepo, request: GitCommitRequest], GitRpcResponse<GitCommitResult>>('git:commit'),
  gitSync: rawRpcMethod<InRepo, GitRpcResponse<GitSyncResult>>('git:sync'),
  gitCreateSnapshot: rawRpcMethod<InRepo, GitRpcResponse<GitSnapshot>>('git:create-snapshot'),
  gitCountChangedSince: rawRpcMethod<[...InRepo, snapshot: string], GitRpcResponse<number>>('git:count-changed-since'),
}
