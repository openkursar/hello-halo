/**
 * The file panel's rows (groups, directory headers, files; tree and list) and
 * the overview's change distribution are computed from the change list alone.
 */

import { describe, it, expect } from 'vitest'
import { buildPanelRows, dirRowKey } from '../../../../../src/renderer/components/canvas/viewers/changes/panel/panel-rows'
import { areaHasHeading, areaOf, computeDistribution, dirLabel } from '../../../../../src/renderer/components/canvas/viewers/changes/overview/distribution'
import type { ViewFile } from '../../../../../src/renderer/components/canvas/viewers/changes/model/view-files'

function file(path: string, additions: number | null = 1, deletions: number | null = 0, state: ViewFile['state'] = 'modified'): ViewFile {
  return { key: path, path, absPath: `/repo/${path}`, state, additions, deletions, binary: additions === null, generated: false }
}

describe('buildPanelRows', () => {
  const files = [file('src/b/z.ts'), file('README.md'), file('src/a.ts'), file('src/b/y.ts')]

  it('lists root files first, then one header per directory in path order', () => {
    const rows = buildPanelRows([{ id: 'unstaged', files }], { tree: true, collapsed: new Set() })
    expect(rows.map((r) => (r.kind === 'file' ? r.file.path : r.kind === 'dir' ? `[${r.dir}]` : `#${r.group}`))).toEqual([
      '#unstaged', 'README.md', '[src]', 'src/a.ts', '[src/b]', 'src/b/y.ts', 'src/b/z.ts',
    ])
    expect(rows.find((r) => r.kind === 'file' && r.file.path === 'README.md')).toMatchObject({ nested: false })
    expect(rows.find((r) => r.kind === 'file' && r.file.path === 'src/a.ts')).toMatchObject({ nested: true })
  })

  it('lists files flat and sorted in list mode', () => {
    const rows = buildPanelRows([{ id: 'changes', files }], { tree: false, collapsed: new Set() })
    expect(rows.filter((r) => r.kind === 'file').map((r) => r.kind === 'file' && r.file.path)).toEqual([
      'README.md', 'src/a.ts', 'src/b/y.ts', 'src/b/z.ts',
    ])
  })

  it('skips empty groups and hides what is collapsed', () => {
    const rows = buildPanelRows(
      [
        { id: 'conflicted', files: [] },
        { id: 'staged', files: [file('x.ts')] },
        { id: 'unstaged', files },
      ],
      { tree: true, collapsed: new Set(['staged', dirRowKey('unstaged', 'src/b')]) }
    )
    expect(rows.some((r) => r.group === 'conflicted')).toBe(false)
    expect(rows.filter((r) => r.group === 'staged')).toEqual([{ kind: 'group', group: 'staged', count: 1, collapsed: true }])
    expect(rows.find((r) => r.kind === 'dir' && r.dir === 'src/b')).toMatchObject({ collapsed: true, count: 2 })
    expect(rows.some((r) => r.kind === 'file' && r.file.path.startsWith('src/b/'))).toBe(false)
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
