import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { test } from 'vitest'
import { createDatabaseManager, type DatabaseManager } from '../../../../src/main/platform/store'
import { migrations } from '../../../../src/main/apps/manager/migrations'

const oldSchema = readFileSync(fileURLToPath(new URL('../../../e2e/fixtures/data/app-manager-v2.sql', import.meta.url)), 'utf8')
const targetVersion = 10
const oldColumns = ['id', 'spec_id', 'space_id', 'spec_json', 'status', 'pending_escalation_id', 'user_config_json', 'user_overrides_json', 'permissions_json', 'installed_at', 'last_run_at', 'last_run_outcome', 'error_message', 'uninstalled_at']
type Row = Record<string, unknown>

function fixture(withReference = false) {
  const directory = mkdtempSync(path.join(tmpdir(), 'acceptance-manager-migration-'))
  const file = path.join(directory, 'halo.db')
  const manager = createDatabaseManager(file)
  const db = manager.getAppDatabase()
  db.exec(`CREATE TABLE _migrations (namespace TEXT PRIMARY KEY, version INTEGER NOT NULL, applied_at INTEGER NOT NULL);
    INSERT INTO _migrations VALUES ('app_manager', 2, 100), ('other_records', 1, 101);`)
  db.exec(oldSchema)
  const insert = db.prepare(`INSERT INTO installed_apps (${oldColumns.join(', ')}) VALUES (${oldColumns.map(() => '?').join(', ')})`)
  for (const [index, status] of ['active', 'paused', 'waiting_user', 'uninstalled'].entries()) {
    const id = `legacy-person-${index}`
    insert.run(id, id, 'legacy-space', JSON.stringify({ type: 'automation', name: id, subscriptions: [] }), status,
      status === 'waiting_user' ? 'legacy-question' : null,
      JSON.stringify({ target: `retained-${index}`, enabled: false }),
      JSON.stringify({ frequency: '5m', notificationLevel: 'none', memoryEnabled: false }),
      JSON.stringify({ granted: ['read-files'], denied: ['shell'] }), 1000 + index, 900, 'useful',
      status === 'paused' ? 'Retained diagnostic' : null, status === 'uninstalled' ? 1100 : null)
  }
  insert.run('legacy-skill', 'legacy-skill', 'legacy-space', JSON.stringify({ type: 'skill', name: 'legacy-skill', skill_files: { 'SKILL.md': 'Retained skill content 87261345' } }), 'active', null, '{}', '{}', '{"granted":[],"denied":[]}', 1200, null, null, null, null)
  db.exec(`CREATE TABLE other_records (id TEXT PRIMARY KEY, value TEXT NOT NULL${withReference ? ', app_id TEXT NOT NULL REFERENCES installed_apps(id) ON DELETE CASCADE' : ''});`)
  db.prepare(`INSERT INTO other_records (id, value${withReference ? ', app_id' : ''}) VALUES ('other-control', 'Keep unrelated namespace bytes'${withReference ? ", 'legacy-person-0'" : ''})`).run()
  return { directory, file, manager, db }
}

function legacyRows(db: Database.Database) {
  return db.prepare(`SELECT ${oldColumns.join(', ')} FROM installed_apps ORDER BY id`).all() as Row[]
}

function expectedRows(rows: Row[]) {
  return rows.map(row => {
    const overrides = JSON.parse(row.user_overrides_json as string)
    delete overrides.frequency
    return { ...row, user_overrides_json: JSON.stringify(overrides) }
  })
}

test('the frozen manager v2 layout preserves supported records and applies only the documented new defaults', () => {
  const own = fixture()
  try {
    assert.equal(migrations.at(-1)?.version, targetVersion, 'Review historical-fixture expectations for a new manager version')
    const old = legacyRows(own.db)
    const control = own.db.prepare('SELECT * FROM other_records').all()
    const namespace = own.db.prepare("SELECT * FROM _migrations WHERE namespace = 'other_records'").all()
    own.manager.runMigrations(own.db, 'app_manager', migrations)
    assert.deepEqual(legacyRows(own.db), expectedRows(old))
    const added = own.db.prepare('SELECT upgrade_strategy, ignored_versions, knowledge_seeded, data_path, author_spec_json FROM installed_apps').all()
    for (const row of added) assert.deepEqual(row, { upgrade_strategy: 'auto', ignored_versions: '[]', knowledge_seeded: 0, data_path: null, author_spec_json: null })
    assert.equal((own.db.pragma('table_info(installed_apps)') as Array<{ name: string; notnull: number }>).find(row => row.name === 'space_id')?.notnull, 0)
    assert.deepEqual(own.db.prepare('SELECT * FROM other_records').all(), control)
    assert.deepEqual(own.db.prepare("SELECT * FROM _migrations WHERE namespace = 'other_records'").all(), namespace)
    assert.equal((own.db.prepare("SELECT version FROM _migrations WHERE namespace = 'app_manager'").get() as { version: number }).version, targetVersion)
    assert.deepEqual(own.db.pragma('foreign_key_check'), [])
  } finally { own.manager.closeAll(); rmSync(own.directory, { recursive: true, force: true }) }
})

test('rebuilding the manager table retains another namespace\'s existing references to its people', () => {
  const own = fixture(true)
  try {
    const control = own.db.prepare('SELECT * FROM other_records').all()
    assert.equal(control.length, 1)
    assert.equal(own.db.pragma('foreign_keys', { simple: true }), 1)
    own.manager.runMigrations(own.db, 'app_manager', migrations)
    assert.deepEqual(own.db.prepare('SELECT * FROM other_records').all(), control)
    assert.deepEqual(own.db.pragma('foreign_key_check'), [])
  } finally { own.manager.closeAll(); rmSync(own.directory, { recursive: true, force: true }) }
})

test('the manager upgrade snapshot contains real v2 records and a second opening is idempotent with the new scope constraints', () => {
  const own = fixture()
  let reopened: DatabaseManager | undefined
  try {
    const old = legacyRows(own.db)
    own.manager.runMigrations(own.db, 'app_manager', migrations)
    const backupNames = readdirSync(own.directory).filter(name => /^halo\.db\.\d+\.premigrate\.bak$/.test(name))
    assert.equal(backupNames.length, 1)
    const backupBytes = readFileSync(path.join(own.directory, backupNames[0]))
    const backup = new Database(path.join(own.directory, backupNames[0]), { readonly: true })
    try {
      assert.equal((backup.prepare("SELECT version FROM _migrations WHERE namespace = 'app_manager'").get() as { version: number }).version, 2)
      assert.deepEqual(legacyRows(backup), old)
      assert.deepEqual((backup.pragma('table_info(installed_apps)') as Array<{ name: string }>).map(column => column.name), oldColumns)
    } finally { backup.close() }
    const insert = own.db.prepare("INSERT INTO installed_apps (id, spec_id, space_id, spec_json, installed_at) VALUES (?, 'new-global-skill', ?, '{\"type\":\"skill\"}', 2000)")
    insert.run('global-skill', null)
    assert.throws(() => insert.run('duplicate-global', null), /UNIQUE/)
    insert.run('space-skill', 'legacy-space')
    assert.throws(() => insert.run('duplicate-space', 'legacy-space'), /UNIQUE/)
    const current = own.db.prepare('SELECT * FROM installed_apps ORDER BY id').all()
    const versions = own.db.prepare('SELECT * FROM _migrations ORDER BY namespace').all()
    own.manager.closeAll()
    reopened = createDatabaseManager(own.file)
    const db = reopened.getAppDatabase()
    reopened.runMigrations(db, 'app_manager', migrations)
    assert.deepEqual(db.prepare('SELECT * FROM installed_apps ORDER BY id').all(), current)
    assert.deepEqual(db.prepare('SELECT * FROM _migrations ORDER BY namespace').all(), versions)
    assert.deepEqual(readdirSync(own.directory).filter(name => /^halo\.db\.\d+\.premigrate\.bak$/.test(name)), backupNames)
    assert.deepEqual(readFileSync(path.join(own.directory, backupNames[0])), backupBytes)
  } finally { reopened?.closeAll(); own.manager.closeAll(); rmSync(own.directory, { recursive: true, force: true }) }
})
