/**
 * Real git repositories in the system temp directory for the git service
 * tests, with git isolated from the machine's user and system config.
 */

import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

const ISOLATION_KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'] as const

/** A scratch directory (real path, so it compares equal to what git prints). */
export function makeTempDir(prefix = 'halo-git-test-'): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

/**
 * Point git (ours and the service's, which inherits process.env) at a private
 * global config with a fixed identity. Returns the undo.
 */
export function isolateGit(): () => void {
  const saved = Object.fromEntries(ISOLATION_KEYS.map((key) => [key, process.env[key]]))
  const dir = makeTempDir('halo-git-config-')
  const config = join(dir, 'gitconfig')
  writeFileSync(
    config,
    [
      '[user]',
      '\tname = Halo Test',
      '\temail = test@halo.invalid',
      '[init]',
      '\tdefaultBranch = main',
      '[commit]',
      '\tgpgsign = false',
      '[core]',
      '\tautocrlf = false',
      '[advice]',
      '\tdetachedHead = false',
      '',
    ].join('\n'),
  )
  process.env.GIT_CONFIG_GLOBAL = config
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  return () => {
    for (const key of ISOLATION_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

export interface TestRepo {
  root: string
  git: (...args: string[]) => string
  write: (path: string, content: string | Buffer) => void
  commitAll: (message: string) => string
}

/** Helpers bound to an existing working tree. */
export function openRepo(root: string): TestRepo {
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const write = (path: string, content: string | Buffer): void => {
    const file = join(root, ...path.split('/'))
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  const commitAll = (message: string): string => {
    git('add', '-A')
    git('commit', '-q', '-m', message)
    return git('rev-parse', 'HEAD').trim()
  }
  return { root, git, write, commitAll }
}

export function initRepo(root: string, ...initArgs: string[]): TestRepo {
  mkdirSync(root, { recursive: true })
  const repo = openRepo(root)
  repo.git('init', '-q', ...initArgs)
  return repo
}

/** A bare repository to push to, and a clone of it at `at` with one commit pushed. */
export function cloneWithRemote(at: string): { remote: string; repo: TestRepo; cleanup: () => void } {
  const remote = makeTempDir('halo-git-remote-')
  initRepo(remote, '--bare')
  const seed = initRepo(makeTempDir('halo-git-seed-'))
  seed.write('README.md', 'seed\n')
  seed.commitAll('seed')
  seed.git('push', '-q', remote, 'HEAD:refs/heads/main')
  execFileSync('git', ['clone', '-q', remote, at], { stdio: 'ignore' })
  return {
    remote,
    repo: openRepo(at),
    cleanup: () => {
      rmSync(remote, { recursive: true, force: true })
      rmSync(seed.root, { recursive: true, force: true })
    },
  }
}
