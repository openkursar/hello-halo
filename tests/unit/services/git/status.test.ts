/**
 * The file panel's groups from a real repository: staged (renames with their
 * old path), unstaged with untracked, conflicts, line counts, binary and
 * generated flags — and nested repositories kept out.
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { rmSync, unlinkSync } from 'fs'
import { join } from 'path'
import { getWorkingTreeStatus } from '../../../../src/main/services/git'
import { initRepo, isolateGit, makeTempDir, type TestRepo } from './_repo'

const { spaces } = vi.hoisted(() => ({ spaces: new Map<string, string>() }))
vi.mock('../../../../src/main/services/space.service', () => ({
  getSpaceDir: (spaceId: string) => spaces.get(spaceId) ?? '',
}))

let restoreGit: () => void
const dirs: string[] = []

beforeAll(() => {
  restoreGit = isolateGit()
})
afterAll(() => restoreGit())
afterEach(() => {
  spaces.clear()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function repoInSpace(): TestRepo {
  const dir = makeTempDir('halo-git-status-')
  dirs.push(dir)
  spaces.set('s', dir)
  return initRepo(dir)
}

describe('getWorkingTreeStatus', () => {
  it('groups staged, unstaged and untracked changes with counts and flags', async () => {
    const repo = repoInSpace()
    repo.write('a.txt', 'one\ntwo\n')
    repo.write('rename me.txt', 'r1\nr2\nr3\nr4\n')
    repo.write('del.txt', 'gone\n')
    repo.write('bin.dat', Buffer.from([0, 1, 2, 3]))
    repo.write('中文/文件.md', '# 标题\n')
    repo.write('.gitattributes', 'gen/** linguist-generated\n')
    repo.write('gen/out.js', 'x\n')
    repo.commitAll('base')

    repo.git('mv', 'rename me.txt', 'renamed.txt')
    repo.write('a.txt', 'one\ntwo\nthree\n')
    repo.git('add', 'a.txt')
    repo.write('a.txt', 'one\nthree\n')
    unlinkSync(join(repo.root, 'del.txt'))
    repo.write('bin.dat', Buffer.from([0, 9, 9]))
    repo.write('中文/文件.md', '# 新标题\n正文\n')
    repo.write('gen/out.js', 'y\n')
    repo.write('new file.txt', 'l1\nl2\nl3')
    repo.write('blob.bin', Buffer.from([1, 0, 1]))
    initRepo(join(repo.root, 'nested'))

    const status = await getWorkingTreeStatus('s', repo.root)

    expect(status.repo).toMatchObject({ branch: 'main', unborn: false, relativePath: '' })
    expect(status.operation).toBeNull()
    expect(status.truncated).toBe(false)
    expect(status.conflicted).toEqual([])
    expect(status.staged).toEqual([
      { path: 'a.txt', state: 'modified', additions: 1, deletions: 0, binary: false },
      { path: 'renamed.txt', oldPath: 'rename me.txt', state: 'renamed', additions: 0, deletions: 0, binary: false },
    ])
    expect(status.unstaged).toEqual([
      { path: 'a.txt', state: 'modified', additions: 0, deletions: 1, binary: false },
      { path: 'bin.dat', state: 'modified', additions: null, deletions: null, binary: true },
      { path: 'del.txt', state: 'deleted', additions: 0, deletions: 1, binary: false },
      { path: 'gen/out.js', state: 'modified', additions: 1, deletions: 1, binary: false, generated: true },
      { path: '中文/文件.md', state: 'modified', additions: 2, deletions: 1, binary: false },
      { path: 'blob.bin', state: 'untracked', additions: null, deletions: null, binary: true },
      { path: 'new file.txt', state: 'untracked', additions: 3, deletions: 0, binary: false },
    ])
  })

  it('reports conflicts once, in their own group, and the merge in progress', async () => {
    const repo = repoInSpace()
    repo.write('c.txt', 'base\n')
    repo.commitAll('base')
    repo.git('checkout', '-q', '-b', 'other')
    repo.write('c.txt', 'other\n')
    repo.commitAll('other')
    repo.git('checkout', '-q', 'main')
    repo.write('c.txt', 'main\n')
    repo.commitAll('main')
    expect(() => repo.git('merge', 'other')).toThrow()

    const status = await getWorkingTreeStatus('s', repo.root)
    expect(status.operation).toBe('merge')
    expect(status.conflicted).toEqual([{ path: 'c.txt', state: 'conflicted', additions: null, deletions: null, binary: false }])
    expect(status.staged).toEqual([])
    expect(status.unstaged).toEqual([])
  })

  it('works before the first commit', async () => {
    const repo = repoInSpace()
    repo.write('first.txt', 'a\nb\n')
    repo.git('add', 'first.txt')
    const status = await getWorkingTreeStatus('s', repo.root)
    expect(status.repo).toMatchObject({ branch: 'main', head: null, unborn: true })
    expect(status.staged).toEqual([{ path: 'first.txt', state: 'added', additions: 2, deletions: 0, binary: false }])
  })
})
