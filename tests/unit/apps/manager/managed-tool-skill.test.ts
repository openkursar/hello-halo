import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import { AppManagerStore } from '../../../../src/main/apps/manager/store'
import { createAppManagerService } from '../../../../src/main/apps/manager/service'
import { MIGRATION_NAMESPACE, migrations } from '../../../../src/main/apps/manager/migrations'

vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(), homedir: () => globalThis.__HALO_TEST_DIR__,
}))

const input = { toolId: 'npm.example', name: 'cli-example', description: 'Example CLI', body: 'Original instructions' }
const toolOwner = { kind: 'cli-tool', id: input.toolId, name: input.toolId } as const
const personOwner = { kind: 'digital-human', id: input.toolId, name: 'Person with the same ID' } as const
const content = (body: string) => `---\nname: "cli-example"\ndescription: "Example CLI"\n---\n\n${body}`

let database: ReturnType<typeof createDatabaseManager>
let store: AppManagerStore
let manager: ReturnType<typeof createAppManagerService>
let file: string
let root: string
let dbPath: string
const trash = vi.fn(async (path: string) => { renameSync(path, join(root, 'trash', String(trash.mock.calls.length))) })

function open() {
  database = createDatabaseManager(dbPath)
  const db = database.getAppDatabase()
  database.runMigrations(db, MIGRATION_NAMESPACE, migrations)
  store = new AppManagerStore(db)
  manager = createAppManagerService({ store, getSpacePath: () => null, getAppDataPath: () => null,
    getGlobalAppDir: () => join(root, 'halo'), trashItem: trash,
  })
}

beforeEach(() => {
  root = globalThis.__HALO_TEST_DIR__
  dbPath = join(root, 'database')
  file = join(root, '.agents', 'skills', input.name, 'SKILL.md')
  trash.mockClear()
  mkdirSync(join(root, 'trash'), { recursive: true })
  open()
})

afterEach(() => {
  vi.restoreAllMocks()
  database.closeAll()
})

function currentRecord() {
  return manager.listSkillRecords(null)[0]
}

function restart() {
  database.closeAll()
  open()
}

function put(path: string, bytes: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
}

describe('managed CLI skill lifecycle', () => {
  it('installs globally, keeps the same file on no-op, updates in place without undoing pause, and trashes untouched files on removal', async () => {
    await manager.reconcileManagedToolSkill(input)
    const record = currentRecord()
    expect(record.userOverrides.skill?.owners).toEqual([toolOwner])
    expect(record.userOverrides.skill?.filePath).toBe(file)
    expect(manager.listManagedToolSkillIds()).toEqual([input.toolId])
    expect(readFileSync(file, 'utf8')).toBe(content(input.body))
    const stat = statSync(file)
    await manager.reconcileManagedToolSkill(input)
    expect(statSync(file).ino).toBe(stat.ino)
    expect(statSync(file).mtimeMs).toBe(stat.mtimeMs)
    manager.pause(record.id)
    await manager.reconcileManagedToolSkill({ ...input, body: 'Updated' })
    expect(currentRecord()).toMatchObject({ id: record.id, status: 'paused' })
    expect(readFileSync(file, 'utf8')).toBe(content('Updated'))
    await manager.removeManagedToolSkill(input.toolId)
    expect(trash).toHaveBeenCalledOnce()
    expect(existsSync(file)).toBe(false)
    expect(manager.listManagedToolSkillIds()).toEqual([])
  })

  it.each(['directory', 'flat'] as const)('does not adopt an identical, unrecorded personal %s skill', async format => {
    const path = format === 'directory' ? file : join(root, '.claude', 'commands', `${input.name}.md`)
    put(path, content(input.body))
    await manager.reconcileManagedToolSkill(input)
    expect(manager.listManagedToolSkillIds()).toEqual([])
    expect(manager.listSkillRecords(null)).toEqual([])
    await manager.removeManagedToolSkill(input.toolId)
    expect(trash).not.toHaveBeenCalled()
    expect(readFileSync(path, 'utf8')).toBe(content(input.body))
  })

  it.each(['update', 'remove'] as const)('does not %s the managed copy when a personal namesake appears later', async operation => {
    await manager.reconcileManagedToolSkill(input)
    const path = operation === 'update'
      ? join(root, '.agents', 'skills', `${input.name}.md`)
      : join(root, '.claude', 'skills', input.name, 'SKILL.md')
    put(path, content('Personal instructions'))
    if (operation === 'update') await manager.reconcileManagedToolSkill({ ...input, body: 'Updated' })
    else await manager.removeManagedToolSkill(input.toolId)
    expect(currentRecord().userOverrides.skill?.owners).toEqual([])
    expect(readFileSync(file, 'utf8')).toBe(content(input.body))
    expect(readFileSync(path, 'utf8')).toBe(content('Personal instructions'))
    expect(trash).not.toHaveBeenCalled()
  })

  it('does not count a tracked non-personal namesake as a personal collision', async () => {
    await manager.reconcileManagedToolSkill(input)
    const app = currentRecord()
    const path = join(root, '.claude', 'skills', input.name, 'SKILL.md')
    put(path, content('Registry instructions'))
    store.insert({ ...app, id: 'registry-skill', specId: 'registry-skill',
      userOverrides: { skill: { version: 1, filePath: path } },
    })
    await manager.reconcileManagedToolSkill({ ...input, body: 'Updated' })
    expect(readFileSync(file, 'utf8')).toBe(content('Updated'))
    await manager.removeManagedToolSkill(input.toolId)
    expect(trash).toHaveBeenCalledOnce()
    expect(readFileSync(path, 'utf8')).toBe(content('Registry instructions'))
  })

  it('does not publish a staged install if a personal namesake appears after the intent is written', async () => {
    const path = join(root, '.claude', 'commands', `${input.name}.md`)
    const insert = store.insert.bind(store)
    vi.spyOn(store, 'insert').mockImplementationOnce(app => {
      insert(app)
      put(path, content('Personal instructions'))
    })
    await manager.reconcileManagedToolSkill(input)
    expect(manager.listManagedToolSkillIds()).toEqual([])
    expect(existsSync(file)).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(content('Personal instructions'))
    expect(trash).not.toHaveBeenCalled()
  })

  it.each(['edited', 'shared', 'replaced', 'supporting-file'] as const)('keeps a %s copy and drops only the CLI owner', async kind => {
    await manager.reconcileManagedToolSkill(input)
    const owned = currentRecord()
    const state = owned.userOverrides.skill!
    if (kind === 'edited') writeFileSync(file, content('User edit'))
    if (kind === 'shared') manager.updateSkillRecord(owned.id, { skill: { ...state, owners: [toolOwner, personOwner] } })
    if (kind === 'replaced') {
      renameSync(dirname(file), join(root, 'original'))
      put(file, content(input.body))
    }
    if (kind === 'supporting-file') put(join(dirname(file), 'example.txt'), 'User file')
    const previous = readFileSync(file, 'utf8')
    await manager.reconcileManagedToolSkill({ ...input, body: 'Updated' })
    await manager.removeManagedToolSkill(input.toolId)
    expect(readFileSync(file, 'utf8')).toBe(previous)
    expect(currentRecord().userOverrides.skill).toMatchObject({ customized: true, owners: kind === 'shared' ? [personOwner] : [] })
    expect(trash).not.toHaveBeenCalled()
    expect(manager.listManagedToolSkillIds()).toEqual([])
  })

  it('normalizes kindless owner JSON without mistaking it for the CLI owner with the same ID', async () => {
    await manager.reconcileManagedToolSkill(input)
    const record = currentRecord()
    const overrides = { skill: { ...record.userOverrides.skill, owners: [toolOwner, { id: personOwner.id, name: personOwner.name }] } }
    database.getAppDatabase().prepare('UPDATE installed_apps SET user_overrides_json = ? WHERE id = ?').run(JSON.stringify(overrides), record.id)
    expect(store.getById(record.id)?.userOverrides.skill?.owners).toEqual([toolOwner, personOwner])
    await manager.removeManagedToolSkill(input.toolId)
    expect(currentRecord().userOverrides.skill?.owners).toEqual([personOwner])
    expect(readFileSync(file, 'utf8')).toBe(content(input.body))
  })

  it('resumes after publication when the final installation record write failed', async () => {
    vi.spyOn(store, 'updateSkillRecord').mockImplementationOnce(() => { throw new Error('Interrupted commit') })
    await expect(manager.reconcileManagedToolSkill(input)).rejects.toThrow('Interrupted commit')
    expect(currentRecord().userOverrides.skill?.managedTool?.stagingId).toBeDefined()
    expect(existsSync(file)).toBe(true)
    restart()
    expect(manager.listManagedToolSkillIds()).toEqual([input.toolId])
    await manager.reconcileManagedToolSkill(input)
    expect(currentRecord().status).toBe('active')
    expect(currentRecord().userOverrides.skill?.managedTool?.stagingId).toBeUndefined()
    expect(readFileSync(file, 'utf8')).toBe(content(input.body))
  })

  it('recognizes an atomic file update if the commit was interrupted after publication', async () => {
    await manager.reconcileManagedToolSkill(input)
    const update = store.updateSkillRecord.bind(store)
    vi.spyOn(store, 'updateSkillRecord').mockImplementationOnce(update)
      .mockImplementationOnce(() => { throw new Error('Interrupted update') })
    await expect(manager.reconcileManagedToolSkill({ ...input, body: 'Updated' })).rejects.toThrow('Interrupted update')
    expect(readFileSync(file, 'utf8')).toBe(content('Updated'))
    restart()
    await manager.reconcileManagedToolSkill({ ...input, body: 'Latest' })
    expect(readFileSync(file, 'utf8')).toBe(content('Latest'))
    expect(currentRecord().userOverrides.skill?.managedTool?.pendingDigest).toBeUndefined()
  })

  it('retries a journaled trash operation after restart when there is no namesake', async () => {
    await manager.reconcileManagedToolSkill(input)
    trash.mockRejectedValueOnce(new Error('Trash unavailable'))
    await expect(manager.removeManagedToolSkill(input.toolId)).rejects.toThrow('Trash unavailable')
    restart()
    await manager.removeManagedToolSkill(input.toolId)
    expect(trash).toHaveBeenCalledTimes(2)
    expect(manager.listManagedToolSkillIds()).toEqual([])
    expect(existsSync(file)).toBe(false)
  })

  it('abandons a journaled trash operation after restart when a personal namesake appeared', async () => {
    await manager.reconcileManagedToolSkill(input)
    trash.mockRejectedValueOnce(new Error('Trash unavailable'))
    await expect(manager.removeManagedToolSkill(input.toolId)).rejects.toThrow('Trash unavailable')
    const removalId = currentRecord().userOverrides.skill?.managedTool?.removalId
    expect(removalId).toBeDefined()
    expect(readFileSync(file, 'utf8')).toBe(content(input.body))
    renameSync(dirname(file), join(dirname(dirname(file)), '.halo-managed-tool-skills', removalId!))
    put(file, content(input.body))
    restart()
    expect(manager.listManagedToolSkillIds()).toEqual([input.toolId])
    await manager.removeManagedToolSkill(input.toolId)
    expect(trash).toHaveBeenCalledTimes(1)
    expect(manager.listManagedToolSkillIds()).toEqual([])
    expect(readFileSync(file, 'utf8')).toBe(content(input.body))
    expect(readFileSync(join(dirname(dirname(file)), '.halo-managed-tool-skills', removalId!, 'SKILL.md'), 'utf8')).toBe(content(input.body))
    rmSync(dirname(file), { recursive: true })
  })
})
