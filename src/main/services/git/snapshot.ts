/**
 * Snapshots: the whole working tree as a git tree object.
 *
 * A copy of the real index goes to a temporary file and `git add -A` runs
 * against that copy, so only files changed since the last real index refresh
 * are re-hashed and neither the real index nor the working tree is touched.
 * The tree gets no ref: it does not appear in the user's history, and git gc
 * may eventually prune it — which "since last review" reports as
 * GIT_SNAPSHOT_MISSING instead of guessing.
 */

import { copyFile, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { GitSnapshot } from '../../../shared/types/git'
import { read, readText, type RepoContext } from './context'
import { GitError } from './errors'
import { requireRepository } from './repositories'

/** Hashing every new or changed file of a large working tree can take a while. */
const SNAPSHOT_TIMEOUT_MS = 120_000

/** A full object id (SHA-1 or SHA-256), the only revision form taken from a client verbatim. */
export function assertObjectId(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw new GitError('GIT_INVALID_ARGUMENT', 'Not a git object id')
  }
  return value
}

export async function assertSnapshotExists(ctx: RepoContext, tree: string): Promise<void> {
  const result = await read(ctx, ['cat-file', '-e', `${tree}^{tree}`], { okExitCodes: [0, 1, 128] })
  if (result.exitCode !== 0) {
    throw new GitError('GIT_SNAPSHOT_MISSING', 'The snapshot of the last review no longer exists in this repository')
  }
}

/** Tree id of the working tree as it is now: tracked and untracked files, ignored ones excluded. */
export async function writeWorkingTreeTree(ctx: RepoContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'halo-git-snapshot-'))
  const index = join(dir, 'index')
  try {
    try {
      await copyFile(join(ctx.gitDir, 'index'), index)
    } catch (error) {
      // No index yet (nothing ever added): start from an empty one.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const env = { GIT_INDEX_FILE: index }
    const added = await read(
      ctx,
      ['-c', 'advice.addEmbeddedRepo=false', '-c', 'core.safecrlf=false', 'add', '-A', '--ignore-errors'],
      { env, timeoutMs: SNAPSHOT_TIMEOUT_MS, okExitCodes: [0, 1] },
    )
    if (added.exitCode !== 0) {
      // --ignore-errors: unreadable files are left out and the rest is snapshotted.
      console.warn(`[Git] Snapshot of ${ctx.root} skipped unreadable files: ${added.stderr.trim().split('\n')[0]}`)
    }
    return (await readText(ctx, ['write-tree'], { env })).trim()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export async function createSnapshot(spaceId: string, repoRoot: string): Promise<GitSnapshot> {
  const ctx = await requireRepository(spaceId, repoRoot)
  return { tree: await writeWorkingTreeTree(ctx), createdAt: Date.now() }
}

/** Paths that differ between a snapshot and the working tree now; a rename counts once. */
export async function countChangedSince(spaceId: string, repoRoot: string, snapshot: string): Promise<number> {
  const ctx = await requireRepository(spaceId, repoRoot)
  const tree = assertObjectId(snapshot)
  await assertSnapshotExists(ctx, tree)
  const now = await writeWorkingTreeTree(ctx)
  if (now === tree) return 0
  const output = await readText(ctx, ['diff-tree', '-r', '-z', '-M', '--name-only', '--no-ext-diff', '--no-textconv', tree, now, '--'])
  return output.split('\0').filter(Boolean).length
}
