/**
 * Change lists for the five compare scopes.
 *
 * Every scope is one tree-ish (`beforeRevision`) against the working tree or
 * the index, read with `--raw --numstat` in a single run, plus the untracked
 * files git leaves out of a tracked diff. The cost follows the size of the
 * change, not of the repository.
 */

import {
  GIT_LIMITS,
  type GitChangedFile,
  type GitChangeList,
  type GitCompareScope,
} from '../../../shared/types/git'
import { read, readText, type RepoContext } from './context'
import { GitError } from './errors'
import { isNestedRepositoryEntry, markGenerated, measureUntracked, untrackedFile } from './files'
import { parseLsFilesStage, parseRawAndNumstat, splitNul, stateFromLetter } from './parse'
import { readHead, requireRepository } from './repositories'
import { assertObjectId, assertSnapshotExists, writeWorkingTreeTree } from './snapshot'

/** `--ignore-submodules=dirty`: see status.ts. */
const DIFF_ARGS = ['-z', '-M', '--raw', '--numstat', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty']

function invalid(message: string): GitError {
  return new GitError('GIT_INVALID_ARGUMENT', message)
}

/** A revision as a user may type it: no option syntax, no whitespace, bounded. */
export function assertRevisionSyntax(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) throw invalid('A branch or commit is required')
  // eslint-disable-next-line no-control-regex
  if (value.startsWith('-') || /[\s\x00-\x1f\x7f]/.test(value)) throw invalid(`Not a branch or commit: ${value}`)
  return value
}

/** Validate a compare scope from a client. */
export function assertCompareScope(value: unknown): GitCompareScope {
  const scope = value as GitCompareScope | null
  switch (scope?.kind) {
    case 'uncommitted':
    case 'staged':
      return { kind: scope.kind }
    case 'since-review':
      return { kind: 'since-review', snapshot: assertObjectId(scope.snapshot) }
    case 'revision':
      if (typeof scope.mergeBase !== 'boolean') throw invalid('A revision scope needs mergeBase')
      return { kind: 'revision', revision: assertRevisionSyntax(scope.revision), mergeBase: scope.mergeBase }
    case 'commit':
      return { kind: 'commit', revision: assertRevisionSyntax(scope.revision) }
    default:
      throw invalid('Unknown compare scope')
  }
}

/** The empty tree in this repository's hash format. */
async function emptyTree(ctx: RepoContext): Promise<string> {
  return (await readText(ctx, ['hash-object', '-t', 'tree', '--stdin'], { stdin: '' })).trim()
}

async function resolveCommit(ctx: RepoContext, revision: string): Promise<string> {
  const oid = (await readText(ctx, ['rev-parse', '-q', '--verify', `${revision}^{commit}`], { okExitCodes: [0, 1] })).trim()
  if (!oid) throw new GitError('GIT_REVISION_NOT_FOUND', `No branch or commit named ${revision}`)
  return oid
}

async function resolveMergeBase(ctx: RepoContext, commit: string, revision: string): Promise<string> {
  const result = await read(ctx, ['merge-base', 'HEAD', commit], { okExitCodes: [0, 1, 128] })
  const oid = result.stdout.toString('utf8').trim()
  if (result.exitCode === 0 && oid) return oid
  throw new GitError('GIT_REVISION_NOT_FOUND', `The current branch shares no history with ${revision}`)
}

interface TrackedDiff {
  files: GitChangedFile[]
  truncated: boolean
}

/** Changed files of one diff run, numstat folded into the raw records. */
async function diffFiles(ctx: RepoContext, args: string[]): Promise<TrackedDiff> {
  const result = await read(ctx, args, { truncate: true })
  const { raw, numstat } = parseRawAndNumstat(result.stdout.toString('utf8'))
  const counts = new Map(numstat.map((entry) => [entry.path, entry]))
  const files = raw.map((entry): GitChangedFile => {
    const count = counts.get(entry.path)
    return {
      path: entry.path,
      ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
      state: stateFromLetter(entry.status) ?? 'modified',
      additions: count?.additions ?? null,
      deletions: count?.deletions ?? null,
      binary: count ? count.additions === null : false,
    }
  })
  return { files, truncated: result.truncated }
}

async function listUnmerged(ctx: RepoContext): Promise<Set<string>> {
  return new Set(parseLsFilesStage(await readText(ctx, ['ls-files', '--unmerged', '-z'])).map((entry) => entry.path))
}

async function listUntracked(ctx: RepoContext): Promise<{ paths: string[]; truncated: boolean }> {
  const result = await read(ctx, ['ls-files', '--others', '--exclude-standard', '-z'], { truncate: true })
  const paths = splitNul(result.stdout.toString('utf8')).filter((path) => !isNestedRepositoryEntry(path))
  return { paths, truncated: result.truncated }
}

/**
 * Tracked changes of `before` against the working tree, plus untracked files.
 * Unmerged paths are reported as conflicted whatever the diff says of them.
 */
async function againstWorkingTree(ctx: RepoContext, before: string): Promise<TrackedDiff> {
  const [tracked, unmerged, untracked] = await Promise.all([
    diffFiles(ctx, ['diff', ...DIFF_ARGS, before, '--']),
    listUnmerged(ctx),
    listUntracked(ctx),
  ])
  for (const file of tracked.files) {
    if (unmerged.has(file.path)) file.state = 'conflicted'
  }
  const room = Math.max(0, GIT_LIMITS.maxListedFiles - tracked.files.length)
  const counted = untracked.paths.slice(0, room)
  const measures = await measureUntracked(ctx.root, counted)
  const files = [...tracked.files, ...counted.map((path) => untrackedFile(path, measures.get(path)))]
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { files, truncated: tracked.truncated || untracked.truncated || untracked.paths.length > room }
}

async function sinceSnapshot(ctx: RepoContext, snapshot: string): Promise<TrackedDiff> {
  await assertSnapshotExists(ctx, snapshot)
  const [now, unmerged] = await Promise.all([writeWorkingTreeTree(ctx), listUnmerged(ctx)])
  const diff = await diffFiles(ctx, ['diff-tree', '-r', ...DIFF_ARGS, snapshot, now, '--'])
  for (const file of diff.files) {
    if (unmerged.has(file.path)) file.state = 'conflicted'
  }
  return diff
}

export async function readChangeList(ctx: RepoContext, scope: GitCompareScope): Promise<GitChangeList> {
  let beforeRevision: string | null
  let diff: TrackedDiff

  switch (scope.kind) {
    case 'uncommitted': {
      beforeRevision = await readHead(ctx)
      diff = await againstWorkingTree(ctx, beforeRevision ?? (await emptyTree(ctx)))
      break
    }
    case 'staged': {
      beforeRevision = await readHead(ctx)
      const [staged, unmerged] = await Promise.all([
        diffFiles(ctx, ['diff', '--cached', ...DIFF_ARGS, beforeRevision ?? (await emptyTree(ctx)), '--']),
        listUnmerged(ctx),
      ])
      for (const file of staged.files) {
        if (unmerged.has(file.path)) file.state = 'conflicted'
      }
      diff = staged
      break
    }
    case 'since-review': {
      beforeRevision = scope.snapshot
      diff = await sinceSnapshot(ctx, scope.snapshot)
      break
    }
    case 'revision': {
      const commit = await resolveCommit(ctx, scope.revision)
      beforeRevision = scope.mergeBase ? await resolveMergeBase(ctx, commit, scope.revision) : commit
      diff = await againstWorkingTree(ctx, beforeRevision)
      break
    }
    case 'commit': {
      const commit = await resolveCommit(ctx, scope.revision)
      beforeRevision = (await readText(ctx, ['rev-parse', '-q', '--verify', `${commit}^`], { okExitCodes: [0, 1] })).trim()
      diff = await diffFiles(ctx, beforeRevision
        ? ['diff-tree', '-r', ...DIFF_ARGS, beforeRevision, commit, '--']
        // A root commit has no parent; --root diffs it against the empty tree.
        : ['diff-tree', '-r', '--root', ...DIFF_ARGS, commit, '--'])
      if (!beforeRevision) beforeRevision = await emptyTree(ctx)
      break
    }
  }

  const files = diff.files.slice(0, GIT_LIMITS.maxListedFiles)
  await markGenerated(ctx, files)
  return { scope, beforeRevision, files, truncated: diff.truncated || diff.files.length > files.length }
}

export async function getChangeList(spaceId: string, repoRoot: string, scope: GitCompareScope): Promise<GitChangeList> {
  const ctx = await requireRepository(spaceId, repoRoot)
  return readChangeList(ctx, assertCompareScope(scope))
}
