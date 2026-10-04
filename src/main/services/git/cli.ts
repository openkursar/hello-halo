/**
 * The one place git is spawned.
 *
 * Arguments are always an argv array (never a shell string) and paths always
 * follow `--`. Output is collected asynchronously and bounded; every command
 * has a deadline. Read-only commands run with GIT_OPTIONAL_LOCKS=0 so a status
 * refresh never takes `index.lock` away from an AI running git in the same
 * repository.
 */

import { spawn, type ChildProcess } from 'child_process'
import { GitError, classifyFailure } from './errors'

/**
 * Ahead of every subcommand: raw UTF-8 paths, no color, and no fsmonitor hook
 * (a repository's own config names that program, and status, diff and add
 * would run it). An empty value turns fsmonitor off in every supported git;
 * before 2.36 the value is a program path, so "false" would run `false`.
 * Child git processes inherit these through GIT_CONFIG_PARAMETERS.
 */
const GLOBAL_ARGS = ['-c', 'core.quotepath=off', '-c', 'color.ui=false', '-c', 'core.fsmonitor=']

/**
 * Inherited variables that would point git at another repository than the
 * one `cwd` names (set when Halo itself was started from inside a git hook).
 */
const REPOSITORY_LOCATION_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
]

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024
const STDERR_TAIL_CHARS = 16_000
const KILL_GRACE_MS = 3_000

export interface GitExecOptions {
  cwd: string
  /** Takes no optional lock (GIT_OPTIONAL_LOCKS=0): for commands that only read. */
  readOnly?: boolean
  stdin?: string
  /** Extra environment, e.g. GIT_INDEX_FILE for a temporary index. */
  env?: Record<string, string>
  timeoutMs?: number
  maxOutputBytes?: number
  /** At the output limit, stop reading and report `truncated` instead of failing. */
  truncate?: boolean
  /**
   * Run without a controlling terminal (own session on POSIX): an ssh, gpg or
   * credential prompt then fails at once instead of waiting forever.
   */
  detached?: boolean
  /** Exit codes that count as success. Default: 0. */
  okExitCodes?: number[]
}

export interface GitExecResult {
  stdout: Buffer
  stderr: string
  exitCode: number
  /** Output stopped at `maxOutputBytes`; the last record may be partial. */
  truncated: boolean
}

function buildEnv(options: GitExecOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of REPOSITORY_LOCATION_ENV) delete env[name]
  delete env.GIT_EXTERNAL_DIFF
  Object.assign(env, {
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_LITERAL_PATHSPECS: '1',
    GIT_PAGER: 'cat',
    GIT_EDITOR: ':',
  })
  if (options.readOnly) env.GIT_OPTIONAL_LOCKS = '0'
  if (options.env) Object.assign(env, options.env)
  return env
}

/** The git subcommand of an argv, skipping `-c name=value` pairs and flags. */
function subcommandOf(args: string[]): string {
  return args.find((arg, i) => !arg.startsWith('-') && args[i - 1] !== '-c') ?? 'git'
}

function terminate(child: ChildProcess, group: boolean, signal: NodeJS.Signals): void {
  try {
    if (group && child.pid) process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    // Already gone.
  }
}

/**
 * Run git and resolve with whatever exit code it ends with. Rejects only when
 * git could not run, ran past its deadline, or overflowed a hard output limit.
 */
export function execGit(executable: string, args: string[], options: GitExecOptions): Promise<GitExecResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const group = Boolean(options.detached) && process.platform !== 'win32'
  const subcommand = subcommandOf(args)

  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(executable, [...GLOBAL_ARGS, ...args], {
        cwd: options.cwd,
        env: buildEnv(options),
        stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: group,
      })
    } catch (error) {
      reject(new GitError('GIT_UNAVAILABLE', `Cannot run git: ${(error as Error).message}`))
      return
    }

    const chunks: Buffer[] = []
    let size = 0
    let stderr = ''
    let truncated = false
    let overflowed = false
    let timedOut = false
    let settled = false
    let killTimer: NodeJS.Timeout | undefined

    const stop = (): void => {
      terminate(child, group, 'SIGTERM')
      killTimer ??= setTimeout(() => terminate(child, group, 'SIGKILL'), KILL_GRACE_MS)
    }

    const deadline = setTimeout(() => {
      timedOut = true
      stop()
    }, timeoutMs)

    child.stdout!.on('data', (chunk: Buffer) => {
      if (truncated || overflowed) return
      const room = maxOutputBytes - size
      if (chunk.length <= room) {
        chunks.push(chunk)
        size += chunk.length
        return
      }
      if (room > 0) chunks.push(chunk.subarray(0, room))
      size = maxOutputBytes
      if (options.truncate) truncated = true
      else overflowed = true
      stop()
    })
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS)
    })

    const finish = (outcome: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      if (killTimer) clearTimeout(killTimer)
      outcome()
    }

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(() => {
        const code = error.code === 'ENOENT' || error.code === 'EACCES' ? 'GIT_UNAVAILABLE' : 'GIT_FAILED'
        reject(new GitError(code, `Cannot run git ${subcommand}: ${error.message}`))
      })
    })
    child.on('close', (exitCode) => {
      finish(() => {
        if (timedOut) {
          reject(new GitError('GIT_TIMEOUT', `git ${subcommand} did not finish within ${Math.round(timeoutMs / 1000)} s`))
        } else if (overflowed) {
          reject(new GitError('GIT_FAILED', `git ${subcommand} produced more than ${maxOutputBytes} bytes of output`))
        } else {
          resolve({ stdout: Buffer.concat(chunks), stderr, exitCode: exitCode ?? -1, truncated })
        }
      })
    })

    if (options.stdin !== undefined) {
      // git may exit before reading all of stdin; the broken pipe is not the failure to report.
      child.stdin!.on('error', () => {})
      child.stdin!.end(options.stdin)
    }
  })
}

/** Run git and throw a classified GitError unless it exits with an accepted code. */
export async function runGit(executable: string, args: string[], options: GitExecOptions): Promise<GitExecResult> {
  const result = await execGit(executable, args, options)
  if (result.truncated || (options.okExitCodes ?? [0]).includes(result.exitCode)) return result
  throw classifyFailure(subcommandOf(args), result.stderr, result.stdout.toString('utf8'))
}
