/**
 * Which git binary to run, decided on first use and cached.
 *
 * Nothing here runs at startup. The answer is keyed by PATH because the GUI
 * process gets the login-shell PATH only after the window loads (fix-path):
 * a lookup made before that must not pin a worse answer for the session.
 * A missing or broken git is re-checked after a short pause rather than
 * cached for good, so installing git takes effect without a restart.
 */

import { access, stat } from 'fs/promises'
import { constants } from 'fs'
import { delimiter, dirname, join } from 'path'
import type { GitAvailability } from '../../../shared/types/git'
import { getAppLocalGitBashDir } from '../git-bash'
import { execGit } from './cli'
import { GitError } from './errors'

/** `git restore` is the oldest command the service relies on. */
const MIN_VERSION: [number, number] = [2, 23]
const FAILURE_RECHECK_MS = 60_000
const PROBE_TIMEOUT_MS = 10_000

interface Located {
  executable: string
  version: string
}

let found: { key: string; located: Located } | null = null
let missing: { key: string; at: number; availability: GitAvailability } | null = null
let probe: Promise<Located | GitAvailability> | null = null
let lastLogged = ''

async function isExecutableFile(file: string): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) return false
    if (process.platform !== 'win32') await access(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Candidate paths in priority order; existence is checked by the caller. */
function candidates(): string[] {
  const pathDirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  if (process.platform !== 'win32') {
    return [...pathDirs.map((dir) => join(dir, 'git')), '/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git']
  }

  const list = pathDirs.map((dir) => join(dir, 'git.exe'))
  // The portable Git that Halo installs for the CLI (services/git-bash).
  const managed = getAppLocalGitBashDir()
  list.push(join(managed, 'cmd', 'git.exe'), join(managed, 'bin', 'git.exe'), join(managed, 'mingw64', 'bin', 'git.exe'))
  // A Git Bash the user pointed Halo at: <root>\bin\bash.exe or <root>\usr\bin\bash.exe.
  const bash = process.env.CLAUDE_CODE_GIT_BASH_PATH
  if (bash && !bash.includes('mock-bash')) {
    for (const root of [dirname(dirname(bash)), dirname(dirname(dirname(bash)))]) {
      list.push(join(root, 'cmd', 'git.exe'), join(root, 'bin', 'git.exe'))
    }
  }
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs')]) {
    if (base) list.push(join(base, 'Git', 'cmd', 'git.exe'))
  }
  return list
}

function parseVersion(output: string): { text: string; major: number; minor: number } | null {
  const match = /git version ((\d+)\.(\d+)\S*(?: \([^)]*\))?)/.exec(output)
  return match ? { text: match[1], major: Number(match[2]), minor: Number(match[3]) } : null
}

async function locate(): Promise<Located | GitAvailability> {
  let executable: string | null = null
  for (const candidate of candidates()) {
    if (await isExecutableFile(candidate)) {
      executable = candidate
      break
    }
  }
  if (!executable) return { available: false, reason: 'not-installed' }

  try {
    const result = await execGit(executable, ['--version'], { cwd: dirname(executable), timeoutMs: PROBE_TIMEOUT_MS })
    const output = result.stdout.toString('utf8')
    const version = parseVersion(output)
    if (result.exitCode !== 0 || !version) {
      // macOS without the command line tools: /usr/bin/git is a stub that fails here.
      return { available: false, reason: 'not-runnable', detail: (result.stderr || output).trim().slice(0, 500) }
    }
    if (version.major < MIN_VERSION[0] || (version.major === MIN_VERSION[0] && version.minor < MIN_VERSION[1])) {
      return { available: false, reason: 'not-runnable', detail: `Git ${MIN_VERSION.join('.')} or newer is required; found ${version.text} at ${executable}` }
    }
    return { executable, version: version.text }
  } catch (error) {
    return { available: false, reason: 'not-runnable', detail: (error as Error).message }
  }
}

function report(outcome: Located | GitAvailability): void {
  const line = 'executable' in outcome
    ? `[Git] Using ${outcome.executable} (git ${outcome.version})`
    : `[Git] Git unavailable: ${outcome.available ? '' : `${outcome.reason}${outcome.detail ? ` — ${outcome.detail}` : ''}`}`
  if (line === lastLogged) return
  lastLogged = line
  if ('executable' in outcome) console.log(line)
  else console.warn(line)
}

async function resolve(): Promise<Located | GitAvailability> {
  const key = `${process.platform}|${process.env.PATH ?? ''}|${process.env.CLAUDE_CODE_GIT_BASH_PATH ?? ''}`
  if (found?.key === key) return found.located
  if (missing?.key === key && Date.now() - missing.at < FAILURE_RECHECK_MS) return missing.availability

  probe ??= locate().finally(() => {
    probe = null
  })
  const outcome = await probe
  report(outcome)
  if ('executable' in outcome) {
    found = { key, located: outcome }
    missing = null
  } else {
    missing = { key, at: Date.now(), availability: outcome }
  }
  return outcome
}

export async function getGitAvailability(): Promise<GitAvailability> {
  const outcome = await resolve()
  return 'executable' in outcome ? { available: true, version: outcome.version } : outcome
}

/** The git binary to run; throws GIT_UNAVAILABLE when there is none. */
export async function requireGitExecutable(): Promise<string> {
  const outcome = await resolve()
  if ('executable' in outcome) return outcome.executable
  const detail = outcome.available ? '' : outcome.detail
  throw new GitError('GIT_UNAVAILABLE', detail ? `Git is not available: ${detail}` : 'Git is not installed')
}
