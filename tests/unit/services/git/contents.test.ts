/**
 * Both sides of a file per scope: the before blob from the list's revision,
 * the after side from the index or the working tree; binary and oversized
 * sides reduced to sizes; nothing outside the working tree served.
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createSnapshot, getChangeList, readFileContents } from '../../../../src/main/services/git'
import { GIT_LIMITS, type GitCompareScope } from '../../../../src/shared/types/git'
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
  const dir = makeTempDir('halo-git-contents-')
  dirs.push(dir)
  spaces.set('s', dir)
  return initRepo(dir)
}

async function contentsOf(repo: TestRepo, scope: GitCompareScope, path: string, oldPath?: string) {
  const list = await getChangeList('s', repo.root, scope)
  return readFileContents('s', repo.root, { scope, beforeRevision: list.beforeRevision, path, oldPath })
}

describe('readFileContents', () => {
  it('reads HEAD and the working tree for uncommitted changes', async () => {
    const repo = repoInSpace()
    repo.write('a.txt', 'old\n')
    repo.write('gone.txt', 'bye\n')
    repo.commitAll('base')
    repo.write('a.txt', 'new\n')
    repo.write('added.txt', 'hello\n')
    unlinkSync(join(repo.root, 'gone.txt'))
    const scope = { kind: 'uncommitted' } as const

    expect(await contentsOf(repo, scope, 'a.txt')).toEqual({
      path: 'a.txt', before: 'old\n', after: 'new\n', binary: false, tooLarge: false, beforeBytes: 4, afterBytes: 4,
    })
    expect(await contentsOf(repo, scope, 'added.txt')).toEqual({
      path: 'added.txt', before: null, after: 'hello\n', binary: false, tooLarge: false, afterBytes: 6,
    })
    expect(await contentsOf(repo, scope, 'gone.txt')).toEqual({
      path: 'gone.txt', before: 'bye\n', after: null, binary: false, tooLarge: false, beforeBytes: 4,
    })
  })

  it('reads the old path of a rename and the index for staged changes', async () => {
    const repo = repoInSpace()
    repo.write('before.txt', 'v1\n')
    repo.commitAll('base')
    repo.git('mv', 'before.txt', 'after.txt')
    repo.write('after.txt', 'v2\n')
    repo.git('add', 'after.txt')
    repo.write('after.txt', 'v3 not staged\n')

    const staged = await contentsOf(repo, { kind: 'staged' }, 'after.txt', 'before.txt')
    expect(staged).toMatchObject({ path: 'after.txt', oldPath: 'before.txt', before: 'v1\n', after: 'v2\n' })
    const uncommitted = await contentsOf(repo, { kind: 'uncommitted' }, 'after.txt', 'before.txt')
    expect(uncommitted).toMatchObject({ before: 'v1\n', after: 'v3 not staged\n' })
  })

  it('reads the snapshot for since-review and reports a pruned one', async () => {
    const repo = repoInSpace()
    repo.write('a.txt', 'committed\n')
    repo.commitAll('base')
    repo.write('a.txt', 'at review\n')
    const snapshot = await createSnapshot('s', repo.root)
    repo.write('a.txt', 'fixed after review\n')
    const scope = { kind: 'since-review', snapshot: snapshot.tree } as const
    expect(await contentsOf(repo, scope, 'a.txt')).toMatchObject({ before: 'at review\n', after: 'fixed after review\n' })
    await expect(
      readFileContents('s', repo.root, { scope: { kind: 'since-review', snapshot: 'b'.repeat(40) }, beforeRevision: 'b'.repeat(40), path: 'a.txt' }),
    ).rejects.toMatchObject({ code: 'GIT_SNAPSHOT_MISSING' })
  })

  it('reduces binary and oversized sides to their sizes', async () => {
    const repo = repoInSpace()
    repo.write('img.bin', Buffer.from([1, 2, 0, 3]))
    repo.write('big.txt', 'small\n')
    repo.commitAll('base')
    repo.write('img.bin', Buffer.from([1, 2, 0, 3, 4]))
    repo.write('big.txt', 'x'.repeat(GIT_LIMITS.maxFileBytes + 1))
    const scope = { kind: 'uncommitted' } as const

    expect(await contentsOf(repo, scope, 'img.bin')).toEqual({
      path: 'img.bin', before: null, after: null, binary: true, tooLarge: false, beforeBytes: 4, afterBytes: 5,
    })
    expect(await contentsOf(repo, scope, 'big.txt')).toEqual({
      path: 'big.txt', before: null, after: null, binary: false, tooLarge: true, beforeBytes: 6, afterBytes: GIT_LIMITS.maxFileBytes + 1,
    })
    repo.git('add', 'big.txt')
    expect(await contentsOf(repo, { kind: 'staged' }, 'big.txt')).toMatchObject({ tooLarge: true, afterBytes: GIT_LIMITS.maxFileBytes + 1 })
  })

  it('reads names literally and symlinks as their target text', async () => {
    const repo = repoInSpace()
    repo.write('a*b.txt', 'star\n')
    repo.write('axb.txt', 'plain\n')
    repo.write('[x].ts', 'bracket\n')
    repo.commitAll('base')
    repo.write('a*b.txt', 'star 2\n')
    symlinkSync('a*b.txt', join(repo.root, 'link.txt'))
    const scope = { kind: 'uncommitted' } as const
    expect(await contentsOf(repo, scope, 'a*b.txt')).toMatchObject({ before: 'star\n', after: 'star 2\n' })
    expect(await contentsOf(repo, scope, '[x].ts')).toMatchObject({ before: 'bracket\n', after: 'bracket\n' })
    expect(await contentsOf(repo, scope, 'link.txt')).toMatchObject({ before: null, after: 'a*b.txt' })
  })

  it('serves nothing outside the working tree', async () => {
    const repo = repoInSpace()
    repo.write('a.txt', 'a\n')
    repo.commitAll('base')
    const outside = makeTempDir()
    dirs.push(outside)
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    mkdirSync(join(repo.root, 'sub'))
    symlinkSync(outside, join(repo.root, 'sub', 'escape'))
    const scope = { kind: 'uncommitted' } as const
    const head = (await getChangeList('s', repo.root, scope)).beforeRevision

    for (const path of ['../a.txt', '/etc/passwd', '.git/config', 'sub/escape/secret.txt']) {
      await expect(readFileContents('s', repo.root, { scope, beforeRevision: head, path })).rejects.toMatchObject({ code: 'GIT_INVALID_ARGUMENT' })
    }
    await expect(readFileContents('s', repo.root, { scope, beforeRevision: 'HEAD', path: 'a.txt' })).rejects.toMatchObject({ code: 'GIT_INVALID_ARGUMENT' })
  })

  it('refuses a malformed request before anything else, so it never waits for a turn to read', async () => {
    const repo = repoInSpace()
    const missing = join(repo.root, 'not-a-repository')
    const bad = { scope: { kind: 'bogus' }, beforeRevision: null, path: 'a.txt' } as unknown as Parameters<typeof readFileContents>[2]
    // The repository check (and the line of reads after it) would answer GIT_NOT_A_REPOSITORY.
    await expect(readFileContents('s', missing, bad)).rejects.toMatchObject({ code: 'GIT_INVALID_ARGUMENT' })
    await expect(readFileContents('s', missing, { scope: { kind: 'uncommitted' }, beforeRevision: null, path: 'a.txt' }))
      .rejects.toMatchObject({ code: 'GIT_NOT_A_REPOSITORY' })
  })
})
