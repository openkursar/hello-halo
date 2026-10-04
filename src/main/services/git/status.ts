/**
 * The working tree as the file panel groups it: staged, unstaged (with
 * untracked) and conflicted — one `git status` plus two `--numstat` runs for
 * line counts, all read-only and in parallel.
 */

import { stat } from 'fs/promises'
import { join } from 'path'
import { GIT_LIMITS, type GitChangedFile, type GitWorkingTreeStatus } from '../../../shared/types/git'
import { read, type RepoContext } from './context'
import { isNestedRepositoryEntry, markGenerated, measureUntracked, untrackedFile } from './files'
import { parsePorcelainV2, parseRawAndNumstat, stateFromLetter, type NumstatEntry } from './parse'
import { repositoryFromBranch, requireRepository } from './repositories'

/**
 * `--ignore-submodules=dirty`: a submodule counts as changed when its commit
 * moved, without git running status inside it — where the submodule's own
 * config would apply (DESIGN.md §3.1).
 */
const NUMSTAT_ARGS = ['--numstat', '-z', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty']

function byPath(entries: NumstatEntry[]): Map<string, NumstatEntry> {
  return new Map(entries.map((entry) => [entry.path, entry]))
}

function withCounts(file: Omit<GitChangedFile, 'additions' | 'deletions' | 'binary'>, counts: NumstatEntry | undefined): GitChangedFile {
  return {
    ...file,
    additions: counts?.additions ?? null,
    deletions: counts?.deletions ?? null,
    binary: counts ? counts.additions === null : false,
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** The multi-step operation git is in the middle of, from the marker files it leaves. */
export async function detectOperation(gitDir: string): Promise<GitWorkingTreeStatus['operation']> {
  const [rebaseMerge, rebaseApply, merge, cherryPick, revert] = await Promise.all(
    ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].map((name) => exists(join(gitDir, name))),
  )
  if (rebaseMerge || rebaseApply) return 'rebase'
  if (merge) return 'merge'
  if (cherryPick) return 'cherry-pick'
  if (revert) return 'revert'
  return null
}

export async function readWorkingTreeStatus(ctx: RepoContext): Promise<GitWorkingTreeStatus> {
  const [status, unstagedCounts, stagedCounts, operation] = await Promise.all([
    read(ctx, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--ignore-submodules=dirty'], { truncate: true }),
    read(ctx, ['diff', ...NUMSTAT_ARGS], { truncate: true }),
    read(ctx, ['diff', '--cached', ...NUMSTAT_ARGS], { truncate: true }),
    detectOperation(ctx.gitDir),
  ])

  const { branch, entries } = parsePorcelainV2(status.stdout.toString('utf8'))
  const unstagedByPath = byPath(parseRawAndNumstat(unstagedCounts.stdout.toString('utf8')).numstat)
  const stagedByPath = byPath(parseRawAndNumstat(stagedCounts.stdout.toString('utf8')).numstat)

  const max = GIT_LIMITS.maxListedFiles
  const staged: GitChangedFile[] = []
  const unstaged: GitChangedFile[] = []
  const conflicted: GitChangedFile[] = []
  const untrackedPaths: string[] = []
  let truncated = status.truncated

  for (const entry of entries) {
    if (entry.kind === 'unmerged') {
      if (conflicted.length < max) conflicted.push({ path: entry.path, state: 'conflicted', additions: null, deletions: null, binary: false })
      else truncated = true
      continue
    }
    if (entry.kind === 'untracked') {
      if (isNestedRepositoryEntry(entry.path)) continue
      if (unstaged.length + untrackedPaths.length < max) untrackedPaths.push(entry.path)
      else truncated = true
      continue
    }
    const stagedState = stateFromLetter(entry.xy[0])
    if (stagedState) {
      if (staged.length < max) {
        staged.push(withCounts({ path: entry.path, ...(entry.origPath ? { oldPath: entry.origPath } : {}), state: stagedState }, stagedByPath.get(entry.path)))
      } else truncated = true
    }
    const unstagedState = stateFromLetter(entry.xy[1])
    if (unstagedState) {
      if (unstaged.length + untrackedPaths.length < max) unstaged.push(withCounts({ path: entry.path, state: unstagedState }, unstagedByPath.get(entry.path)))
      else truncated = true
    }
  }

  const measures = await measureUntracked(ctx.root, untrackedPaths)
  for (const path of untrackedPaths) unstaged.push(untrackedFile(path, measures.get(path)))
  await markGenerated(ctx, [...staged, ...unstaged, ...conflicted])

  return { repo: repositoryFromBranch(ctx, branch), staged, unstaged, conflicted, operation, truncated }
}

export async function getWorkingTreeStatus(spaceId: string, repoRoot: string): Promise<GitWorkingTreeStatus> {
  return readWorkingTreeStatus(await requireRepository(spaceId, repoRoot))
}
