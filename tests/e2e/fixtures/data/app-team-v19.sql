CREATE TABLE teams (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, owning_space_id TEXT NOT NULL, goal TEXT NOT NULL,
  lead_app_id TEXT, member_sourcing TEXT NOT NULL DEFAULT 'manual',
  collab_mode TEXT NOT NULL DEFAULT 'structured', escalation_routing TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'idle', current_epoch_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, host_node_id TEXT,
  ephemeral INTEGER NOT NULL DEFAULT 0, coordinator_conversation_id TEXT
);
CREATE UNIQUE INDEX idx_teams_name_space ON teams(owning_space_id, name);
CREATE INDEX idx_teams_coordinator_conversation ON teams(coordinator_conversation_id);

CREATE TABLE team_members (
  team_id TEXT NOT NULL, app_id TEXT NOT NULL, member_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '', is_lead INTEGER NOT NULL DEFAULT 0,
  ai_provisioned INTEGER NOT NULL DEFAULT 0, added_at INTEGER NOT NULL,
  owner_node_id TEXT NOT NULL DEFAULT 'SELF', origin TEXT NOT NULL DEFAULT 'local',
  member_identity TEXT, scope_json TEXT, owner_display_name TEXT, duty TEXT,
  delegated_policy_json TEXT, accepts_checks INTEGER NOT NULL DEFAULT 1,
  awaiting_decision INTEGER NOT NULL DEFAULT 0, is_system_coordinator INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (team_id, app_id)
);
CREATE UNIQUE INDEX idx_member_name ON team_members(team_id, member_name);

CREATE TABLE team_edges (
  team_id TEXT NOT NULL, from_app_id TEXT NOT NULL, to_app_id TEXT NOT NULL,
  sync INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (team_id, from_app_id, to_app_id)
);

CREATE TABLE blackboard_tasks (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL, epoch_id TEXT NOT NULL, title TEXT NOT NULL,
  assignee_app_id TEXT, status TEXT NOT NULL DEFAULT 'pending', result_ref TEXT, note TEXT,
  parent_id TEXT, created_by_app_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX idx_tasks_team_epoch ON blackboard_tasks(team_id, epoch_id);

CREATE TABLE blackboard_findings (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL, epoch_id TEXT NOT NULL,
  author_app_id TEXT NOT NULL, body TEXT, ref TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX idx_findings_team_epoch ON blackboard_findings(team_id, epoch_id);

CREATE TABLE team_epochs (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL, started_at INTEGER NOT NULL,
  ended_at INTEGER, end_reason TEXT, summary TEXT,
  trigger_type TEXT NOT NULL DEFAULT 'manual', lifecycle TEXT NOT NULL DEFAULT 'run', chat_key TEXT,
  title TEXT, outcome TEXT, last_activity_at INTEGER,
  task_status TEXT CHECK(task_status IN ('open', 'completed')), task_title TEXT,
  task_created_by TEXT, task_entry_app_id TEXT, task_updated_at INTEGER
);
CREATE INDEX idx_epochs_team ON team_epochs(team_id);
CREATE INDEX idx_epochs_team_chat ON team_epochs(team_id, chat_key);

CREATE TABLE team_triggers (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL, source_type TEXT NOT NULL,
  config_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
CREATE INDEX idx_team_triggers_team ON team_triggers(team_id);

CREATE TABLE team_checks (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL, epoch_id TEXT NOT NULL,
  target_app_id TEXT NOT NULL, created_by_app_id TEXT NOT NULL, instruction TEXT NOT NULL,
  schedule_json TEXT NOT NULL, run_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_run_at INTEGER,
  external INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_checks_team_epoch ON team_checks(team_id, epoch_id);
CREATE INDEX idx_checks_target ON team_checks(target_app_id);

CREATE TABLE team_activity (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL, epoch_id TEXT NOT NULL, kind TEXT NOT NULL,
  actor_app_id TEXT NOT NULL, target_app_id TEXT, subject TEXT NOT NULL DEFAULT '', body TEXT,
  ref_id TEXT, correlation_id TEXT, status TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX idx_activity_team_epoch ON team_activity(team_id, epoch_id, created_at);
CREATE INDEX idx_activity_correlation ON team_activity(correlation_id);

CREATE TABLE team_tool_audit (
  id TEXT PRIMARY KEY, team_id TEXT NOT NULL, epoch_id TEXT NOT NULL, app_id TEXT NOT NULL,
  actor_app_id TEXT, external INTEGER NOT NULL DEFAULT 0, tool_name TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '', decision TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX idx_tool_audit_team ON team_tool_audit(team_id, created_at);
CREATE INDEX idx_tool_audit_app ON team_tool_audit(app_id, created_at);
