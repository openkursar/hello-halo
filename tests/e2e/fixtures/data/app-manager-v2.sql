CREATE TABLE installed_apps (
  id TEXT PRIMARY KEY,
  spec_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  pending_escalation_id TEXT,
  user_config_json TEXT NOT NULL DEFAULT '{}',
  user_overrides_json TEXT NOT NULL DEFAULT '{}',
  permissions_json TEXT NOT NULL DEFAULT '{"granted":[],"denied":[]}',
  installed_at INTEGER NOT NULL,
  last_run_at INTEGER,
  last_run_outcome TEXT,
  error_message TEXT,
  uninstalled_at INTEGER,
  UNIQUE(spec_id, space_id)
);
CREATE INDEX idx_installed_apps_space ON installed_apps(space_id);
CREATE INDEX idx_installed_apps_status ON installed_apps(status);
