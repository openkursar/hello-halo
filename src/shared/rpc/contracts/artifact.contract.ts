/**
 * Artifact RPC contract (passthrough). Workspace file listing, tree, content
 * read/write, type detection, and file operations. Handler bodies build their
 * own envelopes, so these are raw passthrough. File-watcher change events
 * (artifact:changed / artifact:tree-update) stay outside the contract.
 */
import { rawRpcMethod } from '../define'

export const artifactRpc = {
  listArtifacts: rawRpcMethod('artifact:list'),
  listArtifactsTree: rawRpcMethod('artifact:list-tree'),
  loadArtifactChildren: rawRpcMethod('artifact:load-children'),
  initArtifactWatcher: rawRpcMethod('artifact:init-watcher'),
  reconcileArtifacts: rawRpcMethod('artifact:reconcile'),
  openArtifact: rawRpcMethod('artifact:open'),
  showArtifactInFolder: rawRpcMethod('artifact:show-in-folder'),
  readArtifactContent: rawRpcMethod('artifact:read-content'),
  saveArtifactContent: rawRpcMethod('artifact:save-content'),
  detectFileType: rawRpcMethod('artifact:detect-file-type'),
  createArtifactFile: rawRpcMethod('artifact:create-file'),
  createArtifactFolder: rawRpcMethod('artifact:create-folder'),
  deleteArtifact: rawRpcMethod('artifact:delete'),
  renameArtifact: rawRpcMethod('artifact:rename'),
  moveArtifact: rawRpcMethod('artifact:move'),
}
