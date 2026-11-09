import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import * as fsPromises from 'fs/promises'
import { dirname, join, sep } from 'path'
import { makeTempDir } from './_repo'

vi.mock('fs/promises', async (importOriginal) => ({ ...await importOriginal<typeof import('fs/promises')>() }))
const { spaces } = vi.hoisted(() => ({ spaces: new Map<string, { path: string; workingDir: string; isTemp: boolean }>() }))
vi.mock('../../../../src/main/services/space.service', () => ({
  getSpaceDir: (id: string) => spaces.get(id)?.workingDir ?? '',
  getSpace: (id: string) => spaces.get(id),
}))

let repositoryStore: typeof import('../../../../src/main/services/git/repository-store')
let base: string
let root: string
let data: string
let store: string
const pending: Promise<unknown>[] = []
const releases: Array<() => void> = []

beforeEach(async () => {
  vi.resetModules()
  repositoryStore = await import('../../../../src/main/services/git/repository-store')
  base = makeTempDir('halo-git-records-')
  root = join(base, 'workspace')
  data = join(base, 'data')
  store = join(data, '.halo', 'git', 'repositories.json')
  mkdirSync(root)
  spaces.set('s', { path: data, workingDir: root, isTemp: false })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await Promise.allSettled(pending.splice(0))
  vi.restoreAllMocks()
  spaces.clear()
  rmSync(base, { recursive: true, force: true })
})

function writeStore(value: unknown): string {
  const text = typeof value === 'string' ? value : `${JSON.stringify(value)}\n`
  mkdirSync(dirname(store), { recursive: true })
  writeFileSync(store, text)
  return text
}

function track<T>(promise: Promise<T>): Promise<T> {
  pending.push(promise)
  return promise
}

function pauseTemporarySync() {
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const waiting = new Promise<void>((resolve) => { release = resolve })
  const original = fsPromises.open
  vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
    const handle = await original(...args)
    if (String(args[0]).endsWith('.tmp')) {
      const sync = handle.sync.bind(handle)
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        await sync()
        entered()
        await waiting
      })
    }
    return handle
  })
  releases.push(release)
  return { started, release }
}

describe('repository records', () => {
  it('reads missing records without creating files or directories', async () => {
    expect(await repositoryStore.readRepositoryRecords('s', root)).toEqual({ roots: [] })
    expect(existsSync(data)).toBe(false)
  })

  it.each([1, 2, 3] as const)('reads version %i and saves known roots without rewriting records', async (version) => {
    const remembered = join(root, 'remembered')
    const dismissed = join(root, 'previously-hidden')
    const roots = version === 2 ? [remembered, dismissed] : [remembered]
    const before = writeStore({ version, workingDir: root, roots: [remembered], ...(version === 2 ? { dismissedRoots: [dismissed] } : {}) })
    const info = statSync(store)
    const rename = vi.spyOn(fsPromises, 'rename')
    const open = vi.spyOn(fsPromises, 'open')
    const mkdir = vi.spyOn(fsPromises, 'mkdir')
    expect(await repositoryStore.readRepositoryRecords('s', root)).toEqual({ roots })
    for (const selected of roots) {
      expect(await repositoryStore.rememberRepositoryRoot('s', root, selected)).toBe(true)
      expect(await repositoryStore.rememberRepositoryRoot('s', root, selected)).toBe(true)
    }
    expect(await repositoryStore.readRepositoryRecords('s', root)).toEqual({ roots })
    expect(readFileSync(store, 'utf8')).toBe(before)
    expect(statSync(store)).toMatchObject({ ino: info.ino, mtimeMs: info.mtimeMs, mode: info.mode })
    expect(rename).not.toHaveBeenCalled()
    expect(mkdir).not.toHaveBeenCalled()
    expect(open.mock.calls.every(([file, flags]) => file === store && flags === 'r')).toBe(true)
  })

  it.each([1, 2] as const)('migrates version %i only when adding a root and preserves all known paths', async (version) => {
    const roots = Array.from({ length: 64 }, (_, index) => join(root, `project-${index}`))
    const dismissedRoots = version === 2 ? Array.from({ length: 255 }, (_, index) => join(root, `previously-hidden-${index}`)) : []
    writeStore({ version, workingDir: root, roots, ...(version === 2 ? { dismissedRoots } : {}) })
    const selected = join(root, 'new')
    const rename = vi.spyOn(fsPromises, 'rename')
    expect(await repositoryStore.rememberRepositoryRoot('s', root, selected)).toBe(true)
    const saved = JSON.parse(readFileSync(store, 'utf8'))
    expect(saved).toEqual({ version: 3, workingDir: root, roots: [...roots, ...dismissedRoots, selected] })
    expect(saved).not.toHaveProperty('dismissedRoots')
    expect(await repositoryStore.readRepositoryRecords('s', root)).toEqual({ roots: saved.roots })
    expect(rename).toHaveBeenCalledTimes(1)
  })

  it('restores version 2 hidden paths across module reloads without probing or changing project files', async () => {
    const remembered = join(root, 'remembered')
    const selected = join(root, 'project')
    const missing = join(root, 'missing', 'project')
    mkdirSync(join(selected, '.git'), { recursive: true })
    writeFileSync(join(selected, 'file.txt'), 'keep me\n')
    writeFileSync(join(selected, '.git', 'config'), '[core]\n\tbare = false\n')
    const before = writeStore({ version: 2, workingDir: root, roots: [remembered], dismissedRoots: [selected, missing] })
    const lstat = vi.spyOn(fsPromises, 'lstat')
    const open = vi.spyOn(fsPromises, 'open')
    const rename = vi.spyOn(fsPromises, 'rename')
    expect(await repositoryStore.readRepositoryRecords('s', root)).toEqual({ roots: [remembered, selected, missing] })
    vi.resetModules()
    const reloaded = await import('../../../../src/main/services/git/repository-store')
    expect(await reloaded.readRepositoryRecords('s', root)).toEqual({ roots: [remembered, selected, missing] })
    expect(await reloaded.rememberRepositoryRoot('s', root, missing)).toBe(true)
    expect(readFileSync(store, 'utf8')).toBe(before)
    expect(rename).not.toHaveBeenCalled()
    expect(lstat.mock.calls.every(([file]) => file === store)).toBe(true)
    expect(open.mock.calls.every(([file, flags]) => file === store && flags === 'r')).toBe(true)
    expect(readFileSync(join(selected, 'file.txt'), 'utf8')).toBe('keep me\n')
    expect(readFileSync(join(selected, '.git', 'config'), 'utf8')).toBe('[core]\n\tbare = false\n')
    expect(existsSync(missing)).toBe(false)
  })

  it('saves and reads missing roots without probing repository paths', async () => {
    const selected = join(root, 'missing', 'project')
    const lstat = vi.spyOn(fsPromises, 'lstat')
    const open = vi.spyOn(fsPromises, 'open')
    const mkdir = vi.spyOn(fsPromises, 'mkdir')
    expect(await repositoryStore.rememberRepositoryRoot('s', root, selected)).toBe(true)
    expect(await repositoryStore.readRepositoryRecords('s', root)).toEqual({ roots: [selected] })
    expect(await repositoryStore.rememberRepositoryRoot('s', root, selected)).toBe(true)
    expect(lstat.mock.calls.every(([file]) => file === store)).toBe(true)
    expect(open.mock.calls.every(([file]) => file === store || (String(file).startsWith(`${store}.`) && String(file).endsWith('.tmp')))).toBe(true)
    expect(mkdir).toHaveBeenCalledTimes(1)
    expect(mkdir).toHaveBeenCalledWith(dirname(store), { recursive: true })
    expect(existsSync(selected)).toBe(false)
  })

  it('serializes concurrent writes for different roots without losing entries', async () => {
    const roots = Array.from({ length: 8 }, (_, index) => join(root, `project-${index}`))
    expect(await Promise.all(roots.map((selected) => repositoryStore.rememberRepositoryRoot('s', root, selected)))).toEqual(roots.map(() => true))
    expect(await repositoryStore.readRepositoryRecords('s', root)).toEqual({ roots })
  })

  it('serializes duplicate saves without reordering or rewriting known roots', async () => {
    const roots = ['first', 'second', 'third'].map((name) => join(root, name))
    const selections = [roots[0], roots[1], roots[0], roots[2], roots[1]]
    const rename = vi.spyOn(fsPromises, 'rename')
    expect(await Promise.all(selections.map((selected) => repositoryStore.rememberRepositoryRoot('s', root, selected)))).toEqual(selections.map(() => true))
    expect(await repositoryStore.readRepositoryRecords('s', root)).toEqual({ roots })
    expect(rename).toHaveBeenCalledTimes(3)
  })

  it('places temporary-space records beside conversations', async () => {
    spaces.get('s')!.isTemp = true
    expect(await repositoryStore.rememberRepositoryRoot('s', root, root)).toBe(true)
    expect(existsSync(store)).toBe(false)
    expect(JSON.parse(readFileSync(join(data, 'git', 'repositories.json'), 'utf8'))).toEqual({ version: 3, workingDir: root, roots: [root] })
  })

  it.each([1, 2, 3] as const)('ignores version %i records from an old working directory until a new save', async (version) => {
    const before = writeStore({ version, workingDir: root, roots: [join(root, 'project')], ...(version === 2 ? { dismissedRoots: [join(root, 'previously-hidden')] } : {}) })
    const other = join(base, 'other')
    spaces.get('s')!.workingDir = other
    expect(await repositoryStore.readRepositoryRecords('s', other)).toEqual({ roots: [] })
    expect(readFileSync(store, 'utf8')).toBe(before)
    expect(await repositoryStore.rememberRepositoryRoot('s', other, other)).toBe(true)
    expect(JSON.parse(readFileSync(store, 'utf8'))).toEqual({ version: 3, workingDir: other, roots: [other] })
  })
})

describe('obsolete repository requests', () => {
  it('returns false before reading or creating a store for an obsolete request', async () => {
    const lstat = vi.spyOn(fsPromises, 'lstat')
    const mkdir = vi.spyOn(fsPromises, 'mkdir')
    expect(await repositoryStore.rememberRepositoryRoot('s', root, root, () => false)).toBe(false)
    expect(lstat).not.toHaveBeenCalled()
    expect(mkdir).not.toHaveBeenCalled()
  })

  it('checks validity when a delayed queued request actually executes', async () => {
    const first = join(root, 'first')
    const late = join(root, 'late')
    const { started, release } = pauseTemporarySync()
    const writing = track(repositoryStore.rememberRepositoryRoot('s', root, first))
    await started
    let current = true
    const isCurrent = vi.fn(() => current)
    const queued = track(repositoryStore.rememberRepositoryRoot('s', root, late, isCurrent))
    expect(isCurrent).not.toHaveBeenCalled()
    current = false
    release()
    expect(await writing).toBe(true)
    expect(await queued).toBe(false)
    expect(isCurrent).toHaveBeenCalledTimes(1)
    expect(await repositoryStore.readRepositoryRecords('s', root)).toEqual({ roots: [first] })
  })

  it('does not acknowledge an unchanged root if validity expires during its read', async () => {
    const before = writeStore({ version: 1, workingDir: root, roots: [root] })
    let current = true
    const original = fsPromises.lstat
    vi.spyOn(fsPromises, 'lstat').mockImplementation(async (...args) => {
      const entry = await original(...args)
      current = false
      return entry
    })
    expect(await repositoryStore.rememberRepositoryRoot('s', root, root, () => current)).toBe(false)
    expect(readFileSync(store, 'utf8')).toBe(before)
  })

  it('does not rename an obsolete save after syncing its temporary file', async () => {
    const selected = join(root, 'selected')
    const before = writeStore({ version: 2, workingDir: root, roots: [], dismissedRoots: [] })
    const rename = vi.spyOn(fsPromises, 'rename')
    const { started, release } = pauseTemporarySync()
    let current = true
    const updating = track(repositoryStore.rememberRepositoryRoot('s', root, selected, () => current))
    await started
    current = false
    release()
    expect(await updating).toBe(false)
    expect(rename).not.toHaveBeenCalled()
    expect(readFileSync(store, 'utf8')).toBe(before)
    expect(readdirSync(dirname(store))).toEqual(['repositories.json'])
  })

  it('does not let an obsolete save disturb valid queued additions', async () => {
    const first = join(root, 'first')
    const late = join(root, 'late')
    const second = join(root, 'second')
    await repositoryStore.rememberRepositoryRoot('s', root, root)
    expect(await Promise.all([
      repositoryStore.rememberRepositoryRoot('s', root, first),
      repositoryStore.rememberRepositoryRoot('s', root, late, () => false),
      repositoryStore.rememberRepositoryRoot('s', root, second),
    ])).toEqual([true, false, true])
    expect(await repositoryStore.readRepositoryRecords('s', root)).toEqual({ roots: [root, first, second] })
  })
})

describe('repository record validation and capacity', () => {
  it.each([
    ['invalid JSON', (): string => '{broken'],
    ['null', (): string => 'null'],
    ['unknown version', () => ({ version: 4, workingDir: root, roots: [] })],
    ['relative working directory', () => ({ version: 3, workingDir: 'relative', roots: [] })],
    ['unnormalized working directory', () => ({ version: 3, workingDir: `${root}${sep}`, roots: [] })],
    ['missing roots', () => ({ version: 3, workingDir: root })],
    ['non-array roots', () => ({ version: 3, workingDir: root, roots: root })],
    ['missing dismissals', () => ({ version: 2, workingDir: root, roots: [] })],
    ['non-array dismissals', () => ({ version: 2, workingDir: root, roots: [], dismissedRoots: root })],
    ['relative root', () => ({ version: 1, workingDir: root, roots: ['relative'] })],
    ['outside root', () => ({ version: 1, workingDir: root, roots: [join(base, 'outside')] })],
    ['unnormalized root', () => ({ version: 1, workingDir: root, roots: [`${root}${sep}a${sep}..${sep}b`] })],
    ['duplicate roots', () => ({ version: 1, workingDir: root, roots: [root, root] })],
    ['version 3 outside root', () => ({ version: 3, workingDir: root, roots: [join(base, 'outside')] })],
    ['version 3 duplicate roots', () => ({ version: 3, workingDir: root, roots: [root, root] })],
    ['duplicate dismissals', () => ({ version: 2, workingDir: root, roots: [], dismissedRoots: [root, root] })],
    ['overlapping lists', () => ({ version: 2, workingDir: root, roots: [root], dismissedRoots: [root] })],
    ['relative dismissal', () => ({ version: 2, workingDir: root, roots: [], dismissedRoots: ['relative'] })],
    ['outside dismissal', () => ({ version: 2, workingDir: root, roots: [], dismissedRoots: [join(base, 'outside')] })],
    ['unnormalized dismissal', () => ({ version: 2, workingDir: root, roots: [], dismissedRoots: [`${root}${sep}a${sep}..${sep}b`] })],
    ['NUL-containing dismissal', () => ({ version: 2, workingDir: root, roots: [], dismissedRoots: [`${root}\0bad`] })],
    ['too many version 1 roots', () => ({ version: 1, workingDir: root, roots: Array.from({ length: 65 }, (_, index) => join(root, `${index}`)) })],
    ['too many version 2 roots', () => ({ version: 2, workingDir: root, roots: Array.from({ length: 65 }, (_, index) => join(root, `${index}`)), dismissedRoots: [] })],
    ['too many version 3 roots', () => ({ version: 3, workingDir: root, roots: Array.from({ length: 321 }, (_, index) => join(root, `${index}`)) })],
    ['too many dismissals', () => ({ version: 2, workingDir: root, roots: [], dismissedRoots: Array.from({ length: 257 }, (_, index) => join(root, `${index}`)) })],
  ] as const)('rejects %s without overwriting the store', async (_name, content) => {
    const before = writeStore(content())
    await expect(repositoryStore.readRepositoryRecords('s', root)).rejects.toMatchObject({ code: 'GIT_FAILED' })
    await expect(repositoryStore.rememberRepositoryRoot('s', root, root)).rejects.toMatchObject({ code: 'GIT_FAILED' })
    expect(readFileSync(store, 'utf8')).toBe(before)
  })

  it('rejects oversized files before opening them and never replaces them', async () => {
    const before = writeStore('x'.repeat(1024 * 1024 + 1))
    const open = vi.spyOn(fsPromises, 'open')
    await expect(repositoryStore.readRepositoryRecords('s', root)).rejects.toMatchObject({ code: 'GIT_FAILED' })
    await expect(repositoryStore.rememberRepositoryRoot('s', root, root)).rejects.toMatchObject({ code: 'GIT_FAILED' })
    expect(open).not.toHaveBeenCalled()
    expect(readFileSync(store, 'utf8')).toBe(before)
  })

  it('rejects non-file stores without replacing them', async () => {
    mkdirSync(store, { recursive: true })
    await expect(repositoryStore.readRepositoryRecords('s', root)).rejects.toMatchObject({ code: 'GIT_FAILED' })
    await expect(repositoryStore.rememberRepositoryRoot('s', root, root)).rejects.toMatchObject({ code: 'GIT_FAILED' })
    expect(statSync(store).isDirectory()).toBe(true)
  })

  it('rejects relative, unnormalized, NUL-containing, overlong and outside request paths before I/O', async () => {
    const lstat = vi.spyOn(fsPromises, 'lstat')
    for (const selected of ['relative', `${root}${sep}a${sep}..${sep}b`, `${root}${sep}`, `${root}\0bad`, `${root}${sep}${'x'.repeat(4096)}`, join(base, 'outside'), `${root}-sibling`]) {
      await expect(repositoryStore.rememberRepositoryRoot('s', root, selected)).rejects.toMatchObject({ code: 'GIT_INVALID_ARGUMENT' })
    }
    for (const workingDir of ['relative', `${root}${sep}`, `${root}\0bad`, `${root}${sep}${'x'.repeat(4096)}`]) {
      await expect(repositoryStore.readRepositoryRecords('s', workingDir)).rejects.toMatchObject({ code: 'GIT_INVALID_ARGUMENT' })
      await expect(repositoryStore.rememberRepositoryRoot('s', workingDir, root)).rejects.toMatchObject({ code: 'GIT_INVALID_ARGUMENT' })
    }
    expect(lstat).not.toHaveBeenCalled()
    expect(existsSync(data)).toBe(false)
  })

  it('restores all 64 + 256 version 2 paths without probing, rewriting or evicting them', async () => {
    const roots = Array.from({ length: 64 }, (_, index) => join(root, `project-${index}`))
    const dismissedRoots = Array.from({ length: 256 }, (_, index) => join(root, `previously-hidden-${index}`))
    const known = [...roots, ...dismissedRoots]
    const before = writeStore({ version: 2, workingDir: root, roots, dismissedRoots })
    const lstat = vi.spyOn(fsPromises, 'lstat')
    const open = vi.spyOn(fsPromises, 'open')
    const rename = vi.spyOn(fsPromises, 'rename')
    const mkdir = vi.spyOn(fsPromises, 'mkdir')
    expect(await repositoryStore.readRepositoryRecords('s', root)).toEqual({ roots: known })
    for (const selected of [roots[0], roots[63], dismissedRoots[0], dismissedRoots[255]]) {
      expect(await repositoryStore.rememberRepositoryRoot('s', root, selected)).toBe(true)
    }
    await expect(repositoryStore.rememberRepositoryRoot('s', root, join(root, 'one-more'))).rejects.toMatchObject({
      code: 'GIT_FAILED', message: expect.stringContaining('At most 320 repositories'),
    })
    expect(await repositoryStore.readRepositoryRecords('s', root)).toEqual({ roots: known })
    expect(readFileSync(store, 'utf8')).toBe(before)
    expect(lstat.mock.calls.every(([file]) => file === store)).toBe(true)
    expect(open.mock.calls.every(([file, flags]) => file === store && flags === 'r')).toBe(true)
    expect(rename).not.toHaveBeenCalled()
    expect(mkdir).not.toHaveBeenCalled()
  })

  it('saves the 320th version 3 root but rejects the 321st without eviction or rewriting', async () => {
    const roots = Array.from({ length: 319 }, (_, index) => join(root, `project-${index}`))
    writeStore({ version: 3, workingDir: root, roots })
    const selected = join(root, 'last')
    const known = [...roots, selected]
    const rename = vi.spyOn(fsPromises, 'rename')
    expect(await repositoryStore.rememberRepositoryRoot('s', root, selected)).toBe(true)
    const before = readFileSync(store, 'utf8')
    expect(JSON.parse(before)).toEqual({ version: 3, workingDir: root, roots: known })
    expect(await repositoryStore.rememberRepositoryRoot('s', root, roots[0])).toBe(true)
    expect(await repositoryStore.rememberRepositoryRoot('s', root, selected)).toBe(true)
    await expect(repositoryStore.rememberRepositoryRoot('s', root, join(root, 'one-more'))).rejects.toMatchObject({
      code: 'GIT_FAILED', message: expect.stringContaining('At most 320 repositories'),
    })
    expect(await repositoryStore.readRepositoryRecords('s', root)).toEqual({ roots: known })
    expect(readFileSync(store, 'utf8')).toBe(before)
    expect(rename).toHaveBeenCalledTimes(1)
  })
})

describe('repository write identity and bounds', () => {
  it('rejects a stale working-directory identity before writing', async () => {
    spaces.get('s')!.workingDir = join(base, 'other')
    await expect(repositoryStore.rememberRepositoryRoot('s', root, root)).rejects.toMatchObject({ code: 'GIT_INVALID_ARGUMENT' })
    expect(existsSync(data)).toBe(false)
  })

  it.each(['workingDir', 'path', 'isTemp', 'removed'] as const)('rejects a space %s change before rename', async (field) => {
    const before = writeStore({ version: 1, workingDir: root, roots: [root] })
    const { started, release } = pauseTemporarySync()
    const rename = vi.spyOn(fsPromises, 'rename')
    const updating = track(repositoryStore.rememberRepositoryRoot('s', root, join(root, 'new')))
    await started
    if (field === 'removed') spaces.delete('s')
    else if (field === 'isTemp') spaces.get('s')!.isTemp = true
    else spaces.get('s')![field] = join(base, 'other')
    release()
    await expect(updating).rejects.toMatchObject({ code: 'GIT_INVALID_ARGUMENT' })
    expect(rename).not.toHaveBeenCalled()
    expect(readFileSync(store, 'utf8')).toBe(before)
    expect(readdirSync(dirname(store))).toEqual(['repositories.json'])
  })

  it('checks the captured data path again when a queued write starts', async () => {
    const before = writeStore({ version: 1, workingDir: root, roots: [root] })
    const { started, release } = pauseTemporarySync()
    const first = track(repositoryStore.rememberRepositoryRoot('s', root, join(root, 'first')))
    await started
    const second = track(repositoryStore.rememberRepositoryRoot('s', root, join(root, 'second')))
    const results = Promise.allSettled([first, second])
    spaces.get('s')!.path = join(base, 'new-data')
    release()
    expect(await results).toMatchObject([
      { status: 'rejected', reason: { code: 'GIT_INVALID_ARGUMENT' } },
      { status: 'rejected', reason: { code: 'GIT_INVALID_ARGUMENT' } },
    ])
    expect(readFileSync(store, 'utf8')).toBe(before)
    expect(existsSync(join(base, 'new-data'))).toBe(false)
    expect(readdirSync(dirname(store))).toEqual(['repositories.json'])
  })

  it('bounds pending writes to 128 and releases the slots when idle', async () => {
    const { started, release } = pauseTemporarySync()
    const queued = Array.from({ length: 128 }, () => track(repositoryStore.rememberRepositoryRoot('s', root, root)))
    await started
    await expect(repositoryStore.rememberRepositoryRoot('s', root, root)).rejects.toMatchObject({ code: 'GIT_BUSY' })
    release()
    expect((await Promise.all(queued)).every(Boolean)).toBe(true)
    expect(await repositoryStore.rememberRepositoryRoot('s', root, root)).toBe(true)
  })

  it('bounds pending files to 32 and releases the file queues when idle', async () => {
    const { started, release } = pauseTemporarySync()
    const queued = Array.from({ length: 32 }, (_, index) => {
      const id = `space-${index}`
      spaces.set(id, { path: join(base, id), workingDir: root, isTemp: false })
      return track(repositoryStore.rememberRepositoryRoot(id, root, root))
    })
    await started
    await expect(repositoryStore.rememberRepositoryRoot('s', root, root)).rejects.toMatchObject({ code: 'GIT_BUSY' })
    release()
    expect((await Promise.all(queued)).every(Boolean)).toBe(true)
    expect(await repositoryStore.rememberRepositoryRoot('s', root, root)).toBe(true)
  })
})

describe('atomic repository record writes', () => {
  it('creates an exclusive private temporary file and syncs and closes it before rename', async () => {
    const events: string[] = []
    const originalOpen = fsPromises.open
    const originalRename = fsPromises.rename
    const open = vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args)
      if (String(args[0]).endsWith('.tmp')) {
        const sync = handle.sync.bind(handle)
        const close = handle.close.bind(handle)
        vi.spyOn(handle, 'sync').mockImplementation(async () => { await sync(); events.push('sync') })
        vi.spyOn(handle, 'close').mockImplementation(async () => { await close(); events.push('close') })
      }
      return handle
    })
    vi.spyOn(fsPromises, 'rename').mockImplementation(async (...args) => {
      expect(events).toEqual(['sync', 'close'])
      events.push('rename')
      return originalRename(...args)
    })
    expect(await repositoryStore.rememberRepositoryRoot('s', root, root)).toBe(true)
    expect(events).toEqual(['sync', 'close', 'rename'])
    expect(open).toHaveBeenCalledWith(expect.stringContaining(`${store}.`), 'wx', 0o600)
    if (process.platform !== 'win32') expect(statSync(store).mode & 0o777).toBe(0o600)
    expect(readdirSync(dirname(store))).toEqual(['repositories.json'])
  })

  it.each(['sync', 'rename'] as const)('preserves existing records and cleans temporary files when %s fails', async (stage) => {
    const before = writeStore({ version: 1, workingDir: root, roots: [root] })
    if (stage === 'rename') vi.spyOn(fsPromises, 'rename').mockRejectedValueOnce(new Error('rename failed'))
    else {
      const original = fsPromises.open
      vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
        const handle = await original(...args)
        if (String(args[0]).endsWith('.tmp')) vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('sync failed'))
        return handle
      })
    }
    await expect(repositoryStore.rememberRepositoryRoot('s', root, join(root, 'new'))).rejects.toMatchObject({ code: 'GIT_FAILED', message: expect.stringContaining(`${stage} failed`) })
    expect(readFileSync(store, 'utf8')).toBe(before)
    expect(readdirSync(dirname(store))).toEqual(['repositories.json'])
  })

  it('reports cleanup errors without replacing an obsolete request result', async () => {
    const { started, release } = pauseTemporarySync()
    vi.spyOn(fsPromises, 'unlink').mockRejectedValueOnce(Object.assign(new Error('cleanup denied'), { code: 'EACCES' }))
    let current = true
    const updating = track(repositoryStore.rememberRepositoryRoot('s', root, root, () => current))
    await started
    current = false
    release()
    expect(await updating).toBe(false)
    expect(existsSync(store)).toBe(false)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Cannot remove temporary repository records'))
  })
})
