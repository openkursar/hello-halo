/**
 * Both sides of one changed file, for the diff view.
 *
 * The before side is a blob of the list's `beforeRevision` (so every file of
 * one list shares a before side, even if HEAD moves meanwhile); the after side
 * is the index for `staged` and the working tree otherwise. A side over
 * GIT_LIMITS.maxFileBytes or with a NUL byte comes back as a size only.
 */

import { lstat, readFile, readlink } from 'fs/promises'
import { join } from 'path'
import { GIT_LIMITS, type GitCompareScope, type GitFileContents, type GitFileContentsRequest } from '../../../shared/types/git'
import { read, readText, run, type RepoContext } from './context'
import { assertCompareScope } from './changes'
import { GitError, isGitError } from './errors'
import { isBinary } from './files'
import { Gate } from './gate'
import { parseLsFilesStage, parseLsTree } from './parse'
import { assertRepoPath, resolveWorktreePath } from './paths'
import { requireRepository } from './repositories'
import { assertObjectId } from './snapshot'

/** One side: absent, known only by size, or loaded. */
type Side = { exists: false } | { exists: true; bytes: number; content: Buffer | null }

const ABSENT: Side = { exists: false }

function submoduleText(oid: string): Side {
  const content = Buffer.from(`Subproject commit ${oid}\n`)
  return { exists: true, bytes: content.length, content }
}

/** A blob's content, bounded: over the limit only its size is returned. */
async function readBlob(ctx: RepoContext, oid: string, knownSize: number | null): Promise<Side> {
  const max = GIT_LIMITS.maxFileBytes
  if (knownSize !== null && knownSize > max) return { exists: true, bytes: knownSize, content: null }
  const result = await read(ctx, ['cat-file', 'blob', oid], { maxOutputBytes: max + 1, truncate: true })
  if (result.stdout.length <= max) return { exists: true, bytes: result.stdout.length, content: result.stdout }
  const size = result.truncated ? Number((await readText(ctx, ['cat-file', '-s', oid])).trim()) : result.stdout.length
  return { exists: true, bytes: size, content: null }
}

async function readTreeSide(ctx: RepoContext, treeish: string, path: string, scope: GitCompareScope): Promise<Side> {
  let output: string
  try {
    output = await readText(ctx, ['ls-tree', '-z', '-l', treeish, '--', path])
  } catch (error) {
    if (isGitError(error) && error.code === 'GIT_FAILED' && /not a (tree object|valid object name)/i.test(error.message)) {
      throw scope.kind === 'since-review'
        ? new GitError('GIT_SNAPSHOT_MISSING', 'The snapshot of the last review no longer exists in this repository')
        : new GitError('GIT_REVISION_NOT_FOUND', `The compared revision no longer exists: ${treeish}`)
    }
    throw error
  }
  const entry = parseLsTree(output).find((candidate) => candidate.path === path)
  if (!entry || entry.type === 'tree') return ABSENT
  if (entry.type === 'commit') return submoduleText(entry.oid)
  return readBlob(ctx, entry.oid, entry.size)
}

async function readIndexSide(ctx: RepoContext, path: string): Promise<Side> {
  const entries = parseLsFilesStage(await readText(ctx, ['ls-files', '-s', '-z', '--', path]))
  const entry = entries.find((candidate) => candidate.path === path && candidate.stage === 0)
  if (!entry) return ABSENT
  if (entry.mode === '160000') return submoduleText(entry.oid)
  return readBlob(ctx, entry.oid, null)
}

async function readWorktreeSide(ctx: RepoContext, path: string): Promise<Side> {
  const file = await resolveWorktreePath(ctx.root, path)
  if (!file) return ABSENT
  let info
  try {
    info = await lstat(file)
  } catch {
    return ABSENT
  }
  if (info.isSymbolicLink()) {
    const content = Buffer.from(await readlink(file))
    return { exists: true, bytes: content.length, content }
  }
  if (info.isDirectory()) {
    // A submodule's working tree: git shows the commit it has checked out.
    // Without its own .git, git would answer for the enclosing repository instead.
    if (!(await lstat(join(file, '.git')).then(() => true, () => false))) return ABSENT
    const head = await run({ ...ctx, root: file }, ['rev-parse', '-q', '--verify', 'HEAD'], { readOnly: true, okExitCodes: [0, 1, 128] })
    const oid = head.exitCode === 0 ? head.stdout.toString('utf8').trim() : ''
    return oid ? submoduleText(oid) : ABSENT
  }
  if (!info.isFile()) return ABSENT
  if (info.size > GIT_LIMITS.maxFileBytes) return { exists: true, bytes: info.size, content: null }
  const content = await readFile(file)
  return { exists: true, bytes: content.length, content }
}

/** A file request from a client, checked field by field. */
interface CheckedContentsRequest {
  scope: GitCompareScope
  path: string
  oldPath?: string
  beforeRevision: string | null
}

function checkContentsRequest(request: GitFileContentsRequest): CheckedContentsRequest {
  if (!request || typeof request !== 'object') throw new GitError('GIT_INVALID_ARGUMENT', 'A file request is required')
  return {
    scope: assertCompareScope(request.scope),
    path: assertRepoPath(request.path),
    oldPath: request.oldPath === undefined || request.oldPath === null ? undefined : assertRepoPath(request.oldPath),
    beforeRevision: request.beforeRevision === null ? null : assertObjectId(request.beforeRevision),
  }
}

async function readContents(ctx: RepoContext, { scope, path, oldPath, beforeRevision }: CheckedContentsRequest): Promise<GitFileContents> {
  const [before, after] = await Promise.all([
    beforeRevision ? readTreeSide(ctx, beforeRevision, oldPath ?? path, scope) : Promise.resolve(ABSENT),
    scope.kind === 'staged' ? readIndexSide(ctx, path) : readWorktreeSide(ctx, path),
  ])

  const sides = [before, after].filter((side): side is Extract<Side, { exists: true }> => side.exists)
  const tooLarge = sides.some((side) => side.content === null)
  const binary = !tooLarge && sides.some((side) => side.content !== null && isBinary(side.content))
  const text = (side: Side): string | null =>
    side.exists && side.content && !tooLarge && !binary ? side.content.toString('utf8') : null

  return {
    path,
    ...(oldPath ? { oldPath } : {}),
    before: text(before),
    after: text(after),
    binary,
    tooLarge,
    ...(before.exists ? { beforeBytes: before.bytes } : {}),
    ...(after.exists ? { afterBytes: after.bytes } : {}),
  }
}

/**
 * Content reads arrive in bursts (a diff view scrolled fast, a remote client
 * calling directly), and each runs up to two git processes at once (before and
 * after side): three at a time keep it to six. Status and change lists are one
 * request per refresh and are not gated.
 */
const contentReads = new Gate({ concurrency: 3, maxQueued: 32, maxWaitMs: 15_000 })

export async function readFileContents(
  spaceId: string,
  repoRoot: string,
  request: GitFileContentsRequest,
  signal?: AbortSignal,
): Promise<GitFileContents> {
  // Checked before the line, so a malformed request never waits in it.
  const checked = checkContentsRequest(request)
  const ctx = await requireRepository(spaceId, repoRoot)
  return contentReads.run(() => readContents(ctx, checked), signal)
}
