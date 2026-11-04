import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'fs'
import { dirname, join } from 'path'
import { getSkillDir, resolveGlobalSkillsDir, syncSkillToFilesystem, reconcileGlobalSkillsLocation } from '../../../../src/main/apps/manager/skill-sync'
import { getHaloDir } from '../../../../src/main/foundation/config.service'
import type { InstalledApp } from '../../../../src/main/apps/manager/types'

const content = '---\nname: report\ndescription: Report\n---\nOriginal'
const noSpace = () => null

function record(overrides: Partial<InstalledApp> = {}): InstalledApp {
  return { id: 'installation', specId: 'report', spaceId: null, status: 'active',
    spec: { type: 'skill', spec_version: '1', name: 'report', version: '1', description: 'Report',
      store: { install_source: 'store', slug: 'author/report', tags: [] }, skill_content: content },
    userConfig: {}, userOverrides: { skill: { version: 1, filePath: join(globalThis.__HALO_TEST_DIR__, 'halo', 'skills', 'installation', 'SKILL.md') } },
    permissions: { granted: [], denied: [] }, installedAt: 1, upgradeStrategy: 'auto', knowledgeSeeded: false,
    ...overrides,
  }
}

beforeEach(() => { globalThis.__HALO_TEST_DIR__ = realpathSync(globalThis.__HALO_TEST_DIR__) })

describe('skill filesystem authority compatibility', () => {
  it('resolves the private global root independently from any engine configuration', () => {
    expect(resolveGlobalSkillsDir()).toBe(join(getHaloDir(), 'skills'))
  })

  it('prefers a recorded location without creating a directory', () => {
    const app = record()
    expect(getSkillDir(app, noSpace)).toBe(dirname(app.userOverrides.skill!.filePath))
    expect(existsSync(app.userOverrides.skill!.filePath)).toBe(false)
    expect(getSkillDir({ ...app, userOverrides: {} }, noSpace)).toBeNull()
  })

  it('writes missing managed files even when paused without changing status', () => {
    const app = record({ status: 'paused' })
    syncSkillToFilesystem(app, noSpace)
    expect(readFileSync(app.userOverrides.skill!.filePath, 'utf8')).toBe(content)
    expect(app.status).toBe('paused')
  })

  it('never overwrites a live managed file with stale stored content', () => {
    const app = record()
    const path = app.userOverrides.skill!.filePath
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'existing disk content')
    syncSkillToFilesystem(app, noSpace)
    expect(readFileSync(path, 'utf8')).toBe('existing disk content')
  })

  it.each(['personal', 'customized', 'deleted', 'uninstalled', 'unmigrated'])('does not restore %s files', condition => {
    const app = record()
    const path = app.userOverrides.skill!.filePath
    if (condition === 'personal') app.spec.store = { install_source: 'manual', tags: [] }
    if (condition === 'customized') app.userOverrides.skill!.customized = true
    if (condition === 'deleted') app.userOverrides.skill!.deleted = true
    if (condition === 'uninstalled') app.status = 'uninstalled'
    if (condition === 'unmigrated') app.userOverrides = {}
    syncSkillToFilesystem(app, noSpace)
    expect(existsSync(path)).toBe(false)
  })

  it('leaves legacy locations untouched instead of rewriting on startup', () => {
    const app = record()
    const legacy = join(globalThis.__HALO_TEST_DIR__, 'old-engine', 'skills', 'report', 'SKILL.md')
    mkdirSync(dirname(legacy), { recursive: true })
    writeFileSync(legacy, 'legacy external edit')
    reconcileGlobalSkillsLocation([app], noSpace)
    expect(readFileSync(legacy, 'utf8')).toBe('legacy external edit')
    expect(existsSync(app.userOverrides.skill!.filePath)).toBe(false)
  })
})
