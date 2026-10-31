import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { test } from 'vitest'
import { createDatabaseManager, type DatabaseManager } from '../../../../src/main/platform/store'
import { migrations } from '../../../../src/main/apps/team/migrations'
import { TeamStore } from '../../../../src/main/apps/team/store'
import {
  addFrozenTeamHistory, currentTeamVersion, expectedTeamRows, frozenLayout, installFrozenTeamSchema,
  prepareLegacyTeam, readTeamMigration, teamHistory, teamTables,
} from '../../../e2e/fixtures/acceptance-team-migration'

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'acceptance-team-migration-'))
  const file = path.join(directory, 'halo.db')
  const manager = createDatabaseManager(file)
  const db = manager.getAppDatabase()
  db.exec(`CREATE TABLE _migrations (namespace TEXT PRIMARY KEY, version INTEGER NOT NULL, applied_at INTEGER NOT NULL);
    INSERT INTO _migrations VALUES ('app_team', 19, 100), ('app_manager', 10, 101), ('reference_control', 1, 102);
    CREATE TABLE installed_apps (id TEXT PRIMARY KEY, spec_json TEXT NOT NULL);
    INSERT INTO installed_apps VALUES ('lead-person', '{"name":"Retained lead"}'), ('reviewer-person', '{"name":"Retained reviewer"}');`)
  installFrozenTeamSchema(db)
  db.exec(`INSERT INTO teams (id, name, owning_space_id, goal, lead_app_id, created_at, updated_at)
    VALUES ('main-team', 'Retained team', 'owned-space', 'Retain team work', 'lead-person', 1000, 1000);
    INSERT INTO team_members (team_id, app_id, member_name, role, is_lead, added_at, duty, delegated_policy_json, accepts_checks)
    VALUES ('main-team', 'lead-person', 'Lead', 'Coordinator', 1, 1000, 'Retained lead duty', NULL, 1),
      ('main-team', 'reviewer-person', 'Reviewer', 'Reviewer', 0, 1000, 'Retained reviewer duty', '{"allowedTools":["Read"],"allowChecks":false}', 0);
    INSERT INTO team_edges VALUES ('main-team', 'lead-person', 'reviewer-person', 1);
    INSERT INTO team_epochs (id, team_id, started_at, ended_at, end_reason, lifecycle, chat_key, task_status, task_title, task_created_by, task_entry_app_id, task_updated_at)
    VALUES ('old-task', 'main-team', 1000, 1100, 'completed', 'conversation', 'native:old-task', 'completed', 'Old completed work', 'retained-owner', 'lead-person', 1100);
    CREATE TABLE reference_control (id TEXT PRIMARY KEY, team_id TEXT REFERENCES teams(id) ON DELETE CASCADE, value TEXT NOT NULL);
    INSERT INTO reference_control VALUES ('control', 'main-team', 'Keep unrelated records');`)
  addFrozenTeamHistory(db, { teamId: 'main-team', spaceId: 'owned-space', leadId: 'lead-person', memberId: 'reviewer-person', epochId: 'old-task', conversationId: 'old-conversation' }, 2000)
  return { directory, file, manager, db }
}

test('the independently frozen v19 columns match the current table layout apart from its binding index and the saved-team link', () => {
  const historical = new Database(':memory:')
  const current = createDatabaseManager(':memory:')
  try {
    installFrozenTeamSchema(historical)
    const db = current.getAppDatabase()
    current.runMigrations(db, 'app_team', migrations)
    for (const table of teamTables) assert.deepEqual(historical.pragma(`table_info(${table})`), frozenLayout(db, table), table)
    assert.deepEqual((db.pragma('table_info(teams)') as Array<{ name: string }>).filter(column => column.name === 'saved_team_id'),
      [{ cid: 15, name: 'saved_team_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 }])
    const oldIndex = historical.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_teams_coordinator_conversation'").pluck().get() as string
    const newIndex = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_teams_coordinator_conversation'").pluck().get() as string
    assert.doesNotMatch(oldIndex, /UNIQUE/)
    assert.match(newIndex, /UNIQUE/)
    assert.match(newIndex, /WHERE coordinator_conversation_id IS NOT NULL/)
  } finally { historical.close(); current.closeAll() }
})

test('an independent v19 schema keeps every team row and dependent namespace while deduplicating only the losing binding', () => {
  const own = fixture()
  try {
    assert.equal(migrations.at(-1)?.version, currentTeamVersion)
    const old = readTeamMigration(own.file)
    const control = own.db.prepare('SELECT * FROM reference_control').all()
    own.manager.runMigrations(own.db, 'app_team', migrations)
    const store = new TeamStore(own.db)
    assert.equal(store.getTeamById('main-team')?.name, 'Retained team')
    assert.equal(store.listTasksByEpoch('main-team', 'old-task')[0].note, teamHistory.task.note)
    assert.equal(store.getMember('main-team', 'reviewer-person')?.delegatedPolicy?.allowChecks, false)
    const current = readTeamMigration(own.file)
    assert.equal(current.version, currentTeamVersion)
    assert.deepEqual(current.tables, expectedTeamRows(old.tables))
    assert.deepEqual(current.managerRows, old.managerRows)
    assert.deepEqual(current.namespaces, old.namespaces)
    assert.deepEqual(own.db.prepare('SELECT * FROM reference_control').all(), control)
    assert.deepEqual(current.foreignKeyViolations, [])
    assert.equal(current.integrity, 'ok')
    assert.equal(own.db.pragma('foreign_keys', { simple: true }), 1)
    assert.equal(current.tables.team_members.find(row => row.team_id === 'main-team' && row.app_id === 'reviewer-person')?.delegated_policy_json, '{"allowedTools":["Read"],"allowChecks":false}')
  } finally { own.manager.closeAll(); rmSync(own.directory, { recursive: true, force: true }) }
})

test('v20 uses the documented tie breaker and rejects duplicate bindings while allowing multiple unbound teams', () => {
  const own = fixture()
  try {
    const insert = own.db.prepare("INSERT INTO teams (id, name, owning_space_id, goal, created_at, updated_at, coordinator_conversation_id) VALUES (?, ?, 'owned-space', 'Keep binding history', 3000, 3000, ?)")
    insert.run('tie-b', 'Tie B', 'tie-conversation')
    insert.run('tie-a', 'Tie A', 'tie-conversation')
    own.manager.runMigrations(own.db, 'app_team', migrations)
    const binding = (id: string) => (own.db.prepare('SELECT coordinator_conversation_id AS value FROM teams WHERE id = ?').get(id) as { value: string | null }).value
    assert.equal(binding('tie-a'), 'tie-conversation')
    assert.equal(binding('tie-b'), null)
    assert.equal(binding(teamHistory.duplicates[1].id), 'old-conversation')
    assert.equal(binding(teamHistory.duplicates[0].id), null)
    assert.throws(() => insert.run('new-duplicate', 'Forbidden duplicate', 'old-conversation'), /UNIQUE/)
    insert.run('new-unbound-one', 'New unbound one', null)
    insert.run('new-unbound-two', 'New unbound two', null)
    assert.equal((own.db.prepare('SELECT COUNT(*) AS count FROM teams WHERE coordinator_conversation_id IS NULL').get() as { count: number }).count, 5)
  } finally { own.manager.closeAll(); rmSync(own.directory, { recursive: true, force: true }) }
})

test('the product snapshot preserves the independent old rows and reopening the upgraded file is idempotent', () => {
  const own = fixture()
  let reopened: DatabaseManager | undefined
  try {
    const old = readTeamMigration(own.file)
    own.manager.runMigrations(own.db, 'app_team', migrations)
    const current = readTeamMigration(own.file)
    const backups = readdirSync(own.directory).filter(name => /^halo\.db\.\d+\.premigrate\.bak$/.test(name))
    assert.equal(backups.length, 1)
    const backup = path.join(own.directory, backups[0])
    const bytes = readFileSync(backup)
    assert.deepEqual(readTeamMigration(backup), old)
    own.manager.closeAll()
    reopened = createDatabaseManager(own.file)
    reopened.runMigrations(reopened.getAppDatabase(), 'app_team', migrations)
    assert.deepEqual(readTeamMigration(own.file), current)
    assert.deepEqual(readdirSync(own.directory).filter(name => /^halo\.db\.\d+\.premigrate\.bak$/.test(name)), backups)
    assert.deepEqual(readFileSync(backup), bytes)
  } finally { reopened?.closeAll(); own.manager.closeAll(); rmSync(own.directory, { recursive: true, force: true }) }
})

test('historical team preparation refuses an application whose exit has not been confirmed', () => {
  assert.throws(() => prepareLegacyTeam('/unopened-test-profile', { exitCode: null, signalCode: null }, {
    teamId: 'team', spaceId: 'space', leadId: 'lead', memberId: 'reviewer', epochId: 'epoch', conversationId: 'conversation',
  }), /owned process to have exited/)
})
