/**
 * Path index over the file tree's loaded nodes, and in-place operations that
 * keep it consistent. The tree mutates node objects and bumps a revision
 * instead of copying the data.
 */

import type { ArtifactTreeNode } from '../../types'

/** Add direct children to the index (non-recursive — deeper nodes indexed on expand) */
export function indexNodes(nodes: ArtifactTreeNode[], index: Map<string, ArtifactTreeNode>): void {
  for (const node of nodes) {
    index.set(node.path, node)
  }
}

/** Remove a node and its entire expanded subtree from the index */
export function removeSubtreeFromIndex(node: ArtifactTreeNode, index: Map<string, ArtifactTreeNode>): void {
  index.delete(node.path)
  if (node.children) {
    for (const child of node.children) {
      removeSubtreeFromIndex(child, index)
    }
  }
}

function hasPendingCreate(node: ArtifactTreeNode): boolean {
  return (node.children ?? []).some(child => child.id.startsWith('temp-') || hasPendingCreate(child))
}

/**
 * Drop a collapsed folder's loaded subtree (it is fetched again on expand).
 * Kept when an inline create is still pending inside it. Returns whether
 * anything was dropped.
 */
export function unloadSubtree(node: ArtifactTreeNode, index: Map<string, ArtifactTreeNode>): boolean {
  if (!node.childrenLoaded || !node.children?.length || hasPendingCreate(node)) return false
  for (const child of node.children) removeSubtreeFromIndex(child, index)
  node.children = []
  node.childrenLoaded = false
  return true
}

/**
 * Fill a folder with its fetched children, then fill every returned folder the
 * tree still has open. The tree keeps openness per node id and a re-fetch of a
 * collapsed folder returns the same ids, so a subfolder that was open before
 * its parent collapsed comes back open and must get its children again.
 * `fetchChildren` resolves null when the folder could not be listed.
 */
export async function fillFolder(
  folder: ArtifactTreeNode,
  fetchChildren: (path: string) => Promise<ArtifactTreeNode[] | null>,
  isOpen: (id: string) => boolean,
  index: Map<string, ArtifactTreeNode>
): Promise<void> {
  const children = await fetchChildren(folder.path)
  if (!children) return
  folder.children = children
  folder.childrenLoaded = true
  indexNodes(children, index)
  await Promise.all(children
    .filter(child => child.type === 'folder' && !child.childrenLoaded && isOpen(child.id))
    .map(child => fillFolder(child, fetchChildren, isOpen, index)))
}

/**
 * Folders whose children the tree holds, parents before children, so their
 * listings can be re-fetched and merged top-down.
 */
export function loadedFolderPaths(index: Map<string, ArtifactTreeNode>): string[] {
  const paths: string[] = []
  for (const node of index.values()) {
    if (node.type === 'folder' && node.childrenLoaded) paths.push(node.path)
  }
  return paths.sort((a, b) => a.length - b.length)
}

/**
 * Merge incoming children (from watcher or IPC) with existing children.
 * Preserves react-arborist node id (key stability) and expanded folder state.
 * Maintains the path→node index as a side effect.
 */
export function mergeChildren(
  incoming: ArtifactTreeNode[],
  existing: ArtifactTreeNode[],
  index: Map<string, ArtifactTreeNode>,
  recentlyCreatedPaths?: Map<string, number>
): ArtifactTreeNode[] {
  const existingByPath = new Map(existing.map(n => [n.path, n]))

  // Remove deleted nodes from index
  const incomingPaths = new Set(incoming.map(n => n.path))
  for (const node of existing) {
    if (!incomingPaths.has(node.path)) {
      removeSubtreeFromIndex(node, index)
    }
  }

  return incoming.map(node => {
    const prev = existingByPath.get(node.path)
    if (prev) {
      // Preserve react-arborist key
      node.id = prev.id
      // Preserve expanded state: keep children the user already loaded
      if (prev.childrenLoaded && prev.children) {
        node.children = prev.children
        node.childrenLoaded = prev.childrenLoaded
      }
    }
    index.set(node.path, node)
    return node
  })
}
