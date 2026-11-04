/**
 * What happens to a built-in skill's text when a newer shipped version arrives.
 *
 * Runs the real manager, store and skill library (no stubs), and applies the shipped version
 * through upgradeSpec exactly as the startup seeder does for a record that is neither
 * customized nor removed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, realpathSync } from 'fs'
import { dirname, join } from 'path'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import { AppManagerStore } from '../../../../src/main/apps/manager/store'
import { createAppManagerService } from '../../../../src/main/apps/manager/service'
import { MIGRATION_NAMESPACE, migrations } from '../../../../src/main/apps/manager/migrations'
import type { AppManagerService } from '../../../../src/main/apps/manager/types'
import type { SkillSpec } from '../../../../src/main/apps/spec'
import { createSkillLibrary } from '../../../../src/main/apps/skills'

const skillMd = (body: string) => `---\nname: office\ndescription: Office\n---\n${body}\n`

function shipped(version: string, body: string, extra: Record<string, string> = {}): SkillSpec {
  return {
    spec_version: '1', name: 'office', type: 'skill', version, description: 'Office',
    store: { slug: 'halo-builtin-skills/office', install_source: 'builtin', tags: [] },
    skill_files: { 'SKILL.md': skillMd(body), 'references/guide.md': 'shipped guide', ...extra },
  }
}

describe('built-in skill text across shipped versions', () => {
  let database: DatabaseManager
  let store: AppManagerStore
  let manager: AppManagerService
  let root: string

  beforeEach(() => {
    root = realpathSync(globalThis.__HALO_TEST_DIR__)
    mkdirSync(join(root, 'halo'), { recursive: true })
    open()
  })
  afterEach(() => database.closeAll())

  function open(databasePath = ':memory:'): void {
    database = createDatabaseManager(databasePath)
    const db = database.getAppDatabase()
    database.runMigrations(db, MIGRATION_NAMESPACE, migrations)
    store = new AppManagerStore(db)
    manager = createAppManagerService({
      store, getSpacePath: () => null, getAppDataPath: () => null, getGlobalAppDir: () => join(root, 'halo'),
      trashItem: async () => undefined,
    })
  }

  function library() {
    return createSkillLibrary({
      context: spaceId => ({ manager, spaceId, haloDir: join(root, 'halo'), workDir: null, spaceDataPath: null, legacyGlobalRoots: [] }),
      trash: async () => undefined, openFolder: () => {},
    })
  }

  const fileOf = (id: string) => store.getById(id)!.userOverrides.skill!.filePath

  it('keeps text saved in Halo through newer shipped versions, also after a restart', async () => {
    const databasePath = join(root, 'edits.sqlite')
    database.closeAll()
    open(databasePath)
    const id = await manager.install(null, shipped('1', 'shipped one'))
    const skills = library()
    skills.list({ spaceId: null })
    const ref = { spaceId: null, id: `app:${id}` }
    const opened = skills.read(ref)
    skills.save({ ref, revision: opened.revision, content: skillMd('my own words') })
    expect(store.getById(id)!.userOverrides.skill!.customized).toBe(true)

    expect(manager.upgradeSpec(id, shipped('2', 'shipped two', { 'references/new.md': 'new' }))).toMatchObject({ fromVersion: '1', toVersion: '1' })
    expect(readFileSync(fileOf(id), 'utf8')).toBe(skillMd('my own words'))
    expect(store.getById(id)!.spec.version).toBe('1')

    database.closeAll()
    open(databasePath)
    expect(manager.upgradeSpec(id, shipped('3', 'shipped three'))).toMatchObject({ toVersion: '1' })
    expect(readFileSync(fileOf(id), 'utf8')).toBe(skillMd('my own words'))
    expect(readFileSync(join(dirname(fileOf(id)), 'references/guide.md'), 'utf8')).toBe('shipped guide')
  })

  it('refreshes an untouched built-in skill to the newer shipped text', async () => {
    const id = await manager.install(null, shipped('1', 'shipped one'))
    expect(manager.upgradeSpec(id, shipped('2', 'shipped two'))).toMatchObject({ fromVersion: '1', toVersion: '2' })
    expect(readFileSync(fileOf(id), 'utf8')).toBe(skillMd('shipped two'))
    expect(store.getById(id)!.userOverrides.skill!.customized).toBeFalsy()
  })
})
