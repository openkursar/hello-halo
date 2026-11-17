import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs/promises'
import { constants } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import {
  prepareAppDataRelocation, recoverAppDataRelocation,
  type AppDataRelocationOptions,
} from '../../../../src/main/apps/manager/data-relocation'

vi.mock('fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('fs/promises')>()
  return { ...original, rename: vi.fn(original.rename), copyFile: vi.fn(original.copyFile),
    lstat: vi.fn(original.lstat), unlink: vi.fn(original.unlink), rmdir: vi.fn(original.rmdir) }
})

const real = await vi.importActual<typeof import('fs/promises')>('fs/promises')
const failure = (code: string) => Object.assign(new Error(code), { code })

let root: string
let source: string
let target: string
let journal: string
let options: AppDataRelocationOptions

async function put(path: string, content: string): Promise<void> {
  await real.mkdir(dirname(path), { recursive: true })
  await real.writeFile(path, content)
}

async function exists(path: string): Promise<boolean> {
  try { await real.lstat(path); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

async function snapshot(path: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  async function walk(path: string, relative: string): Promise<void> {
    const entry = await real.lstat(path)
    if (entry.isSymbolicLink()) result[relative] = `link:${await real.readlink(path)}`
    else if (entry.isDirectory()) {
      result[relative] = 'directory'
      for (const child of await real.readdir(path)) await walk(join(path, child), join(relative, child))
    } else result[relative] = (await real.readFile(path)).toString('base64')
  }
  if (await exists(path)) await walk(path, '')
  return result
}

function forceCrossVolume(): void {
  vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    if (String(from).startsWith(source) && String(to).startsWith(target)) throw failure('EXDEV')
    return real.rename(from, to)
  })
}

async function records(): Promise<Array<{ path: string; value: any }>> {
  const entries = (await real.readdir(journal)).filter(name => /^\d{12}\.json$/.test(name)).sort()
  return Promise.all(entries.map(async name => ({ path: join(journal, name), value: JSON.parse(await real.readFile(join(journal, name), 'utf8')) })))
}

beforeEach(async () => {
  root = await real.realpath(await real.mkdtemp(join(tmpdir(), 'halo-relocation-')))
  source = join(root, 'old', 'person')
  target = join(root, 'new', 'person')
  journal = join(root, 'private', 'relocations', 'person')
  options = { appId: 'person', target, sources: [{ path: source, spaceId: 'oldspace' }], journalPath: journal }
  vi.mocked(fs.rename).mockImplementation(real.rename)
  vi.mocked(fs.copyFile).mockImplementation(real.copyFile)
  vi.mocked(fs.lstat).mockImplementation(real.lstat)
  vi.mocked(fs.unlink).mockImplementation(real.unlink)
  vi.mocked(fs.rmdir).mockImplementation(real.rmdir)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await real.rm(root, { recursive: true, force: true })
})

describe('app data relocation', () => {
  it('fast-renames an absent destination, counts files and commits idempotently', async () => {
    await put(join(source, 'memory.md'), 'memory')
    await put(join(source, 'runs', 'chat.jsonl'), 'history')
    await real.mkdir(join(source, 'empty'))
    const before = await snapshot(source)
    const prepared = await prepareAppDataRelocation(options)
    expect(prepared.fileCount).toBe(2)
    expect(await snapshot(target)).toEqual(before)
    expect(await exists(source)).toBe(false)
    expect(fs.copyFile).not.toHaveBeenCalled()
    await prepared.commit()
    await prepared.commit()
    await recoverAppDataRelocation(journal, true)
    expect(await exists(journal)).toBe(false)
    expect(await snapshot(target)).toEqual(before)
    await expect(prepared.rollback()).rejects.toThrow('already committed')
  })

  it('restores both exact trees and removes created target parents on rollback', async () => {
    await put(join(source, 'memory', 'notes.md'), 'notes')
    await real.mkdir(join(source, 'empty'))
    const before = await snapshot(source)
    const prepared = await prepareAppDataRelocation(options)
    await prepared.rollback()
    await prepared.rollback()
    expect(await snapshot(source)).toEqual(before)
    expect(await exists(join(root, 'new'))).toBe(false)
    expect(await exists(journal)).toBe(false)
    await expect(prepared.commit()).rejects.toThrow('already rolled back')
  })

  it('merges trees, keeps all collisions and restores originals byte-for-byte', async () => {
    await put(join(source, 'memory.md'), 'old')
    await put(join(source, 'only-old'), 'original')
    await put(join(source, 'runs', 'old.jsonl'), 'old history')
    await put(join(target, 'memory.md'), 'current')
    await put(join(target, 'memory.md.from-oldspace'), 'earlier conflict')
    await put(join(target, 'memory.md.from-oldspace.1'), 'another conflict')
    await put(join(target, 'runs', 'new.jsonl'), 'new history')
    const oldTree = await snapshot(source)
    const newTree = await snapshot(target)
    const prepared = await prepareAppDataRelocation(options)
    expect(prepared.fileCount).toBe(3)
    expect(await real.readFile(join(target, 'memory.md'), 'utf8')).toBe('current')
    expect(await real.readFile(join(target, 'memory.md.from-oldspace.2'), 'utf8')).toBe('old')
    expect(await real.readFile(join(target, 'only-old'), 'utf8')).toBe('original')
    await prepared.rollback()
    expect(await snapshot(source)).toEqual(oldTree)
    expect(await snapshot(target)).toEqual(newTree)
  })

  it('merges several source binding maps with target-wins keys and distinct backups', async () => {
    const second = join(root, 'older', 'person')
    options.sources.push({ path: second, spaceId: 'older' })
    const map = (path: string) => join(path, 'runs', '_session-ids.json')
    await put(map(source), '{"old":"old-session","shared":"old-shared","__proto__":"safe"}')
    await put(map(second), '{"older":"older-session","shared":"older-shared"}')
    await put(map(target), '{ "shared": "current-session", "native": {"version":1,"engineId":"anthropic","sessionId":"native-session"} }\n')
    const trees = await Promise.all([source, second, target].map(snapshot))
    const prepared = await prepareAppDataRelocation(options)
    expect(JSON.parse(await real.readFile(map(target), 'utf8'))).toEqual({
      old: 'old-session', older: 'older-session', shared: 'current-session',
      native: { version: 1, engineId: 'anthropic', sessionId: 'native-session' },
      ['__proto__']: 'safe',
    })
    expect(({} as any).safe).toBeUndefined()
    expect(await real.readFile(`${map(target)}.from-oldspace`, 'utf8')).toContain('old-session')
    expect(await real.readFile(`${map(target)}.from-older`, 'utf8')).toContain('older-session')
    await prepared.rollback()
    expect(await Promise.all([source, second, target].map(snapshot))).toEqual(trees)
  })

  it('commits several source binding maps and removes every private backup', async () => {
    const second = join(root, 'older', 'person')
    options.sources.push({ path: second, spaceId: 'older' })
    for (const [path, key] of [[source, 'old'], [second, 'older'], [target, 'new']]) {
      await put(join(path, 'runs', '_session-ids.json'), JSON.stringify({ [key]: key }))
    }
    const prepared = await prepareAppDataRelocation(options)
    await prepared.commit()
    expect(await exists(source)).toBe(false)
    expect(await exists(second)).toBe(false)
    expect((await real.readdir(join(target, 'runs'))).sort()).toEqual([
      '_session-ids.json', '_session-ids.json.from-older', '_session-ids.json.from-oldspace',
    ])
  })

  it('preserves leaf symlinks without reading or deleting their referents', async () => {
    const outside = join(root, 'outside')
    await put(join(outside, 'private'), 'outside data')
    await put(join(target, 'keep'), 'target')
    await real.mkdir(source, { recursive: true })
    await real.symlink(outside, join(source, 'link'), 'dir')
    const prepared = await prepareAppDataRelocation(options)
    expect(await real.readlink(join(target, 'link'))).toBe(outside)
    await prepared.commit()
    expect(await real.readFile(join(outside, 'private'), 'utf8')).toBe('outside data')
  })

  it('copies cross-volume with bounded filesystem copies and restores the original tree', async () => {
    await put(join(source, 'memory.md'), 'memory')
    await put(join(source, 'runs', 'chat'), 'history')
    await real.chmod(join(source, 'memory.md'), 0o640)
    forceCrossVolume()
    const before = await snapshot(source)
    const prepared = await prepareAppDataRelocation(options)
    expect(await snapshot(target)).toEqual(before)
    expect(await exists(source)).toBe(false)
    expect(fs.copyFile).toHaveBeenCalledWith(expect.any(String), expect.any(String), constants.COPYFILE_EXCL)
    expect((await real.stat(join(target, 'memory.md'))).mode & 0o777).toBe(0o640)
    await prepared.rollback()
    expect(await snapshot(source)).toEqual(before)
    expect(await exists(target)).toBe(false)
    expect(await real.readdir(join(root, 'old'))).toEqual(['person'])
  })

  it('commits a cross-volume merge and session map without retaining old roots', async () => {
    await put(join(source, 'memory.md'), 'memory')
    await put(join(source, 'runs', '_session-ids.json'), '{"old":"old"}')
    await put(join(target, 'runs', '_session-ids.json'), '{"new":"new"}')
    forceCrossVolume()
    const prepared = await prepareAppDataRelocation(options)
    await prepared.commit()
    expect(await exists(source)).toBe(false)
    expect(await real.readdir(join(root, 'old'))).toEqual([])
    expect(JSON.parse(await real.readFile(join(target, 'runs', '_session-ids.json'), 'utf8'))).toEqual({ old: 'old', new: 'new' })
  })

  it('removes a partial cross-volume copy and restores all source data', async () => {
    await put(join(source, 'a'), 'a')
    await put(join(source, 'b'), 'b')
    forceCrossVolume()
    let copies = 0
    vi.mocked(fs.copyFile).mockImplementation(async (from, to, mode) => {
      await real.copyFile(from, to, mode)
      if (++copies === 2) throw failure('EIO')
    })
    const before = await snapshot(source)
    await expect(prepareAppDataRelocation(options)).rejects.toThrow('EIO')
    expect(await snapshot(source)).toEqual(before)
    expect(await exists(target)).toBe(false)
    expect(await exists(journal)).toBe(false)
    expect(await real.readdir(join(root, 'old'))).toEqual(['person'])
  })

  it('treats a failed normal rename intent with an intact source as a rollback no-op', async () => {
    await put(join(source, 'memory'), 'retained')
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (String(from) === source) throw failure('EIO')
      return real.rename(from, to)
    })
    await expect(prepareAppDataRelocation(options)).rejects.toThrow('EIO')
    expect(await real.readFile(join(source, 'memory'), 'utf8')).toBe('retained')
    expect(await exists(target)).toBe(false)
    expect(await exists(journal)).toBe(false)
  })

  it('rolls back a successful mutation even when the rename reports failure afterward', async () => {
    await put(join(source, 'memory'), 'retained')
    let injected = false
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      await real.rename(from, to)
      if (!injected && String(from) === source) { injected = true; throw failure('EIO') }
    })
    await expect(prepareAppDataRelocation(options)).rejects.toThrow('EIO')
    expect(await real.readFile(join(source, 'memory'), 'utf8')).toBe('retained')
    expect(await exists(target)).toBe(false)
  })

  it.each([false, true])('restores exact trees when any preparation rename fails (after mutation=%s)', async afterMutation => {
    await put(join(source, 'memory.md'), 'source')
    await put(join(source, 'runs', '_session-ids.json'), '{ "old": "session" }\n')
    await put(join(target, 'memory.md'), 'target')
    await put(join(target, 'runs', '_session-ids.json'), '{ "new": "current" }\n')
    const before = await Promise.all([source, target].map(snapshot))
    let count = 0
    vi.mocked(fs.rename).mockImplementation(async (from, to) => { count++; await real.rename(from, to) })
    const baseline = await prepareAppDataRelocation(options)
    const mutations = count
    vi.mocked(fs.rename).mockImplementation(real.rename)
    await baseline.rollback()
    for (let failAt = 1; failAt <= mutations; failAt++) {
      let operation = 0
      vi.mocked(fs.rename).mockImplementation(async (from, to) => {
        const fail = ++operation === failAt
        if (fail && !afterMutation) throw failure('EIO')
        await real.rename(from, to)
        if (fail) throw failure('EIO')
      })
      await expect(prepareAppDataRelocation(options)).rejects.toThrow('EIO')
      expect(await Promise.all([source, target].map(snapshot)), `rename ${failAt}`).toEqual(before)
      expect(await exists(journal)).toBe(false)
    }
  }, 30000)

  it.each(['EPERM', 'EACCES', 'EBUSY'])('uses asynchronous bounded retries for %s', async code => {
    await put(join(source, 'memory'), 'retained')
    const delays: number[] = []
    const timeout = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, delay?: number) => {
      delays.push(delay ?? 0)
      return timeout(callback, 0)
    }) as typeof setTimeout)
    let attempts = 0
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (String(from) === source && ++attempts <= 3) throw failure(code)
      return real.rename(from, to)
    })
    const prepared = await prepareAppDataRelocation(options)
    expect(delays).toEqual([100, 400, 1000])
    expect(attempts).toBe(4)
    await prepared.commit()
  })

  it('gives up a persistently busy rename after four attempts without losing data', async () => {
    await put(join(source, 'memory'), 'retained')
    const timeout = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void) => timeout(callback, 0)) as typeof setTimeout)
    let attempts = 0
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (String(from) === source) { attempts++; throw failure('EPERM') }
      return real.rename(from, to)
    })
    await expect(prepareAppDataRelocation(options)).rejects.toThrow('EPERM')
    expect(attempts).toBe(4)
    expect(await real.readFile(join(source, 'memory'), 'utf8')).toBe('retained')
    expect(await exists(target)).toBe(false)
  })

  it('logs a missing historical source but propagates inaccessible storage', async () => {
    const prepared = await prepareAppDataRelocation(options)
    expect(prepared.fileCount).toBe(0)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('source is missing'), expect.anything())
    await prepared.rollback()
    vi.mocked(fs.lstat).mockImplementation(async path => {
      if (String(path) === source) throw failure('EACCES')
      return real.lstat(path)
    })
    await expect(prepareAppDataRelocation(options)).rejects.toThrow('EACCES')
    expect(await exists(target)).toBe(false)
  })

  it.each(['{', '[]', '{"broken":false}', '{"bad":{"version":1,"engineId":"bad"}}'])('rejects malformed binding maps before any tree move: %s', async content => {
    await put(join(source, 'runs', '_session-ids.json'), content)
    const before = await snapshot(source)
    await expect(prepareAppDataRelocation(options)).rejects.toThrow()
    expect(await snapshot(source)).toEqual(before)
    expect(await exists(target)).toBe(false)
    expect(await exists(journal)).toBe(false)
  })

  it('refuses unbounded binding maps', async () => {
    await put(join(source, 'runs', '_session-ids.json'), '')
    await real.truncate(join(source, 'runs', '_session-ids.json'), 16 * 1024 * 1024 + 1)
    await expect(prepareAppDataRelocation(options)).rejects.toThrow('bounded regular file')
    expect(await exists(target)).toBe(false)
  })
})

describe('related app roots and instruction reload', () => {
  it.each([false, true])('moves participant transcripts and nested metadata in one journal, committed=%s', async committed => {
    const participant = join(root, 'old', 'participant')
    const metadata = join(root, 'old', 'team-metadata')
    const participantTarget = join(dirname(target), 'participant')
    const metadataTarget = join(target, 'collaboration', 'participant')
    options.sources.unshift({ path: metadata, spaceId: 'oldspace', targetPath: metadataTarget })
    options.sources.push({ path: participant, spaceId: 'oldspace', targetPath: participantTarget })
    await put(join(source, 'memory.md'), 'memory')
    await put(join(source, 'collaboration', 'participant', 'existing'), 'original metadata')
    await put(join(participant, 'runs', 'reply.jsonl'), 'participant history')
    await put(join(metadata, 'state.json'), 'team metadata')
    const before = await Promise.all([source, participant, metadata].map(snapshot))
    const prepared = await prepareAppDataRelocation(options)
    expect(prepared.fileCount).toBe(4)
    expect(await real.readFile(join(participantTarget, 'runs', 'reply.jsonl'), 'utf8')).toBe('participant history')
    expect(await real.readFile(join(metadataTarget, 'state.json'), 'utf8')).toBe('team metadata')
    expect(await real.readFile(join(metadataTarget, 'existing'), 'utf8')).toBe('original metadata')
    const header = JSON.parse(await real.readFile(join(journal, 'header.json'), 'utf8'))
    expect(header.sources).toEqual(options.sources)
    await recoverAppDataRelocation(journal, committed)
    if (committed) {
      for (const path of [source, participant, metadata]) expect(await exists(path)).toBe(false)
      expect(await exists(participantTarget)).toBe(true)
      expect(await exists(metadataTarget)).toBe(true)
    } else {
      expect(await Promise.all([source, participant, metadata].map(snapshot))).toEqual(before)
      expect(await exists(target)).toBe(false)
      expect(await exists(participantTarget)).toBe(false)
    }
  })

  it('merges repeated participant targets and reloads only CC/legacy bindings, with exact rollback', async () => {
    const participant = join(root, 'old', 'participant')
    const older = join(root, 'older', 'participant')
    const participantTarget = join(dirname(target), 'participant')
    options.sources.push({ path: participant, spaceId: 'oldspace', targetPath: participantTarget },
      { path: older, spaceId: 'older', targetPath: participantTarget })
    options.reloadInstructions = true
    const mapPath = (path: string) => join(path, 'runs', '_session-ids.json')
    await put(mapPath(source), '{ "main": "main-session" }\n')
    await put(mapPath(participant), '{ "legacy": "legacy-session", "shared": "old" }\n')
    await put(mapPath(older), '{ "other": "older-session" }\n')
    const initial = {
      shared: 'current', cc: { version: 1, engineId: 'anthropic', sessionId: 'cc-session' },
      codex: { version: 1, engineId: 'codex', sessionId: 'codex-session' },
      routing: { version: 1, engineId: 'anthropic' },
      reloaded: { version: 1, legacySessionId: 'already', useCurrentInstructions: true },
    }
    await put(mapPath(participantTarget), JSON.stringify(initial, null, 2) + '\n')
    const before = await Promise.all([source, participant, older, target, participantTarget].map(snapshot))
    const prepared = await prepareAppDataRelocation(options)
    const map = JSON.parse(await real.readFile(mapPath(participantTarget), 'utf8'))
    expect(map).toEqual({
      ...initial,
      shared: { version: 1, legacySessionId: 'current', useCurrentInstructions: true },
      legacy: { version: 1, legacySessionId: 'legacy-session', useCurrentInstructions: true },
      other: { version: 1, legacySessionId: 'older-session', useCurrentInstructions: true },
      cc: { ...initial.cc, useCurrentInstructions: true },
    })
    expect(JSON.parse(await real.readFile(mapPath(target), 'utf8')).main).toEqual({
      version: 1, legacySessionId: 'main-session', useCurrentInstructions: true,
    })
    await prepared.rollback()
    expect(await Promise.all([source, participant, older, target, participantTarget].map(snapshot))).toEqual(before)
  })

  it('refuses oversized legacy identifiers before a reload could produce an unreadable map', async () => {
    options.reloadInstructions = true
    await put(join(source, 'runs', '_session-ids.json'), JSON.stringify({ chat: 'a'.repeat(513) }))
    const before = await snapshot(source)
    await expect(prepareAppDataRelocation(options)).rejects.toThrow('Malformed')
    expect(await snapshot(source)).toEqual(before)
    expect(await exists(target)).toBe(false)
  })

  it('reloads an existing main map even without source roots and recovers its committed rewrite', async () => {
    options.sources = []
    options.reloadInstructions = true
    await put(join(target, 'runs', '_session-ids.json'), '{"cc":{"version":1,"engineId":"anthropic","sessionId":"native"},"legacy":"old"}')
    await prepareAppDataRelocation(options)
    await recoverAppDataRelocation(journal, true)
    const map = JSON.parse(await real.readFile(join(target, 'runs', '_session-ids.json'), 'utf8'))
    expect(map.cc.useCurrentInstructions).toBe(true)
    expect(map.legacy).toEqual({ version: 1, legacySessionId: 'old', useCurrentInstructions: true })
    expect(await real.readdir(join(target, 'runs'))).toEqual(['_session-ids.json'])
  })

  it.each([false, true])('rolls back every instruction rewrite rename failure, after mutation=%s', async afterMutation => {
    options.reloadInstructions = true
    await put(join(source, 'runs', '_session-ids.json'), '{ "legacy": "old-session" }\n')
    const before = await snapshot(source)
    let count = 0
    vi.mocked(fs.rename).mockImplementation(async (from, to) => { count++; await real.rename(from, to) })
    const baseline = await prepareAppDataRelocation(options)
    const mutations = count
    vi.mocked(fs.rename).mockImplementation(real.rename)
    await baseline.rollback()
    for (let failAt = 1; failAt <= mutations; failAt++) {
      let operation = 0
      vi.mocked(fs.rename).mockImplementation(async (from, to) => {
        const fail = ++operation === failAt
        if (fail && !afterMutation) throw failure('EIO')
        await real.rename(from, to)
        if (fail) throw failure('EIO')
      })
      await expect(prepareAppDataRelocation(options)).rejects.toThrow('EIO')
      expect(await snapshot(source), `rewrite rename ${failAt}`).toEqual(before)
      expect(await exists(target)).toBe(false)
      expect(await exists(journal)).toBe(false)
    }
  }, 30000)

  it('copies related roots cross-volume and restores them on rollback', async () => {
    const participant = join(root, 'old', 'participant')
    const participantTarget = join(dirname(target), 'participant')
    options.sources.push({ path: participant, spaceId: 'oldspace', targetPath: participantTarget })
    await put(join(source, 'memory'), 'memory')
    await put(join(participant, 'runs', 'history'), 'history')
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (String(from).startsWith(join(root, 'old')) && String(to).startsWith(join(root, 'new'))) throw failure('EXDEV')
      return real.rename(from, to)
    })
    const before = await Promise.all([source, participant].map(snapshot))
    const prepared = await prepareAppDataRelocation(options)
    await prepared.rollback()
    expect(await Promise.all([source, participant].map(snapshot))).toEqual(before)
    expect(await exists(target)).toBe(false)
    expect(await exists(participantTarget)).toBe(false)
  })

  it('rejects escaping, overlapping and symlink-related targets before moving anything', async () => {
    const participant = join(root, 'old', 'participant')
    await put(join(source, 'memory'), 'retained')
    await put(join(participant, 'history'), 'retained')
    const extra = (targetPath: string) => ({ path: participant, spaceId: 'oldspace', targetPath })
    for (const targetPath of [dirname(target), join(root, 'outside'), join(dirname(target), '..', 'escape')]) {
      await expect(prepareAppDataRelocation({ ...options, sources: [...options.sources, extra(targetPath)] })).rejects.toThrow('escapes')
    }
    await expect(prepareAppDataRelocation({ ...options, sources: [...options.sources, extra(source)] })).rejects.toThrow()
    const sibling = join(dirname(target), 'participant')
    const another = join(root, 'another')
    await expect(prepareAppDataRelocation({ ...options, sources: [...options.sources, extra(sibling),
      { path: another, spaceId: 'another', targetPath: join(sibling, 'nested') }] })).rejects.toThrow('overlap')
    await real.mkdir(dirname(target), { recursive: true })
    await real.symlink(participant, sibling, 'dir')
    await expect(prepareAppDataRelocation({ ...options, sources: [...options.sources, extra(sibling)] })).rejects.toThrow('real directories')
    expect(await real.readFile(join(source, 'memory'), 'utf8')).toBe('retained')
    expect(await real.readFile(join(participant, 'history'), 'utf8')).toBe('retained')
    expect(await exists(target)).toBe(false)
  })

  it('rejects malicious nested-target paths hidden in the incoming main root before mutation', async () => {
    const metadata = join(root, 'old', 'metadata')
    const outside = join(root, 'outside')
    await put(join(source, 'memory'), 'retained')
    await put(join(metadata, 'state'), 'metadata')
    await real.mkdir(outside)
    await real.symlink(outside, join(source, 'collaboration'), 'dir')
    options.sources.push({ path: metadata, spaceId: 'oldspace', targetPath: join(target, 'collaboration', 'participant') })
    const before = await snapshot(source)
    await expect(prepareAppDataRelocation(options)).rejects.toThrow('parent is not a real directory')
    expect(await snapshot(source)).toEqual(before)
    expect(await exists(target)).toBe(false)
    expect(await exists(journal)).toBe(false)
  })
})

describe('relocation crash recovery and validation', () => {
  it.each([false, true])('recovers an interrupted prepared move with database committed=%s', async committed => {
    await put(join(source, 'memory'), 'retained')
    await prepareAppDataRelocation(options)
    await recoverAppDataRelocation(journal, committed)
    expect(await real.readFile(join(committed ? target : source, 'memory'), 'utf8')).toBe('retained')
    expect(await exists(committed ? source : target)).toBe(false)
    expect(await exists(journal)).toBe(false)
  })

  it('replays an interrupted EXDEV rollback after source restoration before its undone marker', async () => {
    await put(join(source, 'a'), 'source')
    await put(join(target, 'keep'), 'target')
    forceCrossVolume()
    const oldTree = await snapshot(source)
    const newTree = await snapshot(target)
    const prepared = await prepareAppDataRelocation(options)
    const move = (await records()).find(record => record.value.type === 'move')!
    let injected = false
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (!injected && String(to) === `${move.path}.undone`) { injected = true; throw failure('EIO') }
      return real.rename(from, to)
    })
    await expect(prepared.rollback()).rejects.toThrow('EIO')
    expect(await exists(`${move.path}.copy-removed`)).toBe(true)
    expect(await real.readFile(join(source, 'a'), 'utf8')).toBe('source')
    vi.mocked(fs.rename).mockImplementation(real.rename)
    await recoverAppDataRelocation(journal, false)
    expect(await snapshot(source)).toEqual(oldTree)
    expect(await snapshot(target)).toEqual(newTree)
  })

  it.each([false, true])('retries interrupted cleanup after removing the header, committed=%s', async committed => {
    await put(join(source, 'memory'), 'retained')
    await prepareAppDataRelocation(options)
    const outcome = committed ? 'committed' : 'rolled-back'
    vi.mocked(fs.unlink).mockImplementation(async path => {
      if (String(path) === join(journal, outcome)) throw failure('EIO')
      return real.unlink(path)
    })
    await expect(recoverAppDataRelocation(journal, committed)).rejects.toThrow('EIO')
    expect(await exists(join(journal, 'header.json'))).toBe(false)
    expect(await exists(join(journal, outcome))).toBe(true)
    vi.mocked(fs.unlink).mockImplementation(real.unlink)
    await recoverAppDataRelocation(journal, committed)
    expect(await exists(journal)).toBe(false)
    expect(await real.readFile(join(committed ? target : source, 'memory'), 'utf8')).toBe('retained')
  })

  it('replays an interrupted map rollback without deleting the restored original map', async () => {
    await put(join(source, 'runs', '_session-ids.json'), '{ "old": "old-session" }\n')
    await put(join(target, 'runs', '_session-ids.json'), '{ "current": "current-session" }\n')
    const before = await Promise.all([source, target].map(snapshot))
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (String(to) === join(target, 'runs', '_session-ids.json') && String(from).startsWith(journal)
        && !String(from).includes('.relocation-source-')) throw failure('EXDEV')
      return real.rename(from, to)
    })
    const prepared = await prepareAppDataRelocation(options)
    const generatedMove = (await records()).find(record => record.value.type === 'move' && dirname(record.value.from) === journal)!
    let injected = false
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (!injected && String(to) === `${generatedMove.path}.undone`) { injected = true; throw failure('EIO') }
      return real.rename(from, to)
    })
    await expect(prepared.rollback()).rejects.toThrow('EIO')
    const all = await records()
    const mapBackup = all.find(record => record.value.discard)!
    await real.rename(mapBackup.value.to, mapBackup.value.from)
    await real.writeFile(`${mapBackup.path}.undone`, '')
    vi.mocked(fs.rename).mockImplementation(real.rename)
    await recoverAppDataRelocation(journal, false)
    expect(await Promise.all([source, target].map(snapshot))).toEqual(before)
  })

  it('retries committed cleanup after partially deleting a source backup', async () => {
    await put(join(source, 'a'), 'a')
    await put(join(source, 'b'), 'b')
    forceCrossVolume()
    await prepareAppDataRelocation(options)
    let injected = false
    vi.mocked(fs.unlink).mockImplementation(async path => {
      if (!injected && String(path).includes('.relocation-source-')) {
        injected = true
        await real.unlink(path)
        throw failure('EIO')
      }
      return real.unlink(path)
    })
    await expect(recoverAppDataRelocation(journal, true)).rejects.toThrow('EIO')
    vi.mocked(fs.unlink).mockImplementation(real.unlink)
    await recoverAppDataRelocation(journal, true)
    expect(await real.readFile(join(target, 'a'), 'utf8')).toBe('a')
    expect(await real.readFile(join(target, 'b'), 'utf8')).toBe('b')
    expect(await real.readdir(join(root, 'old'))).toEqual([])
  })

  it.each([false, true])('recovers an empty final-cleanup journal, committed=%s', async committed => {
    await real.mkdir(journal, { recursive: true })
    await recoverAppDataRelocation(journal, committed)
    expect(await exists(journal)).toBe(false)
  })

  it('rejects a mismatched durable outcome', async () => {
    await real.mkdir(journal, { recursive: true })
    await real.writeFile(join(journal, 'committed'), '')
    await expect(recoverAppDataRelocation(journal, false)).rejects.toThrow('disagrees')
    expect(await exists(journal)).toBe(true)
  })

  it('rejects nested, repeated, aliased, file and symlink roots before mutation', async () => {
    await put(join(source, 'memory'), 'retained')
    for (const invalid of [
      { ...options, target: source },
      { ...options, target: join(source, 'nested') },
      { ...options, journalPath: join(source, 'journal') },
      { ...options, sources: [...options.sources, ...options.sources] },
      { ...options, target: join(source, 'memory') },
    ]) await expect(prepareAppDataRelocation(invalid)).rejects.toThrow()
    await real.mkdir(dirname(target), { recursive: true })
    await real.symlink(source, target, 'dir')
    await expect(prepareAppDataRelocation(options)).rejects.toThrow('real directories')
    await real.unlink(target)
    await real.symlink(dirname(source), join(root, 'alias'), 'dir')
    await expect(prepareAppDataRelocation({ ...options, target: join(root, 'alias', 'person') })).rejects.toThrow('overlap')
    expect(await real.readFile(join(source, 'memory'), 'utf8')).toBe('retained')
  })

  it.each([false, true])('accepts trusted symlink ancestors and recovers through the original spelling, committed=%s', async committed => {
    await put(join(source, 'memory'), 'retained')
    const participant = join(root, 'old', 'participant')
    await put(join(participant, 'runs', 'history'), 'history')
    const alias = join(root, 'alias')
    await real.symlink(root, alias, 'dir')
    const aliasTarget = join(alias, 'new', 'person')
    const aliasJournal = join(alias, 'private', 'relocations', 'person')
    await prepareAppDataRelocation({ ...options, target: aliasTarget, journalPath: aliasJournal,
      sources: [{ path: join(alias, 'old', 'person'), spaceId: 'oldspace' },
        { path: join(alias, 'old', 'participant'), spaceId: 'oldspace', targetPath: join(alias, 'new', 'participant') }] })
    const header = JSON.parse(await real.readFile(join(journal, 'header.json'), 'utf8'))
    expect(header.target).toBe(target)
    expect(header.journalPath).toBe(journal)
    expect(header.sources[0].path).toBe(source)
    expect(header.sources[1].targetPath).toBe(join(root, 'new', 'participant'))
    await recoverAppDataRelocation(aliasJournal, committed)
    expect(await exists(journal)).toBe(false)
    expect(await real.readFile(join(committed ? target : source, 'memory'), 'utf8')).toBe('retained')
    expect(await real.readFile(join(committed ? join(root, 'new', 'participant') : participant, 'runs', 'history'), 'utf8')).toBe('history')
  })

  it('does not recanonicalize stored roots through a symlink introduced after preparation', async () => {
    await put(join(source, 'memory'), 'retained')
    await prepareAppDataRelocation(options)
    const parked = join(root, 'parked-new')
    await real.rename(dirname(target), parked)
    await real.symlink(parked, dirname(target), 'dir')
    await expect(recoverAppDataRelocation(journal, false)).rejects.toThrow('parent is not a real directory')
    expect(await real.readFile(join(parked, 'person', 'memory'), 'utf8')).toBe('retained')
  })

  it('never follows a symlink journal root', async () => {
    const outside = join(root, 'outside')
    await put(join(outside, 'private'), 'retained')
    await real.mkdir(dirname(journal), { recursive: true })
    await real.symlink(outside, journal, 'dir')
    await expect(recoverAppDataRelocation(journal, false)).rejects.toThrow('real directories')
    expect(await real.readFile(join(outside, 'private'), 'utf8')).toBe('retained')
  })

  it.each(['from', 'to', 'stage', 'sourceBackup'])('rejects a tampered %s operation before modifying any data', async field => {
    await put(join(source, 'memory'), 'retained')
    await prepareAppDataRelocation(options)
    const outside = join(root, 'outside')
    await put(join(outside, 'private'), 'retained outside')
    const record = (await records()).find(record => record.value.type === 'move')!
    record.value[field] = outside
    await real.writeFile(record.path, JSON.stringify(record.value))
    const before = await snapshot(target)
    await expect(recoverAppDataRelocation(journal, false)).rejects.toThrow()
    expect(await snapshot(target)).toEqual(before)
    expect(await real.readFile(join(outside, 'private'), 'utf8')).toBe('retained outside')
  })

  it('rejects tampered directory intents before removing an unrelated empty directory', async () => {
    await put(join(source, 'memory'), 'retained')
    await prepareAppDataRelocation(options)
    const outside = join(root, 'outside')
    await real.mkdir(outside)
    const record = (await records()).find(record => record.value.type === 'mkdir')!
    record.value.path = outside
    await real.writeFile(record.path, JSON.stringify(record.value))
    await expect(recoverAppDataRelocation(journal, false)).rejects.toThrow('directory operation')
    expect(await exists(outside)).toBe(true)
    expect(await real.readFile(join(target, 'memory'), 'utf8')).toBe('retained')
  })

  it('rejects incomplete commits and sparse operation logs without touching data', async () => {
    await put(join(source, 'memory'), 'retained')
    await prepareAppDataRelocation(options)
    await real.unlink(join(journal, 'prepared'))
    await expect(recoverAppDataRelocation(journal, true)).rejects.toThrow('incomplete')
    await real.writeFile(join(journal, '999999999999.json'), '{}')
    await expect(recoverAppDataRelocation(journal, false)).rejects.toThrow('gap')
    expect(await real.readFile(join(target, 'memory'), 'utf8')).toBe('retained')
  })

  it('rejects symlink operation records and symlink operation parents', async () => {
    await put(join(source, 'memory'), 'retained')
    await put(join(target, 'keep'), 'keep')
    await prepareAppDataRelocation(options)
    const record = (await records()).find(record => record.value.type === 'move')!
    const original = await real.readFile(record.path)
    const outside = join(root, 'outside-record')
    await real.writeFile(outside, original)
    await real.unlink(record.path)
    await real.symlink(outside, record.path)
    await expect(recoverAppDataRelocation(journal, false)).rejects.toThrow('journal record')
    await real.unlink(record.path)
    await real.writeFile(record.path, original)
    const parked = `${target}-parked`
    await real.rename(target, parked)
    await real.symlink(parked, target, 'dir')
    await expect(recoverAppDataRelocation(journal, false)).rejects.toThrow('real directories')
    expect(await real.readFile(join(parked, 'memory'), 'utf8')).toBe('retained')
  })
})
