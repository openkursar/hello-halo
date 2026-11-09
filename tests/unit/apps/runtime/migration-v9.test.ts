import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import { MIGRATION_NAMESPACE as managerNamespace, migrations as managerMigrations } from '../../../../src/main/apps/manager/migrations'
import { MIGRATION_NAMESPACE, migrations } from '../../../../src/main/apps/runtime/migrations'

describe('execution actor migration preserves existing work', () => {
  let manager: DatabaseManager
  let db: Database.Database

  beforeEach(() => {
    manager = createDatabaseManager(':memory:')
    db = manager.getAppDatabase()
    manager.runMigrations(db, managerNamespace, managerMigrations)
    manager.runMigrations(db, MIGRATION_NAMESPACE, migrations.filter(migration => migration.version <= 8))
    db.prepare("INSERT INTO installed_apps (id, spec_id, space_id, spec_json, installed_at) VALUES ('member', 'spec', 'space', '{}', 1)").run()
    db.prepare("INSERT INTO automation_runs (run_id, app_id, session_key, trigger_type, started_at) VALUES ('run', 'member', 'session', 'manual', 2)").run()
    db.prepare(`INSERT INTO activity_entries (id, app_id, run_id, type, ts, session_key, content_json, user_response_json)
      VALUES ('decision', 'member', 'run', 'escalation', 3, 'session', '{"question":"Continue?"}', '{"answer":"Yes"}')`).run()
    db.prepare(`INSERT INTO decision_continuations (entry_id, app_id, status, attempts, receipt_published, updated_at, error)
      VALUES ('decision', 'member', 'queued', 2, 1, 4, 'transient failure')`).run()
    db.prepare(`INSERT INTO app_session_environments (session_key, app_id, environment_json)
      VALUES ('session', 'member', '{"workDir":"/fixture/project"}')`).run()
  })

  afterEach(() => manager.closeAll())

  it('preserves pending decisions, their accepted answers, run history and session environments', () => {
    const tables = ['installed_apps', 'automation_runs', 'activity_entries', 'decision_continuations', 'app_session_environments']
    const before = tables.map(table => db.prepare(`SELECT * FROM ${table}`).all())
    manager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
    expect(tables.map(table => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before)
    expect(db.prepare('SELECT id, installed_app_id FROM runtime_execution_actors').all()).toEqual([{ id: 'member', installed_app_id: 'member' }])
    expect(db.pragma('foreign_key_check')).toEqual([])
    manager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
    expect(tables.map(table => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(before)
  })

  it('retains installed-app cleanup and allows new members without changing existing decisions', () => {
    manager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
    db.prepare("INSERT INTO installed_apps (id, spec_id, space_id, spec_json, installed_at) VALUES ('next', 'next-spec', 'space', '{}', 5)").run()
    expect(db.prepare("SELECT id FROM runtime_execution_actors WHERE id = 'next'").get()).toEqual({ id: 'next' })
    db.prepare("DELETE FROM installed_apps WHERE id = 'next'").run()
    expect(db.prepare("SELECT id FROM activity_entries WHERE id = 'decision'").get()).toEqual({ id: 'decision' })
    db.prepare("DELETE FROM installed_apps WHERE id = 'member'").run()
    expect(db.prepare('SELECT * FROM runtime_execution_actors').all()).toEqual([])
    expect(db.prepare('SELECT * FROM activity_entries').all()).toEqual([])
    expect(db.prepare('SELECT * FROM decision_continuations').all()).toEqual([])
    expect(db.prepare('SELECT * FROM app_session_environments').all()).toEqual([])
    expect(db.pragma('foreign_key_check')).toEqual([])
  })
})
