import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync, symlinkSync, realpathSync, truncateSync } from 'node:fs'
import { join } from 'node:path'
import {
  findLoadableSkill,
  findUndeclaredSkills,
  hasPackageableSkillMd,
  listAvailableSkills,
  listLoadableSkillCopies,
  listLoadableSkills,
  normalizeSkillDependencies,
  readLoadableSkillFiles,
} from '../../../src/main/apps/skill-discovery'
import { createSkillLibrary } from '../../../src/main/apps/skills/service'
import type { AppManagerService, InstalledApp } from '../../../src/main/apps/manager'
import type { AppSpec } from '../../../src/main/apps/spec'

vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => globalThis.__HALO_TEST_DIR__ }))
const fixture = vi.hoisted(() => ({ library: null as unknown }))
vi.mock('../../../src/main/apps/skills', () => ({ getSkillLibrary: () => fixture.library }))

let root: string
let project: string
let records: InstalledApp[]
function write(base: string, name: string, content: string) {
  const path = join(base, name)
  mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'SKILL.md'), content)
  return path
}
function globalRoot() { return join(root, '.agents', 'skills') }
function projectRoot() { return join(project, '.agents', 'skills') }

beforeEach(() => {
  root = realpathSync(globalThis.__HALO_TEST_DIR__)
  globalThis.__HALO_TEST_DIR__ = root
  project = join(root, 'project')
  records = []
  const manager = { listSkillRecords: (spaceId: string | null) => records.filter(app => app.spaceId === spaceId) } as unknown as AppManagerService
  fixture.library = createSkillLibrary({
    context: (spaceId, workDir) => ({ spaceId, manager,
      haloDir: join(root, 'halo'), workDir: spaceId === null ? null : workDir ?? project, spaceDataPath: join(root, 'halo/spaces/space'), legacyGlobalRoots: [] }),
    trash: vi.fn(), openFolder: vi.fn(),
  })
})

describe('legacy skill availability consumers use the product catalog', () => {
  it('returns global and space metadata and actual instruction directories', () => {
    const global = write(globalRoot(), 'alpha', '---\nname: alpha\ndescription: First skill\n---\nBody')
    const local = write(projectRoot(), 'beta', '---\nname: beta\ndescription: Second skill\n---\nBody')
    expect(listAvailableSkills('space').map(skill => [skill.name, skill.scope, skill.path])).toEqual([
      ['alpha', 'global', global], ['beta', 'space', local],
    ])
  })

  it('keeps body-only legacy skills with a useful fallback description', () => {
    write(globalRoot(), 'plain', 'Plain legacy instructions')
    expect(listAvailableSkills('space')[0]).toMatchObject({ name: 'plain', description: 'Plain legacy instructions' })
  })

  it('uses the same command identity for space override and retains all copies for policy inspection', () => {
    write(globalRoot(), 'global-report', '---\nname: report\n---\nGlobal body')
    write(projectRoot(), 'local-report', '---\nname: report\n---\nLocal body')
    expect(listAvailableSkills('space')).toHaveLength(1)
    expect(listAvailableSkills('space')[0].content).toContain('Local body')
    expect(listLoadableSkillCopies('space')).toHaveLength(2)
  })

  it('includes a skill directory link without copying its target', () => {
    const target = write(join(root, 'elsewhere'), 'linked', '---\nname: linked\n---\nBody')
    mkdirSync(globalRoot(), { recursive: true }); symlinkSync(target, join(globalRoot(), 'linked'), 'dir')
    expect(listAvailableSkills('space')[0].name).toBe('linked')
  })

  it('ignores non-skill entries and returns an empty list for missing roots', () => {
    expect(listAvailableSkills('space')).toEqual([])
    mkdirSync(join(globalRoot(), 'empty'), { recursive: true }); writeFileSync(join(globalRoot(), 'stray.txt'), 'not a skill')
    expect(listAvailableSkills('space')).toEqual([])
  })

  it('bounds instruction previews while allowing valid larger bodies', () => {
    write(globalRoot(), 'large', '---\nname: large\n---\n' + 'x'.repeat(30000))
    expect(listAvailableSkills('space')[0].content.length).toBe(20000)
  })

  it('honors a retained execution working directory rather than the newly selected one', () => {
    write(projectRoot(), 'current', 'Current')
    const retained = join(root, 'retained')
    write(join(retained, '.agents/skills'), 'old', 'Retained')
    expect(listLoadableSkillCopies('space', retained).map(skill => skill.name)).toEqual(['old'])
  })
})

describe('loadable skills and the dependencies that name them', () => {
  function skillRecord(id: string, spaceId: string | null, filePath: string, specId: string, name: string, store?: InstalledApp['spec']['store']): InstalledApp {
    return {
      id, specId, spaceId, status: 'active',
      spec: { type: 'skill', spec_version: '1', name, version: '1', description: `Stored ${name}`, ...(store ? { store } : {}) },
      userConfig: {}, userOverrides: { skill: { version: 1, filePath: join(filePath, 'SKILL.md') } },
      permissions: { granted: [], denied: [] }, installedAt: 1, upgradeStrategy: 'auto', knowledgeSeeded: false,
    } as unknown as InstalledApp
  }
  const manager = { listSkillRecords: (spaceId: string | null) => records.filter(app => app.spaceId === spaceId) } as unknown as AppManagerService

  function dh(prompt: string, skills?: string[]): AppSpec {
    return { type: 'automation', name: 'dh', system_prompt: prompt, requires: skills ? { skills } : undefined } as unknown as AppSpec
  }
  const folders = (skills: ReturnType<typeof listLoadableSkills>) => skills.map(s => [s.folder, s.app?.id ?? null]).sort()

  // A Store install whose specId, folder and slug all differ, a Halo-shipped
  // skill, and an installed skill whose folder is not on disk.
  beforeEach(() => {
    const image = write(projectRoot(), 'Image_Gen', 'Body')
    write(projectRoot(), 'report-builder', 'Body')
    const globalReport = write(globalRoot(), 'report-builder', 'Global copy')
    const xlsx = write(globalRoot(), 'xlsx', 'Body')
    mkdirSync(join(projectRoot(), 'not-a-skill'), { recursive: true })
    records = [
      skillRecord('app-image', 'space', image, 'Image Gen', 'Image_Gen', { slug: 'acme/image-gen-2', install_source: 'store', tags: [] }),
      skillRecord('app-xlsx', null, xlsx, 'xlsx', 'xlsx', { slug: 'halo-builtin-skills/xlsx', install_source: 'bundled', tags: [] }),
      skillRecord('app-gone', null, join(globalRoot(), 'gone'), 'gone', 'gone', { slug: 'acme/gone', install_source: 'store', tags: [] }),
      skillRecord('app-report-global', null, globalReport, 'report-builder', 'report-builder', { install_source: 'manual', tags: [] }),
    ]
  })

  it('lists each loadable folder once, the space copy of a name before the global one, with its installed record', () => {
    const skills = listLoadableSkills('space', manager)
    expect(folders(skills)).toEqual([['Image_Gen', 'app-image'], ['report-builder', null], ['xlsx', 'app-xlsx']])
    const report = findLoadableSkill(skills, 'report-builder')!
    expect(report.path).toBe(join(projectRoot(), 'report-builder'))
    expect(readLoadableSkillFiles(report)).toEqual({ 'SKILL.md': 'Body' })
    expect(folders(listLoadableSkills(null, manager))).toEqual([['report-builder', 'app-report-global'], ['xlsx', 'app-xlsx']])
  })

  it('leaves single-file command skills out, as they have no folder to name or package', () => {
    mkdirSync(join(projectRoot(), '..', 'commands'), { recursive: true })
    writeFileSync(join(projectRoot(), '..', 'commands', 'quick-fix.md'), '# Quick fix\nDoes a fix.\n')
    expect(listAvailableSkills('space').map(skill => skill.name)).toContain('quick-fix')
    expect(listLoadableSkills('space', manager).map(skill => skill.folder)).not.toContain('quick-fix')
  })

  it('pairs the winning space folder with its space record when global installed the same skill too', () => {
    const globalDup = write(globalRoot(), 'dup', 'Global dup')
    const spaceDup = write(projectRoot(), 'dup', 'Space dup')
    const store = { slug: 'acme/dup', install_source: 'store' as const, tags: [] }
    records.push(
      skillRecord('app-dup-global', null, globalDup, 'dup', 'dup', store),
      skillRecord('app-dup-space', 'space', spaceDup, 'dup', 'dup', store),
    )
    const skills = listLoadableSkills('space', manager)
    const dup = skills.find(skill => skill.folder === 'dup')!
    expect(dup.app?.id).toBe('app-dup-space')
    expect(dup.path).toBe(spaceDup)
    expect(findLoadableSkill(skills, 'acme/dup')?.folder).toBe('dup')
    expect(normalizeSkillDependencies(['dup'], skills)).toEqual(['acme/dup'])
    expect(findUndeclaredSkills(dh('use dup', ['acme/dup']), skills)).toEqual([])
  })

  it('does not treat a turned-off skill as loadable', () => {
    records.push(skillRecord('app-off', null, write(globalRoot(), 'turned-off', 'Body'), 'turned-off', 'turned-off', { slug: 'acme/off', install_source: 'store', tags: [] }))
    records.at(-1)!.status = 'paused'
    expect(listLoadableSkills('space', manager).map(skill => skill.folder)).not.toContain('turned-off')
  })

  it('resolves a dependency by slug, specId or folder in any case', () => {
    const skills = listLoadableSkills('space', manager)
    for (const dep of ['acme/image-gen-2', 'Image Gen', 'image_gen', { id: 'ACME/IMAGE-GEN-2' }]) {
      expect(findLoadableSkill(skills, dep)?.folder).toBe('Image_Gen')
    }
    expect(findLoadableSkill(skills, 'gone')).toBeUndefined()
  })

  it("never takes another author's slug for a local skill of the same name", () => {
    const skills = listLoadableSkills('space', manager)
    expect(findLoadableSkill(skills, 'someone/report-builder')).toBeUndefined()
    expect(findLoadableSkill(skills, 'bob/image-gen-2')).toBeUndefined()
    expect(normalizeSkillDependencies(['bob/image-gen-2'], skills)).toEqual(['bob/image-gen-2'])
  })

  it('reports prompt-named skills that are neither declared nor shipped, a Store install by its slug', () => {
    const prompt = 'Run Image_Gen, then report-builder, then export with xlsx'
    expect(findUndeclaredSkills(dh(prompt), listLoadableSkills('space', manager))).toEqual([
      { id: 'acme/image-gen-2', folder: 'Image_Gen' },
      { id: 'report-builder', folder: 'report-builder' },
    ])
  })

  it('names an undeclared skill by its folder, not by its installation key', () => {
    const namespaced = write(projectRoot(), 'notes-helper', 'Body')
    records.push(skillRecord('app-notes', 'space', namespaced, 'skill:0123abcd:notes-helper', 'notes-helper', { install_source: 'manual', tags: [] }))
    expect(findUndeclaredSkills(dh('call notes-helper'), listLoadableSkills('space', manager))).toEqual([
      { id: 'notes-helper', folder: 'notes-helper' },
    ])
  })

  it('counts a skill declared under any of its ids as declared', () => {
    const prompt = 'Run Image_Gen, then report-builder'
    expect(findUndeclaredSkills(dh(prompt, ['acme/image-gen-2', 'Report-Builder']), listLoadableSkills('space', manager))).toEqual([])
  })

  it('rewrites a declared Store install to its slug and collapses entries naming the same skill', () => {
    const skills = listLoadableSkills('space', manager)
    expect(normalizeSkillDependencies(
      ['image_gen', { id: 'Image Gen', reason: 'charts' }, 'report-builder', 'missing-one', { id: 'Image_Gen', bundled: true }],
      skills,
    )).toEqual(['acme/image-gen-2', 'report-builder', 'missing-one'])
    expect(normalizeSkillDependencies([{ id: 'image_gen', reason: 'charts' }], skills))
      .toEqual([{ id: 'acme/image-gen-2', reason: 'charts' }])
  })

  it('reads a skill folder for packaging without hidden, node_modules, binary or oversized entries', () => {
    const dir = join(globalRoot(), 'report-builder')
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(dir, 'scripts', 'run.js'), 'x()', 'utf-8')
    writeFileSync(join(dir, '.DS_Store'), 'junk', 'utf-8')
    writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'y()', 'utf-8')
    writeFileSync(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x47]))
    writeFileSync(join(dir, 'huge.txt'), 'a'.repeat(1024 * 1024 + 1), 'utf-8')
    mkdirSync(join(dir, '__pycache__'), { recursive: true })
    writeFileSync(join(dir, '__pycache__', 'x.pyc'), 'c', 'utf-8')
    symlinkSync(join(dir, 'scripts', 'run.js'), join(dir, 'linked.js'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const skill = { folder: 'report-builder', path: dir, app: null }
    expect(readLoadableSkillFiles(skill)).toEqual({ 'SKILL.md': 'Global copy', 'scripts/run.js': 'x()' })
    expect(hasPackageableSkillMd(skill)).toBe(true)
    writeFileSync(join(dir, 'SKILL.md'), Buffer.from([0x23, 0x00]))
    expect(hasPackageableSkillMd(skill)).toBe(false)
  })
})

describe('skill packaging byte limits', () => {
  it('skips a sparse file larger than 2 GiB without losing the skill or small scripts', () => {
    const folder = 'sparse-skill'
    const dir = write(globalRoot(), folder, 'Small skill')
    mkdirSync(join(dir, 'scripts'))
    writeFileSync(join(dir, 'scripts', 'run.js'), 'run()')
    const oversized = join(dir, 'huge.txt')
    writeFileSync(oversized, '')
    truncateSync(oversized, 3 * 1024 * 1024 * 1024)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(readLoadableSkillFiles({ folder, path: dir, app: null })).toEqual({
        'SKILL.md': 'Small skill',
        'scripts/run.js': 'run()',
      })
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(
        `[SkillDiscovery] Not packaging ${folder}/huge.txt: binary or larger than 1048576 bytes`,
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('rejects the whole skill before reading a file above the remaining 50 MiB budget', () => {
    const folder = 'budget-skill'
    const dir = write(globalRoot(), folder, 'Skill')
    const content = 'a'.repeat(1024 * 1024)
    for (let index = 0; index < 50; index++) {
      writeFileSync(join(dir, `part-${String(index).padStart(2, '0')}.txt`), content)
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(readLoadableSkillFiles({ folder, path: dir, app: null })).toBeNull()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(
        `[SkillDiscovery] Cannot read skill folder ${folder} for packaging:`,
        expect.stringContaining('exceeds remaining packaging budget'),
      )
    } finally {
      warn.mockRestore()
    }
  })
})
