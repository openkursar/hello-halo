import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { listAvailableSkills, listLoadableSkillCopies } from '../../../src/main/apps/skill-discovery'
import { createSkillLibrary } from '../../../src/main/apps/skills/service'
import type { AppManagerService } from '../../../src/main/apps/manager'

vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => globalThis.__HALO_TEST_DIR__ }))
const fixture = vi.hoisted(() => ({ library: null as unknown }))
vi.mock('../../../src/main/apps/skills', () => ({ getSkillLibrary: () => fixture.library }))

let root: string
let project: string
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
  fixture.library = createSkillLibrary({
    context: (_spaceId, workDir) => ({ spaceId: 'space', manager: { listSkillRecords: () => [] } as unknown as AppManagerService,
      haloDir: join(root, 'halo'), workDir: workDir ?? project, spaceDataPath: join(root, 'halo/spaces/space'), legacyGlobalRoots: [] }),
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
