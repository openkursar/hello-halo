/**
 * Writes: stage, unstage, discard, commit, push, sync.
 *
 * Writes to one repository run one at a time, so two quick clicks (or a
 * desktop and a remote client) cannot race each other for `index.lock`. When
 * another process holds it — usually the AI running git — the write is
 * retried briefly, then reported as GIT_LOCKED. Network and hook-running
 * commands get no terminal: a credential or passphrase prompt fails at once
 * (GIT_AUTH_REQUIRED) instead of hanging a hidden process.
 */

import { shell } from 'electron'
import { lstat } from 'fs/promises'
import { resolve } from 'path'
import type { GitCommitRequest, GitCommitResult, GitSyncResult } from '../../../shared/types/git'
import { exec, readText, run, type RepoContext, type RunOptions } from './context'
import { GitError, classifyFailure, isGitError } from './errors'
import { parseLsFilesStage, splitNul } from './parse'
import { assertRepoPathList, chunkPaths, resolveWorktreePath } from './paths'
import { abbreviate, readHead, readRepositorySummary, requireRepository } from './repositories'

const WRITE_OPTIONS: RunOptions = { timeoutMs: 60_000 }
/** Hooks (lint, tests, signing) can be slow. */
const COMMIT_OPTIONS: RunOptions = { timeoutMs: 5 * 60_000, detached: true }
const NETWORK_OPTIONS: RunOptions = { timeoutMs: 3 * 60_000, detached: true }
const MAX_MESSAGE_CHARS = 64 * 1024
const LOCK_RETRY_DELAYS_MS = [200, 400, 800]
const COMMIT_HOOKS = ['pre-commit', 'prepare-commit-msg', 'commit-msg']

const queues = new Map<string, Promise<void>>()

/** Run `task` after every earlier write to the same repository has settled. */
function serialized<T>(root: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(root) ?? Promise.resolve()
  const result = previous.then(task)
  const tail = result.then(
    () => undefined,
    () => undefined,
  )
  queues.set(root, tail)
  void tail.then(() => {
    if (queues.get(root) === tail) queues.delete(root)
  })
  return result
}

async function retryWhileLocked<T>(task: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await task()
    } catch (error) {
      if (!isGitError(error) || error.code !== 'GIT_LOCKED' || attempt >= LOCK_RETRY_DELAYS_MS.length) throw error
      await new Promise((done) => setTimeout(done, LOCK_RETRY_DELAYS_MS[attempt]))
    }
  }
}

/** Which of `paths` git lists with `flags` (exact names only, never a directory's contents). */
async function listedPaths(ctx: RepoContext, flags: string[], paths: string[]): Promise<Set<string>> {
  const wanted = new Set(paths)
  const listed = new Set<string>()
  const staged = flags.includes('--unmerged') || flags.includes('--stage')
  for (const chunk of chunkPaths(paths)) {
    const output = await readText(ctx, ['ls-files', '-z', ...flags, '--', ...chunk])
    const names = staged ? parseLsFilesStage(output).map((entry) => entry.path) : splitNul(output)
    for (const name of names) {
      if (wanted.has(name)) listed.add(name)
    }
  }
  return listed
}

async function existsInWorktree(ctx: RepoContext, path: string): Promise<boolean> {
  const file = await resolveWorktreePath(ctx.root, path)
  if (!file) return false
  return lstat(file).then(
    () => true,
    () => false,
  )
}

export async function stagePaths(spaceId: string, repoRoot: string, paths: string[]): Promise<void> {
  const ctx = await requireRepository(spaceId, repoRoot)
  const list = assertRepoPathList(paths)
  await serialized(ctx.root, async () => {
    // A path already staged as deleted matches nothing, and `git add` refuses
    // the whole batch for one such path; skip what is already gone.
    const tracked = await listedPaths(ctx, ['--cached'], list)
    const present = await Promise.all(list.map((path) => (tracked.has(path) ? true : existsInWorktree(ctx, path))))
    const stageable = list.filter((_, i) => present[i])
    if (stageable.length < list.length) {
      console.log(`[Git] Stage in ${ctx.root}: ${list.length - stageable.length} path(s) already gone, nothing to stage for them`)
    }
    for (const chunk of chunkPaths(stageable)) {
      await retryWhileLocked(() => run(ctx, ['add', '-A', '--', ...chunk], WRITE_OPTIONS))
    }
  })
}

/** Reset the index entries of `paths` to HEAD (works before the first commit too). */
export async function unstagePaths(spaceId: string, repoRoot: string, paths: string[]): Promise<void> {
  const ctx = await requireRepository(spaceId, repoRoot)
  const list = assertRepoPathList(paths)
  await serialized(ctx.root, async () => {
    for (const chunk of chunkPaths(list)) {
      await retryWhileLocked(() => run(ctx, ['reset', '-q', '--', ...chunk], WRITE_OPTIONS))
    }
  })
}

async function moveToTrash(ctx: RepoContext, path: string): Promise<void> {
  const file = await resolveWorktreePath(ctx.root, path)
  if (!file) return
  const info = await lstat(file).catch(() => null)
  if (!info) return
  if (info.isDirectory()) throw new GitError('GIT_INVALID_ARGUMENT', `Not a file: ${path}`)
  try {
    await shell.trashItem(file)
  } catch (error) {
    throw new GitError('GIT_FAILED', `Could not move ${path} to the trash: ${(error as Error).message}`)
  }
}

/**
 * Discard working-tree changes. A tracked file is restored from the index
 * (its staged part survives); an untracked file goes to the OS trash, never
 * deleted outright. Ignored files are left alone.
 */
export async function discardPaths(spaceId: string, repoRoot: string, paths: string[]): Promise<void> {
  const ctx = await requireRepository(spaceId, repoRoot)
  const list = assertRepoPathList(paths)
  await serialized(ctx.root, async () => {
    const [tracked, unmerged, untracked] = await Promise.all([
      listedPaths(ctx, ['--cached'], list),
      listedPaths(ctx, ['--unmerged'], list),
      listedPaths(ctx, ['--others', '--exclude-standard'], list),
    ])
    if (unmerged.size > 0) {
      throw new GitError('GIT_CONFLICTED', `Resolve the conflicts first: ${[...unmerged].slice(0, 5).join(', ')}`)
    }
    const toTrash = list.filter((path) => !tracked.has(path) && untracked.has(path))
    const untouched = list.length - tracked.size - toTrash.length
    if (untouched > 0) {
      console.warn(`[Git] Discard in ${ctx.root}: left ${untouched} path(s) alone (ignored, missing or a directory)`)
    }
    for (const chunk of chunkPaths(list.filter((path) => tracked.has(path)))) {
      await retryWhileLocked(() => run(ctx, ['restore', '--worktree', '--', ...chunk], WRITE_OPTIONS))
    }
    for (const path of toTrash) {
      await moveToTrash(ctx, path)
    }
  })
}

function assertCommitRequest(value: unknown): GitCommitRequest {
  const request = value as Partial<GitCommitRequest> | null
  if (!request || typeof request.message !== 'string' || typeof request.amend !== 'boolean' || typeof request.push !== 'boolean') {
    throw new GitError('GIT_INVALID_ARGUMENT', 'A commit request needs message, amend and push')
  }
  if (request.message.length > MAX_MESSAGE_CHARS) throw new GitError('GIT_INVALID_ARGUMENT', 'The commit message is too long')
  if (!request.amend && request.message.trim() === '') throw new GitError('GIT_EMPTY_MESSAGE', 'Write a commit message first')
  return { message: request.message, amend: request.amend, push: request.push }
}

/** Whether a hook that can refuse a commit is installed (core.hooksPath honored). */
async function hasCommitHook(ctx: RepoContext): Promise<boolean> {
  const output = await readText(ctx, ['rev-parse', ...COMMIT_HOOKS.flatMap((hook) => ['--git-path', `hooks/${hook}`])])
  const files = output.split('\n').filter(Boolean).map((line) => resolve(ctx.root, line))
  const found = await Promise.all(files.map((file) => lstat(file).then((info) => info.isFile(), () => false)))
  return found.some(Boolean)
}

async function chooseRemote(ctx: RepoContext): Promise<string> {
  const remotes = (await readText(ctx, ['remote'])).split('\n').map((line) => line.trim()).filter(Boolean)
  if (remotes.includes('origin')) return 'origin'
  if (remotes.length === 1 && !remotes[0].startsWith('-')) return remotes[0]
  throw new GitError(
    'GIT_NO_REMOTE',
    remotes.length === 0 ? 'This repository has no remote to push to' : 'This branch has no upstream and there is more than one remote',
  )
}

/** Push the current branch; publishes it with an upstream when it has none. Returns commits pushed. */
async function pushBranch(ctx: RepoContext): Promise<number> {
  const repo = await readRepositorySummary(ctx)
  if (!repo.branch) throw new GitError('GIT_DETACHED_HEAD', 'HEAD is detached; there is no branch to push')
  if (repo.unborn) throw new GitError('GIT_FAILED', 'This branch has no commits yet')
  if (repo.upstream) {
    await run(ctx, ['push'], NETWORK_OPTIONS)
    return repo.ahead
  }
  const remote = await chooseRemote(ctx)
  const ahead = Number((await readText(ctx, ['rev-list', '--count', 'HEAD', '--not', `--remotes=${remote}`])).trim()) || 0
  await run(ctx, ['push', '-u', remote, 'HEAD'], NETWORK_OPTIONS)
  return ahead
}

export async function commitChanges(spaceId: string, repoRoot: string, request: GitCommitRequest): Promise<GitCommitResult> {
  const ctx = await requireRepository(spaceId, repoRoot)
  const { message, amend, push } = assertCommitRequest(request)
  return serialized(ctx.root, async () => {
    // An amend without a message keeps the previous one.
    const keepMessage = amend && message.trim() === ''
    const args = keepMessage ? ['commit', '-q', '--amend', '--no-edit'] : ['commit', '-q', ...(amend ? ['--amend'] : []), '--file=-']
    const options = keepMessage ? COMMIT_OPTIONS : { ...COMMIT_OPTIONS, stdin: message }

    await retryWhileLocked(async () => {
      const attempt = await exec(ctx, args, options)
      if (attempt.exitCode === 0) return
      const error = classifyFailure('commit', attempt.stderr, attempt.stdout.toString('utf8'))
      // A refusing hook prints its own output and makes git exit with 1.
      if (error.code === 'GIT_FAILED' && attempt.exitCode === 1 && (await hasCommitHook(ctx))) {
        throw new GitError('GIT_HOOK_FAILED', error.message)
      }
      throw error
    })

    const head = await readHead(ctx)
    const commit = head ? abbreviate(head) : ''
    if (!push) return { commit, pushed: false }
    try {
      await pushBranch(ctx)
      return { commit, pushed: true }
    } catch (error) {
      if (!isGitError(error)) throw error
      return { commit, pushed: false, pushError: error.message, pushErrorCode: error.code }
    }
  })
}

/** Fast-forward from the upstream, then push; a branch without one is published. */
export async function syncBranch(spaceId: string, repoRoot: string): Promise<GitSyncResult> {
  const ctx = await requireRepository(spaceId, repoRoot)
  return serialized(ctx.root, async () => {
    const repo = await readRepositorySummary(ctx)
    if (!repo.branch) throw new GitError('GIT_DETACHED_HEAD', 'HEAD is detached; there is no branch to sync')
    if (repo.unborn) throw new GitError('GIT_FAILED', 'This branch has no commits yet')
    if (!repo.upstream) {
      const pushed = await pushBranch(ctx)
      return { repo: await readRepositorySummary(ctx), pulled: 0, pushed }
    }

    const before = await readHead(ctx)
    await run(ctx, ['pull', '--ff-only', '--no-rebase'], NETWORK_OPTIONS)
    const after = await readHead(ctx)
    const pulled = before && after && before !== after
      ? Number((await readText(ctx, ['rev-list', '--count', `${before}..${after}`])).trim()) || 0
      : 0

    const synced = await readRepositorySummary(ctx)
    if (synced.ahead === 0) return { repo: synced, pulled, pushed: 0 }
    await run(ctx, ['push'], NETWORK_OPTIONS)
    return { repo: await readRepositorySummary(ctx), pulled, pushed: synced.ahead }
  })
}
