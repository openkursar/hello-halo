import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import { MIGRATION_NAMESPACE, migrations } from '../../../../src/main/apps/team/migrations'
import { TeamStore } from '../../../../src/main/apps/team/store'
import type { ParticipantExecution } from '../../../../src/main/apps/team/participants'
import type { TeamParticipant } from '../../../../src/shared/apps/team-types'

const managers: ReturnType<typeof createDatabaseManager>[] = []
afterEach(() => managers.splice(0).forEach(manager => manager.closeAll()))

const legacyTables = [
  'teams', 'team_members', 'team_edges', 'team_epochs', 'blackboard_tasks',
  'blackboard_findings', 'team_activity', 'team_triggers', 'team_checks', 'team_tool_audit',
]
const addedTables = [
  'team_participants', 'collaboration_requests', 'collaboration_request_heads',
  'collaboration_request_sources', 'collaboration_source_bindings',
  'collaboration_recipient_fences', 'collaboration_recipient_epochs',
]

function snapshot(db: Database.Database, tables: string[]) {
  return Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
}

function populatedLegacyDatabase() {
  const manager = createDatabaseManager(':memory:')
  managers.push(manager)
  const db = manager.getAppDatabase()
  manager.runMigrations(db, MIGRATION_NAMESPACE, migrations.filter(migration => migration.version <= 21))
  db.exec(`
    INSERT INTO teams (id, name, owning_space_id, goal, lead_app_id, member_sourcing, collab_mode,
      escalation_routing, status, current_epoch_id, created_at, updated_at, host_node_id,
      ephemeral, coordinator_conversation_id, saved_team_id) VALUES
      ('standing', 'Research', 'space', 'Keep the standing goal', 'lead', 'ai', 'structured',
       'lead', 'running', 'standing-work', 101, 102, NULL, 0, NULL, NULL),
      ('source', 'Research', 'space', 'Keep the source goal', 'source-lead', 'manual', 'open',
       'user', 'idle', NULL, 103, 104, NULL, 1, 'source-chat', 'standing');
    INSERT INTO team_members (team_id, app_id, member_name, role, is_lead, ai_provisioned,
      added_at, owner_node_id, origin, member_identity, scope_json, owner_display_name, duty,
      delegated_policy_json, accepts_checks, awaiting_decision, is_system_coordinator) VALUES
      ('standing', 'lead', 'coordinator', 'Research lead', 1, 1, 105, 'SELF', 'local', NULL,
       NULL, NULL, 'Review unfinished work', '{"allowedTools":["Read","Glob"],"allowCollaboration":false,"allowChecks":false}', 0, 1, 0),
      ('standing', 'remote-member', 'analyst', 'Analyst', 0, 0, 106, 'remote-node', 'remote',
       'remote-identity', '{"contactable":["lead"],"discoverable":false}', 'Remote owner',
       'Provide evidence', '{"allowedTools":[],"allowCollaboration":false,"allowChecks":false}', 0, 0, 0),
      ('source', 'source-lead', 'coordinator', 'Source coordinator', 1, 0, 107, 'SELF', 'local',
       NULL, NULL, NULL, 'Coordinate source work', NULL, 1, 0, 1);
    INSERT INTO team_edges (team_id, from_app_id, to_app_id, sync)
      VALUES ('standing', 'lead', 'remote-member', 1);
    INSERT INTO team_epochs (id, team_id, started_at, ended_at, end_reason, summary, trigger_type,
      lifecycle, chat_key, title, outcome, last_activity_at, task_status, task_title, task_created_by,
      task_entry_app_id, task_updated_at) VALUES
      ('standing-work', 'standing', 110, NULL, NULL, NULL, 'manual', 'conversation', 'task:active',
       'Unfinished conversation', NULL, 115, 'open', 'Unfinished research', 'owner-node', 'lead', 116),
      ('standing-history', 'standing', 80, 90, 'completed', 'Earlier result', 'schedule', 'run', NULL,
       'Earlier conversation', 'output', 90, 'completed', 'Earlier research', 'owner-node', 'lead', 91),
      ('source-work', 'source', 120, NULL, NULL, NULL, 'manual', 'conversation', 'space:source-chat',
       'Source conversation', NULL, 121, 'open', 'Source research', 'owner-node', 'source-lead', 122);
    INSERT INTO blackboard_tasks (id, team_id, epoch_id, title, assignee_app_id, status,
      result_ref, note, parent_id, created_by_app_id, created_at, updated_at) VALUES
      ('parent-task', 'standing', 'standing-work', 'Unfinished parent', 'lead', 'in_progress',
       NULL, 'Waiting for evidence', NULL, 'lead', 130, 135),
      ('child-task', 'standing', 'standing-work', 'Unfinished child', 'remote-member', 'blocked',
       'draft.md', 'Needs human decision', 'parent-task', 'lead', 131, 136);
    INSERT INTO blackboard_findings (id, team_id, epoch_id, author_app_id, body, ref, created_at)
      VALUES ('finding', 'standing', 'standing-work', 'remote-member', 'Retain this evidence', 'evidence.md', 140);
    INSERT INTO team_activity (id, team_id, epoch_id, kind, actor_app_id, target_app_id, subject,
      body, ref_id, correlation_id, status, created_at)
      VALUES ('activity', 'standing', 'standing-work', 'message', 'lead', 'remote-member',
       'Continue investigation', 'Pending work remains', 'child-task', 'correlation', 'sent', 141);
    INSERT INTO team_triggers (id, team_id, source_type, config_json, enabled, created_at)
      VALUES ('trigger', 'standing', 'schedule', '{"cron":"0 9 * * *"}', 0, 142);
    INSERT INTO team_checks (id, team_id, epoch_id, target_app_id, created_by_app_id, instruction,
      schedule_json, run_count, created_at, updated_at, last_run_at, external)
      VALUES ('check', 'standing', 'standing-work', 'lead', 'remote-member', 'Review the draft',
       '{"interval":"30m"}', 3, 143, 144, 144, 1);
    INSERT INTO team_tool_audit (id, team_id, epoch_id, app_id, actor_app_id, external, tool_name,
      detail, decision, reason, created_at)
      VALUES ('audit', 'standing', 'standing-work', 'lead', 'remote-member', 1, 'Bash',
       'Attempted write', 'denied', 'Read-only delegation', 145);
  `)
  expect(db.prepare('SELECT version FROM _migrations WHERE namespace = ?').get(MIGRATION_NAMESPACE)).toEqual({ version: 21 })
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
  expect(db.pragma('foreign_key_check')).toEqual([])
  return { manager, db }
}

function participant(appId: string, teamId: string, epochId: string): TeamParticipant {
  return { appId, teamId, epochId, parentAppId: teamId === 'source' ? 'source-lead' : 'lead',
    memberName: 'helper', role: 'Research assistant', isLead: false, aiProvisioned: false,
    isTemporary: true, ownerNodeId: 'SELF', origin: 'local', addedAt: 200 }
}

const execution: ParticipantExecution = {
  sourceAppId: 'lead', engineId: 'halo', modelSelection: { modelSourceId: 'fixture-source', modelId: 'fixture-model' },
  environment: { spaceId: 'space', spacePath: '/fixture/space', workDir: '/fixture/work', memoryDir: '/fixture/memory' },
  prompt: 'Investigate the unfinished task', permissions: { granted: ['Read'], denied: ['Bash'] },
}

describe('temporary participant migrations on populated v21 storage', () => {
  it('upgrades to v25 without changing any legacy row or field and reruns as a no-op', () => {
    const { manager, db } = populatedLegacyDatabase()
    const before = snapshot(db, legacyTables)
    expect(Object.values(before).every(rows => rows.length > 0)).toBe(true)

    manager.runMigrations(db, MIGRATION_NAMESPACE, migrations)

    expect(db.prepare('SELECT version FROM _migrations WHERE namespace = ?').get(MIGRATION_NAMESPACE)).toEqual({ version: 25 })
    expect(snapshot(db, legacyTables)).toEqual(before)
    for (const table of addedTables) expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([])
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])

    const schema = db.prepare('SELECT * FROM sqlite_schema ORDER BY type, name').all()
    const migrated = snapshot(db, [...legacyTables, ...addedTables, '_migrations'])
    manager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
    expect(snapshot(db, [...legacyTables, ...addedTables, '_migrations'])).toEqual(migrated)
    expect(db.prepare('SELECT * FROM sqlite_schema ORDER BY type, name').all()).toEqual(schema)
    expect(db.pragma('foreign_key_check')).toEqual([])
  })

  it('keeps new participants independent and cascades only the deleted work or team scope', () => {
    const { manager, db } = populatedLegacyDatabase()
    const before = snapshot(db, legacyTables)
    manager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
    const store = new TeamStore(db)
    store.participants.insert(participant('active-helper', 'standing', 'standing-work'), execution)
    store.participants.insert(participant('history-helper', 'standing', 'standing-history'), execution)
    store.participants.insert(participant('source-helper', 'source', 'source-work'), execution)
    expect(snapshot(db, legacyTables)).toEqual(before)
    expect(store.listMembersByTeam('standing').map(member => member.memberName)).toContain('coordinator')
    expect(store.listMembersByAppId('active-helper')).toEqual([])
    expect(store.listDirectoryMemberships().some(member => member.appId === 'active-helper')).toBe(false)
    expect(store.participants.list('standing', 'standing-work').map(member => member.appId)).toEqual(['active-helper'])
    expect(store.participants.get('standing', 'standing-history', 'active-helper')).toBeNull()
    expect(store.participants.get('source', 'standing-work', 'active-helper')).toBeNull()
    expect(() => store.participants.insert(participant('wrong-scope', 'source', 'standing-work'))).toThrow(/scope/)
    expect(store.participants.getExecution('standing', 'standing-work', 'active-helper')).toEqual(execution)

    const insert = db.prepare(`INSERT INTO team_participants
      (app_id, team_id, epoch_id, parent_app_id, member_name, owner_node_id, origin, added_at, metadata_json)
      VALUES (?, ?, ?, 'lead', 'invalid-helper', 'SELF', 'local', 201, '{}')`)
    expect(() => insert.run('missing-team-helper', 'missing-team', 'standing-work')).toThrow(/FOREIGN KEY/)
    expect(() => insert.run('missing-epoch-helper', 'standing', 'missing-epoch')).toThrow(/FOREIGN KEY/)
    const populated = snapshot(db, [...legacyTables, ...addedTables, '_migrations'])
    manager.runMigrations(db, MIGRATION_NAMESPACE, migrations)
    expect(snapshot(db, [...legacyTables, ...addedTables, '_migrations'])).toEqual(populated)

    const sourceParticipant = snapshot(db, ['team_participants']).team_participants[2]
    db.prepare('DELETE FROM team_epochs WHERE id = ?').run('standing-history')
    expect(store.participants.getById('history-helper')).toBeNull()
    expect(store.participants.getById('active-helper')).not.toBeNull()
    expect(store.participants.getById('source-helper')).not.toBeNull()
    expect(store.deleteTeam('standing')).toBe(true)
    expect(store.participants.listByTeam('standing')).toEqual([])
    expect(db.prepare('SELECT * FROM team_participants').all()).toEqual([sourceParticipant])
    expect(store.participants.getExecution('source', 'source-work', 'source-helper')).toEqual(execution)
    expect(db.prepare('SELECT * FROM teams WHERE id = ?').get('source')).toEqual({ ...before.teams[1] as object, saved_team_id: null })
    expect(db.prepare('SELECT * FROM team_epochs WHERE id = ?').get('source-work')).toEqual(before.team_epochs[2])
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }])
  })
})
