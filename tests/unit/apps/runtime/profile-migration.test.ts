import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'vitest'
import { createDatabaseManager, type DatabaseManager } from '../../../../src/main/platform/store'
import { migrations as runtimeMigrations } from '../../../../src/main/apps/runtime/migrations'
import {
  prepareLegacyRuntime, profileDatabase, readMigrationData, migrationBackups, restoreMigrationBackup,
  currentRuntimeVersion, migrationFault, type MigrationRecords,
} from '../../../e2e/fixtures/acceptance-migration-data'

const closed = { exitCode: 0, signalCode: null }

async function profile() {
  const directory = await mkdtemp(path.join(tmpdir(), 'acceptance-runtime-migration-'))
  await mkdir(path.join(directory, '.halo'))
  const database = path.join(directory, '.halo', 'halo.db')
  const manager = createDatabaseManager(database)
  try {
    const db = manager.getAppDatabase()
    // Parent rows are a storage fixture; the application test installs real people through appInstall.
    manager.runMigrations(db, 'app_manager', [{ version: 1, description: 'Installed-app parent fixture', up(database) {
      database.exec(`CREATE TABLE installed_apps (
        id TEXT PRIMARY KEY, spec_id TEXT NOT NULL, space_id TEXT NOT NULL, spec_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', user_config_json TEXT NOT NULL DEFAULT '{}',
        user_overrides_json TEXT NOT NULL DEFAULT '{}', permissions_json TEXT NOT NULL DEFAULT '{"granted":[],"denied":[]}',
        installed_at INTEGER NOT NULL
      )`)
    } }])
    for (const id of ['old-owner', 'untouched-owner']) {
      db.prepare('INSERT INTO installed_apps (id, spec_id, space_id, spec_json, installed_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, id, 'isolated-space', JSON.stringify({ type: 'automation', name: id, subscriptions: [] }), Date.now())
    }
    manager.runMigrations(db, 'app_runtime', runtimeMigrations)
  } finally { manager.closeAll() }
  const records: MigrationRecords = { appIds: ['old-owner', 'untouched-owner'], runId: 'old-run', sessionKey: 'old-session', entryId: 'old-entry', orphanId: 'old-orphan', orphanAppId: 'removed-owner', summary: 'Keep this actual older activity.', timestamp: Date.now() - 60000 }
  return { directory, database, records }
}

test('a frozen file-backed v3 fixture keeps parent records through the actual current runtime migrations', async () => {
  const own = await profile()
  let manager: DatabaseManager | undefined
  try {
    const old = prepareLegacyRuntime(own.directory, closed, own.records, false)
    assert.equal(old.runtimeVersion, 3)
    assert.equal(old.entries.length, 2)
    manager = createDatabaseManager(own.database)
    manager.runMigrations(manager.getAppDatabase(), 'app_runtime', runtimeMigrations)
    const current = readMigrationData(own.database, own.records)
    assert.equal(current.runtimeVersion, currentRuntimeVersion)
    assert.deepEqual(current.apps, old.apps)
    assert.equal(current.managerVersion, old.managerVersion)
    assert.deepEqual(current.run, old.run)
    assert.equal(current.entries.length, 1)
    assert.equal(current.entries[0].id, own.records.entryId)
    assert.equal(JSON.parse(current.entries[0].content_json as string).summary, own.records.summary)
    assert.equal(current.activityForeignKeys.some(key => key.from === 'run_id'), false)
    assert.deepEqual(current.foreignKeyViolations, [])
    const backups = migrationBackups(own.directory)
    assert.equal(backups.length, 1)
    assert.deepEqual(readMigrationData(backups[0].file, own.records), old)
    manager.closeAll()
    manager = createDatabaseManager(own.database)
    manager.runMigrations(manager.getAppDatabase(), 'app_runtime', runtimeMigrations)
    assert.deepEqual(readMigrationData(own.database, own.records), current)
    assert.deepEqual(migrationBackups(own.directory), backups)
  } finally { manager?.closeAll(); await rm(own.directory, { recursive: true, force: true }) }
})

test('a real SQLite version-write refusal rolls back current migration SQL and preserves a restorable product snapshot', async () => {
  const own = await profile()
  let manager: DatabaseManager | undefined
  try {
    const old = prepareLegacyRuntime(own.directory, closed, own.records, true)
    manager = createDatabaseManager(own.database)
    const db = manager.getAppDatabase()
    assert.throws(() => manager!.runMigrations(db, 'app_runtime', runtimeMigrations), new RegExp(migrationFault))
    assert.deepEqual(readMigrationData(own.database, own.records), old)
    assert.equal((db.pragma('table_info(automation_runs)') as Array<{ name: string }>).some(column => column.name === 'environment_json'), false)
    assert.equal((db.pragma('foreign_key_list(activity_entries)') as Array<{ from: string }>).some(key => key.from === 'run_id'), true)
    const [backup] = migrationBackups(own.directory)
    assert.ok(backup)
    assert.deepEqual(readMigrationData(backup.file, own.records), old)
    manager.closeAll()
    restoreMigrationBackup(own.directory, closed, backup.file, own.records)
    manager = createDatabaseManager(own.database)
    manager.runMigrations(manager.getAppDatabase(), 'app_runtime', runtimeMigrations)
    const recovered = readMigrationData(own.database, own.records)
    assert.equal(recovered.runtimeVersion, currentRuntimeVersion)
    assert.deepEqual(recovered.apps, old.apps)
    assert.deepEqual(recovered.run, old.run)
    assert.equal(recovered.entries[0].id, own.records.entryId)
    assert.deepEqual(recovered.foreignKeyViolations, [])
    assert.equal(migrationBackups(own.directory).find(candidate => candidate.file === backup.file)?.sha256, backup.sha256)
  } finally { manager?.closeAll(); await rm(own.directory, { recursive: true, force: true }) }
})

test('the historical fixture refuses mutation while its application process has not exited', async () => {
  const own = await profile()
  try {
    const before = await readFile(profileDatabase(own.directory))
    assert.throws(() => prepareLegacyRuntime(own.directory, { exitCode: null, signalCode: null }, own.records, false), /owned application process to have exited/)
    assert.throws(() => prepareLegacyRuntime(own.directory, {} as typeof closed, own.records, false), /owned application process to have exited/)
    assert.deepEqual(await readFile(own.database), before)
    assert.deepEqual(migrationBackups(own.directory), [])
  } finally { await rm(own.directory, { recursive: true, force: true }) }
})
