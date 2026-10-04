/**
 * Choices for "compare with a branch / commit": the most recent refs of each
 * kind, then recent commits, bounded by GIT_LIMITS.maxRevisionOptions.
 */

import { GIT_LIMITS, type GitRevisionOption } from '../../../shared/types/git'
import { read, readText, type RepoContext } from './context'
import { parseRefLines } from './parse'
import { requireRepository } from './repositories'

/** Per-kind quotas; commits fill what is left. */
const QUOTA = { branch: 15, 'remote-branch': 10, tag: 5 } as const
const MAX_COMMITS = 30
const MAX_SUBJECT_CHARS = 200

async function recentRefs(
  ctx: RepoContext,
  namespace: string,
  kind: 'branch' | 'remote-branch' | 'tag',
  exclude: (fullName: string) => boolean,
): Promise<GitRevisionOption[]> {
  const output = await readText(ctx, [
    'for-each-ref',
    '--sort=-creatordate',
    // A few extra so excluded refs (the current branch, remote HEADs) do not shrink the list.
    `--count=${QUOTA[kind] + 2}`,
    '--format=%(refname)%00%(refname:short)%00%(creatordate:iso-strict)',
    namespace,
  ])
  return parseRefLines(output)
    .filter(([fullName]) => !exclude(fullName))
    .slice(0, QUOTA[kind])
    .map(([, revision, date]) => ({ revision, kind, ...(date ? { date } : {}) }))
}

async function recentCommits(ctx: RepoContext, count: number): Promise<GitRevisionOption[]> {
  if (count <= 0) return []
  // Exit 128 before the first commit: nothing to offer.
  const result = await read(ctx, ['log', '-z', `-n${count}`, '--no-show-signature', '--format=%H%x1f%cI%x1f%s'], { okExitCodes: [0, 128] })
  if (result.exitCode !== 0) return []
  return result.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const [revision, date, subject = ''] = record.split('\x1f')
      return { revision: revision.trim(), kind: 'commit' as const, subject: subject.slice(0, MAX_SUBJECT_CHARS), date }
    })
}

export async function readRevisionOptions(ctx: RepoContext): Promise<GitRevisionOption[]> {
  const current = (await readText(ctx, ['symbolic-ref', '-q', 'HEAD'], { okExitCodes: [0, 1] })).trim()
  const [branches, remotes, tags] = await Promise.all([
    recentRefs(ctx, 'refs/heads', 'branch', (name) => name === current),
    recentRefs(ctx, 'refs/remotes', 'remote-branch', (name) => name.endsWith('/HEAD')),
    recentRefs(ctx, 'refs/tags', 'tag', () => false),
  ])
  const refs = [...branches, ...remotes, ...tags]
  const commits = await recentCommits(ctx, Math.min(MAX_COMMITS, GIT_LIMITS.maxRevisionOptions - refs.length))
  return [...refs, ...commits].slice(0, GIT_LIMITS.maxRevisionOptions)
}

export async function listRevisionOptions(spaceId: string, repoRoot: string): Promise<GitRevisionOption[]> {
  return readRevisionOptions(await requireRepository(spaceId, repoRoot))
}
