/**
 * The file panel as a flat list of rows (group headers, directory headers,
 * files), so it can be virtualized however long the change list is.
 */

import type { ViewFile } from '../model/view-files'
import { dirName } from '../model/paths'

export type PanelGroupId = 'conflicted' | 'staged' | 'unstaged' | 'changes'

export interface PanelGroup {
  id: PanelGroupId
  files: readonly ViewFile[]
}

export type PanelRow =
  | { kind: 'group'; group: PanelGroupId; count: number; collapsed: boolean }
  | { kind: 'dir'; group: PanelGroupId; dir: string; count: number; collapsed: boolean }
  | { kind: 'file'; group: PanelGroupId; file: ViewFile; nested: boolean }

export interface PanelRowOptions {
  tree: boolean
  /** Keys of collapsed groups (`group`) and directories (`group:dir`). */
  collapsed: ReadonlySet<string>
}

export function dirRowKey(group: PanelGroupId, dir: string): string {
  return `${group}:${dir}`
}

function byPath(a: ViewFile, b: ViewFile): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
}

export function buildPanelRows(groups: readonly PanelGroup[], options: PanelRowOptions): PanelRow[] {
  const rows: PanelRow[] = []
  for (const group of groups) {
    if (group.files.length === 0) continue
    const groupCollapsed = options.collapsed.has(group.id)
    rows.push({ kind: 'group', group: group.id, count: group.files.length, collapsed: groupCollapsed })
    if (groupCollapsed) continue

    const files = [...group.files].sort(byPath)
    if (!options.tree) {
      for (const file of files) rows.push({ kind: 'file', group: group.id, file, nested: false })
      continue
    }

    // Root files first, then one header per directory, in path order.
    const byDir = new Map<string, ViewFile[]>()
    for (const file of files) {
      const dir = dirName(file.path)
      const list = byDir.get(dir)
      if (list) list.push(file)
      else byDir.set(dir, [file])
    }
    for (const file of byDir.get('') ?? []) rows.push({ kind: 'file', group: group.id, file, nested: false })
    const dirs = [...byDir.keys()].filter((dir) => dir !== '').sort()
    for (const dir of dirs) {
      const list = byDir.get(dir)!
      const collapsed = options.collapsed.has(dirRowKey(group.id, dir))
      rows.push({ kind: 'dir', group: group.id, dir, count: list.length, collapsed })
      if (collapsed) continue
      for (const file of list) rows.push({ kind: 'file', group: group.id, file, nested: true })
    }
  }
  return rows
}
