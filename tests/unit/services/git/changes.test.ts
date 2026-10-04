/**
 * The four compare scopes against a real repository: what each one lists,
 * which before side it resolves to, and how it refuses bad input.
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { rmSync, unlinkSync } from 'fs'
import { join } from 'path'
import { createSnapshot, getChangeList } from '../../../../src/main/services/git'
import type { GitChangedFile } from '../../../../src/shared/types/git'
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
  const dir = makeTempDir('halo-git-changes-')
  dirs.push(dir)
  spaces.set('s', dir)
  return initRepo(dir)
}

const summary = (files: GitChangedFile[]) => files.map((file) => [file.state, file.path, file.oldPath ?? null])

/** base commit, then: staged rename, staged + unstaged edit, unstaged delete, untracked file. */
function workInProgress(repo: TestRepo): string {
  repo.write('a.txt', '1\n2\n')
  repo.write('old name.txt', 'x\ny\nz\nw\n')
  repo.write('del.txt', 'd\n')
  const head = repo.commitAll('base')
  repo.git('mv', 'old name.txt', 'new name.txt')
  repo.write('a.txt', '1\n2\n3\n')
  repo.git('add', 'a.txt')
  repo.write('a.txt', '1\n2\n3\n4\n')
  unlinkSync(join(repo.root, 'del.txt'))
  repo.write('fresh.txt', 'f1\nf2\n')
  return head
}

describe('getChangeList', () => {
  it('uncommitted: HEAD against the working tree, untracked files included', async () => {
    const repo = repoInSpace()
    const head = workInProgress(repo)
    const list = await getChangeList('s', repo.root, { kind: 'uncommitted' })
    expect(list.beforeRevision).toBe(head)
    expect(list.truncated).toBe(false)
    expect(summary(list.files)).toEqual([
      ['modified', 'a.txt', null],
      ['deleted', 'del.txt', null],
      ['untracked', 'fresh.txt', null],
      ['renamed', 'new name.txt', 'old name.txt'],
    ])
    expect(list.files.find((file) => file.path === 'a.txt')).toMatchObject({ additions: 2, deletions: 0 })
    expect(list.files.find((file) => file.path === 'fresh.txt')).toMatchObject({ additions: 2, deletions: 0, binary: false })
  })

  it('staged: HEAD against the index only', async () => {
    const repo = repoInSpace()
    const head = workInProgress(repo)
    const list = await getChangeList('s', repo.root, { kind: 'staged' })
    expect(list.beforeRevision).toBe(head)
    expect(summary(list.files)).toEqual([
      ['modified', 'a.txt', null],
      ['renamed', 'new name.txt', 'old name.txt'],
    ])
    expect(list.files[0]).toMatchObject({ additions: 1, deletions: 0 })
  })

  it('before the first commit, compares with nothing', async () => {
    const repo = repoInSpace()
    repo.write('staged.txt', 's\n')
    repo.git('add', 'staged.txt')
    repo.write('loose.txt', 'l\n')
    const uncommitted = await getChangeList('s', repo.root, { kind: 'uncommitted' })
    expect(uncommitted.beforeRevision).toBeNull()
    expect(summary(uncommitted.files)).toEqual([
      ['untracked', 'loose.txt', null],
      ['added', 'staged.txt', null],
    ])
    expect(summary((await getChangeList('s', repo.root, { kind: 'staged' })).files)).toEqual([['added', 'staged.txt', null]])
  })

  it('revision: from where the branch forked, or from the revision itself', async () => {
    const repo = repoInSpace()
    repo.write('shared.txt', 'base\n')
    const fork = repo.commitAll('base')
    repo.git('checkout', '-q', '-b', 'feature')
    repo.write('feature.txt', 'f\n')
    repo.commitAll('feature work')
    repo.git('checkout', '-q', 'main')
    repo.write('shared.txt', 'main moved on\n')
    const mainTip = repo.commitAll('main work')
    repo.git('checkout', '-q', 'feature')
    repo.write('wip.txt', 'w\n')

    const forked = await getChangeList('s', repo.root, { kind: 'revision', revision: 'main', mergeBase: true })
    expect(forked.beforeRevision).toBe(fork)
    expect(summary(forked.files)).toEqual([
      ['added', 'feature.txt', null],
      ['untracked', 'wip.txt', null],
    ])

    const direct = await getChangeList('s', repo.root, { kind: 'revision', revision: 'main', mergeBase: false })
    expect(direct.beforeRevision).toBe(mainTip)
    expect(summary(direct.files)).toEqual([
      ['added', 'feature.txt', null],
      ['modified', 'shared.txt', null],
      ['untracked', 'wip.txt', null],
    ])
  })

  it('since-review: the snapshot against the working tree now', async () => {
    const repo = repoInSpace()
    repo.write('keep.txt', 'k\n')
    repo.write('edit.txt', 'e\n')
    repo.write('drop.txt', 'd\n')
    repo.commitAll('base')
    repo.write('untracked-before.txt', 'u\n')
    const snapshot = await createSnapshot('s', repo.root)

    repo.write('edit.txt', 'e\ne2\n')
    unlinkSync(join(repo.root, 'drop.txt'))
    repo.write('untracked-after.txt', 'n\n')
    const list = await getChangeList('s', repo.root, { kind: 'since-review', snapshot: snapshot.tree })
    expect(list.beforeRevision).toBe(snapshot.tree)
    expect(summary(list.files)).toEqual([
      ['deleted', 'drop.txt', null],
      ['modified', 'edit.txt', null],
      ['added', 'untracked-after.txt', null],
    ])
  })

  it('marks unmerged paths as conflicted', async () => {
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
    const list = await getChangeList('s', repo.root, { kind: 'uncommitted' })
    expect(summary(list.files)).toEqual([['conflicted', 'c.txt', null]])
  })

  it('refuses unknown revisions, malformed scopes and pruned snapshots', async () => {
    const repo = repoInSpace()
    repo.write('a.txt', 'a\n')
    repo.commitAll('base')
    await expect(getChangeList('s', repo.root, { kind: 'revision', revision: 'no-such-branch', mergeBase: true })).rejects.toMatchObject({ code: 'GIT_REVISION_NOT_FOUND' })
    await expect(getChangeList('s', repo.root, { kind: 'revision', revision: '--output=/tmp/x', mergeBase: false })).rejects.toMatchObject({ code: 'GIT_INVALID_ARGUMENT' })
    await expect(getChangeList('s', repo.root, { kind: 'since-review', snapshot: 'HEAD' })).rejects.toMatchObject({ code: 'GIT_INVALID_ARGUMENT' })
    await expect(getChangeList('s', repo.root, { kind: 'since-review', snapshot: 'a'.repeat(40) })).rejects.toMatchObject({ code: 'GIT_SNAPSHOT_MISSING' })
    await expect(getChangeList('s', repo.root, { kind: 'everything' } as never)).rejects.toMatchObject({ code: 'GIT_INVALID_ARGUMENT' })
  })

  it('flags files .gitattributes marks generated', async () => {
    const repo = repoInSpace()
    repo.write('.gitattributes', '*.lock.json linguist-generated=true\n')
    repo.commitAll('attrs')
    repo.write('deps.lock.json', '{}\n')
    repo.write('src.ts', 'x\n')
    const files = (await getChangeList('s', repo.root, { kind: 'uncommitted' })).files
    expect(files.find((file) => file.path === 'deps.lock.json')?.generated).toBe(true)
    expect(files.find((file) => file.path === 'src.ts')?.generated).toBeUndefined()
  })
})
