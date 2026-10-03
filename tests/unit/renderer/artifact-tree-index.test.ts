/**
 * Collapsing a folder drops its loaded subtree, so the tree's data (rebuilt by
 * react-arborist on every revision) tracks what is open rather than every
 * directory ever expanded in the session.
 */

import { describe, it, expect } from 'vitest'
import { fillFolder, indexNodes, loadedFolderPaths, mergeChildren, unloadSubtree } from '../../../src/renderer/components/artifact/tree-index'
import type { ArtifactTreeNode } from '../../../src/renderer/types'

function node(path: string, type: 'file' | 'folder' = 'file', children?: ArtifactTreeNode[]): ArtifactTreeNode {
  return {
    id: `id:${path}`, name: path.split('/').pop()!, path, relativePath: path, type, extension: '', icon: '',
    depth: 0, children: type === 'folder' ? (children ?? []) : undefined, childrenLoaded: !!children,
  } as ArtifactTreeNode
}

describe('unloadSubtree', () => {
  it('drops a loaded subtree from the node and the index', () => {
    const inner = node('/r/a/inner', 'folder', [node('/r/a/inner/x')])
    const a = node('/r/a', 'folder', [inner, node('/r/a/f')])
    const index = new Map<string, ArtifactTreeNode>()
    indexNodes([a], index)
    indexNodes(a.children!, index)
    indexNodes(inner.children!, index)

    expect(unloadSubtree(a, index)).toBe(true)
    expect(a.children).toEqual([])
    expect(a.childrenLoaded).toBe(false)
    expect(Array.from(index.keys())).toEqual(['/r/a'])
  })

  it('keeps a subtree with an inline create in progress', () => {
    const temp = { ...node('/r/a/temp-1'), id: 'temp-1' }
    const a = node('/r/a', 'folder', [temp])
    expect(unloadSubtree(a, new Map())).toBe(false)
    expect(a.children).toHaveLength(1)
  })

  it('is a no-op for a folder that was never loaded', () => {
    expect(unloadSubtree(node('/r/a', 'folder'), new Map())).toBe(false)
  })
})

describe('mergeChildren', () => {
  it('keeps ids and loaded children of folders that survive an update', () => {
    const kept = node('/r/a', 'folder', [node('/r/a/x')])
    const index = new Map<string, ArtifactTreeNode>()
    const merged = mergeChildren([{ ...node('/r/a', 'folder'), id: 'fresh' }, node('/r/b')], [kept, node('/r/gone')], index)

    expect(merged[0].id).toBe('id:/r/a')
    expect(merged[0].children).toBe(kept.children)
    expect(index.has('/r/gone')).toBe(false)
  })
})

describe('fillFolder', () => {
  // Stands in for main's cache: the same node objects (and ids) on every fetch.
  function listing(tree: Record<string, ArtifactTreeNode[]>) {
    const calls: string[] = []
    const fetchChildren = async (path: string) => {
      calls.push(path)
      return (tree[path] ?? []).map(n => ({ ...n, children: n.type === 'folder' ? [] : undefined, childrenLoaded: false }))
    }
    return { calls, fetchChildren }
  }

  it('refills a subfolder that stayed open while its parent was collapsed', async () => {
    const a = node('/r/a', 'folder')
    const b = node('/r/a/b', 'folder')
    const { calls, fetchChildren } = listing({ '/r/a': [b, node('/r/a/f')], '/r/a/b': [node('/r/a/b/x')] })
    const open = new Set<string>()
    const isOpen = (id: string) => open.has(id)
    const index = new Map<string, ArtifactTreeNode>([[a.path, a]])

    // Expand A, expand A/B
    await fillFolder(a, fetchChildren, isOpen, index)
    open.add(a.id)
    await fillFolder(index.get('/r/a/b')!, fetchChildren, isOpen, index)
    open.add(b.id)

    // Collapse A: only A closes in the tree's state, B stays open
    open.delete(a.id)
    unloadSubtree(a, index)

    // Expand A again
    calls.length = 0
    await fillFolder(a, fetchChildren, isOpen, index)

    const bAgain = a.children!.find(n => n.path === '/r/a/b')!
    expect(bAgain.childrenLoaded).toBe(true)
    expect(bAgain.children!.map(n => n.path)).toEqual(['/r/a/b/x'])
    expect(index.has('/r/a/b/x')).toBe(true)
    expect(calls).toEqual(['/r/a', '/r/a/b'])
  })

  it('leaves closed subfolders unloaded and the folder untouched when listing fails', async () => {
    const a = node('/r/a', 'folder')
    const { calls, fetchChildren } = listing({ '/r/a': [node('/r/a/b', 'folder')] })
    await fillFolder(a, fetchChildren, () => false, new Map())
    expect(calls).toEqual(['/r/a'])
    expect(a.children![0].childrenLoaded).toBe(false)

    const c = node('/r/c', 'folder')
    await fillFolder(c, async () => null, () => true, new Map())
    expect(c.childrenLoaded).toBe(false)
  })
})

describe('loadedFolderPaths', () => {
  it('lists loaded folders only, parents before children', () => {
    const inner = node('/r/a/inner', 'folder', [node('/r/a/inner/x')])
    const a = node('/r/a', 'folder', [inner, node('/r/a/closed', 'folder')])
    const index = new Map<string, ArtifactTreeNode>()
    indexNodes([inner, a, ...a.children!], index)
    expect(loadedFolderPaths(index)).toEqual(['/r/a', '/r/a/inner'])
  })
})
