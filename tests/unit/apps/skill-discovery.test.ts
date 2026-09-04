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
import { listAvailableSkills } from '../../../src/main/apps/skill-discovery'
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

describe('listAvailableSkills', () => {
  beforeEach(() => {
    saveConfig({
      agent: {
        ...getConfig().agent,
        configDirMode: 'custom',
        customConfigDir: join(testDir(), 'custom-config'),
      },
    })
  })

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

  it('space skill overrides a global skill with the same dirName', () => {
    writeSkill(globalSkillsDir(), 'dup', '---\nname: Global Dup\n---\nglobal')
    writeSkill(spaceSkillsDir(), 'dup', '---\nname: Space Dup\n---\nspace')

    const skills = listAvailableSkills(SPACE_ID)

    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe('Space Dup')
    expect(skills[0].scope).toBe('space')
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
