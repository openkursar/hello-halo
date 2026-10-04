/**
 * Detail-page navigation (`[` `]`, which files a page shows, which item holds
 * a file, files a report mentions), compare-scope resolution and labels, path
 * helpers, and the files an AI reply's edits turn into.
 */

import { describe, it, expect } from 'vitest'
import {
  currentItem,
  detailAt,
  detailFiles,
  filesMentionedIn,
  itemIndexOf,
  openDetail,
  stepDetail,
} from '../../../../../src/renderer/components/canvas/viewers/changes/overview/detail-nav'
import { resolveScope, revisionName, scopeKey, scopeLabel, sameStoredScope } from '../../../../../src/renderer/components/canvas/viewers/changes/model/scope'
import { baseName, dirName, extensionOf, joinRepoPath, relativeTo } from '../../../../../src/renderer/components/canvas/viewers/changes/model/paths'
import { messageViewFiles } from '../../../../../src/renderer/components/canvas/viewers/changes/message/message-changes'
import { isLargeDiff, totalsOf, type ViewFile } from '../../../../../src/renderer/components/canvas/viewers/changes/model/view-files'
import type { GitReviewRecord } from '../../../../../src/shared/types/git'

const t = (key: string, options?: Record<string, unknown>) =>
  key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name] ?? ''))

function file(path: string): ViewFile {
  return { key: path, path, absPath: `/r/${path}`, state: 'modified', additions: 1, deletions: 1, binary: false, generated: false }
}

describe('detail navigation', () => {
  const files = [file('src/a.ts'), file('src/b.ts'), file('src/x/c.ts'), file('d.md')]

  it('opens on the chosen item and walks without wrapping', () => {
    const state = openDetail('dir', ['src', 'src/x', ''], 'src/x')
    expect(state.index).toBe(1)
    expect(currentItem(stepDetail(state, 1))).toBe('')
    const last = stepDetail(stepDetail(state, 1), 1)
    expect(last).toBe(stepDetail(last, 1))
    expect(currentItem(stepDetail(state, -5))).toBe('src')
  })

  it('shows a directory\'s own files, or one file', () => {
    expect(detailFiles(openDetail('dir', ['src', ''], 'src'), files).map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(detailFiles(openDetail('dir', ['src', ''], ''), files).map((f) => f.path)).toEqual(['d.md'])
    expect(detailFiles(openDetail('file', ['src/x/c.ts'], 'src/x/c.ts', 12), files).map((f) => f.path)).toEqual(['src/x/c.ts'])
  })

  it('keeps the line a report link asked for, and drops it when stepping', () => {
    const state = openDetail('file', ['a.ts', 'b.ts'], 'a.ts', 40)
    expect(state.line).toBe(40)
    expect(stepDetail(state, 1).line).toBeUndefined()
  })

  it('remembers the report mention it was opened from wherever it walks', () => {
    const state = openDetail('file', ['a.ts', 'b.ts', 'c.ts'], 'b.ts', 7, 3)
    expect(state.mention).toBe(3)
    expect(stepDetail(state, 1)).toEqual({ kind: 'file', items: ['a.ts', 'b.ts', 'c.ts'], index: 2, mention: 3 })
    expect(detailAt(state, 0).mention).toBe(3)
    expect(detailAt(state, 1)).toBe(state)
    expect(openDetail('dir', ['src'], 'src')).not.toHaveProperty('mention')
  })

  it('finds the item that holds a file', () => {
    expect(itemIndexOf(openDetail('dir', ['src', 'src/x'], 'src'), 'src/x/c.ts')).toBe(1)
    expect(itemIndexOf(openDetail('file', ['src/a.ts'], 'src/a.ts'), 'src/b.ts')).toBe(-1)
  })

  it('lists changed files a report mentions, in first-mention order', () => {
    const report = [
      '## Must fix',
      '- Broken in `src/x/c.ts:12`, see also src/a.ts:3-5.',
      '- Again `src/x/c.ts:40`; ./d.md is fine. Not changed: src/other.ts:1',
    ].join('\n')
    expect(filesMentionedIn(report, files.map((f) => f.path))).toEqual(['src/x/c.ts', 'src/a.ts', 'd.md'])
  })

  it('reads mentions from the working directory of a repository nested in the space', () => {
    const report = 'See `app/src/a.ts:3` and `app/d.md`; `src/b.ts` is outside this repository.'
    expect(filesMentionedIn(report, files.map((f) => f.path), 'app')).toEqual(['src/a.ts', 'd.md'])
  })
})

describe('compare scopes', () => {
  const review: GitReviewRecord = {
    repoRoot: '/r', conversationId: 'c', variant: 'quick', scope: { kind: 'uncommitted' }, scopeLabel: 'x',
    snapshot: 'tree123', fileCount: 3, startedAt: 1,
  }

  it('resolves "since last review" from the latest review, or falls back to uncommitted', () => {
    expect(resolveScope({ kind: 'since-review' }, review)).toEqual({ kind: 'since-review', snapshot: 'tree123' })
    expect(resolveScope({ kind: 'since-review' }, null)).toEqual({ kind: 'uncommitted' })
    expect(resolveScope({ kind: 'revision', revision: 'main', mergeBase: true }, null)).toEqual({ kind: 'revision', revision: 'main', mergeBase: true })
  })

  it('labels scopes and shortens commit ids only', () => {
    expect(scopeLabel({ kind: 'uncommitted' }, t)).toBe('Uncommitted changes')
    expect(scopeLabel({ kind: 'revision', revision: 'origin/main', mergeBase: true }, t)).toBe('Compared with origin/main')
    expect(revisionName('4b825dc642cb6eb9a060e54bf8d69288fbee4904')).toBe('4b825dc')
    expect(revisionName('feature/abcdef')).toBe('feature/abcdef')
  })

  it('keys scopes by what they compare', () => {
    expect(scopeKey({ kind: 'since-review', snapshot: 'a' })).not.toBe(scopeKey({ kind: 'since-review', snapshot: 'b' }))
    expect(scopeKey({ kind: 'revision', revision: 'main', mergeBase: true })).not.toBe(scopeKey({ kind: 'revision', revision: 'main', mergeBase: false }))
    expect(sameStoredScope({ kind: 'staged' }, { kind: 'staged' })).toBe(true)
    expect(sameStoredScope({ kind: 'revision', revision: 'a', mergeBase: true }, { kind: 'revision', revision: 'b', mergeBase: true })).toBe(false)
  })
})

describe('paths', () => {
  it('joins repository paths in the root\'s own separator style', () => {
    expect(joinRepoPath('/Users/me/repo', 'src/a.ts')).toBe('/Users/me/repo/src/a.ts')
    expect(joinRepoPath('/Users/me/repo/', 'a.ts')).toBe('/Users/me/repo/a.ts')
    expect(joinRepoPath('C:\\work\\repo', 'src/a.ts')).toBe('C:\\work\\repo\\src\\a.ts')
  })

  it('makes paths relative only when inside the folder, case-insensitively on Windows', () => {
    expect(relativeTo('/w/space', '/w/space/src/a.ts')).toBe('src/a.ts')
    expect(relativeTo('/w/space', '/w/spaceship/a.ts')).toBeNull()
    expect(relativeTo('C:\\Work\\Space', 'c:\\work\\space\\a\\b.ts')).toBe('a/b.ts')
  })

  it('splits names, directories and extensions', () => {
    expect(baseName('src/a/b.test.ts')).toBe('b.test.ts')
    expect(baseName('C:\\x\\y.md')).toBe('y.md')
    expect(dirName('src/a/b.ts')).toBe('src/a')
    expect(dirName('b.ts')).toBe('')
    expect(extensionOf('src/App.TSX')).toBe('tsx')
    expect(extensionOf('Makefile')).toBe('')
    expect(extensionOf('.gitignore')).toBe('')
  })
})

describe('reply changes', () => {
  it('turns edits and writes into files, paths relative to the space folder', () => {
    const files = messageViewFiles(
      {
        edits: [
          {
            id: 'e1', file: '/w/space/src/a.ts', fileName: 'a.ts', type: 'edit', stats: { added: 3, removed: 1 },
            editChunks: [
              { id: 'e1', oldString: 'a', newString: 'b', stats: { added: 1, removed: 1 } },
              { id: 'e2', oldString: '', newString: 'c\nd', stats: { added: 2, removed: 0 } },
            ],
          },
          { id: 'e3', file: '/elsewhere/x.ts', fileName: 'x.ts', type: 'edit', oldString: 'p', newString: 'q', stats: { added: 1, removed: 1 } },
        ],
        writes: [{ id: 'w1', file: '/w/space/new.md', fileName: 'new.md', type: 'write', content: '# hi\n', stats: { added: 2, removed: 0 } }],
        totalFiles: 3, totalAdded: 6, totalRemoved: 2,
      },
      '/w/space'
    )
    expect(files.map((f) => [f.key, f.path, f.state])).toEqual([
      ['edit:/w/space/src/a.ts', 'src/a.ts', 'modified'],
      ['edit:/elsewhere/x.ts', '/elsewhere/x.ts', 'modified'],
      ['write:/w/space/new.md', 'new.md', 'added'],
    ])
    expect(files[0].edits).toEqual([{ id: 'e1', before: 'a', after: 'b' }, { id: 'e2', before: '', after: 'c\nd' }])
    expect(files[1].edits).toEqual([{ id: 'e3', before: 'p', after: 'q' }])
    expect(files[2].written).toBe('# hi\n')
    expect(totalsOf(files)).toEqual({ files: 3, additions: 6, deletions: 2 })
  })

  it('folds very large diffs by default', () => {
    expect(isLargeDiff({ ...file('a.ts'), additions: 1200, deletions: 300 })).toBe(true)
    expect(isLargeDiff({ ...file('a.ts'), additions: null, deletions: null })).toBe(false)
  })
})
