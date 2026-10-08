/**
 * Compare-picker choices: recent refs of each kind (the current branch and
 * remote HEAD aliases left out), then recent commits, bounded in total.
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { rmSync } from 'fs'
import { join } from 'path'
import { listRevisionOptions } from '../../../../src/main/services/git'
import { GIT_LIMITS } from '../../../../src/shared/types/git'
import { cloneWithRemote, initRepo, isolateGit, makeTempDir } from './_repo'

const { spaces } = vi.hoisted(() => ({ spaces: new Map<string, string>() }))
vi.mock('../../../../src/main/services/space.service', () => ({
  getSpaceDir: (spaceId: string) => spaces.get(spaceId) ?? '',
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
  for (const cleanup of cleanups.splice(0)) cleanup()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('listRevisionOptions', () => {
  it('offers branches, remote branches, tags and recent commits', async () => {
    const dir = makeTempDir('halo-git-revisions-')
    dirs.push(dir)
    spaces.set('s', dir)
    const { repo, cleanup } = cloneWithRemote(join(dir, 'app'))
    cleanups.push(cleanup)
    repo.git('branch', 'release')
    repo.git('tag', '-a', 'v1.0', '-m', 'release 1.0')
    repo.write('a.txt', 'a\n')
    repo.commitAll('Second commit')

    const options = await listRevisionOptions('s', repo.root)
    expect(options.filter((option) => option.kind !== 'commit').map((option) => [option.kind, option.revision])).toEqual([
      ['branch', 'release'],
      ['remote-branch', 'origin/main'],
      ['tag', 'v1.0'],
    ])
    const commits = options.filter((option) => option.kind === 'commit')
    expect(commits.map((commit) => commit.subject)).toEqual(['Second commit', 'seed'])
    expect(commits[0].revision).toBe(repo.git('rev-parse', 'HEAD').trim())
    expect(commits[0].date).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(options.every((option) => option.date)).toBe(true)
  })

  // Builds its history with about 150 git processes, which outlasts the default
  // timeout when the suite runs in parallel.
  it('stays within the limit and copes with a branch that has no commits', async () => {
    const dir = makeTempDir('halo-git-revisions-')
    dirs.push(dir)
    spaces.set('s', dir)
    const repo = initRepo(dir)
    expect(await listRevisionOptions('s', dir)).toEqual([])

    for (let i = 0; i < 40; i++) {
      repo.write('n.txt', `${i}\n`)
      repo.commitAll(`commit ${i}`)
      if (i % 2 === 0) repo.git('branch', `topic-${i}`)
      if (i % 3 === 0) repo.git('tag', `t-${i}`)
    }
    const options = await listRevisionOptions('s', dir)
    expect(options.length).toBeLessThanOrEqual(GIT_LIMITS.maxRevisionOptions)
    expect(options.filter((option) => option.kind === 'branch')).toHaveLength(15)
    expect(options.filter((option) => option.kind === 'tag')).toHaveLength(5)
    expect(options.filter((option) => option.kind === 'commit')).toHaveLength(30)
    expect(options.some((option) => option.revision === 'main')).toBe(false)
  }, 60_000)
})
