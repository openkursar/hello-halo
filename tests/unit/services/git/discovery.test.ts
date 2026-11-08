import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import * as fsPromises from 'fs/promises'

vi.mock('fs/promises', async (importOriginal) => ({ ...await importOriginal<typeof import('fs/promises')>() }))
import { discoverRepository, forgetRepository, getWorkingTreeStatus, listRepositories, openRepository, resolveRepository } from '../../../../src/main/services/git'
import * as cli from '../../../../src/main/services/git/cli'
import { readRepositoryRecords, updateRepositoryRecord } from '../../../../src/main/services/git/repository-store'
import { initRepo, isolateGit, makeTempDir } from './_repo'

const { spaces } = vi.hoisted(() => ({ spaces: new Map<string, { path: string; workingDir: string; isTemp: boolean }>() }))
vi.mock('../../../../src/main/services/space.service', () => ({
  getSpaceDir: (id: string) => spaces.get(id)?.workingDir ?? '',
  getSpace: (id: string) => spaces.get(id),
}))

let restoreGit: () => void
let base: string
let root: string
let data: string
let store: string
beforeAll(() => { restoreGit = isolateGit() })
afterAll(() => restoreGit())
beforeEach(() => {
  base = makeTempDir('halo-git-discovery-')
  root = join(base, 'workspace')
  data = join(base, 'data')
  store = join(data, '.halo', 'git', 'repositories.json')
  mkdirSync(root)
  spaces.set('s', { path: data, workingDir: root, isTemp: false })
})
afterEach(() => {
  vi.restoreAllMocks()
  spaces.clear()
  rmSync(base, { recursive: true, force: true })
})

function deepRepo() {
  const repo = initRepo(join(root, 'projects', 'nested', 'app'))
  repo.write('src/a.ts', 'hello\n')
  return repo
}

describe('opened-file repository discovery', () => {
  it('finds the nearest independent ignored root without deepening the default scan', async () => {
    const outer = initRepo(root)
    outer.write('.gitignore', 'projects/\n')
    const inner = deepRepo()
    expect((await listRepositories('s')).repositories.map((repo) => repo.root)).toEqual([root])
    expect(await discoverRepository('s', join(inner.root, 'src/a.ts'))).toMatchObject({ repository: { root: inner.root, relativePath: 'projects/nested/app' }, remembered: true })
    expect((await listRepositories('s')).repositories.map((repo) => repo.root)).toEqual([root, inner.root])
    expect(await discoverRepository('s', join(root, 'README.md'))).toMatchObject({ repository: { root }, remembered: true })
    expect((await readRepositoryRecords('s', root)).roots).toEqual([inner.root, root])
  })

  it('shares concurrent and repeated probes by directory without status or recursive work', async () => {
    const repo = deepRepo()
    const run = vi.spyOn(cli, 'runGit')
    const values = await Promise.all(Array.from({ length: 12 }, (_, i) => discoverRepository('s', join(repo.root, `src/${i}.ts`))))
    expect(values.every((value) => value?.repository.root === repo.root && value.remembered)).toBe(true)
    const count = run.mock.calls.length
    await discoverRepository('s', join(repo.root, 'src/again.ts'))
    expect(run).toHaveBeenCalledTimes(count)
    expect(run.mock.calls.filter(([, args]) => args.join(' ') === 'rev-parse --show-toplevel')).toHaveLength(1)
    expect(run.mock.calls.some(([, args]) => args.includes('status') || args.includes('ls-files'))).toBe(false)
  })

  it('caches expected negative probes briefly and rechecks after expiry', async () => {
    const run = vi.spyOn(cli, 'runGit')
    expect(await discoverRepository('s', join(root, 'a.txt'))).toBeNull()
    const count = run.mock.calls.length
    initRepo(root)
    expect(await discoverRepository('s', join(root, 'b.txt'))).toBeNull()
    expect(run).toHaveBeenCalledTimes(count)
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000)
    expect(await discoverRepository('s', join(root, 'c.txt'))).toMatchObject({ repository: { root } })
  })

  it('bounds directory probes and evicts the oldest space state', async () => {
    const run = vi.spyOn(cli, 'runGit')
    await discoverRepository('s', join(root, 'a'))
    for (let i = 0; i < 128; i++) await discoverRepository('s', join(root, `missing-${i}/a`))
    await discoverRepository('s', join(root, 'b'))
    expect(run.mock.calls.filter(([, args]) => args.join(' ') === 'rev-parse --show-toplevel')).toHaveLength(2)
    const repo = deepRepo()
    await discoverRepository('s', join(repo.root, 'src/a.ts'))
    for (let i = 0; i < 32; i++) {
      spaces.set(`space-${i}`, { path: data, workingDir: root, isTemp: false })
      await discoverRepository(`space-${i}`, join(root, 'missing/a'))
    }
    expect((await listRepositories('s')).repositories.map((item) => item.root)).toEqual([repo.root])
  })

  it('reports capacity without evicting remembered deep roots', async () => {
    const roots = Array.from({ length: 64 }, (_, index) => join(root, 'deep', `repo-${index}`))
    mkdirSync(join(data, '.halo/git'), { recursive: true })
    writeFileSync(store, JSON.stringify({ version: 2, workingDir: root, roots, dismissedRoots: [] }))
    const repo = deepRepo()
    expect(await discoverRepository('s', join(repo.root, 'src/a.ts'))).toMatchObject({
      repository: { root: repo.root }, remembered: false, recordError: { code: 'GIT_FAILED' },
    })
    expect((await readRepositoryRecords('s', root)).roots).toEqual(roots)
    expect((await listRepositories('s')).repositories.map((entry) => entry.root)).toEqual([...roots, repo.root])
  })

  it('does not resurrect a forgotten root when its probe completes', async () => {
    const repo = deepRepo()
    const original = cli.runGit
    let release!: () => void
    let started!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve })
    const entered = new Promise<void>((resolve) => { started = resolve })
    vi.spyOn(cli, 'runGit').mockImplementation(async (git, args, options) => {
      if (args.join(' ') === 'rev-parse --show-toplevel') {
        started()
        await waiting
      }
      return original(git, args, options)
    })
    const pending = discoverRepository('s', join(repo.root, 'src/a.ts'))
    await entered
    await forgetRepository('s', repo.root)
    release()
    await pending
    expect((await listRepositories('s')).repositories).toEqual([])
  })

  it('never probes remembered repository paths or runs Git summaries while listing', async () => {
    const outer = initRepo(root)
    const repo = deepRepo()
    await openRepository('s', repo.root)
    const original = fsPromises.lstat
    const pathRead = vi.spyOn(fsPromises, 'lstat').mockImplementation(async (...args) => {
      if (String(args[0]).startsWith(repo.root)) throw new Error('Unselected path must not be touched')
      return original(...args)
    })
    const run = vi.spyOn(cli, 'runGit')
    const listed = await listRepositories('s')
    expect(listed.repositories.map((entry) => entry.root)).toEqual([outer.root, repo.root])
    expect(run).not.toHaveBeenCalled()
    expect(pathRead.mock.calls.some(([path]) => String(path).startsWith(repo.root))).toBe(false)
  })

  it('ignores a probe after its space data identity changes', async () => {
    const repo = deepRepo()
    const original = cli.runGit
    let release!: () => void
    let entered!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    vi.spyOn(cli, 'runGit').mockImplementation(async (git, args, options) => {
      if (args.join(' ') === 'rev-parse --show-toplevel') {
        entered()
        await waiting
      }
      return original(git, args, options)
    })
    const pending = discoverRepository('s', join(repo.root, 'src/a.ts'))
    await started
    spaces.get('s')!.path = join(base, 'replacement-data')
    release()
    expect(await pending).toBeNull()
    expect(existsSync(store)).toBe(false)
    expect((await listRepositories('s')).repositories).toEqual([])
  })

  it('returns null for outside, missing, hidden and Git-internal parents', async () => {
    const outside = initRepo(join(base, 'outside'))
    initRepo(root)
    for (const file of [join(outside.root, 'a'), join(root, 'missing/a'), join(root, '.git/config'), join(root, '.git'), join(root, '.hidden/a')]) {
      expect(await discoverRepository('s', file)).toBeNull()
    }
  })

  it('refuses symlink directories including an intermediate escape and dot-segment aliases', async () => {
    const repo = deepRepo()
    symlinkSync(join(root, 'projects'), join(root, 'alias'), 'junction')
    const outside = initRepo(join(base, 'outside'))
    symlinkSync(outside.root, join(root, 'escape'), 'junction')
    symlinkSync(root, join(outside.root, 'back'), 'junction')
    for (const selected of [join(root, 'alias/nested/app'), join(root, 'escape'), join(root, 'escape/back/projects/nested/app'), `${root}/projects/../projects/nested/app`]) {
      await expect(openRepository('s', selected)).rejects.toMatchObject({ code: 'GIT_NOT_A_REPOSITORY' })
      expect(await discoverRepository('s', `${selected}/a.ts`)).toBeNull()
    }
    await expect(openRepository('s', outside.root)).rejects.toMatchObject({ code: 'GIT_NOT_A_REPOSITORY' })
    await openRepository('s', repo.root)
    renameSync(join(root, 'projects'), join(root, 'moved'))
    symlinkSync(join(root, 'moved'), join(root, 'projects'), 'junction')
    await expect(resolveRepository('s', repo.root)).rejects.toMatchObject({ code: 'GIT_NOT_A_REPOSITORY' })
  })

  it('does not register a forged gitfile but accepts external linked-worktree metadata', async () => {
    const outside = initRepo(join(base, 'outside'))
    outside.write('a.txt', 'a\n')
    outside.commitAll('base')
    const linked = join(root, 'deep', 'linked')
    mkdirSync(join(root, 'deep'))
    outside.git('worktree', 'add', '-q', '-b', 'linked', linked)
    expect(await openRepository('s', linked)).toMatchObject({ root: linked, branch: 'linked' })
    for (const [name, pointer] of [['forged-main', join(outside.root, '.git')], ['forged-linked', outside.git('-C', linked, 'rev-parse', '--absolute-git-dir').trim()]]) {
      const fake = join(root, name)
      mkdirSync(fake)
      writeFileSync(join(fake, '.git'), `gitdir: ${pointer}\n`)
      await expect(openRepository('s', fake)).rejects.toMatchObject({ code: 'GIT_NOT_A_REPOSITORY' })
      expect(await discoverRepository('s', join(fake, 'a'))).toBeNull()
    }
  })

  it('preserves separate-git-dir repositories with external metadata', async () => {
    const selected = join(root, 'separated')
    const metadata = join(base, 'separate-metadata')
    const helper = initRepo(join(base, 'helper'))
    helper.git('init', '-q', `--separate-git-dir=${metadata}`, selected)
    expect(await openRepository('s', selected)).toMatchObject({ root: selected })
    expect((await listRepositories('s')).repositories.some((repo) => repo.root === selected)).toBe(true)
  })

  it('accepts submodule gitfiles whose metadata config identifies their worktree', async () => {
    const source = initRepo(join(base, 'source'))
    source.write('a.txt', 'a\n')
    source.commitAll('base')
    const outer = initRepo(root)
    outer.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source.root, 'deep/module')
    const nested = join(root, 'deep/module')
    expect(await openRepository('s', nested)).toMatchObject({ root: nested })
    expect(await discoverRepository('s', join(nested, 'a.txt'))).toMatchObject({ repository: { root: nested }, remembered: true })
  })

  it('rejects malformed Git metadata and exact non-root manual selections', async () => {
    const repo = deepRepo()
    await expect(openRepository('s', join(repo.root, 'src'))).rejects.toMatchObject({ code: 'GIT_NOT_A_REPOSITORY' })
    await expect(openRepository('s', join(root, 'projects'))).rejects.toMatchObject({ code: 'GIT_NOT_A_REPOSITORY' })
    const broken = join(root, 'broken')
    mkdirSync(broken)
    writeFileSync(join(broken, '.git'), 'not a git pointer\n')
    await expect(openRepository('s', broken)).rejects.toMatchObject({ code: 'GIT_NOT_A_REPOSITORY' })
    expect(await discoverRepository('s', join(broken, 'a.ts'))).toBeNull()
    writeFileSync(join(broken, '.git'), 'gitdir: /does/not/exist\n')
    await expect(openRepository('s', broken)).rejects.toMatchObject({ code: 'GIT_NOT_A_REPOSITORY' })
    expect(existsSync(store)).toBe(false)
  })
})

describe('shared repository records', () => {
  it('remembers a shallow path only after selection and keeps routine status reads free of record I/O', async () => {
    const repo = initRepo(join(root, 'child'))
    repo.write('a.txt', 'a\n')
    expect((await listRepositories('s', { shallow: true })).repositories).toContainEqual({ root: repo.root, name: 'child', relativePath: 'child', remembered: false })
    expect(existsSync(store)).toBe(false)
    expect(await getWorkingTreeStatus('s', repo.root, true)).toMatchObject({ repo: { root: repo.root }, remembered: true })
    expect((await readRepositoryRecords('s', root)).roots).toEqual([repo.root])
    const read = vi.spyOn(fsPromises, 'open')
    await getWorkingTreeStatus('s', repo.root)
    expect(read.mock.calls.some(([path]) => String(path) === store || String(path).startsWith(`${store}.`))).toBe(false)
    await forgetRepository('s', repo.root)
    expect(await getWorkingTreeStatus('s', repo.root, true)).toMatchObject({ remembered: false })
    expect((await listRepositories('s', { shallow: true })).repositories).toEqual([])
  })

  it('persists unique roots without probing unavailable paths during listing', async () => {
    const repo = deepRepo()
    await Promise.all(Array.from({ length: 5 }, () => openRepository('s', repo.root)))
    expect(JSON.parse(readFileSync(store, 'utf8'))).toEqual({ version: 2, workingDir: root, roots: [repo.root], dismissedRoots: [] })
    expect((await readRepositoryRecords('s', root)).roots).toEqual([repo.root])
    expect((await listRepositories('s')).repositories).toEqual([{ root: repo.root, name: 'app', relativePath: 'projects/nested/app', remembered: true }])
    const before = readFileSync(store, 'utf8')
    renameSync(repo.root, `${repo.root}-moved`)
    const run = vi.spyOn(cli, 'runGit')
    for (let i = 0; i < 2; i++) {
      expect((await listRepositories('s')).repositories).toEqual([{ root: repo.root, name: 'app', relativePath: 'projects/nested/app', remembered: true }])
    }
    expect(run).not.toHaveBeenCalled()
    expect(readFileSync(store, 'utf8')).toBe(before)
    await expect(resolveRepository('s', repo.root)).rejects.toMatchObject({ code: 'GIT_NOT_A_REPOSITORY' })
    await forgetRepository('s', repo.root)
    expect(await readRepositoryRecords('s', root)).toEqual({ roots: [], dismissedRoots: [repo.root] })
    expect(existsSync(`${repo.root}-moved/.git`)).toBe(true)
  })

  it('persists removal against future automatic discovery and restores only on explicit open', async () => {
    const repo = deepRepo()
    await discoverRepository('s', join(repo.root, 'src/a.ts'))
    await forgetRepository('s', repo.root)
    expect((await listRepositories('s')).repositories).toEqual([])
    expect(readFileSync(join(repo.root, 'src/a.ts'), 'utf8')).toBe('hello\n')
    expect(existsSync(join(repo.root, '.git'))).toBe(true)
    expect(await discoverRepository('s', join(repo.root, 'src/a.ts'))).toBeNull()
    expect((await listRepositories('s', { shallow: true })).repositories).toEqual([])
    await openRepository('s', repo.root)
    expect(await discoverRepository('s', join(repo.root, 'src/a.ts'))).toMatchObject({ repository: { root: repo.root }, remembered: true })
    expect((await readRepositoryRecords('s', root)).dismissedRoots).toEqual([])
  })

  it('does not reuse manual or transient records after the space working directory changes', async () => {
    const repo = deepRepo()
    await openRepository('s', repo.root)
    await discoverRepository('s', join(repo.root, 'src/a.ts'))
    const other = join(base, 'other')
    mkdirSync(other)
    spaces.get('s')!.workingDir = other
    expect((await listRepositories('s')).repositories).toEqual([])
    expect(await readRepositoryRecords('s', other)).toEqual({ roots: [], dismissedRoots: [] })
    const next = initRepo(join(other, 'deep', 'new'))
    await openRepository('s', next.root)
    expect(JSON.parse(readFileSync(store, 'utf8'))).toEqual({ version: 2, workingDir: other, roots: [next.root], dismissedRoots: [] })
  })

  it('serializes writes for different roots and stores temporary-space records beside conversations', async () => {
    spaces.get('s')!.isTemp = true
    const first = deepRepo()
    const second = initRepo(join(root, 'deep', 'other'))
    await Promise.all([openRepository('s', first.root), openRepository('s', second.root)])
    const saved = JSON.parse(readFileSync(join(data, 'git', 'repositories.json'), 'utf8'))
    expect(saved.roots.sort()).toEqual([first.root, second.root].sort())
    expect(existsSync(store)).toBe(false)
  })

  it.each(['{broken', '{"version":2,"roots":[]}', JSON.stringify({ version: 1, workingDir: '/tmp', roots: ['relative'] }), 'x'.repeat(1024 * 1024 + 1)])('surfaces damaged records without overwriting them (%#)', async (content) => {
    const repo = deepRepo()
    mkdirSync(join(data, '.halo/git'), { recursive: true })
    writeFileSync(store, content)
    expect((await listRepositories('s')).recordError).toMatchObject({ code: 'GIT_FAILED' })
    expect(await discoverRepository('s', join(repo.root, 'src/a.ts'))).toMatchObject({ repository: { root: repo.root }, remembered: false, recordError: { code: 'GIT_FAILED' } })
    await expect(openRepository('s', repo.root)).rejects.toMatchObject({ code: 'GIT_FAILED' })
    await expect(forgetRepository('s', repo.root)).rejects.toMatchObject({ code: 'GIT_FAILED' })
    expect(readFileSync(store, 'utf8')).toBe(content)
  })

  it('enforces the manual-record cap without evicting saved entries', async () => {
    const roots = Array.from({ length: 64 }, (_, i) => join(root, `repo-${i}`))
    mkdirSync(join(data, '.halo/git'), { recursive: true })
    writeFileSync(store, JSON.stringify({ version: 1, workingDir: root, roots }))
    await expect(updateRepositoryRecord('s', root, join(root, 'one-more'), 'open')).rejects.toMatchObject({ code: 'GIT_FAILED' })
    expect((await readRepositoryRecords('s', root)).roots).toEqual(roots)
    await updateRepositoryRecord('s', root, roots[0], 'dismiss')
    await updateRepositoryRecord('s', root, join(root, 'one-more'), 'open')
    expect((await readRepositoryRecords('s', root)).roots).toHaveLength(64)
  })

  it('rejects a directory change while the temporary record is being written', async () => {
    const repo = deepRepo()
    const other = join(base, 'other')
    mkdirSync(other)
    const original = fsPromises.open
    const spy = vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
      const handle = await original(...args)
      if (String(args[0]).endsWith('.tmp')) {
        const write = handle.writeFile.bind(handle)
        vi.spyOn(handle, 'writeFile').mockImplementation(async (...writeArgs) => {
          await write(...writeArgs)
          spaces.get('s')!.workingDir = other
        })
      }
      return handle
    })
    try {
      await expect(openRepository('s', repo.root)).rejects.toMatchObject({ code: 'GIT_INVALID_ARGUMENT' })
      expect(existsSync(store)).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  it('rejects an obsolete working-directory identity before writing', async () => {
    const repo = deepRepo()
    const other = join(base, 'other')
    mkdirSync(other)
    spaces.get('s')!.workingDir = other
    await expect(updateRepositoryRecord('s', root, repo.root, 'open')).rejects.toMatchObject({ code: 'GIT_INVALID_ARGUMENT' })
    expect(existsSync(store)).toBe(false)
  })

  it('surfaces unreadable store types rather than treating them as missing', async () => {
    mkdirSync(store, { recursive: true })
    expect((await listRepositories('s')).recordError).toMatchObject({ code: 'GIT_FAILED' })
  })
})
