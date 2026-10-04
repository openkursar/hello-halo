/**
 * A space's repositories are its folder and its direct sub-folders with a
 * `.git`; a request may name only those. Summaries come from refs alone.
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, symlinkSync } from 'fs'
import { join } from 'path'
import { listRepositories, resolveRepository } from '../../../../src/main/services/git'
import { cloneWithRemote, initRepo, isolateGit, makeTempDir, openRepo } from './_repo'

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

function space(): string {
  const dir = makeTempDir('halo-git-space-')
  dirs.push(dir)
  spaces.set('space-1', dir)
  return dir
}

describe('listRepositories', () => {
  it('lists the space folder first, then direct sub-folders with a .git by name', async () => {
    const dir = space()
    initRepo(dir)
    initRepo(join(dir, 'beta'))
    const alpha = initRepo(join(dir, 'alpha'))
    alpha.write('a.txt', 'a\n')
    alpha.commitAll('a')
    alpha.git('worktree', 'add', '-q', '-b', 'wt-branch', join(dir, 'wt'))
    initRepo(join(dir, '.hidden'))
    initRepo(join(dir, 'deep', 'grandchild'))
    mkdirSync(join(dir, 'plain'))
    symlinkSync(join(dir, 'alpha'), join(dir, 'linked'))

    const list = await listRepositories('space-1')
    expect(list.git.available).toBe(true)
    expect(list.repositories.map((repo) => repo.relativePath)).toEqual(['', 'alpha', 'beta', 'wt'])
    expect(list.repositories[0]).toMatchObject({ root: dir, relativePath: '', branch: 'main', unborn: true, head: null })
    expect(list.repositories[1]).toMatchObject({ name: 'alpha', branch: 'main', unborn: false, upstream: null, ahead: 0, behind: 0 })
    expect(list.repositories[1].head).toMatch(/^[0-9a-f]{7}$/)
    expect(list.repositories[3]).toMatchObject({ name: 'wt', branch: 'wt-branch', unborn: false })
  })

  it('returns no repositories for a space folder without any', async () => {
    const dir = space()
    mkdirSync(join(dir, 'docs'))
    expect((await listRepositories('space-1')).repositories).toEqual([])
  })

  it('refuses an unknown space', async () => {
    await expect(listRepositories('nope')).rejects.toMatchObject({ code: 'GIT_INVALID_ARGUMENT' })
  })
})

describe('resolveRepository', () => {
  it('reads upstream and ahead / behind from local refs only', async () => {
    const dir = space()
    const { remote, repo, cleanup } = cloneWithRemote(join(dir, 'app'))
    try {
      const other = openRepo(makeTempDir('halo-git-other-'))
      dirs.push(other.root)
      execFileSync('git', ['clone', '-q', remote, other.root], { stdio: 'ignore' })
      other.write('c.txt', 'c\n')
      other.commitAll('remote 1')
      other.write('d.txt', 'd\n')
      other.commitAll('remote 2')
      other.git('push', '-q', 'origin', 'main')

      repo.write('b.txt', 'b\n')
      repo.commitAll('local')
      repo.git('fetch', '-q', 'origin')

      expect(await resolveRepository('space-1', repo.root)).toMatchObject({
        name: 'app',
        relativePath: 'app',
        branch: 'main',
        upstream: 'origin/main',
        ahead: 1,
        behind: 2,
        unborn: false,
      })
    } finally {
      cleanup()
    }
  })

  it('reports a detached HEAD with its commit', async () => {
    const dir = space()
    const repo = initRepo(dir)
    repo.write('a.txt', 'a\n')
    const first = repo.commitAll('first')
    repo.write('a.txt', 'b\n')
    repo.commitAll('second')
    repo.git('checkout', '-q', first)
    expect(await resolveRepository('space-1', dir)).toMatchObject({ branch: null, head: first.slice(0, 7), unborn: false })
  })

  it('refuses anything that is not a repository of the space', async () => {
    const dir = space()
    initRepo(join(dir, 'deep', 'grandchild'))
    mkdirSync(join(dir, 'plain'))
    initRepo(join(dir, '.hidden'))
    const elsewhere = makeTempDir()
    dirs.push(elsewhere)
    initRepo(elsewhere)

    for (const root of [join(dir, 'deep', 'grandchild'), join(dir, 'plain'), join(dir, '.hidden'), elsewhere, dir]) {
      await expect(resolveRepository('space-1', root)).rejects.toMatchObject({ code: 'GIT_NOT_A_REPOSITORY' })
    }
    await expect(resolveRepository('space-1', '')).rejects.toMatchObject({ code: 'GIT_INVALID_ARGUMENT' })
  })
})
