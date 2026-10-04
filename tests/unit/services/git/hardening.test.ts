/**
 * What Halo runs on its own must not run a program a repository's config
 * names. The repositories here are armed with an fsmonitor hook, external
 * diffs, a textconv driver, GIT_EXTERNAL_DIFF and filter drivers; plain git
 * runs each of them (the control), the service's reads run none. Filter
 * drivers from the user's own config keep working, and writes — which follow
 * a click — keep git's own behavior.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import { appendFileSync, chmodSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  countChangedSince,
  createSnapshot,
  discardPaths,
  getChangeList,
  getWorkingTreeStatus,
  readFileContents,
  stagePaths,
  unstagePaths,
} from '../../../../src/main/services/git'
import { filterOverrides, parseConfigEntries } from '../../../../src/main/services/git/repo-config'
import { initRepo, isolateGit, makeTempDir, openRepo } from './_repo'

const { spaces } = vi.hoisted(() => ({ spaces: new Map<string, string>() }))
vi.mock('../../../../src/main/services/space.service', () => ({
  getSpaceDir: (spaceId: string) => spaces.get(spaceId) ?? '',
}))
vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' }, shell: { trashItem: vi.fn() } }))

const posix = process.platform !== 'win32'

let restoreGit: () => void
let base: string
let dir: string
let marks: string
let envExternalDiff: string
let savedExternalDiff: string | undefined

/** A program that leaves a mark named `name` and passes its input file through. */
function tripwire(name: string): string {
  const script = join(base, `${name}.sh`)
  writeFileSync(script, `#!/bin/sh\ntouch '${join(marks, name)}'\ncat "$1" 2>/dev/null\nexit 0\n`)
  chmodSync(script, 0o755)
  return script
}

/** Marks left since the last call. */
function takeMarks(): string[] {
  const names = readdirSync(marks).sort()
  for (const name of names) rmSync(join(marks, name))
  return names
}

function plainGit(args: string[], externalDiff = false): void {
  const env = { ...process.env }
  if (externalDiff) env.GIT_EXTERNAL_DIFF = envExternalDiff
  else delete env.GIT_EXTERNAL_DIFF
  execFileSync('git', args, { cwd: dir, env, stdio: 'ignore' })
}

beforeAll(() => {
  if (!posix) return
  restoreGit = isolateGit()
  base = makeTempDir('halo-git-hardening-')
  dir = join(base, 'repo')
  marks = join(base, 'marks')
  mkdirSync(marks)
  spaces.set('s', dir)
  const repo = initRepo(dir)
  repo.write('.gitattributes', '*.txt diff=armed\n')
  repo.write('notes.txt', 'one\n')
  repo.write('app.ts', 'export const a = 1\n')
  repo.commitAll('base')
  repo.write('notes.txt', 'one\ntwo\n')
  repo.write('app.ts', 'export const a = 2\n')
  repo.write('new.txt', 'fresh\n')
  repo.git('add', 'app.ts')
  repo.git('config', 'core.fsmonitor', tripwire('fsmonitor'))
  repo.git('config', 'diff.external', tripwire('external-diff'))
  repo.git('config', 'diff.armed.command', tripwire('diff-command'))
  repo.git('config', 'diff.armed.textconv', tripwire('textconv'))
  envExternalDiff = tripwire('env-external-diff')
  savedExternalDiff = process.env.GIT_EXTERNAL_DIFF
  process.env.GIT_EXTERNAL_DIFF = envExternalDiff
})

afterAll(() => {
  if (!posix) return
  if (savedExternalDiff === undefined) delete process.env.GIT_EXTERNAL_DIFF
  else process.env.GIT_EXTERNAL_DIFF = savedExternalDiff
  restoreGit()
  rmSync(base, { recursive: true, force: true })
})

describe.skipIf(!posix)('programs named by repository config', () => {
  it('are armed: plain git runs every one of them', () => {
    takeMarks()
    plainGit(['status', '--porcelain'])
    expect(takeMarks()).toContain('fsmonitor')
    plainGit(['-c', 'core.fsmonitor=', 'diff', 'HEAD', '--', 'app.ts'], true)
    expect(takeMarks()).toEqual(['env-external-diff'])
    plainGit(['-c', 'core.fsmonitor=', 'diff', 'HEAD', '--', 'app.ts'])
    expect(takeMarks()).toEqual(['external-diff'])
    plainGit(['-c', 'core.fsmonitor=', 'diff', 'HEAD', '--', 'notes.txt'])
    expect(takeMarks()).toEqual(['diff-command'])
    plainGit(['-c', 'core.fsmonitor=', 'diff', '--no-ext-diff', 'HEAD', '--', 'notes.txt'])
    expect(takeMarks()).toEqual(['textconv'])
  })

  it('never run for status, change lists, file contents, snapshots, stage or unstage', async () => {
    takeMarks()
    const status = await getWorkingTreeStatus('s', dir)
    expect(status.unstaged.map((file) => file.path).sort()).toEqual(['new.txt', 'notes.txt'])

    const uncommitted = await getChangeList('s', dir, { kind: 'uncommitted' })
    expect(uncommitted.files.map((file) => file.path).sort()).toEqual(['app.ts', 'new.txt', 'notes.txt'])
    await getChangeList('s', dir, { kind: 'staged' })
    await getChangeList('s', dir, { kind: 'revision', revision: 'HEAD', mergeBase: false })
    const snapshot = await createSnapshot('s', dir)
    await getChangeList('s', dir, { kind: 'since-review', snapshot: snapshot.tree })
    expect(await countChangedSince('s', dir, snapshot.tree)).toBe(0)

    const contents = await readFileContents('s', dir, { scope: uncommitted.scope, beforeRevision: uncommitted.beforeRevision, path: 'notes.txt' })
    expect(contents).toMatchObject({ before: 'one\n', after: 'one\ntwo\n' })
    await readFileContents('s', dir, { scope: { kind: 'staged' }, beforeRevision: uncommitted.beforeRevision, path: 'app.ts' })

    await stagePaths('s', dir, ['notes.txt'])
    await unstagePaths('s', dir, ['notes.txt'])

    expect(takeMarks()).toEqual([])
  })
})

/** A filter program that leaves a mark and transforms its input with `transform`. */
function filterTripwire(name: string, transform = 'cat'): string {
  const script = join(base, `${name}.sh`)
  writeFileSync(script, `#!/bin/sh\ntouch '${join(marks, name)}'\n${transform}\n`)
  chmodSync(script, 0o755)
  return script
}

describe('filter overrides', () => {
  it('put every key a repository sets back to the user\'s value, or switch it off', () => {
    const output = [
      'global', 'filter.lfs.clean\ngit-lfs clean -- %f',
      'global', 'filter.lfs.required\ntrue',
      'local', 'filter.lfs.clean\nevil',
      'local', 'filter.Evil.smudge\nevil',
      'worktree', 'filter.a.b.process\nevil',
      'local', 'filter.bare.required',
      'local', 'filter.x.other\nignored',
      '',
    ].join('\0')
    expect(filterOverrides(parseConfigEntries(output, true))).toEqual([
      '-c', 'filter.lfs.clean=git-lfs clean -- %f',
      '-c', 'filter.Evil.smudge=',
      '-c', 'filter.a.b.process=',
      '-c', 'filter.bare.required=false',
    ])
  })

  it('switch off every driver when git cannot say where a value came from', () => {
    const output = ['filter.lfs.clean\ngit-lfs clean -- %f', 'filter.lfs.required\ntrue', ''].join('\0')
    expect(filterOverrides(parseConfigEntries(output, false))).toEqual(['-c', 'filter.lfs.clean=', '-c', 'filter.lfs.required=false'])
  })
})

describe.skipIf(!posix)('filter programs', () => {
  let extracted: string
  let control: string
  let userFilters: string

  beforeAll(() => {
    // A repository as it arrives in an archive: its own config names a filter for every .txt file.
    const original = join(base, 'archived')
    const repo = initRepo(original)
    repo.write('.gitattributes', '*.txt filter=evil\n')
    repo.write('a.txt', 'alpha\n')
    repo.write('b.txt', 'beta\n')
    repo.commitAll('base')
    repo.git('config', 'filter.evil.clean', filterTripwire('evil-clean'))
    repo.git('config', 'filter.evil.smudge', filterTripwire('evil-smudge'))
    repo.git('config', 'filter.evil.required', 'true')
    // Copies get new inodes and ctimes: every file's stat data differs from the index, as after extracting.
    extracted = join(base, 'extracted')
    control = join(base, 'control')
    cpSync(original, extracted, { recursive: true })
    cpSync(original, control, { recursive: true })
    writeFileSync(join(extracted, 'a.txt'), 'alpha\nmore\n')
    writeFileSync(join(extracted, 'new.txt'), 'new\n')
    spaces.set('extracted', extracted)

    // The user's own config defines "upper"; a repository redefines it and adds "lower".
    appendFileSync(process.env.GIT_CONFIG_GLOBAL!, `[filter "upper"]\n\tclean = ${filterTripwire('user-upper', 'tr a-z A-Z')}\n`)
    userFilters = join(base, 'user-filters')
    const own = initRepo(userFilters)
    own.write('.gitattributes', '*.up filter=upper\n*.low filter=lower\n')
    own.write('seed.md', 'seed\n')
    own.commitAll('base')
    own.git('config', 'filter.upper.clean', filterTripwire('repo-upper'))
    own.git('config', 'filter.lower.clean', 'tr A-Z a-z')
    own.git('config', 'filter.lower.smudge', 'tr a-z A-Z')
    spaces.set('user', userFilters)
  })

  it('are armed: plain git status runs the repository\'s clean filter on an extracted copy', () => {
    takeMarks()
    execFileSync('git', ['status', '--porcelain'], { cwd: control, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: 'ignore' })
    expect(takeMarks()).toContain('evil-clean')
  })

  it('from the repository never run for status, change lists, file contents or snapshots', async () => {
    takeMarks()
    const status = await getWorkingTreeStatus('extracted', extracted)
    expect(status.unstaged.map((file) => `${file.state} ${file.path}`).sort()).toEqual(['modified a.txt', 'untracked new.txt'])

    const uncommitted = await getChangeList('extracted', extracted, { kind: 'uncommitted' })
    expect(uncommitted.files.map((file) => file.path).sort()).toEqual(['a.txt', 'new.txt'])
    await getChangeList('extracted', extracted, { kind: 'staged' })
    await getChangeList('extracted', extracted, { kind: 'revision', revision: 'HEAD', mergeBase: false })
    const snapshot = await createSnapshot('extracted', extracted)
    await getChangeList('extracted', extracted, { kind: 'since-review', snapshot: snapshot.tree })
    expect(await countChangedSince('extracted', extracted, snapshot.tree)).toBe(0)
    const contents = await readFileContents('extracted', extracted, { scope: uncommitted.scope, beforeRevision: uncommitted.beforeRevision, path: 'a.txt' })
    expect(contents).toMatchObject({ before: 'alpha\n', after: 'alpha\nmore\n' })

    expect(takeMarks()).toEqual([])
  })

  it('from the user\'s own config keep working, even where a repository redefines them', async () => {
    writeFileSync(join(userFilters, 'note.up'), 'hello\n')
    takeMarks()
    const snapshot = await createSnapshot('user', userFilters)
    expect(takeMarks()).toEqual(['user-upper'])
    expect(openRepo(userFilters).git('cat-file', 'blob', `${snapshot.tree}:note.up`)).toBe('HELLO\n')
  })

  it('run as git runs them for stage and discard, which follow a click', async () => {
    writeFileSync(join(userFilters, 'x.low'), 'Mixed Case\n')
    await stagePaths('user', userFilters, ['x.low'])
    const own = openRepo(userFilters)
    expect(own.git('cat-file', 'blob', ':x.low')).toBe('mixed case\n')
    writeFileSync(join(userFilters, 'x.low'), 'edited\n')
    await discardPaths('user', userFilters, ['x.low'])
    expect(readFileSync(join(userFilters, 'x.low'), 'utf8')).toBe('MIXED CASE\n')
  })
})
