/**
 * The worker's path index answers @ file queries without shipping the whole
 * listing: it walks the space in the background under the watcher's ignore
 * rules, stays current from events, and reports when it is capped.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { PathIndex } from '../../../../src/worker/file-watcher/path-index'
import { loadIgnoreRules } from '../../../../src/worker/file-watcher/scanner'

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'halo-path-index-')))
  mkdirSync(join(root, 'src/components/chat'), { recursive: true })
  mkdirSync(join(root, 'node_modules/pkg'), { recursive: true })
  writeFileSync(join(root, 'README.md'), '')
  writeFileSync(join(root, 'src/components/chat/ChatView.tsx'), '')
  writeFileSync(join(root, 'src/index.ts'), '')
  writeFileSync(join(root, 'node_modules/pkg/index.js'), '')
  writeFileSync(join(root, 'debug.log'), '')
  writeFileSync(join(root, '.gitignore'), '*.log\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const paths = (index: PathIndex, q = '', limit = 100) => index.query(q, limit).items.map(i => i.relativePath).sort()

describe('PathIndex', () => {
  it('indexes the space at any depth under the watcher ignore rules', async () => {
    const index = new PathIndex(root, () => loadIgnoreRules(root))
    await index.rebuild()

    expect(paths(index)).toEqual([
      '.gitignore', 'README.md', 'src', join('src', 'components'), join('src', 'components', 'chat'),
      join('src', 'components', 'chat', 'ChatView.tsx'), join('src', 'index.ts'),
    ].sort())
    expect(index.query('', 10).indexing).toBe(false)
  })

  it('answers a query with only the best matches', async () => {
    const index = new PathIndex(root, () => loadIgnoreRules(root))
    await index.rebuild()

    const result = index.query('chatv', 1)
    expect(result.items).toEqual([{ relativePath: join('src', 'components', 'chat', 'ChatView.tsx'), isFolder: false }])
  })

  it('follows adds and removals, including a removed directory subtree', async () => {
    const index = new PathIndex(root, () => loadIgnoreRules(root))
    await index.rebuild()

    index.add('notes.md', false)
    expect(paths(index, 'notes')).toEqual(['notes.md'])

    index.remove('src')
    expect(paths(index, 'src')).toEqual([])
    expect(paths(index)).toEqual(['.gitignore', 'README.md', 'notes.md'])
  })

  it('walks the contents of a directory that appears', async () => {
    const index = new PathIndex(root, () => loadIgnoreRules(root))
    await index.rebuild()
    mkdirSync(join(root, 'added/inner'), { recursive: true })
    writeFileSync(join(root, 'added/inner/file.txt'), '')

    index.add('added', true)
    await new Promise(r => setTimeout(r, 50))

    expect(paths(index, 'added')).toEqual(['added', join('added', 'inner'), join('added', 'inner', 'file.txt')])
  })

  it('marks results truncated when the space exceeds the entry cap', async () => {
    const index = new PathIndex(root, () => loadIgnoreRules(root), 3)
    await index.rebuild()

    const result = index.query('', 100)
    expect(result.items).toHaveLength(3)
    expect(result.truncated).toBe(true)

    // At the cap the index stops growing, whatever events arrive.
    index.add('late.txt', false)
    index.add('late-dir', true)
    expect(index.size).toBe(3)
    expect(index.query('late', 10).items).toEqual([])
  })

  it('limits a listing by depth', async () => {
    const index = new PathIndex(root, () => loadIgnoreRules(root))
    await index.rebuild()
    expect(index.query('', 100, 1).items.map(i => i.relativePath).sort()).toEqual(['.gitignore', 'README.md', 'src'])
  })

  it('abandons a walk superseded by a newer rebuild', async () => {
    const index = new PathIndex(root, () => loadIgnoreRules(root))
    const first = index.rebuild()
    const second = index.rebuild()
    await Promise.all([first, second])
    expect(paths(index)).toHaveLength(7)
  })
})
