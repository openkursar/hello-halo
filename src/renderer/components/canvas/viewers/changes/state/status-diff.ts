/**
 * How many files changed between two working-tree statuses — the count behind
 * "New changes in N files". A file counts once, whether it appeared,
 * disappeared, moved between groups or changed its line counts.
 */

import type { GitChangedFile, GitWorkingTreeStatus } from '../../../../../../shared/types/git'

type StatusGroups = Pick<GitWorkingTreeStatus, 'staged' | 'unstaged' | 'conflicted'>

function signatures(status: StatusGroups): Map<string, string> {
  const byPath = new Map<string, string>()
  const add = (group: string, file: GitChangedFile) => {
    const entry = `${group}:${file.state}:${file.oldPath ?? ''}:${file.additions ?? '-'}:${file.deletions ?? '-'}`
    byPath.set(file.path, byPath.has(file.path) ? `${byPath.get(file.path)}|${entry}` : entry)
  }
  for (const file of status.conflicted) add('c', file)
  for (const file of status.staged) add('s', file)
  for (const file of status.unstaged) add('u', file)
  return byPath
}

export function countChangedFiles(before: StatusGroups, after: StatusGroups): number {
  const a = signatures(before)
  const b = signatures(after)
  let changed = 0
  for (const [path, signature] of b) if (a.get(path) !== signature) changed++
  for (const path of a.keys()) if (!b.has(path)) changed++
  return changed
}
