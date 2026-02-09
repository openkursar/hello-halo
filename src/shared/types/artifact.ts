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
  changes: ArtifactChangeEvent[]
}
