import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, statSync, symlinkSync, realpathSync } from 'fs'
import { dirname, join } from 'path'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import { AppManagerStore } from '../../../../src/main/apps/manager/store'
import { createAppManagerService } from '../../../../src/main/apps/manager/service'
import { MIGRATION_NAMESPACE, migrations } from '../../../../src/main/apps/manager/migrations'
import type { AppManagerService, InstalledApp } from '../../../../src/main/apps/manager/types'
import type { SkillSpec } from '../../../../src/main/apps/spec'
import { AppAlreadyInstalledError } from '../../../../src/main/apps/manager/errors'
import { createSkillLibrary } from '../../../../src/main/apps/skills'
import { managedSkillPath, personalSkillPath, readSkillPackage } from '../../../../src/main/services/skills'

vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(),
  homedir: () => globalThis.__HALO_TEST_DIR__,
}))

function spec(extra: Partial<SkillSpec> = {}): SkillSpec {
  return { spec_version: '1', name: 'report', type: 'skill', version: '1', description: 'Report',
    skill_files: { 'SKILL.md': '---\nname: report\ndescription: Report\ncustom: retained\n---\nOriginal', 'scripts/run.js': 'original script' },
    skill_assets: { 'images/icon.png': { encoding: 'base64', content: Buffer.from([0, 255, 1]).toString('base64') } },
    ...extra,
  }
}

const maintained = () => spec({ store: { slug: 'author/report', install_source: 'store', registry_id: 'source', tags: [] } })
const missingLegacyFiles = 'The previous skill files are missing. Restore them before using this skill.'
const materializedLegacyContent = '---\nname: report\ndescription: Report\ncustom: retained\nuser-invocable: true\n---\nOriginal'
const legacyCases = (['manual', 'store'] as const).flatMap(source =>
  (['active', 'paused'] as const).flatMap(status =>
    (['space', null] as const).flatMap(spaceId =>
      ([false, true] as const).map(markedMissing => ({ source, status, spaceId, markedMissing })),
    ),
  ),
)

describe('skill installation lifecycle', () => {
  let database: DatabaseManager
  let store: AppManagerStore
  let manager: AppManagerService
  let root: string
  let work: string
  let data: string
  let trash: ReturnType<typeof vi.fn<[string], Promise<void>>>

  beforeEach(() => {
    root = realpathSync(globalThis.__HALO_TEST_DIR__)
    globalThis.__HALO_TEST_DIR__ = root
    work = join(root, 'project')
    data = join(root, 'halo', 'space')
    mkdirSync(work, { recursive: true })
    mkdirSync(data, { recursive: true })
    mkdirSync(join(root, 'trash'), { recursive: true })
    trash = vi.fn(async (path: string) => { renameSync(path, join(root, 'trash', String(trash.mock.calls.length))) })
    openManager()
  })

  function openManager(databasePath = ':memory:'): void {
    database = createDatabaseManager(databasePath)
    const db = database.getAppDatabase()
    database.runMigrations(db, MIGRATION_NAMESPACE, migrations)
    store = new AppManagerStore(db)
    manager = createAppManagerService({ store, getSpacePath: id => id === 'space' ? work : id === 'other' ? join(root, 'other') : null,
      getAppDataPath: id => id === 'space' ? data : id === 'other' ? join(root, 'halo', 'other') : null,
      getGlobalAppDir: () => join(root, 'halo'), trashItem: trash,
    })
  }

  function library() {
    return createSkillLibrary({
      context: spaceId => ({ manager, spaceId, haloDir: join(root, 'halo'),
        workDir: spaceId === null ? null : spaceId === 'space' ? work : join(root, 'other'),
        spaceDataPath: spaceId === null ? null : spaceId === 'space' ? data : join(root, 'halo', 'other'),
        legacyGlobalRoots: [],
      }),
      trash, openFolder: () => {},
    })
  }

  afterEach(() => database.closeAll())

  function path(id: string): string { return store.getById(id)!.userOverrides.skill!.filePath }

  function legacyRecord(source: 'manual' | 'store', status: InstalledApp['status'], spaceId: string | null): InstalledApp {
    return {
      id: 'legacy-report', specId: 'report', spaceId, status,
      spec: source === 'store' ? maintained() : spec({ store: { install_source: 'manual', tags: [] } }),
      userConfig: { retained: true }, userOverrides: {}, permissions: { granted: [], denied: [] },
      installedAt: 1, upgradeStrategy: 'manual', knowledgeSeeded: false,
    }
  }

  function migratedPath(app: InstalledApp, source: 'manual' | 'store'): string {
    return source === 'manual' ? personalSkillPath(app.spaceId === null ? null : work, 'report')
      : managedSkillPath(join(root, 'halo'), app.spaceId === null ? null : data, app.id)
  }

  it.each(legacyCases)('migrates legacy SQLite $source/$status scope=$spaceId with missing marker=$markedMissing without losing contents or later edits', ({ source, status, spaceId, markedMissing }) => {
    database.closeAll()
    const databasePath = join(root, 'legacy.sqlite')
    openManager(databasePath)
    const app = legacyRecord(source, status, spaceId)
    const original = app.spec as SkillSpec
    const target = migratedPath(app, source)
    const oldPath = join(spaceId === null ? join(root, 'halo', 'claude-config', 'skills') : join(work, '.claude', 'skills'), 'report', 'SKILL.md')
    if (markedMissing) app.userOverrides.skill = { version: 1, filePath: target, migrationWarning: missingLegacyFiles }
    store.insert(app)
    database.closeAll()
    openManager(databasePath)
    expect(existsSync(oldPath)).toBe(false)
    expect(existsSync(target)).toBe(false)
    expect(manager.listSkillRecords(spaceId)[0].spec).not.toHaveProperty('skill_files')
    expect(manager.getSkillRecord(app.id)!.spec).toEqual(original)
    const before = store.getById(app.id)!
    const skills = library()
    const inventory = skills.list({ spaceId })
    expect(inventory.warnings).toEqual([])
    expect(inventory.legacyRemoved).toEqual([])
    expect(inventory.groups).toHaveLength(1)
    expect(inventory.groups[0].copies).toHaveLength(1)
    expect(inventory.groups[0].copies[0]).toMatchObject({
      appId: app.id, path: target, enabled: status === 'active', availability: status === 'active' ? 'available' : 'disabled',
    })
    const ref = { spaceId, id: `app:${app.id}` }
    expect(skills.read(ref).content).toBe(materializedLegacyContent)
    expect(readFileSync(target, 'utf8')).toBe(materializedLegacyContent)
    expect(readFileSync(join(dirname(target), 'scripts/run.js'), 'utf8')).toBe('original script')
    expect(readFileSync(join(dirname(target), 'images/icon.png'))).toEqual(Buffer.from([0, 255, 1]))
    expect(existsSync(oldPath)).toBe(false)
    const migrated = store.getById(app.id)!
    expect(migrated).toMatchObject({
      id: app.id, specId: 'report', spaceId, status,
      installedAt: before.installedAt, userConfig: before.userConfig, permissions: before.permissions, upgradeStrategy: before.upgradeStrategy,
      userOverrides: { skill: { version: 1, filePath: target } },
    })
    expect(migrated.userOverrides.skill!.migrationWarning).toBeUndefined()
    if (source === 'manual') {
      expect(migrated.spec).not.toHaveProperty('skill_content')
      expect(migrated.spec).not.toHaveProperty('skill_files')
      expect(migrated.spec).not.toHaveProperty('skill_assets')
    } else {
      expect(migrated.spec).toEqual(original)
    }
    expect(skills.effectiveCatalog(spaceId ?? 'space').map(entry => entry.source.path)).toEqual(status === 'active' ? [target] : [])
    const changed = materializedLegacyContent.replace('Original', 'External changes after recovery')
    const changedBinary = Buffer.from([255, 0, 128, 42])
    writeFileSync(target, changed)
    writeFileSync(join(dirname(target), 'scripts/run.js'), 'external script after recovery')
    writeFileSync(join(dirname(target), 'images/icon.png'), changedBinary)
    database.closeAll()
    openManager(databasePath)
    const reopened = library()
    expect(reopened.list({ spaceId }).warnings).toEqual([])
    expect(reopened.read(ref).content).toBe(changed)
    expect(reopened.effectiveCatalog(spaceId ?? 'space').map(entry => entry.source.path)).toEqual(status === 'active' ? [target] : [])
    expect(readFileSync(target, 'utf8')).toBe(changed)
    expect(readFileSync(join(dirname(target), 'scripts/run.js'), 'utf8')).toBe('external script after recovery')
    expect(readFileSync(join(dirname(target), 'images/icon.png'))).toEqual(changedBinary)
    expect(store.getById(app.id)).toEqual(migrated)
    expect(existsSync(oldPath)).toBe(false)
  })

  it('reads the stored personal package without hydrating a missing file or mutating the SQLite record', () => {
    const app = legacyRecord('manual', 'active', 'space')
    const target = migratedPath(app, 'manual')
    app.userOverrides.skill = { version: 1, filePath: target, migrationWarning: missingLegacyFiles }
    store.insert(app)
    const before = store.getById(app.id)!
    expect(manager.getApp(app.id)!.spec).not.toHaveProperty('skill_files')
    const raw = manager.getSkillRecord(app.id)!
    expect(raw).toEqual(before)
    expect(raw.spec).toEqual(app.spec)
    raw.spec.description = 'Changed only in the returned object'
    expect(manager.getSkillRecord(app.id)).toEqual(before)
    expect(store.getById(app.id)).toEqual(before)
    expect(existsSync(target)).toBe(false)
    expect(manager.getSkillRecord('missing')).toBeNull()
    store.insert({ ...app, id: 'connection', specId: 'connection', spec: {
      spec_version: '1', type: 'mcp', name: 'connection', version: '1', description: 'Fixture connection', author: 'Test',
      mcp_server: { transport: 'stdio', command: 'node' },
    } })
    expect(manager.getSkillRecord('connection')).toBeNull()
  })

  it.each(['manual', 'store'] as const)('repairs an active %s legacy SQLite record whose instructions exist only in skill_content', source => {
    const app = legacyRecord(source, 'active', 'space')
    const target = migratedPath(app, source)
    app.spec = { ...app.spec as SkillSpec, skill_files: undefined, skill_content: materializedLegacyContent }
    app.userOverrides.skill = { version: 1, filePath: target, migrationWarning: missingLegacyFiles }
    store.insert(app)
    expect(manager.getSkillRecord(app.id)!.spec).toHaveProperty('skill_content', materializedLegacyContent)
    const skills = library()
    expect(skills.list({ spaceId: 'space' }).warnings).toEqual([])
    expect(skills.read({ spaceId: 'space', id: `app:${app.id}` }).content).toBe(materializedLegacyContent)
    expect(readFileSync(join(dirname(target), 'images/icon.png'))).toEqual(Buffer.from([0, 255, 1]))
    expect(skills.effectiveCatalog('space')[0].source.path).toBe(target)
    expect(store.getById(app.id)).toMatchObject({ status: 'active', userOverrides: { skill: { version: 1, filePath: target } } })
    expect(store.getById(app.id)!.userOverrides.skill!.migrationWarning).toBeUndefined()
  })

  it.each(['manual', 'store'] as const)('does not revive a successfully migrated %s SQLite package deleted after migration', source => {
    database.closeAll()
    const databasePath = join(root, 'migrated.sqlite')
    openManager(databasePath)
    const app = legacyRecord(source, 'active', 'space')
    store.insert(app)
    expect(library().list({ spaceId: 'space' }).warnings).toEqual([])
    const target = path(app.id)
    expect(readFileSync(target, 'utf8')).toBe(materializedLegacyContent)
    const migrated = store.getById(app.id)!
    rmSync(dirname(target), { recursive: true })
    database.closeAll()
    openManager(databasePath)
    const skills = library()
    for (let attempt = 0; attempt < 2; attempt++) {
      const inventory = skills.list({ spaceId: 'space' })
      expect(inventory.groups).toHaveLength(1)
      expect(inventory.groups[0].copies[0]).toMatchObject({ appId: app.id, path: target, availability: 'missing' })
      expect(inventory.legacyRemoved).toEqual([])
      expect(skills.effectiveCatalog('space')).toEqual([])
      const missing = skills.read({ spaceId: 'space', id: `app:${app.id}` })
      expect(missing).toMatchObject({ copy: { availability: 'missing', editable: false }, content: '', files: [] })
      expect(missing.spec.skill_files).toBeUndefined()
      expect(missing.spec.skill_content).toBeUndefined()
      expect(existsSync(target)).toBe(false)
      expect(store.getById(app.id)).toEqual(migrated)
    }
  })

  it.each(['manual', 'store'] as const)('never automatically restores uninstalled or deleted legacy %s records from SQLite', source => {
    for (const deleted of [false, true]) {
      const app = legacyRecord(source, 'uninstalled', 'space')
      app.id = deleted ? 'deleted-report' : 'removed-report'
      app.specId = app.id
      const target = migratedPath(app, source)
      if (deleted) app.userOverrides.skill = { version: 1, filePath: target, deleted: true, migrationWarning: missingLegacyFiles }
      store.insert(app)
      const before = store.getById(app.id)!
      const skills = library()
      expect(skills.list({ spaceId: 'space' }).groups).toEqual([])
      expect(skills.effectiveCatalog('space')).toEqual([])
      expect(skills.list({ spaceId: 'space' }).legacyRemoved.map(item => item.appId)).toEqual(['removed-report'])
      expect(existsSync(target)).toBe(false)
      expect(manager.getSkillRecord(app.id)).toEqual(before)
    }
    expect(trash).not.toHaveBeenCalled()
  })

  it('writes personal files to user/project roots and stores no instruction or resource copies', async () => {
    const local = await manager.install('space', spec())
    const global = await manager.install(null, spec())
    expect(path(local)).toBe(join(work, '.agents', 'skills', 'report', 'SKILL.md'))
    expect(path(global)).toBe(join(root, '.agents', 'skills', 'report', 'SKILL.md'))
    for (const id of [local, global]) {
      expect(store.getById(id)!.spec).not.toHaveProperty('skill_files')
      expect(store.getById(id)!.spec).not.toHaveProperty('skill_content')
      expect(store.getById(id)!.spec).not.toHaveProperty('skill_assets')
      expect(readFileSync(join(dirname(path(id)), 'images/icon.png'))).toEqual(Buffer.from([0, 255, 1]))
    }
  })

  it('uses private installation IDs and data roots for maintained packages', async () => {
    const local = await manager.install('space', maintained())
    const global = await manager.install(null, maintained())
    expect(path(local)).toBe(join(data, '.halo', 'skills', local, 'SKILL.md'))
    expect(path(global)).toBe(join(root, 'halo', 'skills', global, 'SKILL.md'))
    expect(existsSync(join(work, '.agents'))).toBe(false)
    expect(readFileSync(path(local), 'utf8')).toContain('name: report')
  })

  it('reuses equal packages without re-enabling or replacing configuration; conflicts do not overwrite', async () => {
    const id = await manager.install('space', maintained(), { keep: true })
    manager.pause(id)
    expect(await manager.install('space', maintained(), { keep: false })).toBe(id)
    expect(manager.getApp(id)).toMatchObject({ status: 'paused', userConfig: { keep: true } })
    await expect(manager.install('space', maintainedSpec('changed'))).rejects.toThrow(AppAlreadyInstalledError)
    expect(readFileSync(path(id), 'utf8')).toContain('Original')
  })

  function maintainedSpec(content: string): SkillSpec {
    return { ...maintained(), skill_files: { 'SKILL.md': content } }
  }

  it.each(['space', null])('keeps managed-first and personal same-name packages in scope %s with personal effective priority', async spaceId => {
    const managed = await manager.install(spaceId, maintained())
    const managedBefore = readSkillPackage(path(managed))
    const personal = await manager.install(spaceId, spec({ skill_files: { ...spec().skill_files, 'SKILL.md': 'Personal instructions' } }))
    expect(personal).not.toBe(managed)
    expect(store.getById(managed)!.specId).toMatch(/^skill:[a-f0-9]{64}:report$/)
    expect(store.getById(personal)!.specId).toBe('report')
    expect(manager.listSkillRecords(spaceId)).toHaveLength(2)
    expect(readSkillPackage(path(managed))).toEqual(managedBefore)
    expect(path(personal)).toBe(join(spaceId === null ? root : work, '.agents', 'skills', 'report', 'SKILL.md'))
    expect(readFileSync(join(dirname(path(personal)), 'images/icon.png'))).toEqual(Buffer.from([0, 255, 1]))
    const skills = library()
    const group = skills.list({ spaceId }).groups.find(item => item.name === 'report')!
    expect(group.copies.map(copy => copy.appId).sort()).toEqual([managed, personal].sort())
    expect(skills.effectiveCatalog(spaceId ?? 'space')[0].source.path).toBe(path(personal))
    manager.pause(personal)
    expect(skills.effectiveCatalog(spaceId ?? 'space')[0].source.path).toBe(path(managed))
    expect(readSkillPackage(path(managed))).toEqual(managedBefore)
  })

  it('keeps a personal package unchanged when a namesake managed package is installed later', async () => {
    const personal = await manager.install('space', spec())
    const before = readSkillPackage(path(personal))
    manager.pause(personal)
    const managed = await manager.install('space', maintainedSpec('Managed instructions'))
    expect(store.getById(personal)!.status).toBe('paused')
    expect(readSkillPackage(path(personal))).toEqual(before)
    expect(readFileSync(path(managed), 'utf8')).toContain('Managed instructions')
    expect(manager.listSkillRecords('space')).toHaveLength(2)
  })

  it.each(['registry_id', 'slug', 'repository'] as const)('keeps managed sources separated by %s through update, replacement and restart', async field => {
    database.closeAll()
    const databasePath = join(root, 'identity.sqlite')
    openManager(databasePath)
    const firstSpec = maintained()
    const secondSpec = spec({ store: { ...firstSpec.store!, [field]: field === 'repository' ? 'https://example.invalid/other-source' : 'other-source' },
      skill_files: { 'SKILL.md': 'Other source instructions', 'other.txt': 'other resource' },
    })
    const first = await manager.install('space', firstSpec, { owner: 'first' })
    const second = await manager.install('space', secondSpec, { owner: 'second' })
    const firstKey = store.getById(first)!.specId
    const secondRecord = store.getById(second)!
    const secondBefore = readSkillPackage(path(second))
    expect(first).not.toBe(second)
    expect(firstKey).not.toBe(secondRecord.specId)
    expect(path(first)).not.toBe(path(second))
    expect(library().effectiveCatalog('space')).toEqual([])
    manager.pause(first)
    manager.upgradeSpec(first, { ...firstSpec, version: '2', skill_files: { 'SKILL.md': 'Author version two' } })
    manager.updateSpec(first, { skill_content: 'Customized first instructions' })
    manager.updateSkillRecord(first, { spec: { ...store.getById(first)!.spec as SkillSpec, description: 'Current metadata' },
      skill: { ...store.getById(first)!.userOverrides.skill!, owners: [{ id: 'person', name: 'Person' }] },
    })
    const replacement = { ...firstSpec, version: '3', skill_files: { 'SKILL.md': 'Explicit replacement', 'new.txt': 'new resource' } }
    manager.updateSpec(first, replacement)
    expect(store.getById(first)).toMatchObject({ specId: firstKey, status: 'paused', userConfig: { owner: 'first' } })
    expect(store.getById(second)).toEqual(secondRecord)
    expect(readSkillPackage(path(second))).toEqual(secondBefore)
    database.closeAll()
    openManager(databasePath)
    expect(await manager.install('space', replacement)).toBe(first)
    expect(await manager.install('space', secondSpec)).toBe(second)
    expect(store.getById(first)).toMatchObject({ specId: firstKey, status: 'paused' })
    expect(store.getById(second)).toEqual(secondRecord)
    expect(readSkillPackage(path(second))).toEqual(secondBefore)
    expect(manager.listSkillRecords('space')).toHaveLength(2)
    const otherScope = await manager.install('other', replacement)
    expect(store.getById(otherScope)!.specId).toBe(firstKey)
  })

  it('does not merge source-less bundled packages with different contents or built-in special slugs', async () => {
    const bundled = spec({ store: { install_source: 'bundled', tags: [] } })
    const id = await manager.install('space', bundled)
    expect(await manager.install('space', bundled)).toBe(id)
    await expect(manager.install('space', { ...bundled, skill_files: { 'SKILL.md': 'Other bundled content' } })).rejects.toThrow(AppAlreadyInstalledError)
    const builtinSpec = spec({ store: { slug: 'halo-builtin-skills/report', install_source: 'bundled', tags: [] } })
    const builtin = await manager.install('space', builtinSpec)
    expect(builtin).not.toBe(id)
    expect(await manager.install('space', builtinSpec)).toBe(builtin)
    expect(store.getById(builtin)!.specId).not.toBe(store.getById(id)!.specId)
    expect(readFileSync(path(id), 'utf8')).toContain('Original')
  })

  it.each(['active', 'paused', 'uninstalled'] as const)('preserves legacy name-keyed %s managed records when a personal namesake is installed', async status => {
    const managed = await manager.install('space', maintained())
    const legacy = { ...store.getById(managed)!, specId: 'report' }
    store.updateSkillRecord(legacy)
    if (status === 'paused') manager.pause(managed)
    if (status === 'uninstalled') await manager.uninstall(managed)
    const before = store.getById(managed)!
    const personal = await manager.install('space', spec())
    expect(store.getById(managed)).toEqual(before)
    expect(store.getById(personal)!.specId).toMatch(/^skill:[a-f0-9]{64}:report$/)
    expect(path(personal)).toBe(join(work, '.agents', 'skills', 'report', 'SKILL.md'))
    expect(existsSync(path(managed))).toBe(status !== 'uninstalled')
    manager.updateSkillRecord(personal, { status: 'paused' })
    expect(store.getById(personal)!.specId).not.toBe('report')
    if (status !== 'uninstalled') {
      expect(await manager.install('space', maintained())).toBe(managed)
      manager.updateSpec(managed, { description: 'Updated legacy metadata' })
      manager.updateSkillRecord(managed, { skill: { ...before.userOverrides.skill!, owners: [{ id: 'person', name: 'Person' }] } })
      expect(store.getById(managed)).toMatchObject({ specId: 'report', status })
    }
  })

  it('does not let another source revive or replace a deleted namesake', async () => {
    const first = await manager.install('space', maintained())
    await manager.uninstall(first)
    const before = store.getById(first)!
    const secondSpec = spec({ store: { ...maintained().store!, registry_id: 'other-source' } })
    const second = await manager.install('space', secondSpec)
    expect(store.getById(first)).toEqual(before)
    expect(existsSync(path(first))).toBe(false)
    expect(existsSync(path(second))).toBe(true)
    await expect(manager.install('space', maintainedSpec('Replacement must be explicit'))).rejects.toThrow(AppAlreadyInstalledError)
    expect(store.getById(first)).toEqual(before)
    expect(existsSync(path(first))).toBe(false)
  })

  it('retains managed namespaces during command renames and refuses same-source command collisions', async () => {
    const first = await manager.install('space', maintained())
    const firstPath = path(first)
    const prefix = store.getById(first)!.specId.slice(0, -'report'.length)
    const other = await manager.install('space', { ...maintained(), name: 'renamed', store: { ...maintained().store!, registry_id: 'other-source' } })
    const before = readSkillPackage(path(other))
    manager.updateSpec(first, { name: 'renamed' })
    expect(store.getById(first)!.specId).toBe(`${prefix}renamed`)
    expect(path(first)).toBe(firstPath)
    expect(readFileSync(firstPath, 'utf8')).toContain('name: renamed')
    expect(readSkillPackage(path(other))).toEqual(before)
    const target = await manager.install('space', { ...maintained(), name: 'taken' })
    const renamed = readSkillPackage(firstPath)
    expect(() => manager.updateSpec(first, { name: 'taken' })).toThrow(AppAlreadyInstalledError)
    expect(() => manager.updateSkillRecord(first, { spec: { ...store.getById(first)!.spec as SkillSpec, name: 'taken' } })).toThrow(AppAlreadyInstalledError)
    expect(readSkillPackage(firstPath)).toEqual(renamed)
    expect(existsSync(path(target))).toBe(true)
    manager.updateSkillRecord(first, { spec: { ...store.getById(first)!.spec as SkillSpec, name: 'record-renamed' } })
    expect(store.getById(first)!.specId).toBe(`${prefix}record-renamed`)
  })

  it('rejects source changes through record-only metadata updates', async () => {
    const id = await manager.install('space', maintained())
    const before = store.getById(id)!
    expect(() => manager.updateSkillRecord(id, { spec: { ...maintained(), store: { ...maintained().store!, registry_id: 'other' } } })).toThrow('independent installation')
    expect(store.getById(id)).toEqual(before)
  })

  it.each(['current', 'legacy', 'deleted'] as const)('refuses a scope move into a %s same-source namesake without changing either record or files', async kind => {
    const first = await manager.install('space', maintained())
    const target = await manager.install('other', maintained())
    if (kind === 'legacy') store.updateSkillRecord({ ...store.getById(target)!, specId: 'report' })
    if (kind === 'deleted') await manager.uninstall(target)
    const firstBefore = store.getById(first)!
    const targetBefore = store.getById(target)!
    const firstPackage = readSkillPackage(path(first))
    await expect(manager.moveToSpace(first, 'other')).rejects.toThrow(AppAlreadyInstalledError)
    expect(() => manager.updateSkillRecord(first, { spaceId: 'other' })).toThrow(AppAlreadyInstalledError)
    expect(store.getById(first)).toEqual(firstBefore)
    expect(store.getById(target)).toEqual(targetBefore)
    expect(readSkillPackage(path(first))).toEqual(firstPackage)
    expect(existsSync(path(target))).toBe(kind !== 'deleted')
  })

  it('allows a manager scope move beside a different source without weakening the library conflict check', async () => {
    const first = await manager.install('space', maintained())
    const other = await manager.install('other', spec())
    const otherBefore = readSkillPackage(path(other))
    const key = store.getById(first)!.specId
    const before = path(first)
    const skills = library()
    const ref = { id: `app:${first}`, spaceId: 'space' }
    expect(skills.movePreview({ ref, spaceId: 'other' }).conflict).toBeTruthy()
    expect(() => skills.move({ ref, spaceId: 'other', revision: skills.read(ref).revision })).toThrow()
    expect(path(first)).toBe(before)
    manager.pause(first)
    await manager.moveToSpace(first, 'other')
    expect(existsSync(before)).toBe(false)
    expect(store.getById(first)).toMatchObject({ specId: key, spaceId: 'other', status: 'paused' })
    expect(path(first)).toBe(join(root, 'halo', 'other', '.halo', 'skills', first, 'SKILL.md'))
    expect(readSkillPackage(path(other))).toEqual(otherBefore)
    expect(manager.listSkillRecords('other')).toHaveLength(2)
  })

  it('namespaces a legacy managed key only when moving beside a name-keyed personal record', async () => {
    const first = await manager.install('space', maintained())
    store.updateSkillRecord({ ...store.getById(first)!, specId: 'report' })
    const personal = await manager.install('other', spec())
    const before = readSkillPackage(path(personal))
    await manager.moveToSpace(first, 'other')
    expect(store.getById(first)!.specId).toMatch(/^skill:[a-f0-9]{64}:report$/)
    expect(store.getById(personal)!.specId).toBe('report')
    expect(readSkillPackage(path(personal))).toEqual(before)
    expect(await manager.install('other', maintained())).toBe(first)
  })

  it('never adopts a pre-existing unregistered destination by name', async () => {
    const destination = join(work, '.agents', 'skills', 'report', 'SKILL.md')
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, 'unregistered user file')
    await expect(manager.install('space', spec())).rejects.toThrow('already exists')
    expect(readFileSync(destination, 'utf8')).toBe('unregistered user file')
    expect(manager.listSkillRecords('space')).toEqual([])
  })

  it('does not publish a database record for invalid packages and rolls back files after DB failure', async () => {
    await expect(manager.install('space', spec({ skill_files: { 'SKILL.md': 'body', '../escape': 'bad' } }))).rejects.toThrow()
    expect(manager.listSkillRecords('space')).toEqual([])
    const insert = vi.spyOn(store, 'insert').mockImplementationOnce(() => { throw new Error('disk database full') })
    await expect(manager.install('space', spec())).rejects.toThrow('disk database full')
    expect(existsSync(join(work, '.agents', 'skills', 'report'))).toBe(false)
    insert.mockRestore()
  })

  it('pause/resume preserves bytes and reads external edits for detail/publishing', async () => {
    const id = await manager.install('space', spec())
    const filePath = path(id)
    manager.pause(id)
    expect(existsSync(filePath)).toBe(true)
    const external = '---\nname: renamed\ndescription: Current description\nunknown: value\n---\nExternal edit'
    writeFileSync(filePath, external)
    manager.resume(id)
    expect(readFileSync(filePath, 'utf8')).toBe(external)
    expect(manager.getApp(id)!.spec).toMatchObject({ name: 'renamed', description: 'Current description', skill_content: external })
  })

  it('does not restore missing personal files on resume or return a stale body', async () => {
    const id = await manager.install('space', spec())
    const filePath = path(id)
    manager.pause(id)
    renameSync(dirname(filePath), join(root, 'moved-away'))
    expect(() => manager.resume(id)).toThrow()
    expect(store.getById(id)!.status).toBe('paused')
    expect(manager.getApp(id)!.spec).not.toHaveProperty('skill_content')
    expect(existsSync(filePath)).toBe(false)
  })

  it('instruction edits preserve untouched supporting files and unknown frontmatter', async () => {
    const id = await manager.install('space', spec())
    const script = join(dirname(path(id)), 'scripts/run.js')
    const stamp = statSync(script)
    const content = readFileSync(path(id), 'utf8').replace('Original', 'Edited')
    manager.updateSpec(id, { skill_content: content })
    expect(readFileSync(path(id), 'utf8')).toBe(content)
    expect(statSync(script).ino).toBe(stamp.ino)
    expect(readFileSync(script, 'utf8')).toBe('original script')
    expect(store.getById(id)!.spec).not.toHaveProperty('skill_files')
  })

  it('rolls back instruction bytes and command moves when the record write fails', async () => {
    const id = await manager.install('space', spec())
    const before = path(id)
    const content = readFileSync(before, 'utf8')
    const update = vi.spyOn(store, 'updateSkillRecord').mockImplementationOnce(() => { throw new Error('db write failed') })
    expect(() => manager.updateSpec(id, { name: 'renamed', skill_content: 'replacement' })).toThrow('db write failed')
    expect(readFileSync(before, 'utf8')).toBe(content)
    expect(path(id)).toBe(before)
    expect(existsSync(join(work, '.agents', 'skills', 'renamed'))).toBe(false)
    update.mockRestore()
  })

  it('does not upgrade personal file content from a new stored package', async () => {
    const id = await manager.install('space', spec())
    writeFileSync(path(id), 'external current instructions')
    const result = manager.upgradeSpec(id, { ...spec(), version: '2', skill_files: { 'SKILL.md': 'author content' } })
    expect(result.toVersion).toBe('1')
    expect(readFileSync(path(id), 'utf8')).toBe('external current instructions')
  })

  it('keeps customized maintained upgrades wholly at the current version', async () => {
    const id = await manager.install('space', maintained())
    manager.updateSpec(id, { skill_content: 'Customized instructions' })
    manager.pause(id)
    const update = { ...maintained(), version: '2', skill_files: { 'SKILL.md': 'Updated instructions', 'new.txt': 'new resource' } }
    expect(manager.upgradeSpec(id, update)).toMatchObject({ fromVersion: '1', toVersion: '1' })
    expect(manager.getApp(id)).toMatchObject({ status: 'paused', spec: { version: '1' }, userOverrides: { skill: { customized: true } } })
    expect(readFileSync(path(id), 'utf8')).toBe('Customized instructions')
    expect(existsSync(join(dirname(path(id)), 'new.txt'))).toBe(false)
    manager.updateSpec(id, update)
    expect(manager.getApp(id)!.spec.version).toBe('2')
    expect(store.getById(id)!.status).toBe('paused')
    expect(existsSync(join(dirname(path(id)), 'scripts/run.js'))).toBe(false)
  })

  it('takes an author replacement as the new whole-package baseline, then keeps later local edits', async () => {
    database.closeAll()
    const databasePath = join(root, 'author-updates.sqlite')
    openManager(databasePath)
    const id = await manager.install('space', maintained())
    const key = store.getById(id)!.specId
    manager.updateSpec(id, { skill_content: 'Customized instructions' })
    manager.pause(id)
    const next = { ...maintained(), version: '2', skill_files: { 'SKILL.md': 'Author replacement', 'new.txt': 'new resource' }, skill_assets: undefined }
    const notify = vi.fn()
    manager.onAppSpecUpgraded(notify)
    expect(manager.replaceSkillFromAuthor(id, next)).toMatchObject({ fromVersion: '1', toVersion: '2', kept: [] })
    expect(notify).toHaveBeenCalledWith(id, expect.objectContaining({ fromVersion: '1', toVersion: '2', kept: [] }))
    expect(store.getById(id)).toMatchObject({ specId: key, status: 'paused', spec: { version: '2', skill_files: { 'new.txt': 'new resource' } }, userOverrides: { skill: { customized: false } } })
    expect(existsSync(join(dirname(path(id)), 'scripts/run.js'))).toBe(false)
    expect(existsSync(join(dirname(path(id)), 'images/icon.png'))).toBe(false)
    database.closeAll()
    openManager(databasePath)
    expect(manager.getApp(id)!.userOverrides.skill!.customized).toBe(false)
    const following = { ...next, version: '3', skill_files: { 'SKILL.md': 'Following author version' } }
    expect(manager.upgradeSpec(id, following)).toMatchObject({ fromVersion: '2', toVersion: '3', kept: [] })
    expect(readFileSync(path(id), 'utf8')).toContain('Following author version')
    expect(existsSync(join(dirname(path(id)), 'new.txt'))).toBe(false)
    manager.updateSpec(id, { skill_content: 'New local edit' })
    expect(manager.upgradeSpec(id, { ...following, version: '4' })).toMatchObject({ fromVersion: '3', toVersion: '3', kept: ['skill_files', 'skill_assets', 'skill_content'] })
    expect(readFileSync(path(id), 'utf8')).toBe('New local edit')
    expect(store.getById(id)).toMatchObject({ specId: key, status: 'paused', spec: { version: '3' }, userOverrides: { skill: { customized: true } } })
  })

  it('refuses author replacements for a different source, personal files or deleted installations', async () => {
    const id = await manager.install('space', maintained())
    const before = store.getById(id)!
    const original = readSkillPackage(path(id))
    expect(() => manager.replaceSkillFromAuthor(id, { ...maintained(), version: '2', store: { ...maintained().store!, registry_id: 'other-source' } })).toThrow('independent installation')
    expect(store.getById(id)).toEqual(before)
    expect(readSkillPackage(path(id))).toEqual(original)
    const personal = await manager.install('other', spec())
    expect(() => manager.replaceSkillFromAuthor(personal, { ...spec(), version: '2' })).toThrow('managed skill')
    await manager.uninstall(id)
    const deleted = store.getById(id)!
    expect(() => manager.replaceSkillFromAuthor(id, { ...maintained(), version: '2' })).toThrow('deleted')
    expect(store.getById(id)).toEqual(deleted)
    expect(existsSync(path(id))).toBe(false)
  })

  it('restores files and the customization marker when an author replacement cannot commit', async () => {
    const id = await manager.install('space', maintained())
    manager.updateSpec(id, { skill_content: 'Local customization' })
    const before = store.getById(id)!
    const files = readSkillPackage(path(id))
    const update = vi.spyOn(store, 'updateSkillRecord').mockImplementationOnce(() => { throw new Error('database unavailable') })
    expect(() => manager.replaceSkillFromAuthor(id, { ...maintained(), version: '2' })).toThrow('database unavailable')
    update.mockRestore()
    expect(store.getById(id)).toEqual(before)
    expect(readSkillPackage(path(id)).files).toEqual(files.files)
    expect(readSkillPackage(path(id)).assets).toEqual(files.assets)
  })

  it('updates an untouched paused managed package completely without changing availability', async () => {
    const id = await manager.install('space', maintained())
    manager.pause(id)
    manager.upgradeSpec(id, { ...maintained(), version: '2', skill_files: { 'SKILL.md': 'new' }, skill_assets: undefined })
    expect(store.getById(id)!.status).toBe('paused')
    expect(store.getById(id)!.spec.version).toBe('2')
    expect(existsSync(join(dirname(path(id)), 'scripts/run.js'))).toBe(false)
    expect(existsSync(join(dirname(path(id)), 'images/icon.png'))).toBe(false)
  })

  it('commits internal records without file IO and rejects public path injection', async () => {
    const id = await manager.install('space', spec())
    const filePath = path(id)
    expect(() => manager.updateOverrides(id, { skill: { version: 1, filePath: '/untrusted' } })).toThrow('cannot be changed')
    manager.updateSkillRecord(id, { skill: { version: 1, filePath, owners: [{ id: 'parent', name: 'Parent' }] }, status: 'paused' })
    expect(store.getById(id)!.userOverrides.skill!.owners).toEqual([{ id: 'parent', name: 'Parent' }])
    expect(readFileSync(filePath, 'utf8')).toContain('Original')
    const rows = manager.listSkillRecords('space')
    expect(rows).toHaveLength(1)
    expect(rows[0].spec).not.toHaveProperty('skill_files')
    expect(manager.listSkillRecords(null)).toEqual([])
  })

  it('projects maintained and legacy records without large bodies before JSON deserialization', async () => {
    const id = await manager.install('space', maintained())
    const legacy = { ...store.getById(id)!, id: 'legacy', specId: 'legacy', userOverrides: {}, status: 'uninstalled',
      spec: { ...maintained(), name: 'legacy', skill_content: 'legacy body', skill_files: { 'SKILL.md': 'large'.repeat(10000) } },
    } as InstalledApp
    store.insert(legacy)
    const list = manager.listSkillRecords('space')
    expect(list).toHaveLength(2)
    expect(list.every(row => !('skill_files' in row.spec) && !('skill_content' in row.spec) && !('skill_assets' in row.spec))).toBe(true)
    expect(manager.getApp('legacy')!.spec).toHaveProperty('skill_content', 'legacy body')
  })

  it('trashes once, retains a deletion tombstone and never restores a deleted package on upgrade', async () => {
    const id = await manager.install('space', maintained())
    const filePath = path(id)
    await Promise.all([manager.uninstall(id), manager.uninstall(id)])
    await manager.deleteApp(id)
    expect(trash).toHaveBeenCalledTimes(1)
    expect(existsSync(filePath)).toBe(false)
    expect(manager.getApp(id)).toMatchObject({ status: 'uninstalled', userOverrides: { skill: { deleted: true } } })
    manager.upgradeSpec(id, { ...maintained(), version: '2' })
    expect(store.getById(id)!.spec.version).toBe('1')
    manager.reinstall(id)
    expect(existsSync(filePath)).toBe(true)
    expect(store.getById(id)!.status).toBe('active')
  })

  it('does not mark deleted or permanently erase files when the OS trash fails', async () => {
    const id = await manager.install('space', maintained())
    trash.mockRejectedValueOnce(new Error('trash unavailable'))
    await expect(manager.uninstall(id)).rejects.toThrow('trash unavailable')
    expect(store.getById(id)!.status).toBe('active')
    expect(existsSync(path(id))).toBe(true)
    expect(store.getById(id)!.userOverrides.skill!.deleted).toBeUndefined()
  })

  it('trashes a selected symbolic link rather than its target', async () => {
    const id = await manager.install('space', spec())
    const target = dirname(path(id))
    const link = join(work, '.agents', 'skills', 'linked')
    symlinkSync(target, link, 'dir')
    manager.updateSkillRecord(id, { skill: { version: 1, filePath: join(link, 'SKILL.md') } })
    await manager.uninstall(id)
    expect(trash).toHaveBeenCalledWith(link)
    expect(existsSync(join(target, 'SKILL.md'))).toBe(true)
  })

  it('trashes damaged packages and broken links without traversing their contents', async () => {
    const id = await manager.install('space', spec())
    const filePath = path(id)
    renameSync(filePath, `${filePath}.broken`)
    await manager.uninstall(id)
    expect(store.getById(id)!.userOverrides.skill!.deleted).toBe(true)
    const linked = await manager.install('space', spec({ name: 'linked' }))
    const old = dirname(path(linked))
    renameSync(old, `${old}.original`)
    symlinkSync(join(root, 'missing-target'), old, 'dir')
    await manager.uninstall(linked)
    expect(trash).toHaveBeenLastCalledWith(old)
    expect(existsSync(`${old}.original`)).toBe(true)
  })

  it('preserves legacy uninstalled sole copies and tombstones during pruning', async () => {
    const id = await manager.install('space', maintained())
    store.updateOverrides(id, {})
    store.updateStatus(id, 'uninstalled', null, null)
    store.updateUninstalledAt(id, 1)
    expect(manager.pruneUninstalledApps(0)).toBe(0)
    await expect(manager.deleteApp(id)).rejects.toThrow('legacy skill recovery')
    expect(store.getById(id)).not.toBeNull()
  })

  it('moves current personal bytes with paused status, and rolls back after a record failure', async () => {
    const id = await manager.install('space', spec())
    const before = path(id)
    writeFileSync(before, 'external current body')
    manager.pause(id)
    const update = vi.spyOn(store, 'updateSkillRecord').mockImplementationOnce(() => { throw new Error('db failed') })
    await expect(manager.moveToSpace(id, 'other')).rejects.toThrow('db failed')
    expect(readFileSync(before, 'utf8')).toBe('external current body')
    update.mockRestore()
    await manager.moveToSpace(id, 'other')
    expect(existsSync(before)).toBe(false)
    expect(readFileSync(path(id), 'utf8')).toBe('external current body')
    expect(store.getById(id)!.status).toBe('paused')
  })

  it('keeps bundled resources when deleting a digital human and external personal files when deleting its space', async () => {
    const personal = await manager.install('space', spec())
    const managed = await manager.install('space', { ...maintained(), name: 'dependency' })
    const parent = await manager.install('space', { spec_version: '1', type: 'automation', name: 'parent', version: '1', author: 'Test', description: 'Parent', system_prompt: 'Work', requires: { skills: [{ id: 'dependency', bundled: true }] } })
    const personalPath = path(personal)
    const managedPath = path(managed)
    await manager.uninstall(parent)
    await manager.deleteApp(parent)
    expect(existsSync(managedPath)).toBe(true)
    await manager.deleteAppsInSpace('space')
    expect(existsSync(personalPath)).toBe(true)
    expect(existsSync(managedPath)).toBe(false)
    expect(manager.listSkillRecords('space')).toEqual([])
  })
})
