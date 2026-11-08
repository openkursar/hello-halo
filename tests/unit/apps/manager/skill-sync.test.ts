import { describe, it, expect } from 'vitest'
import { dirname, join } from 'path'
import { getSkillDir } from '../../../../src/main/apps/manager/skill-sync'
import type { InstalledApp } from '../../../../src/main/apps/manager/types'

const noSpace = () => null

function record(overrides: Partial<InstalledApp> = {}): InstalledApp {
  return { id: 'installation', specId: 'report', spaceId: null, status: 'active',
    spec: { type: 'skill', spec_version: '1', name: 'report', version: '1', description: 'Report',
      store: { install_source: 'store', slug: 'author/report', tags: [] } },
    userConfig: {}, userOverrides: { skill: { version: 1, filePath: join('/home', 'user', '.agents', 'skills', 'report', 'SKILL.md') } },
    permissions: { granted: [], denied: [] }, installedAt: 1, upgradeStrategy: 'auto', knowledgeSeeded: false,
    ...overrides,
  }
}

describe('skill folder lookup', () => {
  it('reveals only an explicitly recorded location', () => {
    const app = record()
    expect(getSkillDir(app, noSpace)).toBe(dirname(app.userOverrides.skill!.filePath))
    expect(getSkillDir({ ...app, userOverrides: {} }, noSpace)).toBeNull()
  })

  it('has no folder for anything but a skill', () => {
    const app = record()
    expect(getSkillDir({ ...app, spec: { ...app.spec, type: 'mcp' } as InstalledApp['spec'] }, noSpace)).toBeNull()
  })
})
