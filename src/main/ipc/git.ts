/**
 * IPC handlers for the changes view's git requests.
 *
 * Channels come from `shared/rpc/contracts/git.contract`; each returns the
 * controller's envelope verbatim (`code` included), the same shape the
 * `/api/git/*` routes return to remote clients.
 */

import type { RpcHandlers } from '../../shared/rpc/define'
import { gitRpc } from '../../shared/rpc/contracts/git.contract'
import * as gitController from '../controllers/git.controller'
import { registerRawRpcHandlers } from './rpc'

export function registerGitHandlers(): void {
  const handlers: RpcHandlers<typeof gitRpc> = {
    gitListRepositories: (spaceId) => gitController.listGitRepositories(spaceId),
    gitGetStatus: (spaceId, repoRoot) => gitController.getGitStatus(spaceId, repoRoot),
    gitGetChanges: (spaceId, repoRoot, scope) => gitController.getGitChanges(spaceId, repoRoot, scope),
    gitGetFileContents: (spaceId, repoRoot, request) => gitController.getGitFileContents(spaceId, repoRoot, request),
    gitListRevisionOptions: (spaceId, repoRoot) => gitController.listGitRevisionOptions(spaceId, repoRoot),
    gitGetCommitGraph: (spaceId, repoRoot, query) => gitController.getGitCommitGraph(spaceId, repoRoot, query),
    gitStage: (spaceId, repoRoot, paths) => gitController.stageGitPaths(spaceId, repoRoot, paths),
    gitUnstage: (spaceId, repoRoot, paths) => gitController.unstageGitPaths(spaceId, repoRoot, paths),
    gitDiscard: (spaceId, repoRoot, paths) => gitController.discardGitPaths(spaceId, repoRoot, paths),
    gitCommit: (spaceId, repoRoot, request) => gitController.commitGitChanges(spaceId, repoRoot, request),
    gitSync: (spaceId, repoRoot) => gitController.syncGitBranch(spaceId, repoRoot),
    gitCreateSnapshot: (spaceId, repoRoot) => gitController.createGitSnapshot(spaceId, repoRoot),
    gitCountChangedSince: (spaceId, repoRoot, snapshot) => gitController.countGitChangedSince(spaceId, repoRoot, snapshot),
  }
  registerRawRpcHandlers(gitRpc, handlers)
}
