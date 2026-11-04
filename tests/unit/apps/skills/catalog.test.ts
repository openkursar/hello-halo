import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, opendirSync, readFileSync, realpathSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppManagerService, InstalledApp } from '../../../../src/main/apps/manager'
import type { SkillSpec } from '../../../../src/main/apps/spec'
import { buildSkillCatalog, effectiveSkillCatalog, listSkillInventory, type SkillLibraryContext } from '../../../../src/main/apps/skills/catalog'
import { createSkillLibrary } from '../../../../src/main/apps/skills/service'
import { canonicalSkillPath, skillFileId } from '../../../../src/main/services/skills'

vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(),
  homedir: () => globalThis.__HALO_TEST_DIR__,
}))

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, opendirSync: vi.fn(actual.opendirSync) }
})

function content(name: string, description = `Description for ${name}`): string {
  return `---\nname: ${name}\ndescription: ${description}\nargument-hint: input\nuser-invocable: true\n---\nInstructions for ${name}\n`
}

function put(path: string, body: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body)
  return path
}

function record(id: string, spaceId: string | null, path: string, source: 'manual' | 'store' | 'bundled' | 'builtin' = 'store', name = 'report'): InstalledApp {
  return {
    id, specId: name, spaceId, status: 'active',
    spec: { type: 'skill', spec_version: '1', name, version: '1', description: `Stored ${name}`,
      store: { install_source: source, tags: [], ...(source === 'manual' ? {} : { slug: `author/${id}` }) } },
    userConfig: {}, userOverrides: { skill: { version: 1, filePath: path } },
    permissions: { granted: [], denied: [] }, installedAt: 1, upgradeStrategy: 'auto', knowledgeSeeded: false,
  }
}

describe('scoped skill catalog with real files', () => {
  let root: string
  let work: string
  let other: string
  let halo: string
  let records: InstalledApp[]
  let context: SkillLibraryContext
  let manager: Pick<AppManagerService, 'listSkillRecords' | 'getApp' | 'getSkillRecord' | 'updateSkillRecord'>

  beforeEach(() => {
    root = realpathSync(globalThis.__HALO_TEST_DIR__)
    globalThis.__HALO_TEST_DIR__ = root
    work = join(root, 'project')
    other = join(root, 'unselected-project')
    halo = join(root, 'halo-data')
    records = []
    manager = {
      listSkillRecords: vi.fn(spaceId => records.filter(app => app.spaceId === spaceId).map(app => {
        const spec = { ...app.spec } as SkillSpec
        delete spec.skill_content
        delete spec.skill_files
        delete spec.skill_assets
        return structuredClone({ ...app, spec })
      })),
      getApp: vi.fn(id => structuredClone(records.find(app => app.id === id) ?? null)),
      getSkillRecord: vi.fn(id => structuredClone(records.find(app => app.id === id) ?? null)),
      updateSkillRecord: vi.fn(() => { throw new Error('Catalog fixture records are already migrated') }),
    }
    context = { manager: manager as AppManagerService, haloDir: halo, spaceId: 'space', workDir: work,
      spaceDataPath: join(halo, 'spaces', 'space'), legacyGlobalRoots: [] }
  })

  afterEach(() => { vi.restoreAllMocks() })

  it('checks only the current project and home roots, and ignores unknown private files', () => {
    const local = put(join(work, '.agents', 'skills', 'local', 'SKILL.md'), content('local'))
    const compatibility = put(join(work, '.claude', 'skills', 'compatible', 'SKILL.md'), content('compatible'))
    const global = put(join(root, '.agents', 'skills', 'global', 'SKILL.md'), content('global'))
    put(join(root, '.claude', 'commands', 'legacy-command.md'), '# Legacy command\nA plain command remains usable.\n')
    put(join(other, '.agents', 'skills', 'unselected', 'SKILL.md'), content('unselected'))
    put(join(halo, 'skills', 'unregistered', 'SKILL.md'), content('unregistered'))
    put(join(context.spaceDataPath!, '.halo', 'skills', 'unknown-local', 'SKILL.md'), content('unknown-local'))
    const installed = put(join(context.spaceDataPath!, '.halo', 'skills', 'known', 'SKILL.md'), content('installed'))
    records.push(record('known', 'space', installed, 'store', 'installed'))
    records.push(record('other-record', 'other', join(other, 'private', 'SKILL.md'), 'store', 'other-record'))

    const inventory = listSkillInventory(context, { spaceId: 'space' })

    expect(inventory.groups.map(group => group.name).sort()).toEqual(['compatible', 'global', 'installed', 'legacy-command', 'local'])
    expect(inventory.groups.find(group => group.name === 'local')!.copies[0]).toMatchObject({ path: local, scope: 'space', source: 'personal' })
    expect(inventory.groups.find(group => group.name === 'compatible')!.copies[0].path).toBe(compatibility)
    expect(inventory.groups.find(group => group.name === 'global')!.copies[0]).toMatchObject({ path: global, scope: 'global', spaceId: null })
    expect(inventory.warnings).toEqual([])
    const roots = [work, root].flatMap(base => ['.agents', '.claude'].flatMap(agent => ['skills', 'commands'].map(leaf => join(base, agent, leaf))))
    expect(vi.mocked(opendirSync).mock.calls.map(call => call[0]).sort()).toEqual(roots.sort())
    expect(vi.mocked(manager.listSkillRecords).mock.calls.map(call => call[0])).toEqual([null, 'space'])
    expect(manager.getApp).not.toHaveBeenCalled()
    expect(manager.getSkillRecord).not.toHaveBeenCalled()
    expect(manager.updateSkillRecord).not.toHaveBeenCalled()
  })

  it('deduplicates .agents/.claude aliases to one canonical copy without a false conflict', () => {
    const path = put(join(work, '.agents', 'skills', 'report', 'SKILL.md'), content('report'))
    mkdirSync(join(work, '.claude'), { recursive: true })
    symlinkSync(join(work, '.agents', 'skills'), join(work, '.claude', 'skills'), 'dir')
    const group = buildSkillCatalog(context).groups[0]
    expect(group.copies).toHaveLength(1)
    expect(group).toMatchObject({ name: 'report', conflict: false, effectiveId: skillFileId(path) })
    expect(effectiveSkillCatalog(context)).toEqual([{ name: 'report', description: 'Description for report', argumentHint: 'input', source: { kind: 'file', path } }])
    expect(canonicalSkillPath(join(work, '.claude', 'skills', 'report', 'SKILL.md'))).toBe(path)
  })

  it('ranks workspace above global and personal above managed within the same scope', () => {
    const global = put(join(root, '.agents', 'skills', 'report', 'SKILL.md'), content('report', 'Global personal'))
    const local = put(join(work, '.agents', 'skills', 'report', 'SKILL.md'), content('report', 'Local personal'))
    const privatePath = put(join(context.spaceDataPath!, '.halo', 'skills', 'managed', 'SKILL.md'), content('report', 'Local installed'))
    records.push(record('managed', 'space', privatePath))
    const library = createSkillLibrary({ context: () => context, trash: vi.fn(), openFolder: vi.fn() })
    expect(library.effectiveCatalog('space')[0].source.path).toBe(local)
    const original = readFileSync(local)
    library.setEnabled({ ref: { spaceId: 'space', id: skillFileId(local) }, enabled: false })
    expect(readFileSync(local)).toEqual(original)
    expect(library.effectiveCatalog('space')[0].source.path).toBe(privatePath)
    records[0].status = 'paused'
    expect(library.effectiveCatalog('space')[0].source.path).toBe(global)
    library.setEnabled({ ref: { spaceId: 'space', id: skillFileId(local) }, enabled: true })
    expect(library.effectiveCatalog('space')[0].source.path).toBe(local)
  })

  it('leaves equal-priority distinct copies conflicted until the selected copy is disabled', () => {
    const first = put(join(work, '.agents', 'skills', 'report', 'SKILL.md'), content('report', 'First'))
    const second = put(join(work, '.claude', 'skills', 'report', 'SKILL.md'), content('report', 'Second'))
    const healthy = put(join(work, '.agents', 'skills', 'control', 'SKILL.md'), content('control'))
    put(join(root, '.agents', 'skills', 'report', 'SKILL.md'), content('report', 'Fallback'))
    const before = buildSkillCatalog(context)
    expect(before.groups.find(group => group.name === 'report')).toMatchObject({ conflict: true, effectiveId: undefined })
    expect(before.groups.find(group => group.name === 'report')!.copies.filter(copy => copy.availability === 'conflict')).toHaveLength(2)
    expect(effectiveSkillCatalog(context).map(entry => entry.source.path)).toEqual([healthy])
    const library = createSkillLibrary({ context: () => context, trash: vi.fn(), openFolder: vi.fn() })
    library.setEnabled({ ref: { spaceId: 'space', id: skillFileId(second) }, enabled: false })
    expect(effectiveSkillCatalog(context).find(entry => entry.name === 'report')!.source.path).toBe(first)
  })

  it('merges by command identity, keeps provenance, and searches copies across folded groups', () => {
    put(join(work, '.agents', 'skills', 'report', 'SKILL.md'), content('report', 'Personal'))
    const bundled = put(join(context.spaceDataPath!, '.halo', 'skills', 'bundle', 'SKILL.md'), content('report', 'Hidden dependency needle'))
    const builtin = put(join(halo, 'skills', 'built', 'SKILL.md'), content('builtin-command', 'Built in needle'))
    const app = record('bundle', 'space', bundled, 'bundled')
    app.userOverrides.skill!.owners = [{ id: 'author-one', name: 'First person' }, { id: 'author-two', name: 'Second person' }]
    app.spec.display_name = 'Same display label'
    const built = record('built', null, builtin, 'builtin', 'builtin-command')
    built.spec.display_name = 'Same display label'
    records.push(app, built)
    const result = listSkillInventory(context, { spaceId: 'space', q: 'needle' })
    expect(result.groups).toHaveLength(2)
    expect(result.groups.find(group => group.name === 'report')!.source).toBe('mine')
    expect(result.groups.find(group => group.name === 'report')!.copies.find(copy => copy.appId === 'bundle')!.owners).toEqual(app.userOverrides.skill!.owners)
    expect(result.groups.find(group => group.name === 'builtin-command')!.source).toBe('builtin')
    expect(listSkillInventory(context, { spaceId: 'space', q: 'Personal' }).groups).toHaveLength(1)
  })

  it('refreshes changed file metadata without relying on parent directory timestamps or losing pause', () => {
    const path = put(join(work, '.agents', 'skills', 'report', 'SKILL.md'), content('report', 'Old description'))
    const library = createSkillLibrary({ context: () => context, trash: vi.fn(), openFolder: vi.fn() })
    const id = skillFileId(path)
    expect(library.list({ spaceId: 'space' }).groups[0].description).toBe('Old description')
    library.setEnabled({ ref: { spaceId: 'space', id }, enabled: false })
    const stamp = statSync(dirname(path))
    const revised = content('renamed', 'Externally updated and longer description')
    writeFileSync(path, revised)
    utimesSync(dirname(path), stamp.atime, stamp.mtime)
    const copy = library.list({ spaceId: 'space' }).groups[0].copies[0]
    expect(copy).toMatchObject({ id, name: 'renamed', enabled: false, availability: 'disabled', description: 'Externally updated and longer description' })
    expect(library.read({ spaceId: 'space', id }).content).toBe(revised)
    expect(library.effectiveCatalog('space')).toEqual([])
    library.setEnabled({ ref: { spaceId: 'space', id }, enabled: true })
    expect(library.effectiveCatalog('space')[0].name).toBe('renamed')
    expect(readFileSync(path, 'utf8')).toBe(revised)
  })

  it('does not carry recorded personal files into a new work directory but retains private installations', () => {
    const oldPath = put(join(work, '.agents', 'skills', 'old-project', 'SKILL.md'), content('old-project'))
    const nextPath = put(join(other, '.agents', 'skills', 'next-project', 'SKILL.md'), content('next-project'))
    const managed = put(join(context.spaceDataPath!, '.halo', 'skills', 'managed', 'SKILL.md'), content('managed'))
    records.push(record('personal', 'space', oldPath, 'manual', 'old-project'), record('managed', 'space', managed, 'store', 'managed'))
    expect(effectiveSkillCatalog(context).map(entry => entry.name).sort()).toEqual(['managed', 'old-project'])
    context.workDir = other
    expect(effectiveSkillCatalog(context).map(entry => entry.source.path).sort()).toEqual([managed, nextPath].sort())
    expect(readFileSync(oldPath, 'utf8')).toBe(content('old-project'))
    expect(records.find(app => app.id === 'personal')!.userOverrides.skill!.filePath).toBe(oldPath)
  })

  it('keeps malformed entries visible without excluding healthy or permissive legacy skills', () => {
    put(join(work, '.agents', 'skills', 'invalid', 'SKILL.md'), '---\nname: [broken\n---\nUnreadable header')
    put(join(work, '.claude', 'commands', 'plain.md'), 'Plain legacy instructions without frontmatter')
    put(join(work, '.agents', 'skills', 'healthy', 'SKILL.md'), content('healthy'))
    const catalog = buildSkillCatalog(context)
    expect(catalog.groups.find(group => group.name === 'invalid')!.copies[0]).toMatchObject({ availability: 'invalid', editable: true })
    expect(effectiveSkillCatalog(context).map(entry => entry.name).sort()).toEqual(['healthy', 'plain'])
  })
})
