/**
 * The file panel's rows (groups, directory headers, files; tree and list) and
 * the overview's change distribution are computed from the change list alone.
 */

import { describe, it, expect, vi } from 'vitest'
import { buildPanelTopology, createPathOrder, dirRowKey, flattenPanelRows, inPanelOrder, type PanelGroup } from '../../../../../src/renderer/components/canvas/viewers/changes/panel/panel-rows'
import { areaHasHeading, areaOf, computeDistribution, dirLabel } from '../../../../../src/renderer/components/canvas/viewers/changes/overview/distribution'
import type { ViewFile } from '../../../../../src/renderer/components/canvas/viewers/changes/model/view-files'

function file(path: string, additions: number | null = 1, deletions: number | null = 0, state: ViewFile['state'] = 'modified'): ViewFile {
  return { key: path, path, absPath: `/repo/${path}`, state, additions, deletions, binary: additions === null, generated: false }
}

/** Rows as the panel shows them, with the order built from the same files. */
function rows(groups: PanelGroup[], options: { tree: boolean; collapsed?: ReadonlySet<string> }) {
  return flattenPanelRows(topologyOf(groups, options.tree), options.collapsed ?? new Set())
}

function topologyOf(groups: PanelGroup[], tree = true) {
  return buildPanelTopology(groups, createPathOrder(groups.flatMap((group) => group.files.map((f) => f.path)), tree))
}

const label = (r: ReturnType<typeof rows>[number]) => (r.kind === 'file' ? r.file.path : r.kind === 'dir' ? `[${r.dir}]` : `#${r.group}`)

describe('file panel rows', () => {
  const files = [file('src/b/z.ts'), file('README.md'), file('src/a.ts'), file('src/b/y.ts')]

  it('nests directory segments, directories first, with relative labels and depth', () => {
    const result = rows([{ id: 'unstaged', files }], { tree: true })
    expect(result.map(label)).toEqual([
      '#unstaged', '[src]', '[src/b]', 'src/b/y.ts', 'src/b/z.ts', 'src/a.ts', 'README.md',
    ])
    expect(result.find((r) => r.kind === 'dir' && r.dir === 'src')).toMatchObject({ label: 'src', depth: 0, count: 3 })
    expect(result.find((r) => r.kind === 'dir' && r.dir === 'src/b')).toMatchObject({ label: 'b', depth: 1, count: 2 })
    expect(result.find((r) => r.kind === 'file' && r.file.path === 'src/b/y.ts')).toMatchObject({ depth: 2 })
    expect(result.find((r) => r.kind === 'file' && r.file.path === 'src/a.ts')).toMatchObject({ depth: 1 })
    expect(result.find((r) => r.kind === 'file' && r.file.path === 'README.md')).toMatchObject({ depth: 0 })
  })

  it('lists files flat and sorted in list mode', () => {
    const result = rows([{ id: 'changes', files }], { tree: false })
    expect(result.filter((r) => r.kind === 'file').map(label)).toEqual([
      'README.md', 'src/a.ts', 'src/b/y.ts', 'src/b/z.ts',
    ])
  })

  it('skips empty groups and hides what is collapsed', () => {
    const result = rows(
      [
        { id: 'conflicted', files: [] },
        { id: 'staged', files: [file('x.ts')] },
        { id: 'unstaged', files },
      ],
      { tree: true, collapsed: new Set(['staged', dirRowKey('unstaged', 'src/b')]) }
    )
    expect(result.some((r) => r.group === 'conflicted')).toBe(false)
    expect(result.filter((r) => r.group === 'staged')).toEqual([{ kind: 'group', group: 'staged', count: 1, collapsed: true }])
    expect(result.find((r) => r.kind === 'dir' && r.dir === 'src/b')).toMatchObject({ collapsed: true, count: 2 })
    expect(result.some((r) => r.kind === 'file' && r.file.path.startsWith('src/b/'))).toBe(false)
  })

  it('compacts only single-directory chains, keeping the terminal file separate', () => {
    expect(rows([{ id: 'changes', files: [file('src/main/services/git/status.ts')] }], { tree: true })).toEqual([
      { kind: 'group', group: 'changes', count: 1, collapsed: false },
      { kind: 'dir', group: 'changes', startDir: 'src', dir: 'src/main/services/git', label: 'src/main/services/git', depth: 0, count: 1, collapsed: false },
      { kind: 'file', group: 'changes', file: file('src/main/services/git/status.ts'), depth: 1 },
    ])
  })

  it('stops compaction at branches and directories containing files', () => {
    const result = rows([{ id: 'changes', files: [
      file('src/main/services/a.ts'), file('src/main/b.ts'), file('src/renderer/c.ts'),
    ] }], { tree: true })
    expect(result.filter((r) => r.kind === 'dir').map((r) => [r.dir, r.label, r.depth, r.count])).toEqual([
      ['src', 'src', 0, 3], ['src/main', 'main', 1, 2], ['src/main/services', 'services', 2, 1], ['src/renderer', 'renderer', 1, 1],
    ])
  })

  it('sorts directories and files naturally without changing the input order', () => {
    const input = Object.freeze([
      file('file10.ts'), file('Folder10/x.ts'), file('file2.ts'), file('folder2/x.ts'), file('A.ts'), file('a.ts'),
    ])
    const result = rows([{ id: 'changes', files: input }], { tree: true })
    expect(result.slice(1).map((r) => r.kind === 'dir' ? `[${r.label}]` : r.kind === 'file' ? r.file.path : '')).toEqual([
      '[folder2]', 'folder2/x.ts', '[Folder10]', 'Folder10/x.ts', 'A.ts', 'a.ts', 'file2.ts', 'file10.ts',
    ])
    const list = rows([{ id: 'changes', files: input }], { tree: false })
    expect(list.filter((r) => r.kind === 'file').every((r) => r.depth === 0)).toBe(true)
    expect(list.filter((r) => r.kind === 'file').map(label)).toEqual(['A.ts', 'a.ts', 'file2.ts', 'file10.ts', 'folder2/x.ts', 'Folder10/x.ts'])
    expect(input[0].path).toBe('file10.ts')
  })

  it('hides all descendants of a folded parent, not similarly prefixed peers or other groups', () => {
    const input = [...files, file('src/b/deep/x.ts'), file('src2/keep.ts')]
    const result = rows([
      { id: 'staged', files: input }, { id: 'unstaged', files: input },
    ], { tree: true, collapsed: new Set([dirRowKey('staged', 'src')]) })
    expect(result.find((r) => r.group === 'staged' && r.kind === 'dir' && r.dir === 'src')).toMatchObject({ collapsed: true, count: 4 })
    expect(result.some((r) => r.group === 'staged' && (r.kind === 'dir' ? r.dir.startsWith('src/') : r.kind === 'file' && r.file.path.startsWith('src/')))).toBe(false)
    expect(result.some((r) => r.group === 'staged' && r.kind === 'file' && r.file.path === 'src2/keep.ts')).toBe(true)
    expect(result.some((r) => r.group === 'unstaged' && r.kind === 'file' && r.file.path === 'src/b/deep/x.ts')).toBe(true)
  })

  it('retains a folded child when its parent is folded and unfolded', () => {
    const topology = topologyOf([{ id: 'changes', files }])
    const child = dirRowKey('changes', 'src/b')
    const both = flattenPanelRows(topology, new Set([dirRowKey('changes', 'src'), child]))
    expect(both.some((r) => r.kind === 'dir' && r.dir === 'src/b')).toBe(false)
    const reopened = flattenPanelRows(topology, new Set([child]))
    expect(reopened.find((r) => r.kind === 'dir' && r.dir === 'src/b')).toMatchObject({ collapsed: true })
    expect(reopened.some((r) => r.kind === 'file' && r.file.path.startsWith('src/b/'))).toBe(false)
    const list = flattenPanelRows(topologyOf([{ id: 'changes', files }], false), new Set([child]))
    expect(list.filter((r) => r.kind === 'file')).toHaveLength(files.length)
  })

  it('keeps absolute reply paths canonical without empty directory rows', () => {
    const input = [file('/outside/src/a.ts'), file('C:\\work\\b.ts'), file('src/c.ts'), file('//host/share/d.ts')]
    const topology = topologyOf([{ id: 'changes', files: input }])
    const result = flattenPanelRows(topology, new Set())
    expect(result.filter((r) => r.kind === 'dir').map((r) => [r.dir, r.label])).toEqual([
      ['//host/share', '//host/share'], ['/outside/src', '/outside/src'], ['C:/work', 'C:/work'], ['src', 'src'],
    ])
    expect(result.filter((r) => r.kind === 'file').map((r) => r.file)).toHaveLength(4)
    const collapsed = flattenPanelRows(topology, new Set([dirRowKey('changes', 'C:/work')]))
    expect(collapsed.some((r) => r.kind === 'file' && r.file.path === 'C:\\work\\b.ts')).toBe(false)
  })

  it('does not treat backslashes inside repository-relative filenames as directory separators', () => {
    const result = rows([{ id: 'changes', files: [file('src/back\\slash.ts')] }], { tree: true })
    expect(result.filter((r) => r.kind === 'dir').map((r) => r.dir)).toEqual(['src'])
    expect(result.find((r) => r.kind === 'file')).toMatchObject({ file: { path: 'src/back\\slash.ts' }, depth: 1 })
  })

  it('honors a folded ancestor when filtering makes its directory chain compactable', () => {
    const topology = topologyOf([{ id: 'changes', files: [file('src/main/services/a.ts')] }])
    expect(flattenPanelRows(topology, new Set([dirRowKey('changes', 'src/main')]))).toEqual([
      { kind: 'group', group: 'changes', count: 1, collapsed: false },
      { kind: 'dir', group: 'changes', startDir: 'src', dir: 'src/main', label: 'src/main', depth: 0, count: 1, collapsed: true },
    ])
    const expanded = flattenPanelRows(topology, new Set())
    expect(expanded.find((row) => row.kind === 'dir')).toMatchObject({ startDir: 'src', dir: 'src/main/services', collapsed: false })
  })
})

describe('path order', () => {
  const paths = ['src/b/z.ts', 'README.md', 'src/item-10.ts', 'src/item-2.ts', 'src/b/y.ts', 'docs/a.md']
  const ranked = (tree: boolean) => [...createPathOrder(paths, tree).rank.entries()].sort((a, b) => a[1] - b[1]).map(([path]) => path)

  it('ranks folders before files at every level in Tree mode, whole paths in List mode, naturally', () => {
    expect(ranked(true)).toEqual(['docs/a.md', 'src/b/y.ts', 'src/b/z.ts', 'src/item-2.ts', 'src/item-10.ts', 'README.md'])
    expect(ranked(false)).toEqual(['docs/a.md', 'README.md', 'src/b/y.ts', 'src/b/z.ts', 'src/item-2.ts', 'src/item-10.ts'])
  })

  it('arranges a filtered group by the order without comparing a single path again', () => {
    const all = paths.map((path) => file(path))
    const order = createPathOrder(paths, true)
    const compare = vi.spyOn(Intl.Collator.prototype, 'compare', 'get')
    try {
      const narrowed = flattenPanelRows(buildPanelTopology([{ id: 'changes', files: all.filter((f) => f.path.startsWith('src/')) }], order), new Set())
      expect(narrowed.map(label)).toEqual(['#changes', '[src]', '[src/b]', 'src/b/y.ts', 'src/b/z.ts', 'src/item-2.ts', 'src/item-10.ts'])
      expect(compare).not.toHaveBeenCalled()
    } finally {
      compare.mockRestore()
    }
    expect(flattenPanelRows(buildPanelTopology([{ id: 'changes', files: all }], order), new Set()))
      .toEqual(rows([{ id: 'changes', files: [...all].reverse() }], { tree: true }))
  })

  it('orders a group by itself when it holds a path the order has not seen', () => {
    const order = createPathOrder(['b.ts'], true)
    const result = flattenPanelRows(buildPanelTopology([{ id: 'changes', files: [file('z.ts'), file('lib/x.ts'), file('b.ts')] }], order), new Set())
    expect(result.map(label)).toEqual(['#changes', '[lib]', 'lib/x.ts', 'b.ts', 'z.ts'])
  })

  it('puts the diffs in the panel order: by the first group listing each file, then by path', () => {
    const staged = [file('src/b/y.ts')]
    const unstaged = [file('src/item-10.ts'), file('src/b/y.ts'), file('README.md'), file('src/item-2.ts')]
    const order = createPathOrder(paths, true)
    const stack = [...unstaged, file('docs/a.md')]
    expect(inPanelOrder(stack, [{ id: 'staged', files: staged }, { id: 'unstaged', files: unstaged }], order).map((f) => f.path)).toEqual([
      'src/b/y.ts', 'src/item-2.ts', 'src/item-10.ts', 'README.md', 'docs/a.md',
    ])
  })
})

describe('computeDistribution', () => {
  it('groups directories into areas, container folders by two segments', () => {
    expect(areaOf('')).toBe('')
    expect(areaOf('docs')).toBe('docs')
    expect(areaOf('docs/guide')).toBe('docs')
    expect(areaOf('src/main/services')).toBe('src/main')
    expect(areaOf('src')).toBe('src')
    expect(areaOf('packages/ui/button')).toBe('packages/ui')
  })

  it('counts files, lines, folders and new files, largest change first', () => {
    const d = computeDistribution([
      file('src/main/a.ts', 10, 5),
      file('src/main/sub/b.ts', 1, 1),
      file('src/renderer/c.tsx', 40, 0, 'added'),
      file('README.md', 2, 0),
      file('assets/logo.png', null, null),
      file('src/renderer/d.tsx', 3, 0, 'untracked'),
    ])
    expect(d).toMatchObject({ files: 6, dirs: 5, additions: 56, deletions: 6, newFiles: 2, maxDirLines: 43 })
    expect(d.areas.map((a) => a.area)).toEqual(['src/renderer', 'src/main', '', 'assets'])
    expect(d.areas[1].dirs.map((x) => x.dir)).toEqual(['src/main', 'src/main/sub'])
    expect(d.order).toEqual(['src/renderer', 'src/main', 'src/main/sub', '', 'assets'])
    expect(d.areas[0].dirs[0]).toMatchObject({ files: 2, additions: 43, deletions: 0, newFiles: 2 })
    // A folder of binary files has no line counts to show.
    expect(d.areas[3].dirs[0]).toMatchObject({ dir: 'assets', files: 1, textFiles: 0 })
    expect(d.areas[0].dirs[0].textFiles).toBe(2)
  })

  it('heads only areas of several folders; a folder reads relative to its heading, or in full', () => {
    const d = computeDistribution([
      file('src/main/a.ts', 10, 5),
      file('src/main/sub/b.ts', 1, 1),
      file('src/prompts/p.md', 44, 44),
      file('notes/todo.md', 3, 0),
      file('docs/generated/api.md', 2, 2),
      file('README.md', 2, 0),
    ])
    const area = (name: string) => d.areas.find((a) => a.area === name)!
    expect(d.areas.filter(areaHasHeading).map((a) => a.area)).toEqual(['src/main'])
    // Under a heading: the rest of the path, and the area's own folder in full.
    expect(dirLabel('src/main/sub', area('src/main'))).toBe('sub')
    expect(dirLabel('src/main', area('src/main'))).toBe('src/main')
    // Alone in its area: no heading, so the full path, never '/'.
    expect(dirLabel('src/prompts', area('src/prompts'))).toBe('src/prompts')
    expect(dirLabel('notes', area('notes'))).toBe('notes')
    expect(dirLabel('docs/generated', area('docs'))).toBe('docs/generated')
    expect(dirLabel('', area(''))).toBe('')
  })

  it('is empty for no files', () => {
    expect(computeDistribution([])).toMatchObject({ files: 0, dirs: 0, areas: [], order: [], maxDirLines: 0 })
  })
})
