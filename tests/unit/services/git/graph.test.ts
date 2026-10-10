/**
 * The commit graph against a real repository: topo order, parents, refs at
 * branch heads and tags, filters, page boundaries and bad-query refusal.
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { getCommitGraph } from '../../../../src/main/services/git'
import { initRepo, isolateGit, makeTempDir, removeRepoDir, type TestRepo } from './_repo'

// A small page makes the page boundary testable without hundreds of commits.
vi.mock('../../../../src/shared/types/git', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, GIT_LIMITS: { ...(actual.GIT_LIMITS as object), maxGraphCommits: 3 } }
})

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
  for (const dir of dirs.splice(0)) removeRepoDir(dir)
})

function repoInSpace(): TestRepo {
  const dir = makeTempDir('halo-git-graph-')
  dirs.push(dir)
  spaces.set('s', dir)
  return initRepo(dir)
}

function emptyCommit(repo: TestRepo, message: string, ...extra: string[]): string {
  repo.git('commit', '--allow-empty', '-q', '-m', message, ...extra)
  return repo.git('rev-parse', 'HEAD').trim()
}

/** main and feature each move once off a shared root; main merges feature. */
function forkAndMerge(repo: TestRepo): { root: string; mainTip: string; featureTip: string; mergeTip: string } {
  const root = emptyCommit(repo, 'root')
  repo.git('checkout', '-q', '-b', 'feature')
  const featureTip = emptyCommit(repo, 'feature work')
  repo.git('checkout', '-q', 'main')
  const mainTip = emptyCommit(repo, 'main work')
  repo.git('merge', '-q', '--no-edit', 'feature')
  const mergeTip = repo.git('rev-parse', 'HEAD').trim()
  return { root, mainTip, featureTip, mergeTip }
}

describe('getCommitGraph', () => {
  it('lists history newest first with parents, and truncates long subjects', async () => {
    const repo = repoInSpace()
    const root = emptyCommit(repo, 'root')
    const tip = emptyCommit(repo, 'a'.repeat(250))
    const graph = await getCommitGraph('s', repo.root, {})
    expect(graph.commits.map((c) => c.oid)).toEqual([tip, root])
    expect(graph.commits[0]).toMatchObject({ shortOid: tip.slice(0, 7), parents: [root], author: 'Halo Test', subject: 'a'.repeat(200) })
    expect(graph.commits[1].parents).toEqual([])
    expect(graph.commits[0].date).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(graph.more).toBe(false)
  }, 30_000)

  it('names branch heads and dereferenced tags at their commits', async () => {
    const repo = repoInSpace()
    const root = emptyCommit(repo, 'root')
    const tip = emptyCommit(repo, 'tip')
    repo.git('branch', 'dev')
    repo.git('tag', '-a', '-m', 'release', 'v1', root)
    const graph = await getCommitGraph('s', repo.root, {})
    expect(graph.commits.find((c) => c.oid === tip)?.refs).toEqual(expect.arrayContaining(['dev', 'main']))
    // The annotated tag object dereferences to the commit it names.
    expect(graph.commits.find((c) => c.oid === root)?.refs).toEqual(['v1'])
  }, 30_000)

  it('walks every branch by default, one branch when asked', async () => {
    const repo = repoInSpace()
    forkAndMerge(repo)
    repo.git('checkout', '-q', '-b', 'solo')
    emptyCommit(repo, 'solo work')
    // The first page holds three of the five commits; both branch tips show.
    const all = await getCommitGraph('s', repo.root, {})
    expect(all.more).toBe(true)
    expect(all.commits.map((c) => c.subject)).toContain('solo work')

    const onMain = await getCommitGraph('s', repo.root, { branch: 'main' })
    const subjects = onMain.commits.map((c) => c.subject)
    expect(subjects).toEqual(expect.arrayContaining(['main work', "Merge branch 'feature'"]))
    // The filter keeps the merged-in feature history but drops the other tip.
    expect(subjects).not.toContain('solo work')
    // The busiest setup in the suite: the most git spawns, so the most time.
  }, 60_000)

  it('keeps merge parents in topo order', async () => {
    const repo = repoInSpace()
    const { mainTip, featureTip, mergeTip } = forkAndMerge(repo)
    const graph = await getCommitGraph('s', repo.root, {})
    const merge = graph.commits[0]
    expect(merge.oid).toBe(mergeTip)
    expect(merge.parents).toEqual([mainTip, featureTip])
    // Topo order: every loaded commit sits before its parents. The page cuts
    // before the root, whose lane simply continues past the last row.
    const at = new Map(graph.commits.map((c) => [c.oid, graph.commits.indexOf(c)]))
    for (const commit of graph.commits) {
      for (const parent of commit.parents) {
        const atParent = at.get(parent)
        if (atParent !== undefined) expect(atParent).toBeGreaterThan(at.get(commit.oid)!)
      }
    }
  }, 30_000)

  it('filters by author and by message, case-insensitive substrings', async () => {
    const repo = repoInSpace()
    emptyCommit(repo, 'root')
    emptyCommit(repo, 'by ada', '--author=Ada Lovelace <ada@calc.invalid>')
    emptyCommit(repo, 'fix bug')
    const byAuthor = await getCommitGraph('s', repo.root, { author: 'ADA' })
    expect(byAuthor.commits.map((c) => c.subject)).toEqual(['by ada'])
    const byMessage = await getCommitGraph('s', repo.root, { message: 'BUG' })
    expect(byMessage.commits.map((c) => c.subject)).toEqual(['fix bug'])
  }, 30_000)

  it('pages with skip and flags a full page with more', async () => {
    const repo = repoInSpace()
    for (let i = 0; i < 4; i++) emptyCommit(repo, `c${i}`)
    const firstPage = await getCommitGraph('s', repo.root, {})
    expect(firstPage.commits).toHaveLength(3)
    expect(firstPage.more).toBe(true)
    const secondPage = await getCommitGraph('s', repo.root, { skip: 3 })
    expect(secondPage.commits.map((c) => c.subject)).toEqual(['c0'])
    expect(secondPage.more).toBe(false)
    const pastEnd = await getCommitGraph('s', repo.root, { skip: 10 })
    expect(pastEnd.commits).toEqual([])
    expect(pastEnd.more).toBe(false)
  }, 30_000)

  it('an unborn repository has an empty graph, not an error', async () => {
    const repo = repoInSpace()
    await expect(getCommitGraph('s', repo.root, {})).resolves.toEqual({ commits: [], more: false })
  }, 30_000)

  it('refuses bad queries', async () => {
    const repo = repoInSpace()
    emptyCommit(repo, 'root')
    await expect(getCommitGraph('s', repo.root, { branch: 'no-such-branch' })).rejects.toMatchObject({ code: 'GIT_REVISION_NOT_FOUND' })
    await expect(getCommitGraph('s', repo.root, { branch: '--output=/tmp/x' })).rejects.toMatchObject({ code: 'GIT_INVALID_ARGUMENT' })
    await expect(getCommitGraph('s', repo.root, { author: 'a'.repeat(201) })).rejects.toMatchObject({ code: 'GIT_INVALID_ARGUMENT' })
    await expect(getCommitGraph('s', repo.root, { message: 7 as never })).rejects.toMatchObject({ code: 'GIT_INVALID_ARGUMENT' })
    await expect(getCommitGraph('s', repo.root, { skip: -1 })).rejects.toMatchObject({ code: 'GIT_INVALID_ARGUMENT' })
    await expect(getCommitGraph('s', repo.root, { skip: 1.5 })).rejects.toMatchObject({ code: 'GIT_INVALID_ARGUMENT' })
  }, 30_000)
})
