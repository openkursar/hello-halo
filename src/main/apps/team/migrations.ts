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
  },
  {
    version: 5,
    description: 'Add federation fields to team_members (owner_node_id/origin/member_identity)',
    up(db) {
      // Defaults keep existing local members behaving identically: owned by SELF,
      // origin local. member_identity stays null until a member is federated.
      db.exec(`ALTER TABLE team_members ADD COLUMN owner_node_id TEXT NOT NULL DEFAULT 'SELF'`)
      db.exec(`ALTER TABLE team_members ADD COLUMN origin TEXT NOT NULL DEFAULT 'local'`)
      db.exec(`ALTER TABLE team_members ADD COLUMN member_identity TEXT`)
    }
  },
  {
    version: 6,
    description: 'Add teams.host_node_id to mark a joined ("shadow") office hosted elsewhere',
    up(db) {
      // NULL keeps existing teams behaving identically: this node is the office
      // authority. A non-null remote node id marks a joined shadow office — a
      // host-driven projection this node mirrors but does not author.
      db.exec(`ALTER TABLE teams ADD COLUMN host_node_id TEXT`)
    }
  },
  {
    version: 7,
    description: 'Add team_members.scope_json (permission overlay carried at join)',
    up(db) {
      // NULL = default-open (full visibility, contact anyone, discoverable,
      // may re-invite), so existing local members are unaffected. A remote member
      // admitted under a scoped office credential stores that scope here, and the
      // AUTHORITY enforces it (contactable/visibility) — not just the UI.
      db.exec(`ALTER TABLE team_members ADD COLUMN scope_json TEXT`)
    }
  },
  {
    version: 8,
    description: 'Add team_members.owner_display_name (owner badge for a remote member)',
    up(db) {
      // NULL for local members (no badge). For a remote member this denormalizes
      // the owning node's display name onto the member row so every node — not
      // just the host, whose office_nodes ledger holds the joiners — can label
      // "brought by Alice" from its own store (joiners keep no peer node rows).
      db.exec(`ALTER TABLE team_members ADD COLUMN owner_display_name TEXT`)
    }
  },
  {
    version: 9,
    description: 'Add team_epochs.title (conversation label) + outcome (run result classification)',
    up(db) {
      // title: user-facing conversation name (renameable; null → derived label).
      // outcome: run result class stamped at seal ('output' | 'no_action' |
      // 'escalation' | 'failed'); null for conversations and legacy rows.
      db.exec(`ALTER TABLE team_epochs ADD COLUMN title TEXT`)
      db.exec(`ALTER TABLE team_epochs ADD COLUMN outcome TEXT`)
    }
  },
  {
    version: 10,
    description: 'Add per-team member duty + delegated capability policy, and the team_checks table',
    up(db) {
      // duty: what this member is responsible for INSIDE this team, written by
      // its owner. NULL = nothing written yet.
      db.exec(`ALTER TABLE team_members ADD COLUMN duty TEXT`)
      // delegated_policy_json: what a TEAMMATE may make this member do. NULL =
      // unrestricted, so every existing team behaves exactly as before. Never
      // replicated — it guards the owner's own machine.
      db.exec(`ALTER TABLE team_members ADD COLUMN delegated_policy_json TEXT`)
      // accepts_checks: the one bit of the policy other nodes need, so a
      // teammate is refused early and clearly instead of at the far end.
      db.exec(`ALTER TABLE team_members ADD COLUMN accepts_checks INTEGER NOT NULL DEFAULT 1`)

      db.exec(`
        CREATE TABLE team_checks (
          id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL,
          epoch_id TEXT NOT NULL,
          target_app_id TEXT NOT NULL,
          created_by_app_id TEXT NOT NULL,
          instruction TEXT NOT NULL,
          schedule_json TEXT NOT NULL,
          run_count INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          last_run_at INTEGER
        )
      `)
      db.exec(`
        CREATE INDEX idx_checks_team_epoch
          ON team_checks(team_id, epoch_id)
      `)
      db.exec(`
        CREATE INDEX idx_checks_target
          ON team_checks(target_app_id)
      `)
    }
  },
  {
    version: 11,
    description: 'Add team_epochs.last_activity_at so a list of work can be ordered by when it last moved',
    up(db) {
      // started_at is the wrong sort key for a conversation: it lives for weeks
      // and is used daily, so ordering by creation buries the thread the user
      // talked to five minutes ago under yesterday's runs. Stamped on every turn
      // that enters the epoch. Backfilled to the last time we know the epoch
      // moved, so existing rows sort sensibly from day one.
      db.exec(`ALTER TABLE team_epochs ADD COLUMN last_activity_at INTEGER`)
      db.exec(`UPDATE team_epochs SET last_activity_at = COALESCE(ended_at, started_at)`)
    }
  },
  {
    version: 12,
    description: 'Add team_activity: the office record of what happened (messages, board writes)',
    up(db) {
      // The tasks/findings tables hold current STATE; nothing held the acts that
      // produced it. Directed messages in particular existed only in memory, so
      // "who contacted whom" was unanswerable the moment a run ended — and a
      // teammate could only learn a task moved by re-reading the task itself.
      //
      // Append-only by design: a reply is a new row pointing at the message it
      // answers (correlation_id), never an edit — so the row replicates as a
      // single idempotent insert and needs no pre-image to roll back.
      db.exec(`
        CREATE TABLE team_activity (
          id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL,
          epoch_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          actor_app_id TEXT NOT NULL,
          target_app_id TEXT,
          subject TEXT NOT NULL DEFAULT '',
          body TEXT,
          ref_id TEXT,
          correlation_id TEXT,
          status TEXT,
          created_at INTEGER NOT NULL
        )
      `)
      db.exec(`
        CREATE INDEX idx_activity_team_epoch
          ON team_activity(team_id, epoch_id, created_at)
      `)
      // Answering "has this message been replied to" is a lookup by the
      // correlation the reply carries, not a scan of the epoch.
      db.exec(`
        CREATE INDEX idx_activity_correlation
          ON team_activity(correlation_id)
      `)
    }
  }
]
