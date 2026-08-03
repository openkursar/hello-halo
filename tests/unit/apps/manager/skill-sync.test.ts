/**
 * Unit tests for apps/manager/skill-sync global directory resolution.
 *
 * The critical invariant: global skills must be written to the same directory
 * the SDK reads (resolveClaudeConfigDir()/skills, which follows the user's
 * configDirMode). An earlier version wrote to a fixed userData path, stranding
 * global skills where the agent never loads them in 'cc'/'custom' modes.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  resolveGlobalSkillsDir,
  syncSkillToFilesystem,
  reconcileGlobalSkillsLocation,
} from '../../../../src/main/apps/manager/skill-sync'
import {
  resolveClaudeConfigDir,
  saveConfig,
  getConfig,
} from '../../../../src/main/foundation/config.service'
import type { InstalledApp } from '../../../../src/main/apps/manager/types'
import type { AppSpec } from '../../../../src/main/apps/spec/schema'

function setAgentConfig(agent: Record<string, unknown>): void {
  saveConfig({ agent: { ...getConfig().agent, ...agent } })
}

function testDir(): string {
  return globalThis.__HALO_TEST_DIR__
}

/** The fixed pre-configDirMode write location (userData/claude-config/skills) */
function legacySkillsDir(): string {
  return join(testDir(), '.halo', 'claude-config', 'skills')
}

const SKILL_MD = '---\nname: my-skill\ndescription: A test skill\n---\nBody'

function globalSkillApp(overrides?: Partial<InstalledApp>): InstalledApp {
  return {
    id: 'app-1',
    specId: 'my-skill',
    spaceId: null,
    spec: {
      spec_version: '1',
      name: 'My Skill',
      version: '1.0.0',
      author: 'Test',
      description: 'A test skill',
      type: 'skill',
      skill_content: SKILL_MD,
    } as AppSpec,
    status: 'active',
    userConfig: {},
    userOverrides: {},
    permissions: { granted: [], denied: [] },
    installedAt: Date.now(),
    upgradeStrategy: 'auto',
    ...overrides,
  }
}

const noSpace = (): string | null => null

describe('resolveGlobalSkillsDir', () => {
  beforeEach(() => {
    setAgentConfig({ configDirMode: undefined, customConfigDir: undefined })
  })

  it('always equals the SDK read path (resolveClaudeConfigDir()/skills)', () => {
    for (const mode of [undefined, 'halo', 'cc', 'custom'] as const) {
      setAgentConfig({
        configDirMode: mode,
        customConfigDir: mode === 'custom' ? join(testDir(), 'my-config') : undefined,
      })
      expect(resolveGlobalSkillsDir()).toBe(join(resolveClaudeConfigDir(), 'skills'))
    }
  })

  it("'custom' mode resolves under the configured custom dir", () => {
    const customDir = join(testDir(), 'my-config')
    setAgentConfig({ configDirMode: 'custom', customConfigDir: customDir })
    expect(resolveGlobalSkillsDir()).toBe(join(customDir, 'skills'))
  })
})

describe('syncSkillToFilesystem (global scope)', () => {
  beforeEach(() => {
    setAgentConfig({ configDirMode: undefined, customConfigDir: undefined })
  })

  it("writes into the resolved dir in 'custom' mode, not the legacy fixed path", () => {
    const customDir = join(testDir(), 'my-config')
    setAgentConfig({ configDirMode: 'custom', customConfigDir: customDir })

    syncSkillToFilesystem(globalSkillApp(), noSpace)

    expect(existsSync(join(customDir, 'skills', 'my-skill', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(legacySkillsDir(), 'my-skill'))).toBe(false)
  })
})

describe('reconcileGlobalSkillsLocation', () => {
  beforeEach(() => {
    setAgentConfig({ configDirMode: undefined, customConfigDir: undefined })
  })

  function seedLegacySkill(dirName: string): void {
    const dir = join(legacySkillsDir(), dirName)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), SKILL_MD, 'utf-8')
  }

  it('moves stranded global skills to the resolved dir and removes legacy copies', () => {
    seedLegacySkill('my-skill')
    const customDir = join(testDir(), 'my-config')
    setAgentConfig({ configDirMode: 'custom', customConfigDir: customDir })

    reconcileGlobalSkillsLocation([globalSkillApp()], noSpace)

    const migrated = join(customDir, 'skills', 'my-skill', 'SKILL.md')
    expect(existsSync(migrated)).toBe(true)
    expect(readFileSync(migrated, 'utf-8')).toContain('A test skill')
    expect(existsSync(join(legacySkillsDir(), 'my-skill'))).toBe(false)
  })

  it('is a no-op in the default mode where legacy and resolved dirs coincide', () => {
    seedLegacySkill('my-skill')

    reconcileGlobalSkillsLocation([globalSkillApp()], noSpace)

    // Default mode: resolved dir IS the legacy dir — the skill must survive.
    expect(existsSync(join(legacySkillsDir(), 'my-skill', 'SKILL.md'))).toBe(true)
  })

  it('skips uninstalled apps and non-global apps', () => {
    seedLegacySkill('my-skill')
    seedLegacySkill('space-skill')
    const customDir = join(testDir(), 'my-config')
    setAgentConfig({ configDirMode: 'custom', customConfigDir: customDir })

    reconcileGlobalSkillsLocation(
      [
        globalSkillApp({ status: 'uninstalled' }),
        globalSkillApp({ id: 'app-2', specId: 'space-skill', spaceId: 'space-001' }),
      ],
      noSpace
    )

    expect(existsSync(join(customDir, 'skills', 'my-skill'))).toBe(false)
    expect(existsSync(join(customDir, 'skills', 'space-skill'))).toBe(false)
    // Legacy copies untouched
    expect(existsSync(join(legacySkillsDir(), 'my-skill', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(legacySkillsDir(), 'space-skill', 'SKILL.md'))).toBe(true)
  })
})

describe('syncSkillToFilesystem frontmatter name', () => {
  beforeEach(() => {
    setAgentConfig({ configDirMode: undefined, customConfigDir: undefined })
  })

  function writtenSkillMd(dirName: string): string {
    return readFileSync(join(resolveGlobalSkillsDir(), dirName, 'SKILL.md'), 'utf-8')
  }

  it('leaves an authored frontmatter name alone', () => {
    syncSkillToFilesystem(globalSkillApp(), noSpace)

    // spec.name is "My Skill" while the frontmatter says "my-skill": a spec the
    // author wrote themselves keeps its own command, exactly as before.
    expect(writtenSkillMd('my-skill')).toContain('name: my-skill')
  })

  it('pins the frontmatter to a derived name so it matches the directory', () => {
    const app = globalSkillApp({
      specId: 'ai-xie-zuo',
      spec: {
        spec_version: '1',
        name: 'ai-xie-zuo',
        display_name: 'AI写作',
        version: '1.0.0',
        author: 'Test',
        description: 'A test skill',
        type: 'skill',
        skill_content: SKILL_MD,
      } as AppSpec,
    })

    syncSkillToFilesystem(app, noSpace)

    expect(writtenSkillMd('ai-xie-zuo')).toContain('name: ai-xie-zuo')
  })
})
