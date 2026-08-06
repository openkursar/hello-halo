/**
 * Skill File Tree
 *
 * Renders the directory structure of a multi-file skill package on the store
 * detail page. The skill spec ships its files as a flat `Record<path, content>`;
 * this rebuilds the nested folder view so users can see the package layout
 * before installing.
 */

import { useMemo } from 'react'
import { Folder, FileText } from 'lucide-react'
import { useTranslation } from '../../i18n'

interface TreeNode {
  dirs: Map<string, TreeNode>
  files: string[]
}

function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = { dirs: new Map(), files: [] }
  for (const path of paths) {
    const parts = path.split('/').filter(Boolean)
    let node = root
    parts.forEach((part, i) => {
      if (i === parts.length - 1) {
        node.files.push(part)
        return
      }
      let child = node.dirs.get(part)
      if (!child) {
        child = { dirs: new Map(), files: [] }
        node.dirs.set(part, child)
      }
      node = child
    })
  }
  return root
}

/** Folders first (alphabetical), then files (alphabetical); indentation encodes
 * depth so a deep package stays readable in the narrow aside. */
function TreeLevel({ node, depth }: { node: TreeNode; depth: number }) {
  const dirs = [...node.dirs.keys()].sort()
  const files = [...node.files].sort()
  return (
    <>
      {dirs.map(name => (
        <div key={`d:${name}`}>
          <div
            className="flex items-center gap-1.5 py-[3px] text-xs text-foreground"
            style={{ paddingLeft: depth * 14 }}
          >
            <Folder className="w-3.5 h-3.5 flex-shrink-0 text-muted-foreground" />
            <span className="truncate">{name}</span>
          </div>
          <TreeLevel node={node.dirs.get(name)!} depth={depth + 1} />
        </div>
      ))}
      {files.map(name => (
        <div
          key={`f:${name}`}
          className="flex items-center gap-1.5 py-[3px] text-xs text-muted-foreground"
          style={{ paddingLeft: depth * 14 }}
        >
          <FileText className="w-3.5 h-3.5 flex-shrink-0 opacity-70" />
          <span className="truncate">{name}</span>
        </div>
      ))}
    </>
  )
}

export function SkillFileTree({ paths }: { paths: string[] }) {
  const { t } = useTranslation()
  const tree = useMemo(() => buildTree(paths), [paths])
  return (
    <div className="rounded-[10px] border border-border/60 bg-background p-3.5 space-y-2.5">
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {t('File structure')}
      </h4>
      <div className="overflow-x-auto">
        <TreeLevel node={tree} depth={0} />
      </div>
    </div>
  )
}
