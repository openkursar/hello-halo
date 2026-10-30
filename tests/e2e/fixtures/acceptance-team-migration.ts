import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import Database from 'better-sqlite3'

export const teamTables = ['teams', 'team_members', 'team_edges', 'blackboard_tasks', 'blackboard_findings', 'team_epochs', 'team_triggers', 'team_checks', 'team_activity', 'team_tool_audit'] as const
export const legacyTeamVersion = 19
export const currentTeamVersion = 20
const schema = readFileSync(new URL('./data/app-team-v19.sql', import.meta.url), 'utf8')
const dataBytes = readFileSync(new URL('./data/app-team-v19.json', import.meta.url))
export const teamHistory = JSON.parse(dataBytes.toString('utf8')) as {
  schemaVersion: number; targetVersion: number; schemaDeclaration: string; provenance: string
  task: Record<string, string | number>; finding: Record<string, string | number>; activity: Record<string, string | number>
  audit: Record<string, string | number>; trigger: Record<string, string | number>
  duplicates: Array<{ id: string; name: string; created_at: number }>
}
type Row = Record<string, unknown>
export interface TeamMigrationIdentity {
  teamId: string; spaceId: string; leadId: string; memberId: string; epochId: string; conversationId: string
}

export function teamSchemaIdentity() {
  return { version: legacyTeamVersion, target: currentTeamVersion, declaration: teamHistory.schemaDeclaration, provenance: teamHistory.provenance,
    schemaSha256: createHash('sha256').update(schema).digest('hex'), dataSha256: createHash('sha256').update(dataBytes).digest('hex') }
}

export function installFrozenTeamSchema(db: Database.Database) {
  db.exec(schema)
}

function rows(db: Database.Database, table: string) {
  const quoted = `"${table.replaceAll('"', '""')}"`
  return (db.prepare(`SELECT * FROM ${quoted}`).all() as Row[]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}

function insert(db: Database.Database, table: typeof teamTables[number], record: Row) {
  const columns = Object.keys(record)
  db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...columns.map(column => record[column]))
}

export function addFrozenTeamHistory(db: Database.Database, ids: TeamMigrationIdentity, timestamp: number) {
  const dated = (record: Record<string, string | number>) => Object.fromEntries(Object.entries(record).map(([key, value]) => [key, key.endsWith('_at') ? timestamp + Number(value) - 1735689600000 : value]))
  insert(db, 'blackboard_tasks', { ...dated(teamHistory.task), team_id: ids.teamId, epoch_id: ids.epochId,
    assignee_app_id: ids.memberId, created_by_app_id: ids.leadId })
  insert(db, 'blackboard_findings', { ...dated(teamHistory.finding), team_id: ids.teamId, epoch_id: ids.epochId, author_app_id: ids.memberId })
  insert(db, 'team_activity', { ...dated(teamHistory.activity), team_id: ids.teamId, epoch_id: ids.epochId,
    actor_app_id: ids.memberId, target_app_id: ids.leadId, ref_id: teamHistory.task.id })
  insert(db, 'team_tool_audit', { ...dated(teamHistory.audit), team_id: ids.teamId, epoch_id: ids.epochId, app_id: ids.memberId, actor_app_id: ids.leadId })
  insert(db, 'team_triggers', { ...dated(teamHistory.trigger), team_id: ids.teamId })
  for (const duplicate of teamHistory.duplicates) {
    const started = timestamp + duplicate.created_at - 1735689600000
    const coordinator = `space-conv-${ids.conversationId}`
    insert(db, 'teams', { id: duplicate.id, name: duplicate.name, owning_space_id: ids.spaceId,
      goal: 'Retain the old collaboration binding and its history.', lead_app_id: coordinator,
      member_sourcing: 'manual', collab_mode: 'free', escalation_routing: 'user', status: 'idle',
      created_at: started, updated_at: started + 10, ephemeral: 1, coordinator_conversation_id: ids.conversationId })
    insert(db, 'team_members', { team_id: duplicate.id, app_id: coordinator, member_name: 'coordinator', role: 'Coordinator',
      is_lead: 1, is_system_coordinator: 1, ai_provisioned: 0, added_at: started })
    insert(db, 'team_members', { team_id: duplicate.id, app_id: ids.memberId, member_name: 'Reviewer', role: 'Reviewer',
      ai_provisioned: 0, duty: `Retained duty in ${duplicate.name}`, added_at: started })
    insert(db, 'team_epochs', { id: `${duplicate.id}-epoch`, team_id: duplicate.id, started_at: started,
      ended_at: started + 10, end_reason: 'completed', summary: `Retained summary for ${duplicate.name}`,
      trigger_type: 'manual', lifecycle: 'conversation', chat_key: `space:${ids.conversationId}`,
      title: duplicate.name, last_activity_at: started + 10, task_status: 'completed', task_title: duplicate.name,
      task_created_by: null, task_entry_app_id: coordinator, task_updated_at: started + 10 })
    insert(db, 'blackboard_findings', { id: `${duplicate.id}-finding`, team_id: duplicate.id, epoch_id: `${duplicate.id}-epoch`,
      author_app_id: ids.memberId, body: `Retained independent finding for ${duplicate.name}`, created_at: started + 5 })
  }
}

export function teamProfileDatabase(profile: string) {
  const file = join(profile, '.halo', 'halo.db')
  assert.ok(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink())
  const owned = relative(realpathSync(profile), realpathSync(file))
  assert.ok(owned && !isAbsolute(owned) && owned !== '..' && !owned.startsWith(`..${sep}`), 'Only the owned profile database may receive historical data')
  return file
}

function readState(db: Database.Database) {
  return {
    version: (db.prepare("SELECT version FROM _migrations WHERE namespace = 'app_team'").get() as { version: number }).version,
    tables: Object.fromEntries(teamTables.map(table => [table, rows(db, table)])) as Record<typeof teamTables[number], Row[]>,
    namespaces: db.prepare("SELECT * FROM _migrations WHERE namespace != 'app_team' ORDER BY namespace").all(),
    managerRows: rows(db, 'installed_apps'),
    foreignKeyViolations: db.pragma('foreign_key_check'), integrity: db.pragma('integrity_check', { simple: true }),
    bindingIndex: db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_teams_coordinator_conversation'").get(),
  }
}

export type TeamMigrationState = ReturnType<typeof readState>

export function readTeamMigration(file: string) {
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try { return readState(db) } finally { db.close() }
}

function namespaceControls(db: Database.Database) {
  const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string; sql: string }>
  return tables.filter(table => !teamTables.includes(table.name as typeof teamTables[number]) && table.name !== '_migrations')
    .map(table => ({ ...table, sha256: createHash('sha256').update(JSON.stringify(rows(db, table.name))).digest('hex') }))
}

export function prepareLegacyTeam(profile: string, child: Pick<ChildProcess, 'exitCode' | 'signalCode'>, ids: TeamMigrationIdentity) {
  assert.ok(child.exitCode != null || child.signalCode != null, 'Historical team preparation requires the owned process to have exited')
  const db = new Database(teamProfileDatabase(profile), { fileMustExist: true })
  const oldLayout = new Database(':memory:')
  try {
    installFrozenTeamSchema(oldLayout)
    const before = readState(db)
    assert.equal(before.version, currentTeamVersion, 'Review the frozen team layout before accepting a new target version')
    assert.equal(before.tables.teams.length, 1, 'The isolated fixture must contain only its own explicitly created team')
    assert.equal(before.tables.teams[0].id, ids.teamId)
    assert.ok(before.tables.team_epochs.some(epoch => epoch.id === ids.epochId && epoch.task_status === 'completed'))
    for (const table of teamTables) assert.deepEqual(db.pragma(`table_info(${table})`), oldLayout.pragma(`table_info(${table})`), `Review changed table layout: ${table}`)
    const controls = namespaceControls(db)
    db.pragma('foreign_keys = OFF')
    db.transaction(() => {
      for (const table of [...teamTables].reverse()) db.exec(`DROP TABLE ${table}`)
      installFrozenTeamSchema(db)
      for (const table of teamTables) for (const record of before.tables[table]) insert(db, table, record)
      addFrozenTeamHistory(db, ids, Date.now() - 600000)
      db.prepare("UPDATE _migrations SET version = ? WHERE namespace = 'app_team'").run(legacyTeamVersion)
    })()
    db.pragma('foreign_keys = ON')
    assert.deepEqual(namespaceControls(db), controls, 'Preparing only the team namespace must not alter other application data')
    const old = readState(db)
    assert.deepEqual(old.namespaces, before.namespaces)
    assert.deepEqual(old.managerRows, before.managerRows)
    assert.deepEqual(old.foreignKeyViolations, [])
    assert.equal(old.integrity, 'ok')
    return { old, controls }
  } finally { oldLayout.close(); db.close() }
}

export function expectedTeamRows(old: TeamMigrationState['tables']) {
  const result = structuredClone(old)
  result.teams = result.teams.map(team => team.id === teamHistory.duplicates[0].id ? { ...team, coordinator_conversation_id: null } : team)
  return result
}
