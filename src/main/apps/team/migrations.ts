/** apps/team -- Database migrations. */

import type { Migration } from '../../platform/store'
import { TEAM_MIGRATION_NAMESPACE } from '../../../shared/apps/team-types'

export const MIGRATION_NAMESPACE = TEAM_MIGRATION_NAMESPACE

export const migrations: Migration[] = [
  {
    version: 1,
    description: 'Create digital-team tables (teams, members, edges, blackboard, epochs)',
    up(db) {
      db.exec(`
        CREATE TABLE teams (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          owning_space_id TEXT NOT NULL,
          goal TEXT NOT NULL,
          lead_app_id TEXT,
          member_sourcing TEXT NOT NULL DEFAULT 'manual',
          collab_mode TEXT NOT NULL DEFAULT 'structured',
          escalation_routing TEXT NOT NULL DEFAULT 'user',
          status TEXT NOT NULL DEFAULT 'idle',
          current_epoch_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)
      db.exec(`
        CREATE UNIQUE INDEX idx_teams_name_space
          ON teams(owning_space_id, name)
      `)

      // ai_provisioned drives orphan cleanup on dissolve.
      db.exec(`
        CREATE TABLE team_members (
          team_id TEXT NOT NULL,
          app_id TEXT NOT NULL,
          member_name TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT '',
          is_lead INTEGER NOT NULL DEFAULT 0,
          ai_provisioned INTEGER NOT NULL DEFAULT 0,
          added_at INTEGER NOT NULL,
          PRIMARY KEY (team_id, app_id)
        )
      `)
      db.exec(`
        CREATE UNIQUE INDEX idx_member_name
          ON team_members(team_id, member_name)
      `)

      db.exec(`
        CREATE TABLE team_edges (
          team_id TEXT NOT NULL,
          from_app_id TEXT NOT NULL,
          to_app_id TEXT NOT NULL,
          sync INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (team_id, from_app_id, to_app_id)
        )
      `)

      db.exec(`
        CREATE TABLE blackboard_tasks (
          id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL,
          epoch_id TEXT NOT NULL,
          title TEXT NOT NULL,
          assignee_app_id TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          result_ref TEXT,
          note TEXT,
          parent_id TEXT,
          created_by_app_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)
      db.exec(`
        CREATE INDEX idx_tasks_team_epoch
          ON blackboard_tasks(team_id, epoch_id)
      `)

      db.exec(`
        CREATE TABLE blackboard_findings (
          id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL,
          epoch_id TEXT NOT NULL,
          author_app_id TEXT NOT NULL,
          body TEXT,
          ref TEXT,
          created_at INTEGER NOT NULL
        )
      `)
      db.exec(`
        CREATE INDEX idx_findings_team_epoch
          ON blackboard_findings(team_id, epoch_id)
      `)

      db.exec(`
        CREATE TABLE team_epochs (
          id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          end_reason TEXT,
          summary TEXT
        )
      `)
      db.exec(`
        CREATE INDEX idx_epochs_team
          ON team_epochs(team_id)
      `)
    }
  },
  {
    version: 2,
    description: 'Add team_triggers (team as first-class triggerable entity) + epoch trigger_type',
    up(db) {
      db.exec(`
        CREATE TABLE team_triggers (
          id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL,
          source_type TEXT NOT NULL,
          config_json TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL
        )
      `)
      db.exec(`
        CREATE INDEX idx_team_triggers_team
          ON team_triggers(team_id)
      `)

      db.exec(`ALTER TABLE team_epochs ADD COLUMN trigger_type TEXT NOT NULL DEFAULT 'manual'`)
    }
  },
  {
    version: 3,
    description: 'Add epoch lifecycle (run vs conversation) for IM-backed long-lived epochs',
    up(db) {
      db.exec(`ALTER TABLE team_epochs ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'run'`)
    }
  },
  {
    version: 4,
    description: 'Add epoch chat_key to scope conversation epochs per IM chat (one open epoch per chat)',
    up(db) {
      db.exec(`ALTER TABLE team_epochs ADD COLUMN chat_key TEXT`)
      // Fast lookup of the open conversation epoch for a given (team, chat).
      db.exec(`
        CREATE INDEX idx_epochs_team_chat
          ON team_epochs(team_id, chat_key)
      `)
    }
  }
]
