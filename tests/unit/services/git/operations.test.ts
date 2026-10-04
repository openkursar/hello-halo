/**
 * Writes against real repositories and a local bare remote (no network):
 * stage / unstage / discard (untracked files go to the trash), commit and
 * amend, push and sync, and the error codes the UI branches on.
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { chmodSync, existsSync, readFileSync, rmSync, unlinkSync } from 'fs'
import { join } from 'path'
import {
  commitChanges,
  discardPaths,
  getWorkingTreeStatus,
  stagePaths,
  syncBranch,
  unstagePaths,
} from '../../../../src/main/services/git'
import { cloneWithRemote, initRepo, isolateGit, makeTempDir, openRepo, type TestRepo } from './_repo'

const { spaces, trashed } = vi.hoisted(() => ({ spaces: new Map<string, string>(), trashed: [] as string[] }))
vi.mock('../../../../src/main/services/space.service', () => ({
  getSpaceDir: (spaceId: string) => spaces.get(spaceId) ?? '',
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent' },
  shell: {
    trashItem: async (path: string) => {
      trashed.push(path)
      rmSync(path, { force: true })
    },
  },
}))

let restoreGit: () => void
const dirs: string[] = []
const cleanups: Array<() => void> = []

beforeAll(() => {
  restoreGit = isolateGit()
})
afterAll(() => restoreGit())
afterEach(() => {
  spaces.clear()
  trashed.length = 0
  for (const cleanup of cleanups.splice(0)) cleanup()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function spaceDir(): string {
  const dir = makeTempDir('halo-git-ops-')
  dirs.push(dir)
  spaces.set('s', dir)
  return dir
}

function repoInSpace(): TestRepo {
  return initRepo(spaceDir())
}

/** A clone of a bare remote, as a repository of the space. */
function clonedInSpace(): { repo: TestRepo; remote: string; other: TestRepo } {
  const { remote, repo, cleanup } = cloneWithRemote(join(spaceDir(), 'app'))
  cleanups.push(cleanup)
  const other = openRepo(makeTempDir('halo-git-other-'))
  dirs.push(other.root)
  execFileSync('git', ['clone', '-q', remote, other.root], { stdio: 'ignore' })
  return { repo, remote, other }
}

const paths = async (repo: TestRepo) => {
  const status = await getWorkingTreeStatus('s', repo.root)
  return { staged: status.staged.map((f) => `${f.state}:${f.path}`), unstaged: status.unstaged.map((f) => `${f.state}:${f.path}`) }
}

describe('stage and unstage', () => {
  it('stages modifications, deletions and new files; unstages them again', async () => {
    const repo = repoInSpace()
    repo.write('mod.txt', 'a\n')
    repo.write('del.txt', 'd\n')
    repo.commitAll('base')
    repo.write('mod.txt', 'b\n')
    unlinkSync(join(repo.root, 'del.txt'))
    repo.write('new file.txt', 'n\n')

    await stagePaths('s', repo.root, ['mod.txt', 'del.txt', 'new file.txt'])
    expect(await paths(repo)).toEqual({ staged: ['deleted:del.txt', 'modified:mod.txt', 'added:new file.txt'], unstaged: [] })

    // Staging an already staged deletion again is not an error.
    await stagePaths('s', repo.root, ['del.txt'])

    await unstagePaths('s', repo.root, ['mod.txt', 'del.txt', 'new file.txt', 'never-existed.txt'])
    expect(await paths(repo)).toEqual({ staged: [], unstaged: ['deleted:del.txt', 'modified:mod.txt', 'untracked:new file.txt'] })
  })

  it('unstages a rename when given both paths, and works before the first commit', async () => {
    const repo = repoInSpace()
    repo.write('first.txt', 'f\n')
    repo.git('add', 'first.txt')
    await unstagePaths('s', repo.root, ['first.txt'])
    expect((await paths(repo)).staged).toEqual([])

    repo.commitAll('base')
    repo.git('mv', 'first.txt', 'second.txt')
    expect((await paths(repo)).staged).toEqual(['renamed:second.txt'])
    await unstagePaths('s', repo.root, ['second.txt', 'first.txt'])
    expect(await paths(repo)).toEqual({ staged: [], unstaged: ['deleted:first.txt', 'untracked:second.txt'] })
  })

  it('refuses paths outside the repository', async () => {
    const repo = repoInSpace()
    await expect(stagePaths('s', repo.root, ['../escape.txt'])).rejects.toMatchObject({ code: 'GIT_INVALID_ARGUMENT' })
    await expect(stagePaths('s', repo.root, [])).rejects.toMatchObject({ code: 'GIT_INVALID_ARGUMENT' })
  })
})

describe('discard', () => {
  it('restores tracked files from the index and moves untracked ones to the trash', async () => {
    const repo = repoInSpace()
    repo.write('.gitignore', '*.log\n')
    repo.write('tracked.txt', 'v1\n')
    repo.write('gone.txt', 'g\n')
    repo.commitAll('base')
    repo.write('tracked.txt', 'v2 staged\n')
    repo.git('add', 'tracked.txt')
    repo.write('tracked.txt', 'v3 unstaged\n')
    unlinkSync(join(repo.root, 'gone.txt'))
    repo.write('scratch.txt', 's\n')
    repo.write('debug.log', 'ignored\n')

    await discardPaths('s', repo.root, ['tracked.txt', 'gone.txt', 'scratch.txt', 'debug.log', 'no-such-file.txt'])

    expect(readFileSync(join(repo.root, 'tracked.txt'), 'utf8')).toBe('v2 staged\n')
    expect(readFileSync(join(repo.root, 'gone.txt'), 'utf8')).toBe('g\n')
    expect(trashed).toEqual([join(repo.root, 'scratch.txt')])
    expect(existsSync(join(repo.root, 'debug.log'))).toBe(true)
    expect(await paths(repo)).toEqual({ staged: ['modified:tracked.txt'], unstaged: [] })
  })

  it('never trashes a nested repository or a directory', async () => {
    const repo = repoInSpace()
    repo.write('a.txt', 'a\n')
    repo.commitAll('base')
    initRepo(join(repo.root, 'nested'))
    repo.write('dir/inside.txt', 'i\n')
    await discardPaths('s', repo.root, ['nested', 'dir'])
    expect(trashed).toEqual([])
    expect(existsSync(join(repo.root, 'nested', '.git'))).toBe(true)
    expect(existsSync(join(repo.root, 'dir', 'inside.txt'))).toBe(true)
  })

  it('refuses conflicted paths', async () => {
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
    await expect(discardPaths('s', repo.root, ['c.txt'])).rejects.toMatchObject({ code: 'GIT_CONFLICTED' })
  })
})

describe('commit', () => {
  it('commits the index; amend without a message keeps the previous one', async () => {
    const repo = repoInSpace()
    repo.write('a.txt', 'a\n')
    repo.git('add', 'a.txt')
    const result = await commitChanges('s', repo.root, { message: 'Add a\n\nBody line', amend: false, push: false })
    expect(result).toEqual({ commit: repo.git('rev-parse', 'HEAD').trim().slice(0, 7), pushed: false })
    expect(repo.git('log', '-1', '--format=%B').trim()).toBe('Add a\n\nBody line')

    repo.write('b.txt', 'b\n')
    repo.git('add', 'b.txt')
    await commitChanges('s', repo.root, { message: '', amend: true, push: false })
    expect(repo.git('log', '--format=%s').trim().split('\n')).toEqual(['Add a'])
    expect(repo.git('show', '--name-only', '--format=', 'HEAD').trim().split('\n')).toEqual(['a.txt', 'b.txt'])

    await commitChanges('s', repo.root, { message: 'Add a and b', amend: true, push: false })
    expect(repo.git('log', '--format=%s').trim().split('\n')).toEqual(['Add a and b'])
  })

  it('reports an empty message, an empty index and a refusing hook', async () => {
    const repo = repoInSpace()
    repo.write('a.txt', 'a\n')
    repo.commitAll('base')
    await expect(commitChanges('s', repo.root, { message: '  \n', amend: false, push: false })).rejects.toMatchObject({ code: 'GIT_EMPTY_MESSAGE' })
    await expect(commitChanges('s', repo.root, { message: 'nothing', amend: false, push: false })).rejects.toMatchObject({ code: 'GIT_NOTHING_TO_COMMIT' })

    repo.write('.git/hooks/pre-commit', '#!/bin/sh\necho "lint: src/x.ts:3 unused variable" >&2\nexit 1\n')
    chmodSync(join(repo.root, '.git', 'hooks', 'pre-commit'), 0o755)
    repo.write('a.txt', 'a2\n')
    repo.git('add', 'a.txt')
    const refusal = commitChanges('s', repo.root, { message: 'blocked', amend: false, push: false })
    await expect(refusal).rejects.toMatchObject({ code: 'GIT_HOOK_FAILED' })
    await expect(refusal).rejects.toThrow(/unused variable/)
  })

  it('pushes after committing, and reports a rejected push without failing the commit', async () => {
    const { repo, remote, other } = clonedInSpace()
    repo.write('a.txt', 'a\n')
    repo.git('add', 'a.txt')
    const pushed = await commitChanges('s', repo.root, { message: 'pushed', amend: false, push: true })
    expect(pushed.pushed).toBe(true)
    expect(execFileSync('git', ['log', '-1', '--format=%s', 'main'], { cwd: remote, encoding: 'utf8' }).trim()).toBe('pushed')

    other.git('pull', '-q', '--ff-only')
    other.write('o.txt', 'o\n')
    other.commitAll('from elsewhere')
    other.git('push', '-q', 'origin', 'HEAD:main')
    repo.write('b.txt', 'b\n')
    repo.git('add', 'b.txt')
    const rejected = await commitChanges('s', repo.root, { message: 'too late', amend: false, push: true })
    expect(rejected).toMatchObject({ pushed: false, pushErrorCode: 'GIT_PUSH_REJECTED' })
    expect(repo.git('log', '-1', '--format=%s').trim()).toBe('too late')
  })
})

describe('sync', () => {
  it('fast-forwards from the upstream, then pushes local commits', async () => {
    const { repo, remote, other } = clonedInSpace()
    other.write('o.txt', 'o\n')
    other.commitAll('remote work')
    other.git('push', '-q', 'origin', 'HEAD:main')
    repo.git('fetch', '-q')
    repo.write('l.txt', 'l\n')
    repo.git('add', 'l.txt')

    // Behind by one and nothing local yet: pull only.
    const pulled = await syncBranch('s', repo.root)
    expect(pulled).toMatchObject({ pulled: 1, pushed: 0, repo: { ahead: 0, behind: 0 } })

    repo.commitAll('local work')
    const pushed = await syncBranch('s', repo.root)
    expect(pushed).toMatchObject({ pulled: 0, pushed: 1, repo: { ahead: 0, behind: 0 } })
    expect(execFileSync('git', ['log', '-1', '--format=%s', 'main'], { cwd: remote, encoding: 'utf8' }).trim()).toBe('local work')
  })

  it('reports a diverged branch as needing a merge', async () => {
    const { repo, other } = clonedInSpace()
    other.write('o.txt', 'o\n')
    other.commitAll('remote work')
    other.git('push', '-q', 'origin', 'HEAD:main')
    repo.write('l.txt', 'l\n')
    repo.commitAll('local work')
    await expect(syncBranch('s', repo.root)).rejects.toMatchObject({ code: 'GIT_NEEDS_MERGE' })
  })

  it('publishes a branch without an upstream', async () => {
    const { repo, remote } = clonedInSpace()
    repo.git('checkout', '-q', '-b', 'feature')
    repo.write('f.txt', 'f\n')
    repo.commitAll('feature work')
    const result = await syncBranch('s', repo.root)
    expect(result).toMatchObject({ pulled: 0, pushed: 1, repo: { branch: 'feature', upstream: 'origin/feature' } })
    expect(execFileSync('git', ['log', '-1', '--format=%s', 'feature'], { cwd: remote, encoding: 'utf8' }).trim()).toBe('feature work')
  })

  it('reports a missing remote and a detached HEAD', async () => {
    const repo = repoInSpace()
    repo.write('a.txt', 'a\n')
    const first = repo.commitAll('base')
    await expect(syncBranch('s', repo.root)).rejects.toMatchObject({ code: 'GIT_NO_REMOTE' })
    repo.git('checkout', '-q', first)
    await expect(syncBranch('s', repo.root)).rejects.toMatchObject({ code: 'GIT_DETACHED_HEAD' })
  })
})
