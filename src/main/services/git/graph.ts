/**
 * The commit graph: one page of history in topo order, parents included so the
 * renderer can draw lanes, plus the refs that name branch heads and tags.
 */

import {
  GIT_LIMITS,
  type GitCommitGraph,
  type GitGraphCommit,
  type GitGraphQuery,
} from '../../../shared/types/git'
import { assertRevisionSyntax } from './changes'
import { read, readText, type RepoContext } from './context'
import { GitError } from './errors'
import { parseRefLines, splitNul } from './parse'
import { requireRepository } from './repositories'

/** %oid %short %author %date %subject %parents, NUL-terminated records. */
const FORMAT = '%H%x1f%h%x1f%an%x1f%cI%x1f%s%x1f%P'
const MAX_SUBJECT_CHARS = 200
/**
 * `--all` walks every ref in topo order before it can emit the first page, so
 * on huge histories this outlives the click-read default; capped, not open.
 */
const LOG_TIMEOUT_MS = 120_000

/** A query from a client, checked field by field. */
export function assertGraphQuery(value: unknown): GitGraphQuery {
  const query = (value ?? {}) as GitGraphQuery
  if (query.branch !== undefined && query.branch !== null) query.branch = assertRevisionSyntax(query.branch)
  if (query.author !== undefined && query.author !== null) {
    if (typeof query.author !== 'string' || query.author.length > 200) throw new GitError('GIT_INVALID_ARGUMENT', 'Not an author filter')
    query.author = query.author.trim() || undefined
  }
  if (query.message !== undefined && query.message !== null) {
    if (typeof query.message !== 'string' || query.message.length > 200) throw new GitError('GIT_INVALID_ARGUMENT', 'Not a message filter')
    query.message = query.message.trim() || undefined
  }
  if (query.skip !== undefined && (typeof query.skip !== 'number' || !Number.isInteger(query.skip) || query.skip < 0 || query.skip > 1_000_000)) {
    throw new GitError('GIT_INVALID_ARGUMENT', 'Not a page offset')
  }
  return query
}

/** Ref names by the commit they point at (annotated tags dereferenced). */
async function readRefs(ctx: RepoContext): Promise<Map<string, string[]>> {
  const output = await readText(ctx, [
    'for-each-ref',
    `--count=${GIT_LIMITS.maxGraphRefs}`,
    '--sort=-creatordate',
    '--format=%(refname)%00%(refname:short)%00%(if)%(*objectname)%(then)%(*objectname)%(else)%(objectname)%(end)',
    'refs/heads', 'refs/remotes', 'refs/tags',
  ])
  const refs = new Map<string, string[]>()
  for (const [, short, oid] of parseRefLines(output)) {
    if (!short || !oid) continue
    const names = refs.get(oid)
    if (names) names.push(short)
    else refs.set(oid, [short])
  }
  return refs
}

async function readGraph(ctx: RepoContext, query: GitGraphQuery): Promise<GitCommitGraph> {
  // Pages are point-in-time snapshots: `--skip` counts from the ref tips at
  // the moment the page runs, so commits arriving between pages shift offsets.
  // The renderer dedupes by oid when appending; a commit leaving the window is
  // only noticed on the next full reset. Accepted boundary, not cursor paging.
  const args = [
    'log', '-z', '--topo-order',
    `-n${GIT_LIMITS.maxGraphCommits}`,
    ...(query.skip ? [`--skip=${query.skip}`] : []),
    `--format=${FORMAT}`,
    // Both filters are plain substrings: fixed strings, case-insensitive.
    ...(query.author || query.message ? ['-i', '-F'] : []),
    ...(query.author ? [`--author=${query.author}`] : []),
    ...(query.message ? [`--grep=${query.message}`] : []),
    query.branch ?? '--all',
  ]
  // Exit 128: no commits at all, or the branch does not exist.
  const result = await read(ctx, args, { okExitCodes: [0, 128], timeoutMs: LOG_TIMEOUT_MS })
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString('utf8')
    if (query.branch) throw new GitError('GIT_REVISION_NOT_FOUND', `No branch or commit named ${query.branch}`)
    // An unborn repository has no graph yet, not an error.
    if (/does not have any commits yet/i.test(stderr)) return { commits: [], more: false }
    throw new GitError('GIT_FAILED', stderr.split('\n')[0] || 'git log failed')
  }

  const refs = await readRefs(ctx)
  const commits = splitNul(result.stdout.toString('utf8')).map((record): GitGraphCommit => {
    const [oid, shortOid, author, date, subject = '', parents = ''] = record.split('\x1f')
    return {
      oid,
      shortOid,
      parents: parents.split(' ').filter(Boolean),
      author,
      date,
      subject: subject.slice(0, MAX_SUBJECT_CHARS),
      refs: refs.get(oid) ?? [],
    }
  })
  return { commits, more: commits.length === GIT_LIMITS.maxGraphCommits }
}

export async function getCommitGraph(spaceId: string, repoRoot: string, query: GitGraphQuery): Promise<GitCommitGraph> {
  const ctx = await requireRepository(spaceId, repoRoot)
  return readGraph(ctx, assertGraphQuery(query))
}
