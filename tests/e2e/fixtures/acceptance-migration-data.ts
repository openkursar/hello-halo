import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

export const legacyRuntimeVersion = 3
// A newer runtime namespace requires an explicit fixture-layout review.
export const currentRuntimeVersion = 8
const legacySchema = readFileSync(fileURLToPath(new URL('./data/app-runtime-v3.sql', import.meta.url)), 'utf8')
export const migrationFault = 'Acceptance runtime version write refused'
const faultTrigger = 'acceptance_refuse_runtime_migration'
const runtimeTables = [
  'decision_continuations', 'app_session_environments', 'runtime_closed_runs',
  'runtime_legacy_deadlines', 'runtime_decision_migration_backup', 'activity_entries', 'automation_runs',
]

export function legacySchemaIdentity() {
  return { version: legacyRuntimeVersion, sha256: createHash('sha256').update(legacySchema).digest('hex') }
}

export interface MigrationRecords {
  appIds: string[]
  runId: string
  sessionKey: string
  entryId: string
  orphanId: string
  orphanAppId: string
  summary: string
  timestamp: number
}

type Row = Record<string, unknown>
export interface MigrationData {
  runtimeVersion: number
  managerVersion: number
  apps: Row[]
  run: Row | undefined
  entries: Row[]
  activityForeignKeys: Row[]
  foreignKeyViolations: Row[]
  integrity: string
}

export function profileDatabase(profile: string) {
  const database = join(profile, '.halo', 'halo.db')
  const inside = relative(realpathSync(profile), realpathSync(database))
  assert.ok(inside && !isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`), 'The database must belong to the isolated profile')
  return database
}

function assertClosed(child: Pick<ChildProcess, 'exitCode' | 'signalCode'>) {
  assert.ok(child.exitCode != null || child.signalCode != null, 'Database mutation requires the owned application process to have exited')
}

function snapshot(db: Database.Database, records: MigrationRecords): MigrationData {
  const version = (namespace: string) => (db.prepare('SELECT version FROM _migrations WHERE namespace = ?').get(namespace) as { version: number }).version
  const placeholders = records.appIds.map(() => '?').join(',')
  return {
    runtimeVersion: version('app_runtime'), managerVersion: version('app_manager'),
    apps: db.prepare(`SELECT id, spec_id, space_id, spec_json, user_config_json, user_overrides_json, permissions_json, installed_at FROM installed_apps WHERE id IN (${placeholders}) ORDER BY id`).all(...records.appIds) as Row[],
    run: db.prepare('SELECT run_id, app_id, session_key, status, trigger_type, started_at, finished_at, duration_ms, tokens_used, error_message, session_id FROM automation_runs WHERE run_id = ?').get(records.runId) as Row | undefined,
    entries: db.prepare('SELECT id, app_id, run_id, type, ts, session_key, content_json, user_response_json FROM activity_entries WHERE id IN (?, ?) ORDER BY id').all(records.entryId, records.orphanId) as Row[],
    activityForeignKeys: db.pragma('foreign_key_list(activity_entries)') as Row[],
    foreignKeyViolations: db.pragma('foreign_key_check') as Row[],
    integrity: db.pragma('integrity_check', { simple: true }) as string,
  }
}

export function readMigrationData(database: string, records: MigrationRecords): MigrationData {
  const db = new Database(database, { readonly: true, fileMustExist: true })
  try { return snapshot(db, records) } finally { db.close() }
}

/** Build only the historical runtime namespace; installed people and every other namespace stay in place. */
export function prepareLegacyRuntime(profile: string, child: Pick<ChildProcess, 'exitCode' | 'signalCode'>, records: MigrationRecords, failVersionWrite: boolean): MigrationData {
  assertClosed(child)
  const database = profileDatabase(profile)
  const db = new Database(database, { fileMustExist: true })
  try {
    const current = (db.prepare("SELECT version FROM _migrations WHERE namespace = 'app_runtime'").get() as { version: number }).version
    assert.equal(current, currentRuntimeVersion, 'Review the fixture before accepting a different runtime schema version')
    assert.deepEqual((db.pragma('table_info(automation_runs)') as Array<{ name: string }>).map(column => column.name), [
      'run_id', 'app_id', 'session_key', 'status', 'trigger_type', 'trigger_data_json', 'started_at',
      'finished_at', 'duration_ms', 'tokens_used', 'error_message', 'session_id', 'environment_json',
      'stopped_at', 'transcript_cleared_at',
    ], 'Only the reviewed current runtime layout can be converted to the frozen historical input')
    assert.deepEqual((db.pragma('foreign_key_list(activity_entries)') as Row[]).map(key => ({ from: key.from, table: key.table })), [{ from: 'app_id', table: 'installed_apps' }])
    for (const table of runtimeTables) {
      // This v7 table is derived from installed specs, which stay intact below.
      if (table === 'runtime_legacy_deadlines') continue
      assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count, 0, `The fresh profile must not discard existing runtime data in ${table}`)
    }
    const appsBefore = db.prepare('SELECT * FROM installed_apps ORDER BY id').all()
    const namespacesBefore = db.prepare("SELECT * FROM _migrations WHERE namespace != 'app_runtime' ORDER BY namespace").all()
    db.pragma('foreign_keys = OFF')
    db.transaction(() => {
      for (const table of runtimeTables) db.exec(`DROP TABLE ${table}`)
      db.exec(legacySchema)
      db.prepare("UPDATE _migrations SET version = ?, applied_at = ? WHERE namespace = 'app_runtime'").run(legacyRuntimeVersion, records.timestamp)
      db.prepare(`INSERT INTO automation_runs (run_id, app_id, session_key, status, trigger_type, started_at, finished_at, duration_ms, tokens_used, session_id)
        VALUES (?, ?, ?, 'ok', 'manual', ?, ?, 12, 8, 'legacy-session')`).run(records.runId, records.appIds[0], records.sessionKey, records.timestamp, records.timestamp + 12)
      const insert = db.prepare('INSERT INTO activity_entries (id, app_id, run_id, type, ts, session_key, content_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
      insert.run(records.entryId, records.appIds[0], records.runId, 'run_complete', records.timestamp, records.sessionKey, JSON.stringify({ summary: records.summary }))
      insert.run(records.orphanId, records.orphanAppId, 'legacy-orphan-run', 'report', records.timestamp, 'legacy-orphan-session', JSON.stringify({ summary: 'An old record whose app was removed.' }))
      if (failVersionWrite) db.exec(`CREATE TRIGGER ${faultTrigger} BEFORE UPDATE OF version ON _migrations
        WHEN OLD.namespace = 'app_runtime' AND NEW.version > ${legacyRuntimeVersion}
        BEGIN SELECT RAISE(ABORT, '${migrationFault}'); END`)
    })()
    db.pragma('foreign_keys = ON')
    assert.deepEqual(db.prepare('SELECT * FROM installed_apps ORDER BY id').all(), appsBefore)
    assert.deepEqual(db.prepare("SELECT * FROM _migrations WHERE namespace != 'app_runtime' ORDER BY namespace").all(), namespacesBefore)
    const result = snapshot(db, records)
    assert.equal(result.runtimeVersion, legacyRuntimeVersion)
    assert.equal(result.apps.length, records.appIds.length)
    assert.equal(result.entries.length, 2)
    assert.ok(result.activityForeignKeys.some(key => key.from === 'run_id' && key.table === 'automation_runs'))
    assert.equal(result.integrity, 'ok')
    return result
  } finally { db.close() }
}

export function migrationBackups(profile: string) {
  const database = profileDatabase(profile)
  const directory = join(profile, '.halo')
  return readdirSync(directory).filter(name => /^halo\.db\.\d+\.premigrate\.bak$/.test(name)).sort().map(name => {
    const file = join(directory, name)
    const inside = relative(realpathSync(profile), realpathSync(file))
    assert.ok(inside && !isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`))
    return { file, sha256: createHash('sha256').update(readFileSync(file)).digest('hex'), database }
  })
}

export function restoreMigrationBackup(profile: string, child: Pick<ChildProcess, 'exitCode' | 'signalCode'>, backup: string, records: MigrationRecords) {
  assertClosed(child)
  const owned = migrationBackups(profile).find(candidate => candidate.file === backup)
  assert.ok(owned, 'Restore only a product-created snapshot inside this profile')
  const previous = readMigrationData(backup, records)
  assert.equal(previous.runtimeVersion, legacyRuntimeVersion)
  const database = profileDatabase(profile)
  for (const suffix of ['-wal', '-shm']) if (existsSync(database + suffix)) rmSync(database + suffix)
  copyFileSync(backup, database)
  const db = new Database(database, { fileMustExist: true })
  try {
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(faultTrigger), 'The controlled refusal must exist in the original snapshot')
    db.exec(`DROP TRIGGER ${faultTrigger}`)
    assert.deepEqual(snapshot(db, records), previous)
  } finally { db.close() }
}
