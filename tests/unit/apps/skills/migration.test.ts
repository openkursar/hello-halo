import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, lstatSync, mkdirSync, opendirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppManagerService, InstalledApp } from '../../../../src/main/apps/manager'
import type { SkillSpec } from '../../../../src/main/apps/spec'
import { migrateSkillRecord, migrateUnregisteredGlobalSkills } from '../../../../src/main/apps/skills/migration'
import { buildSkillCatalog, effectiveSkillCatalog, type SkillLibraryContext } from '../../../../src/main/apps/skills/catalog'
import { skillFilePath, readSkillPackage, readSkillPreference } from '../../../../src/main/services/skills'

vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(),
  homedir: () => globalThis.__HALO_TEST_DIR__,
}))

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, opendirSync: vi.fn(actual.opendirSync), lstatSync: vi.fn(actual.lstatSync) }
})

const original = '---\nname: report\ndescription: Stored report\nuser-invocable: true\n---\nOriginal instructions\n'
const binary = Buffer.from([0, 255, 128, 1, 0])
const missingLegacyFiles = 'The previous skill files are missing. Restore them before using this skill.'

function legacy(source: 'manual' | 'store' = 'manual', status: InstalledApp['status'] = 'active', spaceId: string | null = 'space'): InstalledApp {
  return {
    id: 'legacy-installation', specId: 'report', spaceId, status,
    spec: { type: 'skill', spec_version: '1', name: 'report', version: '1', description: 'Stored report',
      store: { install_source: source, tags: [], ...(source === 'store' ? { slug: 'author/report' } : {}) },
      skill_files: { 'SKILL.md': original, 'scripts/run.js': 'original script' },
      skill_assets: { 'assets/sample.bin': { encoding: 'base64', content: binary.toString('base64') } } },
    userConfig: {}, userOverrides: {}, permissions: { granted: [], denied: [] },
    installedAt: 1, upgradeStrategy: 'auto', knowledgeSeeded: false,
  }
}

function packageAt(path: string, body = original): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
  mkdirSync(join(dirname(path), 'scripts'), { recursive: true })
  writeFileSync(join(dirname(path), 'scripts', 'run.js'), 'original script')
  mkdirSync(join(dirname(path), 'assets'), { recursive: true })
  writeFileSync(join(dirname(path), 'assets', 'sample.bin'), binary)
}

describe('legacy skill migration with isolated files and record commits', () => {
  let root: string
  let work: string
  let context: SkillLibraryContext
  let records: Map<string, InstalledApp>
  let manager: Pick<AppManagerService, 'getSkillRecord' | 'listSkillRecords' | 'updateSkillRecord'>

  beforeEach(() => {
    vi.spyOn(console, 'info')
    root = realpathSync(globalThis.__HALO_TEST_DIR__)
    globalThis.__HALO_TEST_DIR__ = root
    work = join(root, 'project')
    records = new Map()
    manager = {
      getSkillRecord: vi.fn(id => structuredClone(records.get(id) ?? null)),
      listSkillRecords: vi.fn(spaceId => [...records.values()].filter(app => app.spaceId === spaceId).map(app => {
        const spec = { ...app.spec } as SkillSpec
        delete spec.skill_content
        delete spec.skill_files
        delete spec.skill_assets
        return structuredClone({ ...app, spec })
      })),
      updateSkillRecord: vi.fn((id, change) => {
        const previous = records.get(id)!
        records.set(id, structuredClone({ ...previous,
          ...(change.spec ? { spec: change.spec, specId: change.spec.name } : {}),
          ...(change.spaceId !== undefined ? { spaceId: change.spaceId } : {}),
          ...(change.status ? { status: change.status } : {}),
          userOverrides: { ...previous.userOverrides, ...(change.skill ? { skill: change.skill } : {}) },
        }))
      }),
    }
    context = { manager: manager as AppManagerService, haloDir: join(root, 'halo-data'),
      spaceId: 'space', workDir: work, spaceDataPath: join(root, 'halo-data', 'spaces', 'space'),
      legacyGlobalRoots: [join(root, 'legacy-halo-config', 'skills')] }
  })

  afterEach(() => { vi.restoreAllMocks() })

  function add(app = legacy()): InstalledApp {
    records.set(app.id, structuredClone(app))
    return app
  }

  function oldPath(app: InstalledApp): string {
    return join(app.spaceId ? join(work, '.claude', 'skills') : context.legacyGlobalRoots[0], 'report', 'SKILL.md')
  }

  function migrate(app: InstalledApp): string | undefined {
    const summary = manager.listSkillRecords(app.spaceId).find(item => item.id === app.id)!
    return migrateSkillRecord(summary, context)
  }

  function expectPreservationRecordedOnce(app: InstalledApp): void {
    expect(migrate(records.get(app.id)!)).toBeUndefined()
    expect(buildSkillCatalog(context).warnings).toEqual([])
    expect(records.get(app.id)!.userOverrides.skill!.migrationWarning).toBeUndefined()
    expect(console.info).toHaveBeenCalledTimes(1)
    expect(console.info).toHaveBeenCalledWith(
      '[Skills] Preserved legacy skill files during migration',
      expect.objectContaining({ appId: app.id, reason: expect.any(String) }),
    )
    expect(manager.getSkillRecord).toHaveBeenCalledTimes(1)
    expect(manager.updateSkillRecord).toHaveBeenCalledTimes(1)
  }

  it('preserves owned flat legacy Markdown on conflict once without revisiting it after the target is removed', () => {
    const owned = context.legacyGlobalRoots[0]
    context.ownedLegacyGlobalRoot = owned
    mkdirSync(owned, { recursive: true })
    const source = join(owned, 'flat.md')
    const target = join(root, '.agents/skills/flat.md')
    const bytes = Buffer.from('\ufeff# Legacy\r\nKeep exact bytes\r\n')
    writeFileSync(source, bytes)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, 'Existing')
    expect(migrateUnregisteredGlobalSkills([], context).length).toBeGreaterThan(0)
    expect(readFileSync(source)).toEqual(bytes)
    vi.mocked(opendirSync).mockClear()
    expect(migrateUnregisteredGlobalSkills([], context)).toEqual([])
    expect(opendirSync).not.toHaveBeenCalled()
    expect(readSkillPreference(context.haloDir, `migration:personal-root:${owned}`).enabled).toBe(true)
    rmSync(target)
    expect(migrateUnregisteredGlobalSkills([], context)).toEqual([])
    expect(existsSync(source)).toBe(true)
    expect(existsSync(target)).toBe(false)
  })

  it('retries a failed root read without repeating an already preserved conflict', async () => {
    const owned = context.legacyGlobalRoots[0]
    context.ownedLegacyGlobalRoot = owned
    const source = join(owned, 'report', 'SKILL.md')
    packageAt(source)
    packageAt(skillFilePath(null, 'report'), 'Existing personal package')
    const { opendirSync: actualOpen } = await vi.importActual<typeof import('node:fs')>('node:fs')
    vi.mocked(opendirSync).mockImplementationOnce(((...args: Parameters<typeof opendirSync>) => {
      const directory = actualOpen(...args)
      const read = directory.readSync.bind(directory)
      let count = 0
      directory.readSync = () => {
        if (count++ > 0) throw Object.assign(new Error('Read permission denied'), { code: 'EACCES' })
        return read()
      }
      return directory
    }) as typeof opendirSync)
    const first = migrateUnregisteredGlobalSkills([], context)
    expect(first).toHaveLength(2)
    expect(readSkillPreference(context.haloDir, `migration:personal-root:${owned}`).enabled).toBeUndefined()
    expect(migrateUnregisteredGlobalSkills([], context)).toEqual([])
    expect(readSkillPreference(context.haloDir, `migration:personal-root:${owned}`).enabled).toBe(true)
    expect(readFileSync(source, 'utf8')).toBe(original)
  })

  it('does not mark an unreadable root as safely migrated', () => {
    const owned = context.legacyGlobalRoots[0]
    context.ownedLegacyGlobalRoot = owned
    const source = join(owned, 'report', 'SKILL.md')
    packageAt(source)
    vi.mocked(opendirSync).mockImplementationOnce(() => { throw Object.assign(new Error('Read permission denied'), { code: 'EACCES' }) })
    expect(migrateUnregisteredGlobalSkills([], context)).toEqual(['The previous global skill directory cannot be read.'])
    expect(readSkillPreference(context.haloDir, `migration:personal-root:${owned}`).enabled).toBeUndefined()
    expect(migrateUnregisteredGlobalSkills([], context)).toEqual([])
    expect(existsSync(source)).toBe(false)
    expect(readFileSync(skillFilePath(null, 'report'), 'utf8')).toBe(original)
  })

  it('does not treat a legacy file permission failure as safe preservation', async () => {
    const app = add()
    const source = oldPath(app)
    packageAt(source)
    const { lstatSync: actualStat } = await vi.importActual<typeof import('node:fs')>('node:fs')
    vi.mocked(lstatSync).mockImplementation(((...args: Parameters<typeof lstatSync>) => {
      if (args[0] === source) throw Object.assign(new Error('Read permission denied'), { code: 'EACCES' })
      return actualStat(...args)
    }) as typeof lstatSync)
    expect(migrate(app)).toMatch(/Read permission denied/)
    expect(manager.updateSkillRecord).not.toHaveBeenCalled()
    expect(records.get(app.id)).toEqual(app)
    expect(existsSync(skillFilePath(work, 'report'))).toBe(false)
    vi.mocked(lstatSync).mockImplementation(actualStat)
    expect(migrate(app)).toBeUndefined()
    expect(readFileSync(skillFilePath(work, 'report'), 'utf8')).toBe(original)
  })

  it('does not let a workspace record suppress an unrelated owned global migration', () => {
    const app = add()
    const owned = context.legacyGlobalRoots[0]
    context.ownedLegacyGlobalRoot = owned
    const source = join(owned, 'report', 'SKILL.md')
    packageAt(source)
    expect(migrateUnregisteredGlobalSkills([app], context)).toEqual([])
    expect(existsSync(source)).toBe(false)
    expect(readFileSync(skillFilePath(null, 'report'), 'utf8')).toBe(original)
    expect(records.get(app.id)).toEqual(app)
  })

  it('moves unchanged manual legacy packages to personal files without retaining stale bodies', () => {
    const app = add()
    const source = oldPath(app)
    packageAt(source)
    expect(migrate(app)).toBeUndefined()
    const target = skillFilePath(work, 'report')
    expect(existsSync(source)).toBe(false)
    expect(readSkillPackage(target)).toMatchObject({ files: { 'SKILL.md': original, 'scripts/run.js': 'original script' }, assets: { 'assets/sample.bin': { encoding: 'base64', content: binary.toString('base64') } } })
    expect(records.get(app.id)!.spec).toMatchObject({ skill_files: undefined, skill_content: undefined, skill_assets: undefined })
    expect(records.get(app.id)!.userOverrides.skill).toMatchObject({ version: 1, filePath: target })
    const changed = original.replace('Original instructions', 'Edited after migration')
    writeFileSync(target, changed)
    expect(migrate(records.get(app.id)!)).toBeUndefined()
    expect(readFileSync(target, 'utf8')).toBe(changed)
    expect(manager.updateSkillRecord).toHaveBeenCalledTimes(1)
  })

  it('preserves externally modified manual content and resources rather than restoring the stored package', () => {
    const app = add()
    const source = oldPath(app)
    const changed = original.replace('Original instructions', 'User work not present in the database')
    packageAt(source, changed)
    writeFileSync(join(dirname(source), 'scripts', 'run.js'), 'user script')
    expect(migrate(app)).toBeUndefined()
    expectPreservationRecordedOnce(app)
    expect(readFileSync(source, 'utf8')).toBe(changed)
    expect(readFileSync(join(dirname(source), 'scripts', 'run.js'), 'utf8')).toBe('user script')
    expect(readFileSync(join(dirname(source), 'assets', 'sample.bin'))).toEqual(binary)
    expect(records.get(app.id)!.userOverrides.skill!.filePath).toBe(source)
    expect(existsSync(skillFilePath(work, 'report'))).toBe(false)
    expect(effectiveSkillCatalog(context)[0].source.path).toBe(source)
  })

  it('refreshes only scoped records after a successful migration and skips the second read thereafter', () => {
    add(legacy('store'))
    const other = { ...legacy('store', 'active', 'other'), id: 'unselected-record' }
    records.set(other.id, other)
    const first = buildSkillCatalog(context)
    expect(first.groups[0].copies[0].availability).toBe('available')
    expect(vi.mocked(manager.listSkillRecords).mock.calls.map(call => call[0])).toEqual([null, 'space', null, 'space'])
    expect(records.get(other.id)).toEqual(other)
    vi.mocked(manager.listSkillRecords).mockClear()
    vi.mocked(manager.getSkillRecord).mockClear()
    expect(buildSkillCatalog(context).warnings).toEqual([])
    expect(vi.mocked(manager.listSkillRecords).mock.calls.map(call => call[0])).toEqual([null, 'space'])
    expect(manager.getSkillRecord).not.toHaveBeenCalled()
  })

  it('moves an unchanged managed package into the shared skill folder', () => {
    const app = add(legacy('store'))
    const source = oldPath(app)
    packageAt(source)
    expect(migrate(app)).toBeUndefined()
    const target = skillFilePath(app.spaceId === null ? null : work, 'report')
    expect(existsSync(source)).toBe(false)
    expect(target).toBe(join(work, '.agents', 'skills', 'report', 'SKILL.md'))
    expect(readFileSync(target, 'utf8')).toBe(original)
    expect(records.get(app.id)!.userOverrides.skill).toMatchObject({ filePath: target, digest: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(records.get(app.id)!.spec).toMatchObject({ skill_files: { 'SKILL.md': original } })
  })

  it.each(['manual', 'store'] as const)('recovers a %s paused package missing from old disk without enabling it', source => {
    const app = add(legacy(source, 'paused'))
    expect(migrate(app)).toBeUndefined()
    const target = source === 'manual' ? skillFilePath(work, 'report') : skillFilePath(app.spaceId === null ? null : work, 'report')
    expect(readFileSync(target, 'utf8')).toBe(original)
    expect(readFileSync(join(dirname(target), 'assets', 'sample.bin'))).toEqual(binary)
    expect(records.get(app.id)!.status).toBe('paused')
    expect(buildSkillCatalog(context).groups[0].copies[0]).toMatchObject({ enabled: false, availability: 'disabled' })
    expect(effectiveSkillCatalog(context)).toEqual([])
    expect(migrate(records.get(app.id)!)).toBeUndefined()
    expect(manager.updateSkillRecord).toHaveBeenCalledTimes(1)
  })

  it.each(['manual', 'store'] as const)('restores an active %s legacy package from its authoritative record when generated files are missing', source => {
    const app = add(legacy(source))
    expect(migrate(app)).toBeUndefined()
    expect(manager.getSkillRecord).toHaveBeenCalledWith(app.id)
    expect(existsSync(oldPath(app))).toBe(false)
    const target = source === 'manual' ? skillFilePath(work, 'report') : skillFilePath(app.spaceId === null ? null : work, 'report')
    expect(readFileSync(target, 'utf8')).toBe(original)
    expect(readFileSync(join(dirname(target), 'scripts', 'run.js'), 'utf8')).toBe('original script')
    expect(readFileSync(join(dirname(target), 'assets', 'sample.bin'))).toEqual(binary)
    const catalog = buildSkillCatalog(context)
    expect(catalog.warnings).toEqual([])
    expect(catalog.groups[0].copies[0]).toMatchObject({ enabled: true, availability: 'available', path: target })
    expect(effectiveSkillCatalog(context)[0].source.path).toBe(target)
    expect(records.get(app.id)!.status).toBe('active')
    const changed = original.replace('Original instructions', 'Edited after recovery')
    writeFileSync(target, changed)
    expect(migrate(records.get(app.id)!)).toBeUndefined()
    expect(readFileSync(target, 'utf8')).toBe(changed)
    expect(manager.getSkillRecord).toHaveBeenCalledTimes(1)
    expect(manager.updateSkillRecord).toHaveBeenCalledTimes(1)
  })

  it('keeps both versions of an externally modified managed skill and uses the personal copy first', () => {
    const app = add(legacy('store'))
    const source = oldPath(app)
    const changed = original.replace('Original instructions', 'User customization on legacy disk')
    packageAt(source, changed)
    expect(migrate(app)).toBeUndefined()
    expectPreservationRecordedOnce(app)
    const target = skillFilePath(app.spaceId === null ? null : work, 'report')
    expect(readFileSync(source, 'utf8')).toBe(changed)
    expect(readFileSync(target, 'utf8')).toBe(original)
    const catalog = buildSkillCatalog(context)
    expect(catalog.groups[0].copies).toHaveLength(2)
    expect(catalog.groups[0].conflict).toBe(false)
    expect(effectiveSkillCatalog(context)[0].source.path).toBe(source)
  })

  it('does not enable either preserved copy when a modified managed legacy skill was paused', () => {
    const app = add(legacy('store', 'paused'))
    const source = oldPath(app)
    const changed = original.replace('Original instructions', 'Paused external customization')
    packageAt(source, changed)
    expect(migrate(app)).toBeUndefined()
    expectPreservationRecordedOnce(app)
    const catalog = buildSkillCatalog(context)
    expect(catalog.groups[0].copies).toHaveLength(2)
    expect(catalog.groups[0].copies.every(copy => !copy.enabled && copy.availability === 'disabled')).toBe(true)
    expect(effectiveSkillCatalog(context)).toEqual([])
    expect(readFileSync(source, 'utf8')).toBe(changed)
    expect(readFileSync(skillFilePath(app.spaceId === null ? null : work, 'report'), 'utf8')).toBe(original)
  })

  it('records safely preserved conflicting locations once without losing either package', () => {
    const app = add()
    const source = oldPath(app)
    const target = skillFilePath(work, 'report')
    packageAt(source)
    packageAt(target, 'Destination user content')
    expect(migrate(app)).toBeUndefined()
    expectPreservationRecordedOnce(app)
    expect(readFileSync(source, 'utf8')).toBe(original)
    expect(readFileSync(target, 'utf8')).toBe('Destination user content')
    expect(records.get(app.id)!.userOverrides.skill!.filePath).toBe(source)
  })

  it('preserves a paused original and an already independent matching destination without name-wide disablement', () => {
    const app = add(legacy('manual', 'paused'))
    const source = oldPath(app)
    const target = skillFilePath(work, 'report')
    packageAt(source)
    packageAt(target)
    expect(migrate(app)).toBeUndefined()
    expectPreservationRecordedOnce(app)
    expect(readFileSync(source, 'utf8')).toBe(original)
    expect(readFileSync(target, 'utf8')).toBe(original)
    const catalog = buildSkillCatalog(context)
    expect(catalog.groups[0].copies.find(copy => copy.path === source)).toMatchObject({ enabled: false, availability: 'disabled' })
    expect(catalog.groups[0].copies.find(copy => copy.path === target)).toMatchObject({ enabled: true, availability: 'available' })
    expect(effectiveSkillCatalog(context)[0].source.path).toBe(target)
    expect(records.get(app.id)!.status).toBe('paused')
  })

  it('does not consume the sole paused legacy instructions by adopting unrelated existing destination files', () => {
    const app = add(legacy('manual', 'paused'))
    const target = skillFilePath(work, 'report')
    packageAt(target, 'Unrelated personal instructions already at destination')
    const warning = migrate(app)
    expect.soft(warning).toEqual(expect.stringMatching(/destination|different|conflict/i))
    expect(readFileSync(target, 'utf8')).toBe('Unrelated personal instructions already at destination')
    expect(records.get(app.id)).toEqual(app)
    expect(migrate(app)).toMatch(/destination.*different/i)
    expect(manager.updateSkillRecord).not.toHaveBeenCalled()
  })

  it.each(['manual', 'store'] as const)('keeps the original %s package at its source when committing its migration record fails', source => {
    const app = add(legacy(source))
    const path = oldPath(app)
    packageAt(path)
    vi.mocked(manager.updateSkillRecord).mockImplementationOnce(() => { throw new Error('record storage unavailable') })
    expect(migrate(app)).toMatch(/record storage unavailable/)
    expect.soft(existsSync(path), 'A failed migration must leave its original source usable').toBe(true)
    if (existsSync(path)) {
      expect(readFileSync(path, 'utf8')).toBe(original)
      expect(readFileSync(join(dirname(path), 'assets', 'sample.bin'))).toEqual(binary)
    }
    expect(records.get(app.id)).toEqual(app)
  })

  it.each([true, false])('keeps a paused manual package unavailable after a failed migration commit, with legacy files present: %s', oldFilesPresent => {
    const app = add(legacy('manual', 'paused'))
    if (oldFilesPresent) packageAt(oldPath(app))
    vi.mocked(manager.updateSkillRecord).mockImplementation(() => { throw new Error('record storage unavailable') })
    const catalog = buildSkillCatalog(context)
    expect(catalog.warnings.some(warning => warning.includes('record storage unavailable'))).toBe(true)
    expect.soft(catalog.groups.every(group => group.effectiveId === undefined), 'Migration failure must not expose restored paused instructions').toBe(true)
    expect.soft(effectiveSkillCatalog(context)).toEqual([])
    expect(records.get(app.id)).toEqual(app)
    const remaining = [oldPath(app), skillFilePath(work, 'report')].filter(path => existsSync(path))
    for (const path of remaining) expect(readFileSync(path, 'utf8')).toBe(original)
  })

  it('keeps a linked legacy personal package and its physical target unchanged', () => {
    const app = add()
    const target = join(root, 'external-fixture', 'report', 'SKILL.md')
    packageAt(target)
    const source = oldPath(app)
    mkdirSync(dirname(dirname(source)), { recursive: true })
    symlinkSync(dirname(target), dirname(source), 'dir')
    expect(migrate(app)).toBeUndefined()
    expectPreservationRecordedOnce(app)
    expect(realpathSync(source)).toBe(target)
    expect(readFileSync(target, 'utf8')).toBe(original)
    expect(records.get(app.id)!.userOverrides.skill!.filePath).toBe(source)
  })

  it('records canonical .claude/.agents aliases once without warning or duplicate copies', () => {
    const app = add()
    const target = skillFilePath(work, 'report')
    packageAt(target)
    mkdirSync(join(work, '.claude'), { recursive: true })
    symlinkSync(join(work, '.agents', 'skills'), join(work, '.claude', 'skills'), 'dir')
    expect(migrate(app)).toBeUndefined()
    expectPreservationRecordedOnce(app)
    expect(realpathSync(oldPath(app))).toBe(target)
    expect(readFileSync(target, 'utf8')).toBe(original)
    const catalog = buildSkillCatalog(context)
    expect(catalog.groups[0].copies).toHaveLength(1)
    expect(catalog.groups[0].conflict).toBe(false)
    expect(effectiveSkillCatalog(context)).toHaveLength(1)
  })

  it.each(['manual', 'store'] as const)('retains a failed %s missing-marker repair for retry without losing the stored package', source => {
    const app = legacy(source)
    const target = source === 'manual' ? skillFilePath(work, 'report') : skillFilePath(app.spaceId === null ? null : work, 'report')
    app.userOverrides.skill = { version: 1, filePath: target, migrationWarning: missingLegacyFiles }
    add(app)
    vi.mocked(manager.updateSkillRecord).mockImplementationOnce(() => { throw new Error('record storage unavailable') })
    expect(migrate(app)).toMatch(/record storage unavailable/)
    expect(records.get(app.id)).toEqual(app)
    expect(readFileSync(target, 'utf8')).toBe(original)
    expect(migrate(app)).toBeUndefined()
    expect(records.get(app.id)!.userOverrides.skill!.migrationWarning).toBeUndefined()
    expect(readFileSync(join(dirname(target), 'assets', 'sample.bin'))).toEqual(binary)
    expect(buildSkillCatalog(context).warnings).toEqual([])
    expect(effectiveSkillCatalog(context)[0].source.path).toBe(target)
    expect(manager.getSkillRecord).toHaveBeenCalledTimes(2)
    expect(manager.updateSkillRecord).toHaveBeenCalledTimes(2)
  })

  it.each([undefined, 'The skill file is missing.', `${missingLegacyFiles} `])('does not repair completed migration with a non-matching warning: %s', migrationWarning => {
    const app = legacy('store')
    const target = skillFilePath(app.spaceId === null ? null : work, 'report')
    app.userOverrides.skill = { version: 1, filePath: target, migrationWarning }
    add(app)
    expect(migrate(app)).toBeUndefined()
    expect(buildSkillCatalog(context).groups[0].copies[0].availability).toBe('missing')
    expect(effectiveSkillCatalog(context)).toEqual([])
    expect(existsSync(target)).toBe(false)
    expect(records.get(app.id)).toEqual(app)
    expect(manager.getSkillRecord).not.toHaveBeenCalled()
    expect(manager.updateSkillRecord).not.toHaveBeenCalled()
  })

  it('migrates a global paused personal record from isolated Halo roots to the isolated home', () => {
    const app = add(legacy('manual', 'paused', null))
    expect(migrate(app)).toBeUndefined()
    expect(records.get(app.id)!.userOverrides.skill!.filePath).toBe(join(root, '.agents', 'skills', 'report', 'SKILL.md'))
    expect(readFileSync(skillFilePath(null, 'report'), 'utf8')).toBe(original)
    expect(effectiveSkillCatalog(context)).toEqual([])
  })

  it('keeps old removed content recoverable and distinguishes a new deletion tombstone', () => {
    const app = add(legacy('manual', 'uninstalled'))
    const deleted = { ...legacy('store', 'uninstalled'), id: 'deleted', specId: 'deleted', userOverrides: { skill: { version: 1 as const, filePath: '', deleted: true } } }
    records.set(deleted.id, deleted)
    const catalog = buildSkillCatalog(context)
    expect(catalog.legacyRemoved).toEqual([{ appId: app.id, name: 'report', description: 'Stored report', spaceId: 'space' }])
    expect(catalog.groups).toEqual([])
    expect(records.get(app.id)).toEqual(app)
    expect(manager.updateSkillRecord).not.toHaveBeenCalled()
    expect(existsSync(skillFilePath(work, 'report'))).toBe(false)
  })

  it.each(['active', 'paused', 'uninstalled'] as const)('never repairs a deleted record carrying the old missing marker even when its status is %s', status => {
    const app = legacy('store', status)
    const target = skillFilePath(app.spaceId === null ? null : work, 'report')
    app.userOverrides.skill = { version: 1, filePath: target, deleted: true, migrationWarning: missingLegacyFiles }
    add(app)
    expect(migrate(app)).toBeUndefined()
    expect(existsSync(target)).toBe(false)
    expect(records.get(app.id)).toEqual(app)
    expect(manager.getSkillRecord).not.toHaveBeenCalled()
    expect(manager.updateSkillRecord).not.toHaveBeenCalled()
  })

  it('does not recreate a migrated personal file after an external deletion', () => {
    const app = add(legacy('manual', 'paused'))
    migrate(app)
    const target = records.get(app.id)!.userOverrides.skill!.filePath
    rmSync(dirname(target), { recursive: true })
    expect(buildSkillCatalog(context).groups[0].copies[0].availability).toBe('missing')
    expect(existsSync(target)).toBe(false)
    expect(effectiveSkillCatalog(context)).toEqual([])
  })

  it('defers a legacy store skill instead of binding it to a different skill that already holds the shared folder', () => {
    const app = add(legacy('store'))
    const source = oldPath(app)
    packageAt(source, `${original}Edited by the user\n`)
    const taken = skillFilePath(work, 'report')
    mkdirSync(dirname(taken), { recursive: true })
    writeFileSync(taken, 'the user\'s own skill')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(migrate(app)).toContain('Could not migrate')
    expect(records.get(app.id)).toEqual(app)
    expect(readFileSync(taken, 'utf8')).toBe('the user\'s own skill')
    expect(readFileSync(source, 'utf8')).toContain('Edited by the user')
  })

  it('does not let two legacy records of one name bind to the same shared folder', () => {
    const first = add(legacy('store'))
    const second = legacy('store')
    second.id = 'second-installation'
    second.specId = 'report-second'
    second.spec = { ...second.spec, store: { install_source: 'store', tags: [], slug: 'author/another-report' } } as SkillSpec
    add(second)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(migrate(first)).toBeUndefined()
    expect(migrate(second)).toContain('Could not migrate')
    expect(records.get(second.id)!.userOverrides.skill).toBeUndefined()
    expect(records.get(first.id)!.userOverrides.skill!.filePath).toBe(skillFilePath(work, 'report'))
  })

  describe('skills recorded under the retired private roots', () => {
    function recorded(id: string, spaceId: string | null, path: string): InstalledApp {
      const app = legacy('store', 'active', spaceId)
      app.id = id
      app.userOverrides = { skill: { version: 1, filePath: path } }
      return add(app)
    }

    it.each([
      ['global', null],
      ['workspace', 'space'],
    ] as const)('moves a %s skill into the shared skill folder and records what it wrote', (_scope, spaceId) => {
      const from = spaceId === null
        ? join(context.haloDir, 'skills', 'private-id', 'SKILL.md')
        : join(context.spaceDataPath!, '.halo', 'skills', 'private-id', 'SKILL.md')
      const to = join(spaceId === null ? root : work, '.agents', 'skills', 'report', 'SKILL.md')
      packageAt(from)
      const app = recorded(`move-${spaceId}`, spaceId, from)
      expect(migrate(app)).toBeUndefined()
      expect(records.get(app.id)!.userOverrides.skill).toMatchObject({ filePath: to, digest: expect.stringMatching(/^[a-f0-9]{64}$/) })
      expect(existsSync(from)).toBe(false)
      expect(readFileSync(to, 'utf8')).toBe(original)
      expect(readFileSync(join(dirname(to), 'scripts', 'run.js'), 'utf8')).toBe('original script')
      expect(migrate(records.get(app.id)!)).toBeUndefined()
      expect(manager.updateSkillRecord).toHaveBeenCalledTimes(1)
    })

    it('records no fingerprint for a package the user had already changed', () => {
      const from = join(context.haloDir, 'skills', 'edited-id', 'SKILL.md')
      packageAt(from, `${original}Edited by the user\n`)
      const app = recorded('edited', null, from)
      migrate(app)
      expect(records.get(app.id)!.userOverrides.skill!.filePath).toBe(join(root, '.agents', 'skills', 'report', 'SKILL.md'))
      expect(records.get(app.id)!.userOverrides.skill!.digest).toBeUndefined()
      expect(readFileSync(records.get(app.id)!.userOverrides.skill!.filePath, 'utf8')).toContain('Edited by the user')
    })

    it('leaves the skill where it works when the shared folder already holds another one', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const from = join(context.haloDir, 'skills', 'occupied-id', 'SKILL.md')
      packageAt(from)
      const taken = join(root, '.agents', 'skills', 'report', 'SKILL.md')
      mkdirSync(dirname(taken), { recursive: true })
      writeFileSync(taken, 'the user\'s own skill')
      const app = recorded('occupied', null, from)
      expect(migrate(app)).toBeUndefined()
      expect(records.get(app.id)).toEqual(app)
      expect(existsSync(from)).toBe(true)
      expect(readFileSync(taken, 'utf8')).toBe('the user\'s own skill')
      expect(warn).not.toHaveBeenCalled()
      expect(effectiveSkillCatalog(context).map(entry => entry.source.path)).toEqual([taken])
      expect(buildSkillCatalog(context).groups[0].copies.map(copy => copy.path).sort()).toEqual([from, taken].sort())
    })

    it('puts the files back when the record cannot be saved, warns once, and retries later', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const from = join(context.haloDir, 'skills', 'retry-id', 'SKILL.md')
      const to = join(root, '.agents', 'skills', 'report', 'SKILL.md')
      packageAt(from)
      const app = recorded('retry', null, from)
      vi.mocked(manager.updateSkillRecord).mockImplementation(() => { throw new Error('db write failed') })
      migrate(app)
      migrate(app)
      expect(existsSync(from)).toBe(true)
      expect(existsSync(to)).toBe(false)
      expect(records.get(app.id)).toEqual(app)
      expect(warn).toHaveBeenCalledTimes(1)
      vi.mocked(manager.updateSkillRecord).mockRestore()
      migrate(app)
      expect(existsSync(from)).toBe(false)
      expect(readFileSync(to, 'utf8')).toBe(original)
    })

    it('relocates while the catalog is built, so the next session reads the shared folder', () => {
      const from = join(context.haloDir, 'skills', 'catalog-id', 'SKILL.md')
      const to = join(root, '.agents', 'skills', 'report', 'SKILL.md')
      packageAt(from)
      recorded('catalog', null, from)
      expect(effectiveSkillCatalog(context).map(entry => entry.source.path)).toEqual([to])
    })

    it('puts a workspace skill in the workspace folder even when a session works elsewhere', () => {
      const from = join(context.spaceDataPath!, '.halo', 'skills', 'cwd-id', 'SKILL.md')
      packageAt(from)
      const app = recorded('cwd', 'space', from)
      context.workDir = join(root, 'a-digital-human-working-directory')
      context.spaceWorkDir = work
      migrate(app)
      expect(records.get(app.id)!.userOverrides.skill!.filePath).toBe(join(work, '.agents', 'skills', 'report', 'SKILL.md'))
      expect(existsSync(join(context.workDir, '.agents'))).toBe(false)
    })

    it('records a fingerprint for a package whose SKILL.md has no user-invocable line, and keeps one the record already had', () => {
      const plain = '---\nname: report\ndescription: Stored report\n---\nOriginal instructions\n'
      const fixture = (id: string, digest?: string) => {
        const from = join(context.haloDir, 'skills', `${id}-id`, 'SKILL.md')
        packageAt(from, plain)
        const app = legacy('store', 'active', null)
        app.id = id
        app.spec = { ...app.spec, skill_files: { ...(app.spec as SkillSpec).skill_files, 'SKILL.md': plain } } as SkillSpec
        app.userOverrides = { skill: { version: 1, filePath: from, ...(digest ? { digest } : {}) } }
        return add(app)
      }
      const fresh = fixture('plain-fresh')
      migrate(fresh)
      expect(records.get(fresh.id)!.userOverrides.skill!.digest).toMatch(/^[a-f0-9]{64}$/)
      rmSync(join(root, '.agents'), { recursive: true })
      const known = fixture('plain-known', 'a'.repeat(64))
      migrate(known)
      expect(records.get(known.id)!.userOverrides.skill!.digest).toBe('a'.repeat(64))
    })

    it('ignores files a file manager leaves behind when deciding whether the package changed', () => {
      const from = join(context.haloDir, 'skills', 'junk-id', 'SKILL.md')
      packageAt(from)
      writeFileSync(join(dirname(from), '.DS_Store'), 'finder')
      const app = recorded('junk', null, from)
      migrate(app)
      expect(records.get(app.id)!.userOverrides.skill!.digest).toMatch(/^[a-f0-9]{64}$/)
    })

    it('leaves a missing private package alone for the library to report', () => {
      const from = join(context.haloDir, 'skills', 'gone-id', 'SKILL.md')
      const app = recorded('gone', null, from)
      expect(migrate(app)).toBeUndefined()
      expect(records.get(app.id)).toEqual(app)
      expect(manager.updateSkillRecord).not.toHaveBeenCalled()
    })
  })
})
