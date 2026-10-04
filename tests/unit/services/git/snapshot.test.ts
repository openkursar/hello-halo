/**
 * A snapshot captures the whole working tree without touching the user's
 * index, working tree or refs; and nothing that only reads takes the index
 * lock, so a review or a refresh never collides with the AI running git.
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { countChangedSince, createSnapshot, getChangeList, getWorkingTreeStatus, readFileContents, stagePaths } from '../../../../src/main/services/git'
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
  const dir = makeTempDir('halo-git-snapshot-')
  dirs.push(dir)
  spaces.set('s', dir)
  return initRepo(dir)
}

describe('createSnapshot', () => {
  it('captures tracked and untracked files, skips ignored ones, and leaves index, tree and refs alone', async () => {
    const repo = repoInSpace()
    repo.write('.gitignore', 'ignored.log\n')
    repo.write('tracked.txt', 't\n')
    repo.commitAll('base')
    repo.write('tracked.txt', 't2\n')
    repo.write('staged.txt', 's\n')
    repo.git('add', 'staged.txt')
    repo.write('untracked.txt', 'u\n')
    repo.write('ignored.log', 'noise\n')

    // Our own `git status` refreshes (rewrites) the index, so it runs before the index is sampled.
    const statusBefore = repo.git('status', '--porcelain=v2', '--untracked-files=all')
    const refsBefore = repo.git('for-each-ref')
    const indexFile = join(repo.root, '.git', 'index')
    const indexBefore = readFileSync(indexFile)
    const indexMtime = statSync(indexFile).mtimeMs

    const snapshot = await createSnapshot('s', repo.root)
    expect(snapshot.tree).toMatch(/^[0-9a-f]{40}$/)
    expect(repo.git('cat-file', '-t', snapshot.tree).trim()).toBe('tree')
    expect(repo.git('ls-tree', '--name-only', snapshot.tree).trim().split('\n')).toEqual([
      '.gitignore', 'staged.txt', 'tracked.txt', 'untracked.txt',
    ])
    expect(repo.git('show', `${snapshot.tree}:tracked.txt`)).toBe('t2\n')

    expect(readFileSync(indexFile).equals(indexBefore)).toBe(true)
    expect(statSync(indexFile).mtimeMs).toBe(indexMtime)
    expect(repo.git('status', '--porcelain=v2', '--untracked-files=all')).toBe(statusBefore)
    expect(repo.git('for-each-ref')).toBe(refsBefore)
  })

  it('works before the first commit and with no index at all', async () => {
    const repo = repoInSpace()
    repo.write('only.txt', 'o\n')
    const snapshot = await createSnapshot('s', repo.root)
    expect(repo.git('ls-tree', '--name-only', snapshot.tree).trim()).toBe('only.txt')
  })
})

describe('countChangedSince', () => {
  it('counts paths changed since the snapshot, a rename once', async () => {
    const repo = repoInSpace()
    repo.write('a.txt', 'a\n')
    repo.write('move-me.txt', 'line 1\nline 2\nline 3\nline 4\nline 5\n')
    repo.commitAll('base')
    const snapshot = await createSnapshot('s', repo.root)
    expect(await countChangedSince('s', repo.root, snapshot.tree)).toBe(0)

    repo.write('a.txt', 'a2\n')
    repo.write('new.txt', 'n\n')
    repo.git('mv', 'move-me.txt', 'moved.txt')
    expect(await countChangedSince('s', repo.root, snapshot.tree)).toBe(3)
  })

  it('reports a pruned snapshot and refuses anything but an object id', async () => {
    const repo = repoInSpace()
    repo.write('a.txt', 'a\n')
    repo.commitAll('base')
    await expect(countChangedSince('s', repo.root, 'c'.repeat(40))).rejects.toMatchObject({ code: 'GIT_SNAPSHOT_MISSING' })
    await expect(countChangedSince('s', repo.root, 'HEAD~1')).rejects.toMatchObject({ code: 'GIT_INVALID_ARGUMENT' })
  })
})

describe('sharing a repository with another git process', () => {
  it('reads and snapshots while another process holds index.lock; writes report GIT_LOCKED', async () => {
    const repo = repoInSpace()
    repo.write('a.txt', 'a\n')
    repo.commitAll('base')
    repo.write('a.txt', 'changed\n')
    repo.write('b.txt', 'new\n')
    const lock = join(repo.root, '.git', 'index.lock')
    writeFileSync(lock, '')
    try {
      const status = await getWorkingTreeStatus('s', repo.root)
      expect(status.unstaged.map((file) => file.path)).toEqual(['a.txt', 'b.txt'])
      const list = await getChangeList('s', repo.root, { kind: 'uncommitted' })
      expect(list.files).toHaveLength(2)
      const contents = await readFileContents('s', repo.root, { scope: list.scope, beforeRevision: list.beforeRevision, path: 'a.txt' })
      expect(contents.after).toBe('changed\n')
      const snapshot = await createSnapshot('s', repo.root)
      expect(await countChangedSince('s', repo.root, snapshot.tree)).toBe(0)

      await expect(stagePaths('s', repo.root, ['a.txt'])).rejects.toMatchObject({ code: 'GIT_LOCKED' })
    } finally {
      rmSync(lock, { force: true })
    }
    // Once the other process is done, the same write goes through.
    await stagePaths('s', repo.root, ['a.txt'])
    expect(repo.git('diff', '--cached', '--name-only').trim()).toBe('a.txt')
  })
})
