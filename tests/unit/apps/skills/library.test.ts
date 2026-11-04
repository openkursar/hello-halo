import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync, rmSync } from 'node:fs'
import * as fs from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppManagerService, InstalledApp } from '../../../../src/main/apps/manager'
import type { SkillSpec } from '../../../../src/main/apps/spec'
import type { SkillImportInput, SkillRef } from '../../../../src/shared/types/skills'
import { createSkillLibrary, type SkillLibraryDependencies } from '../../../../src/main/apps/skills/service'
import { classifySkillSource, managedSkillPath, personalSkillPath, readSkillPackage, skillFileId, skillRevision, writeSkillPackage } from '../../../../src/main/services/skills'

vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }))
vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(),
  homedir: () => globalThis.__HALO_TEST_DIR__,
}))

const asset = Buffer.from([0, 255, 130, 0, 1])

function content(name = 'report', body = 'Original instructions'): string {
  return `---\nname: ${name}\ndescription: Report instructions\ncustom-header: preserved\nuser-invocable: true\n---\n${body}\n`
}

function spec(extra: Partial<SkillSpec> = {}): SkillSpec {
  return { type: 'skill', spec_version: '1', name: 'report', version: '1', description: 'Report instructions',
    store: { install_source: 'manual', tags: [] },
    skill_files: { 'SKILL.md': content(), 'scripts/old.js': 'old script' },
    skill_assets: { 'assets/sample.bin': { encoding: 'base64', content: asset.toString('base64') } },
    ...extra,
  }
}

function record(id: string, spaceId: string | null, definition = spec(), filePath?: string, status: InstalledApp['status'] = 'active'): InstalledApp {
  return { id, specId: definition.name, spaceId, status, spec: definition,
    userConfig: {}, userOverrides: filePath ? { skill: { version: 1, filePath } } : {},
    permissions: { granted: [], denied: [] }, installedAt: 1, upgradeStrategy: 'auto', knowledgeSeeded: false }
}

function metadata(definition: SkillSpec): SkillSpec {
  const result = { ...definition }
  delete result.skill_content
  delete result.skill_files
  delete result.skill_assets
  return result
}

describe('skill library file operations with a narrow manager', () => {
  let root: string
  let halo: string
  let work: Map<string, string>
  let records: Map<string, InstalledApp>
  let deps: SkillLibraryDependencies
  let library: ReturnType<typeof createSkillLibrary>
  let manager: Pick<AppManagerService, 'getApp' | 'getSkillRecord' | 'listSkillRecords' | 'updateSkillRecord' | 'install' | 'pause' | 'resume' | 'uninstall'>

  beforeEach(() => {
    root = realpathSync(globalThis.__HALO_TEST_DIR__)
    globalThis.__HALO_TEST_DIR__ = root
    halo = join(root, 'halo-data')
    work = new Map([['space', join(root, 'project')], ['other', join(root, 'other-project')]])
    records = new Map()
    let sequence = 0
    manager = {
      listSkillRecords: vi.fn(spaceId => [...records.values()].filter(app => app.spaceId === spaceId).map(app => structuredClone({ ...app, spec: metadata(app.spec as SkillSpec) }))),
      getApp: vi.fn(id => structuredClone(records.get(id) ?? null)),
      getSkillRecord: vi.fn(id => structuredClone(records.get(id) ?? null)),
      updateSkillRecord: vi.fn((id, change) => {
        const previous = records.get(id)!
        records.set(id, structuredClone({ ...previous,
          ...(change.spec ? { spec: classifySkillSource(change.spec) === 'personal' ? metadata(change.spec) : change.spec, specId: change.spec.name } : {}),
          ...(change.spaceId !== undefined ? { spaceId: change.spaceId } : {}),
          ...(change.status ? { status: change.status } : {}),
          userOverrides: { ...previous.userOverrides, ...(change.skill ? { skill: change.skill } : {}) },
        }))
      }),
      install: vi.fn(async (spaceId, definition) => {
        if (definition.type !== 'skill') throw new Error('The fixture only accepts skills')
        const existing = [...records.values()].find(app => app.specId === definition.name && app.spaceId === spaceId)
        if (existing && (existing.status !== 'uninstalled' || classifySkillSource(existing.spec as SkillSpec) !== classifySkillSource(definition) || existing.spec.store?.slug !== definition.store?.slug)) {
          throw new Error('An installation with this name already exists')
        }
        const id = existing?.id ?? `installation-${++sequence}`
        const path = personalSkillPath(spaceId === null ? null : work.get(spaceId)!, definition.name)
        const files = definition.skill_files ?? { 'SKILL.md': definition.skill_content! }
        writeSkillPackage(path, files, definition.skill_assets)
        records.set(id, record(id, spaceId, metadata(definition), path))
        return id
      }),
      uninstall: vi.fn(async id => {
        const app = records.get(id)!
        if (existsSync(dirname(app.userOverrides.skill!.filePath))) await deps.trash(dirname(app.userOverrides.skill!.filePath))
        records.set(id, { ...app, status: 'uninstalled', userOverrides: { ...app.userOverrides, skill: { ...app.userOverrides.skill!, deleted: true } } })
      }),
      pause: vi.fn(id => { records.set(id, { ...records.get(id)!, status: 'paused' }) }),
      resume: vi.fn(id => {
        const app = records.get(id)!
        skillRevision(app.userOverrides.skill!.filePath)
        records.set(id, { ...app, status: 'active' })
      }),
    }
    deps = {
      context: (spaceId, workDir) => ({ manager: manager as AppManagerService, haloDir: halo, spaceId,
        workDir: workDir ?? (spaceId === null ? null : work.get(spaceId)!),
        spaceDataPath: spaceId === null ? null : join(halo, 'spaces', spaceId), legacyGlobalRoots: [] }),
      trash: vi.fn(async () => { throw new Error('Test trash is unavailable') }), openFolder: vi.fn(),
    }
    library = createSkillLibrary(deps)
  })

  afterEach(() => { vi.restoreAllMocks() })

  function personal(spaceId: string | null = 'space', name = 'report', agent = '.agents'): string {
    const path = join(spaceId === null ? root : work.get(spaceId)!, agent, 'skills', name, 'SKILL.md')
    writeSkillPackage(path, { 'SKILL.md': content(name), 'scripts/old.js': 'old script' }, spec().skill_assets)
    return path
  }

  function ref(path: string, spaceId: string | null = 'space'): SkillRef {
    return { spaceId, id: skillFileId(path) }
  }

  function registered(source: 'manual' | 'store' = 'manual', status: InstalledApp['status'] = 'active'): { app: InstalledApp; path: string; ref: SkillRef } {
    const definition = spec({ store: source === 'manual' ? { install_source: 'manual', tags: [] } : { install_source: 'store', slug: 'author/report', tags: [] } })
    const path = source === 'manual' ? personalSkillPath(work.get('space')!, 'report') : managedSkillPath(halo, join(halo, 'spaces', 'space'), 'managed')
    writeSkillPackage(path, definition.skill_files!, definition.skill_assets)
    const app = record(source === 'manual' ? 'personal-installation' : 'managed', 'space', source === 'manual' ? metadata(definition) : definition, path, status)
    records.set(app.id, app)
    return { app, path, ref: { spaceId: 'space', id: `app:${app.id}` } }
  }

  it('persists pause without changing any package bytes and returns a new effective catalog', () => {
    const local = personal()
    const global = personal(null)
    const before = readSkillPackage(local)
    expect(library.effectiveCatalog('space')[0].source.path).toBe(local)
    library.setEnabled({ ref: ref(local), enabled: false })
    expect(readSkillPackage(local)).toEqual(before)
    const reopened = createSkillLibrary(deps)
    expect(reopened.list({ spaceId: 'space' }).groups[0].copies.find(copy => copy.id === skillFileId(local))).toMatchObject({ enabled: false, availability: 'disabled' })
    expect(reopened.effectiveCatalog('space')[0].source.path).toBe(global)
    reopened.setEnabled({ ref: ref(local), enabled: true })
    expect(reopened.effectiveCatalog('space')[0].source.path).toBe(local)
    expect(readSkillPackage(local)).toEqual(before)
  })

  it('delegates registered pause/resume without copying old instructions back onto disk', () => {
    const selected = registered()
    const fresh = content('report', 'Externally revised instructions')
    writeFileSync(selected.path, fresh)
    library.setEnabled({ ref: selected.ref, enabled: false })
    expect(manager.pause).toHaveBeenCalledWith(selected.app.id)
    expect(library.effectiveCatalog('space')).toEqual([])
    library.setEnabled({ ref: selected.ref, enabled: true })
    expect(manager.resume).toHaveBeenCalledWith(selected.app.id)
    expect(library.read(selected.ref).content).toBe(fresh)
    expect(readFileSync(selected.path, 'utf8')).toBe(fresh)
  })

  it('rejects a stale save and preserves external changes, unknown headers, and untouched resources', () => {
    const path = personal()
    const previous = library.read(ref(path))
    const external = content('report', 'New external version, not the editor draft')
    writeFileSync(path, external)
    expect(() => library.save({ ref: ref(path), revision: previous.revision, content: content('report', 'Stale editor draft') })).toThrow(/changed|reload/i)
    expect(readFileSync(path, 'utf8')).toBe(external)
    const current = library.read(ref(path))
    const script = join(dirname(path), 'scripts', 'old.js')
    const before = statSync(script)
    const saved = library.save({ ref: ref(path), revision: current.revision, content: current.content.replace('New external version, not the editor draft', 'Confirmed current edit') })
    expect(saved.content).toContain('custom-header: preserved')
    expect(saved.content).toContain('Confirmed current edit')
    expect(statSync(script).ino).toBe(before.ino)
    expect(readFileSync(script, 'utf8')).toBe('old script')
    expect(readFileSync(join(dirname(path), 'assets', 'sample.bin'))).toEqual(asset)
  })

  it('moves a disabled discovered global package to one workspace without keeping an old copy', () => {
    const path = personal(null)
    library.setEnabled({ ref: ref(path, null), enabled: false })
    const before = library.read(ref(path, null))
    const preview = library.movePreview({ ref: ref(path, null), spaceId: 'space' })
    expect(preview).toMatchObject({ fromPath: path, toPath: personalSkillPath(work.get('space')!, 'report'), fromSpaceId: null, toSpaceId: 'space' })
    const moved = library.move({ ref: ref(path, null), spaceId: 'space', revision: before.revision })
    expect(moved).toMatchObject({ enabled: false, availability: 'disabled', spaceId: 'space' })
    expect(existsSync(path)).toBe(false)
    expect(readFileSync(moved.path, 'utf8')).toBe(before.content)
    expect(readFileSync(join(dirname(moved.path), 'assets', 'sample.bin'))).toEqual(asset)
    const reopened = createSkillLibrary(deps)
    expect(reopened.effectiveCatalog('space')).toEqual([])
    expect(reopened.effectiveCatalog('other')).toEqual([])
    reopened.setEnabled({ ref: ref(moved.path), enabled: true })
    expect(reopened.effectiveCatalog('space')[0].source.path).toBe(moved.path)
  })

  it.each(['manual', 'store'] as const)('moves a registered paused %s package while retaining its installation and availability', source => {
    const selected = registered(source, 'paused')
    const before = library.read(selected.ref)
    const moved = library.move({ ref: selected.ref, spaceId: 'other', revision: before.revision })
    expect(moved).toMatchObject({ appId: selected.app.id, spaceId: 'other', enabled: false, availability: 'disabled' })
    expect(existsSync(selected.path)).toBe(false)
    expect(records.get(selected.app.id)).toMatchObject({ status: 'paused', spaceId: 'other', userOverrides: { skill: { filePath: moved.path } } })
    expect(readFileSync(moved.path, 'utf8')).toBe(before.content)
    expect(library.effectiveCatalog('space')).toEqual([])
    expect(library.effectiveCatalog('other')).toEqual([])
  })

  it('refuses a conflicting scope move without changing either package', () => {
    const path = personal()
    const other = personal('other')
    const destination = content('report', 'Destination version')
    writeFileSync(other, destination)
    const detail = library.read(ref(path))
    expect(library.movePreview({ ref: ref(path), spaceId: 'other' }).conflict).toBeTruthy()
    expect(() => library.move({ ref: ref(path), spaceId: 'other', revision: detail.revision })).toThrow(/already|conflict/i)
    expect(readFileSync(path, 'utf8')).toBe(detail.content)
    expect(readFileSync(other, 'utf8')).toBe(destination)
  })

  it.each(['manual', 'store'] as const)('preserves the original %s location and record when a move record commit fails', source => {
    const selected = registered(source, 'paused')
    const before = library.read(selected.ref)
    const previous = structuredClone(records.get(selected.app.id))
    vi.mocked(manager.updateSkillRecord).mockImplementationOnce(() => { throw new Error('record storage unavailable') })
    expect(() => library.move({ ref: selected.ref, spaceId: 'other', revision: before.revision })).toThrow(/record storage unavailable/)
    expect.soft(existsSync(selected.path), 'Failed scope change must preserve the original skill path').toBe(true)
    if (existsSync(selected.path)) expect(readFileSync(selected.path, 'utf8')).toBe(before.content)
    expect(records.get(selected.app.id)).toEqual(previous)
  })

  it.each(['.agents', '.claude'])('replaces a paused %s copy completely and makes the same request ID retry idempotent', async agent => {
    const path = personal('space', 'report', agent)
    library.setEnabled({ ref: ref(path), enabled: false })
    const detail = library.read(ref(path))
    const replacement = spec({ skill_files: { 'SKILL.md': content('report', 'Replacement instructions'), 'scripts/new.js': 'new script' } })
    const input: SkillImportInput = { spaceId: 'space', spec: replacement, requestId: 'replace-request', replace: { ref: ref(path), revision: detail.revision } }
    const first = await library.import(input)
    expect(first).toMatchObject({ path, enabled: false, availability: 'disabled' })
    expect(readFileSync(path, 'utf8')).toBe(replacement.skill_files!['SKILL.md'])
    expect(existsSync(join(dirname(path), 'scripts', 'old.js'))).toBe(false)
    expect(readFileSync(join(dirname(path), 'scripts', 'new.js'), 'utf8')).toBe('new script')
    expect(readFileSync(join(dirname(path), 'assets', 'sample.bin'))).toEqual(asset)
    const reopened = createSkillLibrary(deps)
    await expect(reopened.import(input)).resolves.toMatchObject({ id: first.id, path, enabled: false })
    expect(manager.install).not.toHaveBeenCalled()
    expect(reopened.effectiveCatalog('space')).toEqual([])
  })

  it('coalesces concurrent import requests and repeated confirmations into one installed copy', async () => {
    const input = { spaceId: 'space', spec: spec(), requestId: 'import-request' }
    const [first, second] = await Promise.all([library.import(input), library.import(input)])
    expect(first.id).toBe(second.id)
    expect(manager.install).toHaveBeenCalledTimes(1)
    expect(records.size).toBe(1)
    expect(await createSkillLibrary(deps).import(input)).toMatchObject({ id: first.id })
    expect(manager.install).toHaveBeenCalledTimes(1)
    expect(readFileSync(join(dirname(first.path), 'assets', 'sample.bin'))).toEqual(asset)
  })

  it.each(['manual', 'store'] as const)('preserves the previous %s instructions if its save record update fails', source => {
    const selected = registered(source)
    const before = library.read(selected.ref)
    const previous = structuredClone(records.get(selected.app.id))
    vi.mocked(manager.updateSkillRecord).mockImplementationOnce(() => { throw new Error('record storage unavailable') })
    expect(() => library.save({ ref: selected.ref, revision: before.revision, content: content('report', 'Uncommitted editor change') })).toThrow(/record storage unavailable/)
    expect(readFileSync(selected.path, 'utf8')).toBe(before.content)
    expect(records.get(selected.app.id)).toEqual(previous)
  })

  it('preserves the previous complete package if a replacement record update fails', async () => {
    const selected = registered()
    const before = library.read(selected.ref)
    const previous = readSkillPackage(selected.path)
    vi.mocked(manager.updateSkillRecord).mockImplementationOnce(() => { throw new Error('record storage unavailable') })
    await expect(library.import({ spaceId: 'space', requestId: 'failed-replacement', replace: { ref: selected.ref, revision: before.revision },
      spec: spec({ skill_files: { 'SKILL.md': content('report', 'Uncommitted replacement') }, skill_assets: undefined }) })).rejects.toThrow(/record storage unavailable/)
    const current = readSkillPackage(selected.path)
    expect(current.files).toEqual(previous.files)
    expect(current.assets).toEqual(previous.assets)
  })

  it('leaves legacy removed instructions recoverable when their attempted restore fails', async () => {
    const removed = record('legacy-removed', 'space', spec(), undefined, 'uninstalled')
    records.set(removed.id, removed)
    vi.mocked(manager.install).mockRejectedValueOnce(new Error('destination unavailable'))
    await expect(library.restoreLegacy({ appId: removed.id, spaceId: 'space' })).rejects.toThrow(/destination unavailable/)
    expect(records.get(removed.id)).toEqual(removed)
    expect(library.list({ spaceId: 'space' }).legacyRemoved).toHaveLength(1)
    expect(library.effectiveCatalog('space')).toEqual([])
    expect(existsSync(personalSkillPath(work.get('space')!, 'report'))).toBe(false)
  })

  it('restores a removed manual skill through its existing installation without discarding its sole contents', async () => {
    const removed = record('legacy-removed', 'space', spec(), undefined, 'uninstalled')
    records.set(removed.id, removed)
    const restored = await library.restoreLegacy({ appId: removed.id, spaceId: 'space' })
    expect(restored).toMatchObject({ appId: removed.id, enabled: true, source: 'personal' })
    expect(readFileSync(restored.path, 'utf8')).toBe(content())
    expect(readFileSync(join(dirname(restored.path), 'assets', 'sample.bin'))).toEqual(asset)
    expect(library.list({ spaceId: 'space' }).legacyRemoved).toEqual([])
    expect(library.effectiveCatalog('space')[0].source.path).toBe(restored.path)
  })

  it('saves a removed managed package as a separate personal copy before hiding its legacy entry', async () => {
    const removed = record('legacy-removed', 'space', spec({ store: { install_source: 'store', slug: 'author/report', tags: [] } }), undefined, 'uninstalled')
    records.set(removed.id, removed)
    const restored = await library.restoreLegacy({ appId: removed.id, spaceId: 'space', name: 'recovered-report' })
    expect(restored).toMatchObject({ name: 'recovered-report', source: 'personal', enabled: true })
    expect(restored.appId).not.toBe(removed.id)
    expect(readFileSync(restored.path, 'utf8')).toContain('Original instructions')
    expect(readFileSync(join(dirname(restored.path), 'scripts', 'old.js'), 'utf8')).toBe('old script')
    expect(readFileSync(join(dirname(restored.path), 'assets', 'sample.bin'))).toEqual(asset)
    expect(records.get(removed.id)!.status).toBe('uninstalled')
    expect(library.list({ spaceId: 'space' }).legacyRemoved).toEqual([])
  })

  it('does not hide an old removed package when recovery collides with an existing personal copy', async () => {
    const path = personal()
    const original = readSkillPackage(path)
    const removed = record('legacy-removed', 'space', spec(), undefined, 'uninstalled')
    records.set(removed.id, removed)
    await expect(library.restoreLegacy({ appId: removed.id, spaceId: 'space' })).rejects.toThrow(/already exists/i)
    expect(records.get(removed.id)).toEqual(removed)
    expect(readSkillPackage(path)).toEqual(original)
    expect(library.list({ spaceId: 'space' }).legacyRemoved).toHaveLength(1)
  })

  it.each(['manual', 'store'] as const)('can inspect, disable and forget a %s record whose entire package was removed', async source => {
    const selected = registered(source)
    rmSync(dirname(selected.path), { recursive: true })
    const detail = library.read(selected.ref)
    expect(detail).toMatchObject({ revision: 'missing', content: '', files: [], copy: { availability: 'missing', editable: false, enabled: true } })
    expect(() => library.setEnabled({ ref: selected.ref, enabled: true })).toThrow(/missing/)
    expect(library.setEnabled({ ref: selected.ref, enabled: false })).toMatchObject({ enabled: false, availability: 'missing' })
    await library.delete({ ref: selected.ref, revision: detail.revision })
    expect(manager.uninstall).toHaveBeenCalledWith(selected.app.id)
    expect(deps.trash).not.toHaveBeenCalled()
    expect(records.get(selected.app.id)).toMatchObject({ status: 'uninstalled', userOverrides: { skill: { deleted: true } } })
    expect(library.list({ spaceId: 'space' }).groups).toEqual([])
  })

  it('never treats an unreadable package as missing when deleting or disabling it', async () => {
    const selected = registered()
    const original = fs.lstatSync
    vi.spyOn(fs, 'lstatSync').mockImplementation(((path: fs.PathLike, options?: unknown) => {
      if (String(path) === dirname(selected.path)) throw Object.assign(new Error('Controlled access denied'), { code: 'EACCES' })
      return original(path, options as fs.StatOptions)
    }) as typeof fs.lstatSync)
    expect(() => library.read(selected.ref)).toThrow(/access denied/)
    expect(() => library.setEnabled({ ref: selected.ref, enabled: false })).toThrow(/access denied/)
    await expect(library.delete({ ref: selected.ref, revision: 'missing' })).rejects.toThrow(/access denied/)
    expect(manager.pause).not.toHaveBeenCalled()
    expect(manager.uninstall).not.toHaveBeenCalled()
    expect(deps.trash).not.toHaveBeenCalled()
  })

  it('does not let a missing-file confirmation delete a package restored before confirmation', async () => {
    const selected = registered()
    rmSync(dirname(selected.path), { recursive: true })
    const detail = library.read(selected.ref)
    writeSkillPackage(selected.path, { 'SKILL.md': content('report', 'Restored newer instructions') })
    await expect(library.delete({ ref: selected.ref, revision: detail.revision })).rejects.toThrow(/changed since/)
    expect(manager.uninstall).not.toHaveBeenCalled()
    expect(readFileSync(selected.path, 'utf8')).toContain('Restored newer instructions')
  })

  it('does not remove bytes or create a tombstone when the trash operation fails', async () => {
    const selected = registered()
    const before = library.read(selected.ref)
    const previous = structuredClone(records.get(selected.app.id))
    await expect(library.delete({ ref: selected.ref, revision: before.revision })).rejects.toThrow(/trash is unavailable/)
    expect(readFileSync(selected.path, 'utf8')).toBe(before.content)
    expect(records.get(selected.app.id)).toEqual(previous)
  })
})
