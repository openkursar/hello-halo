/**
 * Shared artifact types -- used by both main process and file-watcher worker.
 * MUST NOT import any Node.js or Electron modules.
 */

/**
 * Tree node for hierarchical view
 */
export interface CachedTreeNode {
  id: string
  name: string
  type: 'file' | 'folder'
  path: string
  relativePath: string
  extension: string
  icon: string
  size?: number
  depth: number
  children?: CachedTreeNode[]
  childrenLoaded: boolean
}

/**
 * Artifact item for flat list view
 */
export interface CachedArtifact {
  id: string
  spaceId: string
  name: string
  type: 'file' | 'folder'
  path: string
  relativePath: string
  extension: string
  icon: string
  size?: number
  createdAt: string
  modifiedAt: string
}

/**
 * File change event for incremental updates
 */
export interface ArtifactChangeEvent {
  type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'
  path: string
  relativePath: string
  spaceId: string
  item?: CachedArtifact | CachedTreeNode
}

/**
 * Tree update event pushed to renderer with pre-computed data
 */
export interface ArtifactTreeUpdateEvent {
  spaceId: string
  updatedDirs: Array<{ dirPath: string; children: CachedTreeNode[] }>
}

/** One file-system change as delivered to renderer / remote clients. */
export interface ArtifactChange {
  type: ArtifactChangeEvent['type']
  path: string
  relativePath: string
}

/**
 * Changes in one space since the previous batch (`artifact:changed-batch`).
 *
 * `resync` means changes were lost — a burst over the delivery limit, or a
 * watcher failure — so `changes` is incomplete and any file in the space may
 * have changed. Consumers holding per-file state must treat it as all stale.
 */
export interface ArtifactChangeBatchEvent {
  spaceId: string
  changes: ArtifactChange[]
  resync?: boolean
}

/** One file-query match (`artifact:query-files`). */
export interface FileQueryItem {
  path: string
  relativePath: string
  name: string
  type: 'file' | 'folder'
}

export interface FileQueryResult {
  items: FileQueryItem[]
  /** The space has more paths than the index holds; deep paths may be missing. */
  truncated: boolean
  /** The index is still being built; a repeated query may find more. */
  indexing: boolean
  /** The space has at least one indexed path, whether or not any matched. */
  hasPaths: boolean
}

/** One answer of `artifact:resolve-paths`: whether a mentioned path is a file or folder of the space. */
export interface ResolvedArtifactPath {
  /** The path as asked. */
  path: string
  /** Absolute path of an existing file or folder inside the space; null when missing or outside it. */
  absolutePath: string | null
  isDirectory: boolean
}
