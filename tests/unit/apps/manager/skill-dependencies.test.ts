import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, realpathSync, readFileSync, renameSync } from 'fs'
import { join } from 'path'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import { AppManagerStore } from '../../../../src/main/apps/manager/store'
import { createAppManagerService } from '../../../../src/main/apps/manager/service'
import { MIGRATION_NAMESPACE, migrations } from '../../../../src/main/apps/manager/migrations'
import type { AppManagerService } from '../../../../src/main/apps/manager/types'
import type { AppSpec, SkillSpec } from '../../../../src/main/apps/spec'

const managerRef = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../../../../src/main/apps/manager', () => ({ getAppManager: managerRef.get }))
vi.mock('../../../../src/main/apps/runtime', () => ({ getAppRuntime: () => null }))
vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(), homedir: () => globalThis.__HALO_TEST_DIR__,
}))

import { installRequiredSkills } from '../../../../src/main/store/registry.service'

const skill: SkillSpec = { type: 'skill', spec_version: '1', name: 'helper', description: 'Helper', version: '1',
  skill_files: { 'SKILL.md': '---\nname: helper\ndescription: Helper\n---\nInstructions', 'tool.js': 'original' },
}
function parent(name: string): AppSpec {
  return { type: 'automation', spec_version: '1', name, author: 'Test', version: '1', description: 'Parent', system_prompt: 'Work',
    store: { slug: `author/${name}`, registry_id: 'controlled-source', tags: [] },
    requires: { skills: [{ id: 'helper', bundled: true }] },
  }
}

describe('skill dependencies preserve user choices', () => {
  let database: DatabaseManager
  let manager: AppManagerService

  beforeEach(() => {
    globalThis.__HALO_TEST_DIR__ = realpathSync(globalThis.__HALO_TEST_DIR__)
    const root = globalThis.__HALO_TEST_DIR__
    const work = join(root, 'project')
    mkdirSync(work)
    database = createDatabaseManager(':memory:')
    const db = database.getAppDatabase()
    database.runMigrations(db, MIGRATION_NAMESPACE, migrations)
    manager = createAppManagerService({ store: new AppManagerStore(db), getSpacePath: () => work,
      getAppDataPath: () => root, getGlobalAppDir: () => root,
      trashItem: async path => { renameSync(path, `${path}.trash`) },
    })
    managerRef.get.mockReturnValue(manager)
  })
  afterEach(() => database.closeAll())

  async function install(name: string, incoming = skill): Promise<string> {
    const spec = parent(name)
    const id = await manager.install('space', spec)
    await installRequiredSkills(spec, 'space', new Map([['helper', incoming]]), id)
    return id
  }

  it('reuses same-source same-content bytes and records both actual digital-human owners', async () => {
    const first = await install('first')
    const second = await install('second')
    const records = manager.listSkillRecords('space')
    expect(records).toHaveLength(1)
    expect(records[0].userOverrides.skill!.owners).toEqual([{ id: first, name: 'first' }, { id: second, name: 'second' }])
    await manager.uninstall(first)
    await manager.deleteApp(first)
    expect(readFileSync(records[0].userOverrides.skill!.filePath, 'utf8')).toContain('Instructions')
  })

  it.each(['paused', 'deleted'])('does not revive a %s dependency', async choice => {
    await install('first')
    const dependency = manager.listSkillRecords('space')[0]
    if (choice === 'paused') manager.pause(dependency.id)
    else await manager.uninstall(dependency.id)
    await expect(install('second')).rejects.toThrow('enable or reinstall it explicitly')
    expect(manager.getApp(dependency.id)!.status).toBe(choice === 'paused' ? 'paused' : 'uninstalled')
  })

  it('reports different content from the same source without overwriting the existing dependency', async () => {
    await install('first')
    const dependency = manager.listSkillRecords('space')[0]
    const incoming: SkillSpec = { ...skill, skill_files: { 'SKILL.md': 'new instructions' } }
    await expect(install('second', incoming)).rejects.toThrow('Failed to install required skills')
    expect(readFileSync(dependency.userOverrides.skill!.filePath, 'utf8')).toContain('Instructions')
    expect(manager.getApp(dependency.id)!.userOverrides.skill!.owners).toHaveLength(1)
  })

  it('keeps same-name dependencies from different sources as independent installations', async () => {
    const first = await install('first')
    const dependency = manager.listSkillRecords('space')[0]
    const incoming: SkillSpec = { ...skill, store: { slug: 'helper', registry_id: 'another-source', tags: [] },
      skill_files: { 'SKILL.md': 'Other source instructions' },
    }
    const second = await install('second', incoming)
    const records = manager.listSkillRecords('space')
    expect(records).toHaveLength(2)
    expect(manager.getApp(dependency.id)!.userOverrides.skill!.owners).toEqual([{ id: first, name: 'first' }])
    const other = records.find(record => record.id !== dependency.id)!
    expect(other.specId).not.toBe(dependency.specId)
    expect(other.userOverrides.skill!.owners).toEqual([{ id: second, name: 'second' }])
    expect(readFileSync(dependency.userOverrides.skill!.filePath, 'utf8')).toContain('Instructions')
    expect(readFileSync(other.userOverrides.skill!.filePath, 'utf8')).toContain('Other source instructions')
  })

  it('installs beside a personal same-name skill without replacing it or claiming its ownership', async () => {
    const id = await manager.install('space', skill)
    const before = manager.getApp(id)!
    const file = before.userOverrides.skill!.filePath
    const person = await install('first')
    expect(readFileSync(file, 'utf8')).toContain('Instructions')
    expect(manager.getApp(id)).toEqual(before)
    const records = manager.listSkillRecords('space')
    expect(records).toHaveLength(2)
    const dependency = records.find(record => record.id !== id)!
    expect(dependency.userOverrides.skill!.owners).toEqual([{ id: person, name: 'first' }])
    expect(dependency.userOverrides.skill!.filePath).not.toBe(file)
  })

  it('keeps legacy callers safe without inventing an owner from a display name', async () => {
    await installRequiredSkills(parent('unbound'), 'space', new Map([['helper', skill]]))
    const dependency = manager.listSkillRecords('space')[0]
    expect(dependency.userOverrides.skill!.owners).toBeUndefined()
    manager.pause(dependency.id)
    await expect(installRequiredSkills(parent('unbound'), 'space', new Map([['helper', skill]]))).rejects.toThrow('disabled or deleted')
  })
})
