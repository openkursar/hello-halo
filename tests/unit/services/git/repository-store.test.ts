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
    expect(await repositoryStore.readRepositoryRecords('s', root)).toEqual({ roots: [], dismissedRoots: [] })
    expect(existsSync(data)).toBe(false)
  })

  it('reads version 1 without rewriting and migrates only on an actual mutation', async () => {
    const first = join(root, 'first')
    const second = join(root, 'second')
    const before = writeStore({ version: 1, workingDir: root, roots: [first] })
    const rename = vi.spyOn(fsPromises, 'rename')
    expect(await repositoryStore.readRepositoryRecords('s', root)).toEqual({ roots: [first], dismissedRoots: [] })
    for (const action of ['discover', 'open'] as const) {
      expect(await repositoryStore.updateRepositoryRecord('s', root, first, action)).toBe(true)
    }
    expect(rename).not.toHaveBeenCalled()
    expect(readFileSync(store, 'utf8')).toBe(before)
    expect(await repositoryStore.updateRepositoryRecord('s', root, second, 'discover')).toBe(true)
    expect(JSON.parse(readFileSync(store, 'utf8'))).toEqual({ version: 2, workingDir: root, roots: [first, second], dismissedRoots: [] })
    expect(rename).toHaveBeenCalledTimes(1)
  })

  it('does not rewrite unchanged remembered or dismissed roots', async () => {
    const remembered = join(root, 'remembered')
    const dismissed = join(root, 'dismissed')
    const before = writeStore({ version: 2, workingDir: root, roots: [remembered], dismissedRoots: [dismissed] })
    const rename = vi.spyOn(fsPromises, 'rename')
    const open = vi.spyOn(fsPromises, 'open')
    for (const action of ['discover', 'open'] as const) {
      expect(await repositoryStore.updateRepositoryRecord('s', root, remembered, action)).toBe(true)
    }
    expect(await repositoryStore.updateRepositoryRecord('s', root, dismissed, 'dismiss')).toBe(true)
    expect(await repositoryStore.updateRepositoryRecord('s', root, dismissed, 'discover')).toBe(false)
    expect(readFileSync(store, 'utf8')).toBe(before)
    expect(rename).not.toHaveBeenCalled()
    expect(open.mock.calls.some(([, flags]) => flags === 'wx')).toBe(false)
  })

  it('persists dismissal across module reloads without deleting repository files', async () => {
    const selected = join(root, 'project')
    mkdirSync(selected)
    writeFileSync(join(selected, 'file.txt'), 'keep me\n')
    await repositoryStore.updateRepositoryRecord('s', root, selected, 'discover')
    expect(await repositoryStore.updateRepositoryRecord('s', root, selected, 'dismiss')).toBe(true)
    const before = readFileSync(store, 'utf8')
    vi.resetModules()
    const reloaded = await import('../../../../src/main/services/git/repository-store')
    expect(await reloaded.readRepositoryRecords('s', root)).toEqual({ roots: [], dismissedRoots: [selected] })
    expect(await reloaded.updateRepositoryRecord('s', root, selected, 'discover')).toBe(false)
    expect(readFileSync(store, 'utf8')).toBe(before)
    expect(readFileSync(join(selected, 'file.txt'), 'utf8')).toBe('keep me\n')
  })

  it('allows only explicit opening to restore a dismissed root', async () => {
    const selected = join(root, 'project')
    await repositoryStore.updateRepositoryRecord('s', root, selected, 'dismiss')
    expect(await repositoryStore.updateRepositoryRecord('s', root, selected, 'discover')).toBe(false)
    expect(await repositoryStore.updateRepositoryRecord('s', root, selected, 'open')).toBe(true)
    expect(await repositoryStore.readRepositoryRecords('s', root)).toEqual({ roots: [selected], dismissedRoots: [] })
    expect(await repositoryStore.updateRepositoryRecord('s', root, selected, 'discover')).toBe(true)
  })

  it('accepts missing roots and touches only the record file while reading or removing them', async () => {
    const selected = join(root, 'missing', 'project')
    const lstat = vi.spyOn(fsPromises, 'lstat')
    expect(await repositoryStore.updateRepositoryRecord('s', root, selected, 'discover')).toBe(true)
    expect(await repositoryStore.readRepositoryRecords('s', root)).toEqual({ roots: [selected], dismissedRoots: [] })
    expect(await repositoryStore.updateRepositoryRecord('s', root, selected, 'dismiss')).toBe(true)
    expect(await repositoryStore.readRepositoryRecords('s', root)).toEqual({ roots: [], dismissedRoots: [selected] })
    expect(lstat.mock.calls.every(([file]) => file === store)).toBe(true)
    expect(existsSync(selected)).toBe(false)
  })

  it('serializes concurrent writes for different roots without losing entries', async () => {
    const roots = Array.from({ length: 8 }, (_, index) => join(root, `project-${index}`))
    expect(await Promise.all(roots.map((selected) => repositoryStore.updateRepositoryRecord('s', root, selected, 'discover')))).toEqual(roots.map(() => true))
    expect(await repositoryStore.readRepositoryRecords('s', root)).toEqual({ roots, dismissedRoots: [] })
  })

  it('applies different actions in their serial execution order', async () => {
    const selected = join(root, 'project')
    const actions = ['discover', 'dismiss', 'discover', 'open', 'dismiss'] as const
    expect(await Promise.all(actions.map((action) => repositoryStore.updateRepositoryRecord('s', root, selected, action)))).toEqual([true, true, false, true, true])
    expect(await repositoryStore.readRepositoryRecords('s', root)).toEqual({ roots: [], dismissedRoots: [selected] })
  })

  it('places temporary-space records beside conversations', async () => {
    spaces.get('s')!.isTemp = true
    expect(await repositoryStore.updateRepositoryRecord('s', root, root, 'open')).toBe(true)
    expect(existsSync(store)).toBe(false)
    expect(JSON.parse(readFileSync(join(data, 'git', 'repositories.json'), 'utf8'))).toEqual({ version: 2, workingDir: root, roots: [root], dismissedRoots: [] })
  })

  it('ignores records from an old working directory and replaces them only on mutation', async () => {
    const before = writeStore({ version: 1, workingDir: root, roots: [join(root, 'project')] })
    const other = join(base, 'other')
    spaces.get('s')!.workingDir = other
    expect(await repositoryStore.readRepositoryRecords('s', other)).toEqual({ roots: [], dismissedRoots: [] })
    expect(readFileSync(store, 'utf8')).toBe(before)
    expect(await repositoryStore.updateRepositoryRecord('s', other, other, 'dismiss')).toBe(true)
    expect(JSON.parse(readFileSync(store, 'utf8'))).toEqual({ version: 2, workingDir: other, roots: [], dismissedRoots: [other] })
  })
})

describe('obsolete repository requests', () => {
  it('returns false before reading or creating a store for an obsolete request', async () => {
    const lstat = vi.spyOn(fsPromises, 'lstat')
    const mkdir = vi.spyOn(fsPromises, 'mkdir')
    expect(await repositoryStore.updateRepositoryRecord('s', root, root, 'discover', () => false)).toBe(false)
    expect(lstat).not.toHaveBeenCalled()
    expect(mkdir).not.toHaveBeenCalled()
  })

  it('checks validity when a delayed queued request actually executes', async () => {
    const first = join(root, 'first')
    const late = join(root, 'late')
    const { started, release } = pauseTemporarySync()
    const writing = track(repositoryStore.updateRepositoryRecord('s', root, first, 'discover'))
    await started
    let current = true
    const isCurrent = vi.fn(() => current)
    const queued = track(repositoryStore.updateRepositoryRecord('s', root, late, 'discover', isCurrent))
    expect(isCurrent).not.toHaveBeenCalled()
    current = false
    release()
    expect(await writing).toBe(true)
    expect(await queued).toBe(false)
    expect(isCurrent).toHaveBeenCalledTimes(1)
    expect(await repositoryStore.readRepositoryRecords('s', root)).toEqual({ roots: [first], dismissedRoots: [] })
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
    expect(await repositoryStore.updateRepositoryRecord('s', root, root, 'discover', () => current)).toBe(false)
    expect(readFileSync(store, 'utf8')).toBe(before)
  })

  it.each(['discover', 'open', 'dismiss'] as const)('does not rename an obsolete %s after syncing its temporary file', async (action) => {
    const selected = join(root, 'selected')
    const before = writeStore({ version: 2, workingDir: root, roots: [], dismissedRoots: [] })
    const rename = vi.spyOn(fsPromises, 'rename')
    const { started, release } = pauseTemporarySync()
    let current = true
    const updating = track(repositoryStore.updateRepositoryRecord('s', root, selected, action, () => current))
    await started
    current = false
    release()
    expect(await updating).toBe(false)
    expect(rename).not.toHaveBeenCalled()
    expect(readFileSync(store, 'utf8')).toBe(before)
    expect(readdirSync(dirname(store))).toEqual(['repositories.json'])
  })

  it('does not let an obsolete opening overwrite an earlier dismissal', async () => {
    await repositoryStore.updateRepositoryRecord('s', root, root, 'discover')
    expect(await Promise.all([
      repositoryStore.updateRepositoryRecord('s', root, root, 'dismiss'),
      repositoryStore.updateRepositoryRecord('s', root, root, 'open', () => false),
      repositoryStore.updateRepositoryRecord('s', root, root, 'discover'),
    ])).toEqual([true, false, false])
    expect(await repositoryStore.readRepositoryRecords('s', root)).toEqual({ roots: [], dismissedRoots: [root] })
  })
})

describe('repository record validation and capacity', () => {
  it.each([
    ['invalid JSON', (): string => '{broken'],
    ['null', (): string => 'null'],
    ['unknown version', () => ({ version: 3, workingDir: root, roots: [], dismissedRoots: [] })],
    ['missing dismissals', () => ({ version: 2, workingDir: root, roots: [] })],
    ['relative root', () => ({ version: 1, workingDir: root, roots: ['relative'] })],
    ['outside root', () => ({ version: 1, workingDir: root, roots: [join(base, 'outside')] })],
    ['unnormalized root', () => ({ version: 1, workingDir: root, roots: [`${root}${sep}a${sep}..${sep}b`] })],
    ['duplicate roots', () => ({ version: 1, workingDir: root, roots: [root, root] })],
    ['duplicate dismissals', () => ({ version: 2, workingDir: root, roots: [], dismissedRoots: [root, root] })],
    ['overlapping lists', () => ({ version: 2, workingDir: root, roots: [root], dismissedRoots: [root] })],
    ['outside dismissal', () => ({ version: 2, workingDir: root, roots: [], dismissedRoots: [join(base, 'outside')] })],
    ['too many roots', () => ({ version: 1, workingDir: root, roots: Array.from({ length: 65 }, (_, index) => join(root, `${index}`)) })],
    ['too many dismissals', () => ({ version: 2, workingDir: root, roots: [], dismissedRoots: Array.from({ length: 257 }, (_, index) => join(root, `${index}`)) })],
  ] as const)('rejects %s without overwriting the store', async (_name, content) => {
    const before = writeStore(content())
    await expect(repositoryStore.readRepositoryRecords('s', root)).rejects.toMatchObject({ code: 'GIT_FAILED' })
    for (const action of ['discover', 'open', 'dismiss'] as const) {
      await expect(repositoryStore.updateRepositoryRecord('s', root, root, action)).rejects.toMatchObject({ code: 'GIT_FAILED' })
    }
    expect(readFileSync(store, 'utf8')).toBe(before)
  })

  it('rejects oversized files before opening them and never replaces them', async () => {
    const before = writeStore('x'.repeat(1024 * 1024 + 1))
    const open = vi.spyOn(fsPromises, 'open')
    await expect(repositoryStore.readRepositoryRecords('s', root)).rejects.toMatchObject({ code: 'GIT_FAILED' })
    await expect(repositoryStore.updateRepositoryRecord('s', root, root, 'dismiss')).rejects.toMatchObject({ code: 'GIT_FAILED' })
    expect(open).not.toHaveBeenCalled()
    expect(readFileSync(store, 'utf8')).toBe(before)
  })

  it('rejects non-file stores without replacing them', async () => {
    mkdirSync(store, { recursive: true })
    await expect(repositoryStore.readRepositoryRecords('s', root)).rejects.toMatchObject({ code: 'GIT_FAILED' })
    await expect(repositoryStore.updateRepositoryRecord('s', root, root, 'open')).rejects.toMatchObject({ code: 'GIT_FAILED' })
    expect(statSync(store).isDirectory()).toBe(true)
  })

  it('rejects relative, unnormalized, NUL-containing and outside request paths before I/O', async () => {
    const lstat = vi.spyOn(fsPromises, 'lstat')
    for (const selected of ['relative', `${root}${sep}a${sep}..${sep}b`, `${root}${sep}`, `${root}\0bad`, join(base, 'outside'), `${root}-sibling`]) {
      for (const action of ['discover', 'open', 'dismiss'] as const) {
        await expect(repositoryStore.updateRepositoryRecord('s', root, selected, action)).rejects.toMatchObject({ code: 'GIT_INVALID_ARGUMENT' })
      }
    }
    await expect(repositoryStore.readRepositoryRecords('s', 'relative')).rejects.toMatchObject({ code: 'GIT_INVALID_ARGUMENT' })
    await expect(repositoryStore.updateRepositoryRecord('s', `${root}${sep}`, root, 'open')).rejects.toMatchObject({ code: 'GIT_INVALID_ARGUMENT' })
    expect(lstat).not.toHaveBeenCalled()
    expect(existsSync(data)).toBe(false)
  })

  it('never evicts remembered roots or clears dismissals when the 64-root limit is full', async () => {
    const roots = Array.from({ length: 64 }, (_, index) => join(root, `project-${index}`))
    const selected = join(root, 'dismissed')
    const before = writeStore({ version: 2, workingDir: root, roots, dismissedRoots: [selected] })
    for (const action of ['discover', 'open'] as const) {
      await expect(repositoryStore.updateRepositoryRecord('s', root, join(root, 'one-more'), action)).rejects.toMatchObject({ code: 'GIT_FAILED' })
    }
    await expect(repositoryStore.updateRepositoryRecord('s', root, selected, 'open')).rejects.toMatchObject({ code: 'GIT_FAILED' })
    expect(await repositoryStore.updateRepositoryRecord('s', root, selected, 'discover')).toBe(false)
    expect(await repositoryStore.updateRepositoryRecord('s', root, roots[0], 'open')).toBe(true)
    expect(readFileSync(store, 'utf8')).toBe(before)
    await repositoryStore.updateRepositoryRecord('s', root, roots[0], 'dismiss')
    await repositoryStore.updateRepositoryRecord('s', root, selected, 'open')
    expect(await repositoryStore.readRepositoryRecords('s', root)).toEqual({ roots: [...roots.slice(1), selected], dismissedRoots: [roots[0]] })
  })

  it('never evicts dismissed roots or partly removes a root at the 256-dismissal limit', async () => {
    const dismissedRoots = Array.from({ length: 256 }, (_, index) => join(root, `dismissed-${index}`))
    const selected = join(root, 'selected')
    const before = writeStore({ version: 2, workingDir: root, roots: [selected], dismissedRoots })
    await expect(repositoryStore.updateRepositoryRecord('s', root, selected, 'dismiss')).rejects.toMatchObject({ code: 'GIT_FAILED' })
    expect(await repositoryStore.updateRepositoryRecord('s', root, dismissedRoots[0], 'dismiss')).toBe(true)
    expect(readFileSync(store, 'utf8')).toBe(before)
    await repositoryStore.updateRepositoryRecord('s', root, dismissedRoots[0], 'open')
    await repositoryStore.updateRepositoryRecord('s', root, selected, 'dismiss')
    expect(await repositoryStore.readRepositoryRecords('s', root)).toEqual({ roots: [dismissedRoots[0]], dismissedRoots: [...dismissedRoots.slice(1), selected] })
  })
})

describe('repository write identity and bounds', () => {
  it('rejects a stale working-directory identity before writing', async () => {
    spaces.get('s')!.workingDir = join(base, 'other')
    await expect(repositoryStore.updateRepositoryRecord('s', root, root, 'discover')).rejects.toMatchObject({ code: 'GIT_INVALID_ARGUMENT' })
    expect(existsSync(data)).toBe(false)
  })

  it.each(['workingDir', 'path', 'isTemp', 'removed'] as const)('rejects a space %s change before rename', async (field) => {
    const before = writeStore({ version: 1, workingDir: root, roots: [root] })
    const { started, release } = pauseTemporarySync()
    const rename = vi.spyOn(fsPromises, 'rename')
    const updating = track(repositoryStore.updateRepositoryRecord('s', root, join(root, 'new'), 'open'))
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
    const first = track(repositoryStore.updateRepositoryRecord('s', root, join(root, 'first'), 'discover'))
    await started
    const second = track(repositoryStore.updateRepositoryRecord('s', root, join(root, 'second'), 'discover'))
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
    const queued = Array.from({ length: 128 }, () => track(repositoryStore.updateRepositoryRecord('s', root, root, 'discover')))
    await started
    await expect(repositoryStore.updateRepositoryRecord('s', root, root, 'open')).rejects.toMatchObject({ code: 'GIT_BUSY' })
    release()
    expect((await Promise.all(queued)).every(Boolean)).toBe(true)
    expect(await repositoryStore.updateRepositoryRecord('s', root, root, 'open')).toBe(true)
  })

  it('bounds pending files to 32 and releases the file queues when idle', async () => {
    const { started, release } = pauseTemporarySync()
    const queued = Array.from({ length: 32 }, (_, index) => {
      const id = `space-${index}`
      spaces.set(id, { path: join(base, id), workingDir: root, isTemp: false })
      return track(repositoryStore.updateRepositoryRecord(id, root, root, 'discover'))
    })
    await started
    await expect(repositoryStore.updateRepositoryRecord('s', root, root, 'open')).rejects.toMatchObject({ code: 'GIT_BUSY' })
    release()
    expect((await Promise.all(queued)).every(Boolean)).toBe(true)
    expect(await repositoryStore.updateRepositoryRecord('s', root, root, 'open')).toBe(true)
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
    expect(await repositoryStore.updateRepositoryRecord('s', root, root, 'discover')).toBe(true)
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
    await expect(repositoryStore.updateRepositoryRecord('s', root, join(root, 'new'), 'open')).rejects.toMatchObject({ code: 'GIT_FAILED', message: expect.stringContaining(`${stage} failed`) })
    expect(readFileSync(store, 'utf8')).toBe(before)
    expect(readdirSync(dirname(store))).toEqual(['repositories.json'])
  })

  it('reports cleanup errors without replacing an obsolete request result', async () => {
    const { started, release } = pauseTemporarySync()
    vi.spyOn(fsPromises, 'unlink').mockRejectedValueOnce(Object.assign(new Error('cleanup denied'), { code: 'EACCES' }))
    let current = true
    const updating = track(repositoryStore.updateRepositoryRecord('s', root, root, 'discover', () => current))
    await started
    current = false
    release()
    expect(await updating).toBe(false)
    expect(existsSync(store)).toBe(false)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Cannot remove temporary repository records'))
  })
})
