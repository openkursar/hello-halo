/**
 * The file panel as a flat list of rows (group headers, directory headers,
 * files), so it can be virtualized however long the change list is. Paths are
 * sorted once per change list (`createPathOrder`); the groups a filter
 * narrows on every keystroke are only arranged by that order.
 */

import type { ViewFile } from '../model/view-files'
import { baseName, dirName } from '../model/paths'

export type PanelGroupId = 'conflicted' | 'staged' | 'unstaged' | 'changes'

export interface PanelGroup {
  id: PanelGroupId
  files: readonly ViewFile[]
}

export type PanelRow =
  | { kind: 'group'; group: PanelGroupId; count: number; collapsed: boolean }
  | { kind: 'dir'; group: PanelGroupId; startDir: string; dir: string; label: string; depth: number; count: number; collapsed: boolean }
  | { kind: 'file'; group: PanelGroupId; file: ViewFile; depth: number }

type PanelNode =
  | { kind: 'dir'; dir: string; label: string; count: number; children: readonly PanelNode[] }
  | { kind: 'file'; file: ViewFile }

export interface PanelTopologyGroup {
  id: PanelGroupId
  /** In panel order. */
  files: readonly ViewFile[]
  /** Folders and files; empty in List mode. */
  children: readonly PanelNode[]
}

export interface PanelTopology {
  tree: boolean
  groups: readonly PanelTopologyGroup[]
}

/**
 * Where each path goes in the file list. Tree: folders before files at every
 * level; List: whole paths. Names compare naturally (file2 before file10).
 */
export interface PathOrder {
  tree: boolean
  rank: ReadonlyMap<string, number>
}

interface Folder<T> {
  dir: string
  label: string
  count: number
  parent: Folder<T> | null
  folders: Map<string, Folder<T>>
  items: T[]
}

/** A folder tree being filled; `byDir` lets files of a known folder skip walking their path. */
interface FolderTree<T> {
  root: Folder<T>
  byDir: Map<string, Folder<T>>
}

export function dirRowKey(group: PanelGroupId, dir: string): string {
  return `${group}:${dir}`
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

function compareNames(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0)
}

function folder<T>(dir: string, label: string, parent: Folder<T> | null): Folder<T> {
  return { dir, label, count: 0, parent, folders: new Map(), items: [] }
}

function folderTree<T>(): FolderTree<T> {
  const root = folder<T>('', '', null)
  return { root, byDir: new Map([['', root]]) }
}

/** Files `item` under the folders of `path`; an absolute reply path keeps its root on the top folder's label. */
function place<T>(tree: FolderTree<T>, path: string, item: T): void {
  const normalized = /^[a-z]:[\\/]|^\\\\/i.test(path) ? path.replace(/\\/g, '/') : path
  const dir = dirName(normalized)
  const known = tree.byDir.get(dir)
  if (known) {
    for (let at: Folder<T> | null = known; at && at !== tree.root; at = at.parent) at.count++
    known.items.push(item)
    return
  }
  const prefix = dir.startsWith('//') ? '//' : dir.startsWith('/') ? '/' : ''
  let parent: Folder<T> = tree.root
  let at = prefix
  for (const segment of dir.split('/').filter(Boolean)) {
    at = at === prefix ? `${at}${segment}` : `${at}/${segment}`
    let child: Folder<T> | undefined = parent.folders.get(at)
    if (!child) {
      child = folder(at, parent === tree.root ? `${prefix}${segment}` : segment, parent)
      parent.folders.set(at, child)
      tree.byDir.set(at, child)
    }
    child.count++
    parent = child
  }
  parent.items.push(item)
}

/** The one place paths are compared; run it when the change list or the mode changes, not when a filter does. */
export function createPathOrder(paths: Iterable<string>, tree: boolean): PathOrder {
  const unique = [...new Set(paths)]
  const rank = new Map<string, number>()
  if (!tree) {
    for (const path of unique.sort(compareNames)) rank.set(path, rank.size)
    return { tree, rank }
  }
  const folders = folderTree<string>()
  for (const path of unique) place(folders, path, path)
  const visit = (parent: Folder<string>) => {
    for (const child of [...parent.folders.values()].sort((a, b) => compareNames(a.label, b.label))) visit(child)
    const files = parent.items.map((path) => ({ path, name: baseName(path) })).sort((a, b) => compareNames(a.name, b.name))
    for (const file of files) rank.set(file.path, rank.size)
  }
  visit(folders.root)
  return { tree, rank }
}

function byRank(files: readonly ViewFile[], rank: ReadonlyMap<string, number>): ViewFile[] {
  return files
    .map((file) => ({ file, at: rank.get(file.path) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.at - b.at)
    .map((entry) => entry.file)
}

/** Files arrive in tree order, so every folder already holds its subfolders and files in order. */
function nodesOf(parent: Folder<ViewFile>): PanelNode[] {
  const nodes: PanelNode[] = []
  for (const child of parent.folders.values()) {
    nodes.push({ kind: 'dir', dir: child.dir, label: child.label, count: child.count, children: nodesOf(child) })
  }
  for (const file of parent.items) nodes.push({ kind: 'file', file })
  return nodes
}

/** Groups arranged by `order`; independent of what is folded, so folding never rebuilds it. */
export function buildPanelTopology(groups: readonly PanelGroup[], order: PathOrder): PanelTopology {
  return {
    tree: order.tree,
    groups: groups.filter((group) => group.files.length > 0).map((group) => {
      // A path the order has not seen would land out of place; order such a group by itself.
      const rank = group.files.every((file) => order.rank.has(file.path))
        ? order.rank
        : createPathOrder(group.files.map((file) => file.path), order.tree).rank
      const files = byRank(group.files, rank)
      if (!order.tree) return { id: group.id, files, children: [] }
      const folders = folderTree<ViewFile>()
      for (const file of files) place(folders, file.path, file)
      return { id: group.id, files, children: nodesOf(folders.root) }
    }),
  }
}

/** Keys of collapsed groups (`group`) and directories (`dirRowKey`). */
export function flattenPanelRows(topology: PanelTopology, collapsed: ReadonlySet<string>): PanelRow[] {
  const rows: PanelRow[] = []
  const visit = (nodes: readonly PanelNode[], group: PanelGroupId, depth: number) => {
    for (let node of nodes) {
      if (node.kind === 'file') {
        rows.push({ kind: 'file', group, file: node.file, depth })
        continue
      }
      const startDir = node.dir
      let label = node.label
      // Stop at a folded ancestor even if a new filter made its chain compactable.
      while (!collapsed.has(dirRowKey(group, node.dir)) && node.children.length === 1 && node.children[0].kind === 'dir') {
        node = node.children[0]
        label += `/${node.label}`
      }
      const folded = collapsed.has(dirRowKey(group, node.dir))
      rows.push({ kind: 'dir', group, startDir, dir: node.dir, label, depth, count: node.count, collapsed: folded })
      if (!folded) visit(node.children, group, depth + 1)
    }
  }

  for (const group of topology.groups) {
    const folded = collapsed.has(group.id)
    rows.push({ kind: 'group', group: group.id, count: group.files.length, collapsed: folded })
    if (folded) continue
    if (topology.tree) visit(group.children, group.id, 0)
    else for (const file of group.files) rows.push({ kind: 'file', group: group.id, file, depth: 0 })
  }
  return rows
}

/** `files` as the panel lists them: by the first group showing each file, then in path order. */
export function inPanelOrder(files: readonly ViewFile[], groups: readonly PanelGroup[], order: PathOrder): ViewFile[] {
  const groupOf = new Map<string, number>()
  groups.forEach((group, index) => {
    for (const file of group.files) if (!groupOf.has(file.key)) groupOf.set(file.key, index)
  })
  return files
    .map((file) => ({ file, group: groupOf.get(file.key) ?? groups.length, at: order.rank.get(file.path) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.group - b.group || a.at - b.at)
    .map((entry) => entry.file)
}
