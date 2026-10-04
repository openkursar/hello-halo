/**
 * A repository a request has been validated against, and how to run git in it.
 */

import { execGit, runGit, type GitExecOptions, type GitExecResult } from './cli'
import { automaticCommandArgs } from './repo-config'

export interface RepoContext {
  /** The space folder the repository was found in. */
  spaceDir: string
  /** Absolute repository root (the working tree). */
  root: string
  /** Absolute git directory; for a linked worktree, that worktree's own. */
  gitDir: string
  /** The git binary to run. */
  git: string
}

export type RunOptions = Omit<GitExecOptions, 'cwd'>

export function run(ctx: RepoContext, args: string[], options: RunOptions = {}): Promise<GitExecResult> {
  return runGit(ctx.git, args, { ...options, cwd: ctx.root })
}

/** Like `run`, but resolves with any exit code for callers that interpret it. */
export function exec(ctx: RepoContext, args: string[], options: RunOptions = {}): Promise<GitExecResult> {
  return execGit(ctx.git, args, { ...options, cwd: ctx.root })
}

/** Output as UTF-8 text. */
export async function runText(ctx: RepoContext, args: string[], options: RunOptions = {}): Promise<string> {
  return (await run(ctx, args, options)).stdout.toString('utf8')
}

/**
 * Read-only: no optional locks, so it never contends with another git process.
 * Reads are what Halo runs without being asked, so no filter program from the
 * repository's own config runs either (repo-config.ts). Writes (`run`) follow
 * a click and keep git's own behavior.
 */
export async function read(ctx: RepoContext, args: string[], options: RunOptions = {}): Promise<GitExecResult> {
  return run(ctx, [...(await automaticCommandArgs(ctx)), ...args], { ...options, readOnly: true })
}

export async function readText(ctx: RepoContext, args: string[], options: RunOptions = {}): Promise<string> {
  return (await read(ctx, args, options)).stdout.toString('utf8')
}
