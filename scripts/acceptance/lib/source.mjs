import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

export function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
}

export async function sourceIdentity(root) {
  const commit = git(root, ['rev-parse', 'HEAD']).trim()
  const digest = createHash('sha256').update(commit)
  const difference = git(root, ['diff', '--binary', 'HEAD', '--', '.', ':(exclude)tests/acceptance/output/**'])
  digest.update(difference)
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(name => name && !name.startsWith('tests/acceptance/output/')).sort()
  for (const name of untracked) {
    const filename = path.join(root, name)
    const stat = await fs.lstat(filename)
    if (!stat.isFile()) continue
    digest.update(name).update('\0').update(await fs.readFile(filename))
  }
  return { commit, dirty: Boolean(difference || untracked.length), worktreeHash: digest.digest('hex') }
}

export function resolveCurrentHead(root, head = 'HEAD') {
  if (!/^[a-zA-Z0-9_./-]+$/.test(head) || head.startsWith('-')) throw new Error('Invalid target revision')
  const target = git(root, ['rev-parse', '--verify', `${head}^{commit}`]).trim()
  if (target !== git(root, ['rev-parse', 'HEAD']).trim()) throw new Error('The selected head is not the current checkout; use an isolated checkout of the requested revision')
  return target
}

export function changedPaths(root, base, head = 'HEAD') {
  if (!base) return null
  if (!/^[a-zA-Z0-9_./-]+$/.test(base) || base.startsWith('-')) throw new Error('Invalid change baseline')
  git(root, ['rev-parse', '--verify', `${base}^{commit}`])
  resolveCurrentHead(root, head)
  git(root, ['merge-base', '--is-ancestor', base, head])
  const committed = git(root, ['diff', '--name-only', '--no-renames', '-z', base, head])
  const working = git(root, ['diff', '--name-only', '--no-renames', '-z', 'HEAD'])
  const added = git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
  return [...new Set([committed, working, added].flatMap(value => value.split('\0').filter(Boolean)))].sort()
}
