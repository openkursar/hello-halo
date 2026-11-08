/** Space repositories: shallow discovery, explicit roots, and opened-file probes. */

import { lstat, readdir, readFile, realpath, stat } from 'fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import type { GitRepository, GitRepositoryList } from '../../../shared/types/git'
import { getSpaceDir } from '../space.service'
import { GitError } from './errors'
import { execGit, runGit } from './cli'
import { assertRepoPath, requireSpaceDirectory } from './paths'
import { readSavedRepositories, updateSavedRepository } from './repository-store'
import { Gate } from './gate'
import { getGitAvailability, requireGitExecutable } from './locate'
import { parseRefLines, parseTrack, type BranchHeader } from './parse'
import { readText, type RepoContext } from './context'

/** Sub-folders examined for a `.git`; a folder with more is not a folder of projects. */
const MAX_CHILD_FOLDERS = 1_000
const DISCOVERY_CONCURRENCY = 32
const SUMMARY_CONCURRENCY = 8
const PROBE_TTL_MS = 60_000
const MAX_SPACES = 32
const MAX_PROBES = 128
const MAX_DISCOVERED_ROOTS = 64
const probeGate = new Gate({ concurrency: 4, maxQueued: 128, maxWaitMs: 15_000 })

interface DirectoryProbe {
  expiresAt: number
  result: Promise<GitRepository | null>
}

interface SpaceRepositories {
  spaceDir: string
  probes: Map<string, DirectoryProbe>
  roots: Set<string>
  warnings: Set<string>
}

// LRU spaces and FIFO roots/probes bound session memory without lifecycle hooks or timers.
const spaces = new Map<string, SpaceRepositories>()

function spaceRepositories(spaceId: string, spaceDir: string): SpaceRepositories {
  let state = spaces.get(spaceId)
  if (!state || state.spaceDir !== spaceDir) state = { spaceDir, probes: new Map(), roots: new Set(), warnings: new Set() }
  spaces.delete(spaceId)
  spaces.set(spaceId, state)
  if (spaces.size > MAX_SPACES) spaces.delete(spaces.keys().next().value!)
  return state
}

function rememberRoot(state: SpaceRepositories, root: string): void {
  state.roots.delete(root)
  state.roots.add(root)
  if (state.roots.size > MAX_DISCOVERED_ROOTS) state.roots.delete(state.roots.values().next().value!)
}

function reportUnavailable(state: SpaceRepositories, root: string, error: unknown): void {
  if (state.warnings.has(root)) return
  if (state.warnings.size >= 128) state.warnings.delete(state.warnings.values().next().value!)
  state.warnings.add(root)
  console.warn(`[Git] Skipping repository ${root}: ${(error as Error).message.split('\n')[0]}`)
}

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
    const info = await lstat(dotGit)
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
export async function requireRepository(spaceId: unknown, repoRoot: unknown, verifyIdentity = false): Promise<RepoContext> {
  const spaceDir = requireSpaceDir(spaceId)
  const root = await requireSpaceDirectory(spaceDir, repoRoot)
  const notARepository = new GitError('GIT_NOT_A_REPOSITORY', `Not a repository of this space: ${repoRoot}`)
  const gitDir = await resolveGitDir(root)
  if (!gitDir) throw notARepository
  const ctx = { spaceDir, root, gitDir, git: await requireGitExecutable() }
  if (verifyIdentity || (await lstat(join(root, '.git'))).isFile()) await validateRepositoryIdentity(ctx)
  return ctx
}

async function validateRepositoryIdentity(ctx: RepoContext): Promise<void> {
  const { root, gitDir, git } = ctx
  const notARepository = new GitError('GIT_NOT_A_REPOSITORY', `Git metadata does not identify this worktree: ${root}`)
  const options = { cwd: root, readOnly: true, maxOutputBytes: 16_384 }
  const identity = await runGit(git, ['rev-parse', '--show-toplevel', '--absolute-git-dir'], options)
  const [top, actualGitDir] = identity.stdout.toString('utf8').trimEnd().split('\n')
  if (!top || !actualGitDir || await realpath(top) !== await realpath(root) || await realpath(actualGitDir) !== await realpath(gitDir)) throw notARepository

  if ((await lstat(join(root, '.git'))).isFile()) {
    // A forged gitfile can make --show-toplevel claim cwd. Metadata must identify this worktree too.
    const metadata = await execGit(git, ['rev-parse', '--show-toplevel'], { ...options, cwd: gitDir })
    if (metadata.exitCode === 0) {
      if (await realpath(metadata.stdout.toString('utf8').trimEnd()) !== await realpath(root)) throw notARepository
    } else {
      let backPointer: string
      try {
        const pointer = join(gitDir, 'gitdir')
        if ((await stat(pointer)).size > 4096) throw notARepository
        backPointer = (await readFile(pointer, 'utf8')).trimEnd()
        if (await realpath(resolve(gitDir, backPointer)) !== await realpath(join(root, '.git'))) throw notARepository
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw notARepository
        const parent = await execGit(git, ['rev-parse', '--absolute-git-dir'], { ...options, cwd: dirname(gitDir) })
        if (parent.exitCode === 0 && await realpath(parent.stdout.toString('utf8').trimEnd()) === await realpath(gitDir)) throw notARepository
        // Separate git directories have no reverse pointer; Git treats the gitfile as their worktree binding.
        const bare = await runGit(git, ['rev-parse', '--is-bare-repository'], { ...options, cwd: gitDir })
        if (bare.stdout.toString('utf8').trim() !== 'false') throw notARepository
      }
    }
  }
}

function describe(ctx: RepoContext): Pick<GitRepository, 'root' | 'name' | 'relativePath'> {
  return {
    root: ctx.root,
    name: basename(ctx.root),
    relativePath: relative(ctx.spaceDir, ctx.root).split(sep).join('/'),
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
  const state = spaceRepositories(spaceId, spaceDir)
  const saved = await readSavedRepositories(spaceId, spaceDir)
  const git = await getGitAvailability()
  const repositories: GitRepository[] = []
  if (git.available) {
    const shallow = new Set(await discoverRoots(spaceDir))
    const roots = [...new Set([...shallow, ...state.roots, ...saved])]
    for (let i = 0; i < roots.length; i += SUMMARY_CONCURRENCY) {
      const summaries = await Promise.all(roots.slice(i, i + SUMMARY_CONCURRENCY).map(async (root) => {
        try {
          const ctx = await requireRepository(spaceId, root, !shallow.has(root))
          const summary = await readRepositorySummary(ctx)
          state.warnings.delete(root)
          return summary
        } catch (error) {
          reportUnavailable(state, root, error)
          return null
        }
      }))
      repositories.push(...summaries.filter((repo): repo is GitRepository => repo !== null))
    }
  }
  const available = new Set(repositories.map((repo) => repo.root))
  return { git, repositories, ...(saved.length ? { savedRepositories: saved.map((root) => ({ root, available: available.has(root) })) } : {}) }
}

/** Probe the opened file's nearest Git root; never recursively search a directory. */
export async function discoverRepository(spaceId: string, filePath: string): Promise<GitRepository | null> {
  const spaceDir = requireSpaceDir(spaceId)
  if (typeof filePath !== 'string' || !isAbsolute(filePath) || filePath.length > 4096 || filePath.includes('\0')) {
    throw new GitError('GIT_INVALID_ARGUMENT', 'An absolute file path is required')
  }
  try {
    assertRepoPath(basename(filePath))
  } catch (error) {
    if (error instanceof GitError && error.code === 'GIT_INVALID_ARGUMENT') return null
    throw error
  }
  const state = spaceRepositories(spaceId, spaceDir)
  const directory = dirname(filePath)
  const cached = state.probes.get(directory)
  if (cached && cached.expiresAt > Date.now()) return cached.result
  const probe: DirectoryProbe = { expiresAt: Infinity, result: Promise.resolve(null) }
  probe.result = probeGate.run(async () => {
    try {
      await requireSpaceDirectory(spaceDir, directory)
      const git = await requireGitExecutable()
      const result = await runGit(git, ['rev-parse', '--show-toplevel'], {
        cwd: directory, readOnly: true, maxOutputBytes: 8192,
      })
      const realRoot = result.stdout.toString('utf8').trimEnd()
      const fromRoot = relative(realRoot, await realpath(directory))
      if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return null
      // Git resolves aliases above the space (e.g. /tmp on macOS); preserve the space's spelling.
      const root = resolve(spaceDir, relative(await realpath(spaceDir), realRoot))
      const summary = await resolveRepository(spaceId, root)
      if (state.probes.get(directory) === probe) rememberRoot(state, root)
      return summary
    } catch (error) {
      if (error instanceof GitError && error.code === 'GIT_NOT_A_REPOSITORY') return null
      throw error
    } finally {
      probe.expiresAt = Date.now() + PROBE_TTL_MS
    }
  })
  state.probes.delete(directory)
  state.probes.set(directory, probe)
  if (state.probes.size > MAX_PROBES) state.probes.delete(state.probes.keys().next().value!)
  try {
    return await probe.result
  } catch (error) {
    if (state.probes.get(directory) === probe) state.probes.delete(directory)
    throw error
  }
}

/** Save only an exact, validated worktree root after its summary has been read. */
export async function openRepository(spaceId: string, repoRoot: string): Promise<GitRepository> {
  const ctx = await requireRepository(spaceId, repoRoot, true)
  const summary = await readRepositorySummary(ctx)
  await updateSavedRepository(spaceId, ctx.spaceDir, ctx.root, true)
  return summary
}

/** Forget records only, including roots whose directory no longer exists. */
export async function forgetRepository(spaceId: string, repoRoot: string): Promise<void> {
  const spaceDir = requireSpaceDir(spaceId)
  if (typeof repoRoot !== 'string' || !isAbsolute(repoRoot) || repoRoot.length > 4096 || repoRoot.includes('\0')) {
    throw new GitError('GIT_INVALID_ARGUMENT', 'An absolute repository root is required')
  }
  const root = resolve(repoRoot)
  await updateSavedRepository(spaceId, spaceDir, root, false)
  if (requireSpaceDir(spaceId) !== spaceDir) throw new GitError('GIT_INVALID_ARGUMENT', 'The space changed while removing a repository')
  const state = spaceRepositories(spaceId, spaceDir)
  state.roots.delete(root)
  // In-flight probes must not re-register a forgotten root when they settle.
  state.probes.clear()
  state.warnings.delete(root)
}

/** The validated repository with its current branch summary. */
export async function resolveRepository(spaceId: string, repoRoot: string): Promise<GitRepository> {
  const ctx = await requireRepository(spaceId, repoRoot, true)
  return readRepositorySummary(ctx)
}
