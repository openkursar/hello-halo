import { mkdirSync } from 'fs'
import { join } from 'path'
import { createDatabaseManager } from '../../../src/main/platform/store/database-manager'
import { migrations as managerMigrations } from '../../../src/main/apps/manager/migrations'
import { migrations as runtimeMigrations } from '../../../src/main/apps/runtime/migrations'
import { migrations as teamMigrations } from '../../../src/main/apps/team/migrations'
import { ActivityStore } from '../../../src/main/apps/runtime/store'
import { TeamStore } from '../../../src/main/apps/team/store'

const { directory, count } = JSON.parse(process.argv[2]) as { directory: string; count: number }
const manager = createDatabaseManager(join(directory, '.halo', 'halo.db'))
const db = manager.getAppDatabase()
manager.runMigrations(db, 'app_manager', managerMigrations)
manager.runMigrations(db, 'app_runtime', runtimeMigrations)
manager.runMigrations(db, 'app_team', teamMigrations)
const activity = new ActivityStore(db)
const teams = new TeamStore(db)
const now = Date.now() - 60000
const insert = db.prepare(`INSERT INTO installed_apps
  (id, spec_id, space_id, spec_json, status, user_config_json, user_overrides_json, permissions_json, installed_at)
  VALUES (?, ?, 'halo-temp', ?, 'paused', '{}', '{}', '{"granted":[],"denied":[]}', ?)`)
for (let index = 0; index <= count; index++) {
  const id = index === count ? 'system-coordinator' : `person-${String(index).padStart(3, '0')}`
  const name = index === count ? 'System coordinator' : `Analyst ${String(index).padStart(3, '0')}`
  insert.run(id, id, JSON.stringify({
    spec_version: '1', name, version: '1.0', author: 'e2e', type: 'automation',
    description: index === 0 ? 'Evidence review specialist' : 'Reviews market research and source documents',
    system_prompt: 'Use report_to_user to report a concise result.', subscriptions: [], requires: {}, config_schema: [], permissions: [],
  }), now + index)
  mkdirSync(join(directory, '.halo', 'temp', '.halo', 'apps', id, 'sessions'), { recursive: true })
}
teams.insertTeam({
  id: 'review-team', name: 'Evidence team', goal: 'Review evidence', owningSpaceId: 'halo-temp',
  leadAppId: 'system-coordinator', memberSourcing: 'manual', collabMode: 'structured',
  escalationRouting: 'user', status: 'idle', currentEpochId: null, createdAt: now, updatedAt: now, hostNodeId: null,
})
for (const appId of ['person-000', 'system-coordinator']) {
  teams.addMember({ teamId: 'review-team', appId, memberName: appId, role: 'Researcher', isLead: appId === 'system-coordinator', aiProvisioned: appId === 'system-coordinator', isSystemCoordinator: appId === 'system-coordinator', addedAt: now })
}
teams.insertEpoch({ id: 'review-task', teamId: 'review-team', title: 'Review launch evidence', startedAt: now, endedAt: null, endReason: null, summary: null, lifecycle: 'conversation', chatKey: null, outcome: null, triggerType: 'manual' })
// A second team blocked on the user, so the task panel's team entry is real
// persisted state rather than a stub. Its lead is deliberately unset: a lead
// app is hidden from the people directory, and this fixture's directory
// assertions count people.
teams.insertTeam({
  id: 'decision-team', name: 'Decision team', goal: 'Settle the launch decision', owningSpaceId: 'halo-temp',
  leadAppId: null, memberSourcing: 'manual', collabMode: 'structured',
  escalationRouting: 'user', status: 'waiting_user', currentEpochId: null, createdAt: now, updatedAt: now, hostNodeId: null,
})
teams.addMember({ teamId: 'decision-team', appId: 'person-000', memberName: 'person-000', role: 'Researcher', isLead: false, aiProvisioned: false, isSystemCoordinator: false, addedAt: now })
for (let index = 0; index < 34; index++) {
  const appId = index === 33 ? 'system-coordinator' : 'person-000'
  const runId = `review-run-${index}`
  activity.insertRun({ runId, appId, sessionKey: runId, status: 'waiting_user', triggerType: 'manual', startedAt: now + index })
  activity.insertEntry({ id: `decision-${index}`, appId, runId, type: 'escalation', ts: now + index, content: {
    summary: `Review evidence request ${index + 1}`,
    ...(index === 33 ? { teamContext: { teamId: 'review-team', epochId: 'review-task' } } : {}),
    source: index === 33
      ? { kind: 'team', appId, teamId: 'review-team', epochId: 'review-task', memberId: appId, teamName: 'Evidence team', label: 'Review launch evidence' }
      : { kind: 'automation', appId, runId },
  } })
}
manager.closeAll()
