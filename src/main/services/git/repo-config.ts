/**
 * Filter programs a repository's own config names, kept out of the commands
 * Halo runs on its own.
 *
 * A filter driver (`filter.<x>.clean / smudge / process`, picked per path by
 * .gitattributes) runs whenever git re-hashes a file: status and diff do so for
 * every file whose stat data changed — every file of a freshly extracted copy —
 * and so does the snapshot's `add -A`. Drivers from the user's own config
 * (system, global, command line) stay; any of these keys that a repository's
 * config sets (local or worktree scope, and the files those include) is put
 * back to the user's value, or switched off. Git before 2.26 cannot tell
 * where a value came from (`--show-scope`), so there every driver is switched off.
 */

import { execGit } from './cli'
import type { RepoContext } from './context'
import { classifyFailure } from './errors'

const FILTER_KEY = /^filter\..+\.(clean|smudge|process|required)$/
const USER_SCOPES = new Set(['system', 'global', 'command'])
/** git config's exit code for an option it does not know. */
const UNKNOWN_OPTION = 129

interface Entry {
  scope: string | null
  key: string
  /** Undefined for a bare boolean key (`required` alone means true). */
  value: string | undefined
}

/** `git config -z --get-regexp` output, with or without a scope before each entry. */
export function parseConfigEntries(output: string, withScope: boolean): Entry[] {
  const fields = output.split('\0')
  if (fields[fields.length - 1] === '') fields.pop()
  const entries: Entry[] = []
  for (let i = 0; i < fields.length; i++) {
    const scope = withScope ? fields[i++] : null
    const record = fields[i] ?? ''
    const newline = record.indexOf('\n')
    entries.push({
      scope,
      key: newline === -1 ? record : record.slice(0, newline),
      value: newline === -1 ? undefined : record.slice(newline + 1),
    })
  }
  return entries
}

/**
 * `-c key=value` pairs restoring every filter key a repository sets to the
 * user's own value, or to nothing.
 */
export function filterOverrides(entries: Entry[]): string[] {
  const userValue = new Map<string, string>()
  const repositoryKeys = new Set<string>()
  for (const { scope, key, value } of entries) {
    if (!FILTER_KEY.test(key)) continue
    if (scope !== null && USER_SCOPES.has(scope)) userValue.set(key, value ?? 'true')
    else repositoryKeys.add(key)
  }
  return [...repositoryKeys].flatMap((key) => {
    const restored = userValue.get(key) ?? (key.endsWith('.required') ? 'false' : '')
    return ['-c', `${key}=${restored}`]
  })
}

async function readOverrides(ctx: RepoContext): Promise<string[]> {
  const options = { cwd: ctx.root, readOnly: true }
  const query = ['-z', '--includes', '--get-regexp', '^filter\\.']
  let result = await execGit(ctx.git, ['config', '--show-scope', ...query], options)
  const scoped = result.exitCode !== UNKNOWN_OPTION
  if (!scoped) result = await execGit(ctx.git, ['config', ...query], options)
  // 1: no filter key anywhere.
  if (result.exitCode === 1) return []
  if (result.exitCode !== 0) throw classifyFailure('config', result.stderr, result.stdout.toString('utf8'))
  return filterOverrides(parseConfigEntries(result.stdout.toString('utf8'), scoped))
}

const overridesByRequest = new WeakMap<RepoContext, Promise<string[]>>()

/** The overrides for one request's repository context, read once per request. */
export function automaticCommandArgs(ctx: RepoContext): Promise<string[]> {
  let pending = overridesByRequest.get(ctx)
  if (!pending) {
    pending = readOverrides(ctx)
    overridesByRequest.set(ctx, pending)
  }
  return pending
}
