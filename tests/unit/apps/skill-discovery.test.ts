/**
 * Unit tests for apps/skill-discovery.
 *
 * Covers directory scanning (frontmatter extraction, fallbacks, symlinks,
 * malformed entries), space-over-global override merging, and content
 * truncation. Uses the 'halo-temp' space so getWorkingDir resolves inside the
 * per-test sandbox without a spaces DB.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Newly reachable via ai-sources/manager.ts or mcp-manager.ts pulling in
// analytics.service.ts (which statically imports providers/baidu.ts's
// `BrowserWindow` from 'electron') — mock it out like every other test that
// touches this transitive chain, so this file's own module graph controls
// what it needs rather than the real telemetry provider stack.
vi.mock('../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn(), trackErrorSurface: vi.fn() }
}))

import { mkdirSync, writeFileSync, symlinkSync } from 'fs'
import { join } from 'path'
import {
  findLoadableSkill,
  findUndeclaredSkills,
  listAvailableSkills,
  listLoadableSkills,
  normalizeSkillDependencies,
  readLoadableSkillFiles,
  hasPackageableSkillMd,
} from '../../../src/main/apps/skill-discovery'
import type { AppSpec } from '../../../src/main/apps/spec'
import { saveConfig, getConfig } from '../../../src/main/foundation/config.service'

const SPACE_ID = 'halo-temp'

function testDir(): string {
  return globalThis.__HALO_TEST_DIR__
}

/** Global skills dir under a 'custom' config dir inside the sandbox */
function globalSkillsDir(): string {
  return join(testDir(), 'custom-config', 'skills')
}

/** Space skills dir for halo-temp (SDK workDir is temp/artifacts) */
function spaceSkillsDir(): string {
  return join(testDir(), '.halo', 'temp', 'artifacts', '.claude', 'skills')
}

function writeSkill(baseDir: string, dirName: string, md: string): void {
  const dir = join(baseDir, dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), md, 'utf-8')
}

beforeEach(() => {
  saveConfig({
    agent: {
      ...getConfig().agent,
      configDirMode: 'custom',
      customConfigDir: join(testDir(), 'custom-config'),
    },
  })
})

describe('listAvailableSkills', () => {
  it('lists global and space skills with frontmatter name/description', () => {
    writeSkill(globalSkillsDir(), 'alpha', '---\nname: Alpha\ndescription: First skill\n---\nBody')
    writeSkill(spaceSkillsDir(), 'beta', '---\nname: Beta\ndescription: Second skill\n---\nBody')

    const skills = listAvailableSkills(SPACE_ID)

    expect(skills).toHaveLength(2)
    expect(skills.map(s => [s.name, s.scope])).toEqual([
      ['Alpha', 'global'],
      ['Beta', 'space'],
    ])
    expect(skills[0].description).toBe('First skill')
    expect(skills[0].dirName).toBe('alpha')
    expect(skills[0].path).toBe(join(globalSkillsDir(), 'alpha'))
    expect(skills[1].path).toBe(join(spaceSkillsDir(), 'beta'))
  })

  it('falls back to the directory name when frontmatter has no name', () => {
    writeSkill(globalSkillsDir(), 'no-front', 'Just body, no frontmatter')

    const skills = listAvailableSkills(SPACE_ID)

    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe('no-front')
    expect(skills[0].description).toBe('')
  })

  it('keeps the global skill over a space skill with the same dirName, as the engine does', () => {
    writeSkill(globalSkillsDir(), 'dup', '---\nname: Global Dup\n---\nglobal')
    writeSkill(spaceSkillsDir(), 'dup', '---\nname: Space Dup\n---\nspace')

    const skills = listAvailableSkills(SPACE_ID)

    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe('Global Dup')
    expect(skills[0].scope).toBe('global')
  })

  it('includes symlinked skill directories', () => {
    const realDir = join(testDir(), 'elsewhere', 'linked-skill')
    mkdirSync(realDir, { recursive: true })
    writeFileSync(join(realDir, 'SKILL.md'), '---\nname: Linked\n---\nBody', 'utf-8')
    mkdirSync(globalSkillsDir(), { recursive: true })
    symlinkSync(realDir, join(globalSkillsDir(), 'linked-skill'))

    const skills = listAvailableSkills(SPACE_ID)

    expect(skills.map(s => s.name)).toContain('Linked')
  })

  it('skips directories without SKILL.md, plain files, and symlinks to files', () => {
    mkdirSync(join(globalSkillsDir(), 'empty-dir'), { recursive: true })
    writeFileSync(join(globalSkillsDir(), 'stray.txt'), 'not a skill', 'utf-8')
    symlinkSync(join(globalSkillsDir(), 'stray.txt'), join(globalSkillsDir(), 'file-link'))

    expect(listAvailableSkills(SPACE_ID)).toHaveLength(0)
  })

  it('returns an empty list when no skills dirs exist', () => {
    expect(listAvailableSkills(SPACE_ID)).toEqual([])
  })

  it('truncates oversized SKILL.md content', () => {
    const big = '---\nname: Big\n---\n' + 'x'.repeat(30000)
    writeSkill(globalSkillsDir(), 'big', big)

    const skills = listAvailableSkills(SPACE_ID)

    expect(skills[0].content.length).toBe(20000)
  })
})

describe('loadable skills and the dependencies that name them', () => {
  // A Store install whose specId, folder and slug all differ, a Halo-shipped
  // skill, and an app whose folder is not on disk.
  const skillApps = [
    { id: 'app-image', spaceId: SPACE_ID, specId: 'Image Gen', status: 'active', spec: { type: 'skill', store: { slug: 'acme/image-gen-2', install_source: 'store' } } },
    { id: 'app-xlsx', spaceId: null, specId: 'xlsx', status: 'active', spec: { type: 'skill', store: { slug: 'halo-builtin-skills/xlsx', install_source: 'bundled' } } },
    { id: 'app-gone', spaceId: null, specId: 'gone', status: 'active', spec: { type: 'skill' } },
    { id: 'app-report-global', spaceId: null, specId: 'report-builder', status: 'active', spec: { type: 'skill' } },
  ]
  // listApps is per scope; the effective view is space-over-global by specId, as the real manager.
  const manager = {
    listApps: ({ spaceId }: { spaceId: string | null }) => skillApps.filter(app => app.spaceId === spaceId),
    listEffectiveSkillApps: (spaceId: string) => {
      const space = skillApps.filter(app => app.spaceId === spaceId)
      return [...space, ...skillApps.filter(app => app.spaceId === null && !space.some(own => own.specId === app.specId))]
    },
  } as never

  function dh(prompt: string, skills?: string[]): AppSpec {
    return { type: 'automation', name: 'dh', system_prompt: prompt, requires: skills ? { skills } : undefined } as unknown as AppSpec
  }

  beforeEach(() => {
    writeSkill(spaceSkillsDir(), 'Image_Gen', 'Body')
    writeSkill(spaceSkillsDir(), 'report-builder', 'Body')
    writeSkill(globalSkillsDir(), 'report-builder', 'Global copy')
    writeSkill(globalSkillsDir(), 'xlsx', 'Body')
    mkdirSync(join(spaceSkillsDir(), 'not-a-skill'), { recursive: true })
  })

  it('lists each loadable folder once, global before space, with its installed app', () => {
    const skills = listLoadableSkills(SPACE_ID, manager)
    // The global report-builder wins over the space's hand-placed copy of that name.
    expect(skills.map(s => [s.folder, s.app?.id ?? null])).toEqual([
      ['report-builder', 'app-report-global'],
      ['xlsx', 'app-xlsx'],
      ['Image_Gen', 'app-image'],
    ])
    expect(skills[0].path).toBe(join(globalSkillsDir(), 'report-builder'))
    expect(listLoadableSkills(null, manager).map(s => s.folder).sort()).toEqual(['report-builder', 'xlsx'])
    expect(listLoadableSkills(null, manager).find(s => s.folder === 'report-builder')?.app?.id).toBe('app-report-global')
  })

  it('pairs the winning global folder with its global app when the space installed the same skill too', () => {
    skillApps.push(
      { id: 'app-dup-global', spaceId: null, specId: 'dup', status: 'active', spec: { type: 'skill', store: { slug: 'acme/dup', install_source: 'store' } } },
      { id: 'app-dup-space', spaceId: SPACE_ID, specId: 'dup', status: 'active', spec: { type: 'skill', store: { slug: 'acme/dup', install_source: 'store' } } },
    )
    try {
      writeSkill(globalSkillsDir(), 'dup', 'Global dup')
      writeSkill(spaceSkillsDir(), 'dup', 'Space dup')
      const skills = listLoadableSkills(SPACE_ID, manager)
      const dup = skills.find(skill => skill.folder === 'dup')!
      expect(dup.app?.id).toBe('app-dup-global')
      expect(dup.path).toBe(join(globalSkillsDir(), 'dup'))
      expect(findLoadableSkill(skills, 'acme/dup')?.folder).toBe('dup')
      expect(normalizeSkillDependencies(['dup'], skills)).toEqual(['acme/dup'])
      expect(findUndeclaredSkills(dh('use dup', ['acme/dup']), skills)).toEqual([])
    } finally {
      skillApps.splice(-2, 2)
    }
  })

  it('resolves a dependency by slug, specId or folder in any case', () => {
    const skills = listLoadableSkills(SPACE_ID, manager)
    for (const dep of ['acme/image-gen-2', 'Image Gen', 'image_gen', { id: 'ACME/IMAGE-GEN-2' }]) {
      expect(findLoadableSkill(skills, dep)?.folder).toBe('Image_Gen')
    }
    expect(findLoadableSkill(skills, 'gone')).toBeUndefined()
  })

  it("never takes another author's slug for a local skill of the same name", () => {
    const skills = listLoadableSkills(SPACE_ID, manager)
    expect(findLoadableSkill(skills, 'someone/report-builder')).toBeUndefined()
    expect(findLoadableSkill(skills, 'bob/image-gen-2')).toBeUndefined()
    expect(normalizeSkillDependencies(['bob/image-gen-2'], skills)).toEqual(['bob/image-gen-2'])
  })

  it('reports prompt-named skills that are neither declared nor shipped, a Store install by its slug', () => {
    const prompt = 'Run Image_Gen, then report-builder, then export with xlsx'
    expect(findUndeclaredSkills(dh(prompt), listLoadableSkills(SPACE_ID, manager))).toEqual([
      { id: 'acme/image-gen-2', folder: 'Image_Gen' },
      { id: 'report-builder', folder: 'report-builder' },
    ])
  })

  it('counts a skill declared under any of its ids as declared', () => {
    const prompt = 'Run Image_Gen, then report-builder'
    expect(findUndeclaredSkills(dh(prompt, ['acme/image-gen-2', 'Report-Builder']), listLoadableSkills(SPACE_ID, manager))).toEqual([])
  })

  it('rewrites a declared Store install to its slug and collapses entries naming the same skill', () => {
    const skills = listLoadableSkills(SPACE_ID, manager)
    expect(normalizeSkillDependencies(
      ['image_gen', { id: 'Image Gen', reason: 'charts' }, 'report-builder', 'missing-one', { id: 'Image_Gen', bundled: true }],
      skills,
    )).toEqual(['acme/image-gen-2', 'report-builder', 'missing-one'])
    expect(normalizeSkillDependencies([{ id: 'image_gen', reason: 'charts' }], skills))
      .toEqual([{ id: 'acme/image-gen-2', reason: 'charts' }])
  })

  it('reads a skill folder for packaging without hidden, node_modules, binary or oversized entries', () => {
    const dir = join(globalSkillsDir(), 'report-builder')
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
    const skill = findLoadableSkill(listLoadableSkills(SPACE_ID, manager), 'report-builder')!
    expect(readLoadableSkillFiles(skill)).toEqual({ 'SKILL.md': 'Global copy', 'scripts/run.js': 'x()' })
    expect(hasPackageableSkillMd(skill)).toBe(true)
    writeFileSync(join(dir, 'SKILL.md'), Buffer.from([0x23, 0x00]))
    expect(hasPackageableSkillMd(skill)).toBe(false)
  })
})
