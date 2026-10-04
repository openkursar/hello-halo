/**
 * Which repositories a space has, and the gate every request passes.
 *
 * A space's repositories are its folder itself and its direct sub-folders that
 * hold a `.git` (a directory, or a file for worktrees and submodules). One
 * level only, symlinked folders not followed. A request may only name one of
 * these: validation re-derives the answer from the path in O(1) instead of
 * listing the folder again.
 */

import { lstat, readdir, readFile, stat } from 'fs/promises'
import { basename, dirname, join, resolve } from 'path'
import type { GitRepository, GitRepositoryList } from '../../../shared/types/git'
import { getSpaceDir } from '../space.service'
import { GitError } from './errors'
import { getGitAvailability, requireGitExecutable } from './locate'
import { parseRefLines, parseTrack, type BranchHeader } from './parse'
import { readText, type RepoContext } from './context'

/** Sub-folders examined for a `.git`; a folder with more is not a folder of projects. */
const MAX_CHILD_FOLDERS = 1_000
const DISCOVERY_CONCURRENCY = 32

function requireSpaceDir(spaceId: unknown): string {
  if (typeof spaceId !== 'string' || spaceId.length === 0) throw new GitError('GIT_INVALID_ARGUMENT', 'A space id is required')
  const dir = getSpaceDir(spaceId)
  if (!dir) throw new GitError('GIT_INVALID_ARGUMENT', `Unknown space: ${spaceId}`)
  return resolve(dir)
}

/** The git directory of a working tree, or null when it has none. */
async function resolveGitDir(root: string): Promise<string | null> {
  const dotGit = join(root, '.git')
  try {
    const info = await stat(dotGit)
    if (info.isDirectory()) return dotGit
    if (!info.isFile() || info.size > 4096) return null
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(dotGit, 'utf8'))
    return match ? resolve(root, match[1]) : null
  } catch {
    return null
  }
}

async function hasGitDir(dir: string): Promise<boolean> {
  try {
    const info = await stat(join(dir, '.git'))
    return info.isDirectory() || info.isFile()
  } catch {
    return false
  }
}

async function discoverRoots(spaceDir: string): Promise<string[]> {
  const roots: string[] = []
  if (await hasGitDir(spaceDir)) roots.push(spaceDir)

  let names: string[]
  try {
    names = (await readdir(spaceDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b))
  } catch (error) {
    console.warn(`[Git] Cannot list space folder ${spaceDir}:`, (error as Error).message)
    return roots
  }
  if (names.length > MAX_CHILD_FOLDERS) {
    console.warn(`[Git] Space folder ${spaceDir} has ${names.length} sub-folders; looking for repositories in the first ${MAX_CHILD_FOLDERS}`)
    names = names.slice(0, MAX_CHILD_FOLDERS)
  }
  for (let i = 0; i < names.length; i += DISCOVERY_CONCURRENCY) {
    const batch = names.slice(i, i + DISCOVERY_CONCURRENCY)
    const flags = await Promise.all(batch.map((name) => hasGitDir(join(spaceDir, name))))
    batch.forEach((name, j) => {
      if (flags[j]) roots.push(join(spaceDir, name))
    })
  }
  return roots
}

/**
 * Validate that `repoRoot` is a repository of the space and return the context
 * to run git in. Every request goes through here.
 */
export async function requireRepository(spaceId: unknown, repoRoot: unknown): Promise<RepoContext> {
  const spaceDir = requireSpaceDir(spaceId)
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) throw new GitError('GIT_INVALID_ARGUMENT', 'A repository root is required')
  const root = resolve(repoRoot)
  const notARepository = new GitError('GIT_NOT_A_REPOSITORY', `Not a repository of this space: ${repoRoot}`)

  if (root !== spaceDir) {
    if (dirname(root) !== spaceDir || basename(root).startsWith('.')) throw notARepository
    try {
      if (!(await lstat(root)).isDirectory()) throw notARepository
    } catch {
      throw notARepository
    }
  }
  const gitDir = await resolveGitDir(root)
  if (!gitDir) throw notARepository
  return { spaceDir, root, gitDir, git: await requireGitExecutable() }
}

function describe(ctx: RepoContext): Pick<GitRepository, 'root' | 'name' | 'relativePath'> {
  return {
    root: ctx.root,
    name: basename(ctx.root),
    relativePath: ctx.root === ctx.spaceDir ? '' : basename(ctx.root),
  }
}

/** HEAD's commit id, or null before the first commit. */
export async function readHead(ctx: RepoContext): Promise<string | null> {
  const oid = (await readText(ctx, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { okExitCodes: [0, 1] })).trim()
  return oid || null
}

/** Display form of a commit id. */
export function abbreviate(oid: string): string {
  return oid.slice(0, 7)
}

/** The repository summary from a `git status --branch` header. */
export function repositoryFromBranch(ctx: RepoContext, branch: BranchHeader): GitRepository {
  return {
    ...describe(ctx),
    branch: branch.head,
    head: branch.oid ? abbreviate(branch.oid) : null,
    unborn: branch.oid === null,
    upstream: branch.upstream,
    ahead: branch.ahead,
    behind: branch.behind,
  }
}

/**
 * Branch, head and upstream from refs alone — no working-tree scan, so listing
 * repositories costs the same in a huge repository as in a small one.
 */
export async function readRepositorySummary(ctx: RepoContext): Promise<GitRepository> {
  const symbolic = await readText(ctx, ['symbolic-ref', '-q', 'HEAD'], { okExitCodes: [0, 1] })
  const ref = symbolic.trim()
  if (!ref) {
    const oid = (await readText(ctx, ['rev-parse', '-q', '--verify', 'HEAD'], { okExitCodes: [0, 1] })).trim()
    return { ...describe(ctx), branch: null, head: oid ? abbreviate(oid) : null, unborn: !oid, upstream: null, ahead: 0, behind: 0 }
  }

  const lines = parseRefLines(
    await readText(ctx, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(upstream:track,nobracket)', ref]),
  )
  const line = lines.find(([name]) => name === ref)
  const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
  if (!line) {
    // The branch HEAD names has no commit yet.
    return { ...describe(ctx), branch, head: null, unborn: true, upstream: null, ahead: 0, behind: 0 }
  }
  const [, oid, upstream, track] = line
  return { ...describe(ctx), branch, head: abbreviate(oid), unborn: false, upstream: upstream || null, ...parseTrack(track ?? '') }
}

export async function listRepositories(spaceId: string): Promise<GitRepositoryList> {
  const spaceDir = requireSpaceDir(spaceId)
  const git = await getGitAvailability()
  if (!git.available) return { git, repositories: [] }
  const executable = await requireGitExecutable()

  const summaries = await Promise.all(
    (await discoverRoots(spaceDir)).map(async (root): Promise<GitRepository | null> => {
      const gitDir = await resolveGitDir(root)
      if (!gitDir) return null
      try {
        return await readRepositorySummary({ spaceDir, root, gitDir, git: executable })
      } catch (error) {
        console.warn(`[Git] Skipping repository ${root}: ${(error as Error).message.split('\n')[0]}`)
        return null
      }
    }),
  )
  return { git, repositories: summaries.filter((repo): repo is GitRepository => repo !== null) }
}

/** The validated repository with its current branch summary. */
export async function resolveRepository(spaceId: string, repoRoot: string): Promise<GitRepository> {
  return readRepositorySummary(await requireRepository(spaceId, repoRoot))
}
