/**
 * apps/team -- SQLite Store
 *
 * Low-level CRUD for the Digital Team tables: teams, team_members, team_edges,
 * blackboard_tasks, blackboard_findings, team_activity, team_epochs,
 * team_checks, team_triggers.
 *
 * All methods are synchronous (better-sqlite3). The store handles the mapping
 * between flat SQLite rows and the frozen domain types and enforces no business
 * rules — that is the future service layer's responsibility.
 *
 * Concurrency: every write targets a single primary key (teams/tasks/epochs by
 * id, members/edges by composite key) and findings are append-only, so no
 * in-process locking is needed.
 */

import type Database from 'better-sqlite3'
import type {
  Team,
  TeamMember,
  TeamEdge,
  BlackboardTask,
  BlackboardFinding,
  TeamEpoch,
  TeamStatus,
  TaskStatus,
  EpochEndReason,
  EpochOutcome,
  TeamRow,
  TeamMemberRow,
  TeamEdgeRow,
  BlackboardTaskRow,
  BlackboardFindingRow,
  TeamActivityRow,
  TeamEpochRow,
  TeamTriggerRow,
  TeamCheckRow,
  TeamFieldUpdate,
  MemberFieldUpdate,
  TaskPatch,
  TeamStore as ITeamStore,
} from './types'
import type { TeamActivity, TeamCheck, TeamDelegatedPolicy } from '../../../shared/apps/team-types'
import type {
  TeamTrigger,
  TeamRunTriggerType,
  JoinedOfficeSnapshot,
  TeamMemberRuntimeStatus,
  RosterBusyEntry,
} from '../../../shared/apps/team-types'
import { SELF_NODE_ID } from '../../../shared/apps/team-types'

// ── Row <-> Domain Mapping ──

function rowToTeam(row: TeamRow): Team {
  return {
    id: row.id,
    name: row.name,
    owningSpaceId: row.owning_space_id,
    goal: row.goal,
    leadAppId: row.lead_app_id,
    memberSourcing: row.member_sourcing as Team['memberSourcing'],
    collabMode: row.collab_mode as Team['collabMode'],
    escalationRouting: row.escalation_routing as Team['escalationRouting'],
    status: row.status as TeamStatus,
    currentEpochId: row.current_epoch_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    hostNodeId: row.host_node_id ?? null,
  }
}

function rowToMember(row: TeamMemberRow): TeamMember {
  return {
    teamId: row.team_id,
    appId: row.app_id,
    memberName: row.member_name,
    role: row.role,
    isLead: row.is_lead === 1,
    aiProvisioned: row.ai_provisioned === 1,
    addedAt: row.added_at,
    ownerNodeId: row.owner_node_id,
    origin: row.origin as 'local' | 'remote',
    memberIdentity: row.member_identity,
    scopeJson: row.scope_json ?? null,
    ownerDisplayName: row.owner_display_name ?? null,
    duty: row.duty ?? null,
    delegatedPolicy: parsePolicy(row.delegated_policy_json),
    acceptsChecks: row.accepts_checks !== 0,
  }
}

/** A policy that fails to parse is treated as unset — never as a lockout. */
function parsePolicy(json: string | null): TeamDelegatedPolicy | null {
  if (!json) return null
  try {
    return JSON.parse(json) as TeamDelegatedPolicy
  } catch {
    return null
  }
}

function rowToCheck(row: TeamCheckRow): TeamCheck {
  return {
    id: row.id,
    teamId: row.team_id,
    epochId: row.epoch_id,
    targetAppId: row.target_app_id,
    createdByAppId: row.created_by_app_id,
    instruction: row.instruction,
    schedule: JSON.parse(row.schedule_json) as TeamCheck['schedule'],
    runCount: row.run_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunAt: row.last_run_at,
  }
}

function rowToEdge(row: TeamEdgeRow): TeamEdge {
  return {
    teamId: row.team_id,
    fromAppId: row.from_app_id,
    toAppId: row.to_app_id,
    sync: row.sync === 1,
  }
}

function rowToTask(row: BlackboardTaskRow): BlackboardTask {
  return {
    id: row.id,
    teamId: row.team_id,
    epochId: row.epoch_id,
    title: row.title,
    assigneeAppId: row.assignee_app_id,
    status: row.status as TaskStatus,
    resultRef: row.result_ref,
    note: row.note,
    parentId: row.parent_id,
    createdByAppId: row.created_by_app_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToFinding(row: BlackboardFindingRow): BlackboardFinding {
  return {
    id: row.id,
    teamId: row.team_id,
    epochId: row.epoch_id,
    authorAppId: row.author_app_id,
    body: row.body,
    ref: row.ref,
    createdAt: row.created_at,
  }
}

function rowToActivity(row: TeamActivityRow): TeamActivity {
  return {
    id: row.id,
    teamId: row.team_id,
    epochId: row.epoch_id,
    kind: row.kind as TeamActivity['kind'],
    actorAppId: row.actor_app_id,
    targetAppId: row.target_app_id,
    subject: row.subject,
    body: row.body,
    refId: row.ref_id,
    correlationId: row.correlation_id,
    status: (row.status as TeamActivity['status']) ?? null,
    createdAt: row.created_at,
  }
}

function rowToEpoch(row: TeamEpochRow): TeamEpoch {
  return {
    id: row.id,
    teamId: row.team_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    endReason: (row.end_reason as EpochEndReason | null) ?? null,
    summary: row.summary,
    lifecycle: (row.lifecycle as TeamEpoch['lifecycle'] | undefined) ?? 'run',
    chatKey: row.chat_key ?? null,
    title: row.title ?? null,
    outcome: (row.outcome as TeamEpoch['outcome'] | undefined) ?? null,
    triggerType: (row.trigger_type as TeamEpoch['triggerType'] | undefined) ?? 'manual',
    lastActivityAt: row.last_activity_at ?? row.started_at,
  }
}

function rowToTrigger(row: TeamTriggerRow): TeamTrigger {
  let config: TeamTrigger['config']
  try {
    config = JSON.parse(row.config_json) as TeamTrigger['config']
  } catch {
    config = {}
  }
  return {
    id: row.id,
    teamId: row.team_id,
    sourceType: row.source_type as TeamTrigger['sourceType'],
    config,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  }
}

// ── TeamStore ──

/**
 * Prepared-statement-based store for the Digital Team tables.
 *
 * Statements are prepared once at construction. The store keeps no in-memory
 * data beyond the prepared statements.
 */
export class TeamStore implements ITeamStore {
  // teams
  private readonly stmtInsertTeam: Database.Statement
  private readonly stmtGetTeamById: Database.Statement
  private readonly stmtListTeams: Database.Statement
  private readonly stmtListTeamsBySpace: Database.Statement
  private readonly stmtUpdateTeamStatus: Database.Statement
  private readonly stmtUpdateTeamLeadAppId: Database.Statement
  private readonly stmtUpdateTeamCurrentEpoch: Database.Statement
  private readonly stmtDeleteTeam: Database.Statement
  // team_members
  private readonly stmtAddMember: Database.Statement
  private readonly stmtSetMemberScope: Database.Statement
  private readonly stmtRemoveMember: Database.Statement
  private readonly stmtListMembersByTeam: Database.Statement
  private readonly stmtGetMemberByName: Database.Statement
  private readonly stmtGetMember: Database.Statement
  private readonly stmtListMembersByAppId: Database.Statement
  private readonly stmtSetMemberLead: Database.Statement
  // team_checks
  private readonly stmtUpsertCheck: Database.Statement
  private readonly stmtGetCheckById: Database.Statement
  private readonly stmtDeleteCheck: Database.Statement
  private readonly stmtListChecksByEpoch: Database.Statement
  private readonly stmtListChecksByTeam: Database.Statement
  private readonly stmtListAllChecks: Database.Statement
  // team_edges
  private readonly stmtDeleteEdgesForTeam: Database.Statement
  private readonly stmtInsertEdge: Database.Statement
  private readonly stmtListEdgesByTeam: Database.Statement
  private readonly stmtGetEdge: Database.Statement
  // blackboard_tasks
  private readonly stmtInsertTask: Database.Statement
  private readonly stmtGetTaskById: Database.Statement
  private readonly stmtListTasksByEpoch: Database.Statement
  private readonly stmtListTasksByTeam: Database.Statement
  // blackboard_findings
  private readonly stmtInsertFinding: Database.Statement
  private readonly stmtListFindingsByEpoch: Database.Statement
  // team_activity
  private readonly stmtInsertActivity: Database.Statement
  private readonly stmtDeleteActivity: Database.Statement
  private readonly stmtListActivityByEpoch: Database.Statement
  private readonly stmtListActivityByTeam: Database.Statement
  // team_epochs
  private readonly stmtInsertEpoch: Database.Statement
  private readonly stmtGetEpochById: Database.Statement
  private readonly stmtEndEpoch: Database.Statement
  private readonly stmtTouchEpoch: Database.Statement
  private readonly stmtReopenEpoch: Database.Statement
  private readonly stmtListEpochsByTeam: Database.Statement
  private readonly stmtGetCurrentEpochForTeam: Database.Statement
  private readonly stmtGetOpenConversationEpoch: Database.Statement
  private readonly stmtListOpenConversationEpochs: Database.Statement
  private readonly stmtListOpenEpochs: Database.Statement
  private readonly stmtRenameEpoch: Database.Statement
  // team_triggers
  private readonly stmtInsertTrigger: Database.Statement
  private readonly stmtDeleteTrigger: Database.Statement
  private readonly stmtDeleteTriggersByTeam: Database.Statement
  private readonly stmtGetTriggerById: Database.Statement
  private readonly stmtListTriggersByTeam: Database.Statement
  private readonly stmtListAllEnabledTriggers: Database.Statement

  /**
   * Transient per-office runtime status projection from the last materialized
   * roster snapshot of a joined office: officeId → (appId → {status, taskTitle}).
   * Run-state is a live projection, not a persisted column, so it lives in memory
   * and the joiner's status board overlays it. Replaced wholesale per snapshot.
   */
  private readonly joinedMemberRuntime = new Map<
    string,
    Map<string, { status: TeamMemberRuntimeStatus; taskTitle?: string; busy?: RosterBusyEntry[] }>
  >()

  constructor(private readonly db: Database.Database) {
    // ── teams ─────────────────────────────────────
    this.stmtInsertTeam = db.prepare(`
      INSERT INTO teams (
        id, name, owning_space_id, goal, lead_app_id,
        member_sourcing, collab_mode, escalation_routing,
        status, current_epoch_id, created_at, updated_at, host_node_id
      ) VALUES (
        @id, @name, @owning_space_id, @goal, @lead_app_id,
        @member_sourcing, @collab_mode, @escalation_routing,
        @status, @current_epoch_id, @created_at, @updated_at, @host_node_id
      )
    `)
    this.stmtGetTeamById = db.prepare(`SELECT * FROM teams WHERE id = ?`)
    this.stmtListTeams = db.prepare(`SELECT * FROM teams ORDER BY updated_at DESC`)
    this.stmtListTeamsBySpace = db.prepare(`
      SELECT * FROM teams WHERE owning_space_id = ? ORDER BY updated_at DESC
    `)
    this.stmtUpdateTeamStatus = db.prepare(`
      UPDATE teams SET status = @status, updated_at = @updated_at WHERE id = @id
    `)
    this.stmtUpdateTeamLeadAppId = db.prepare(`
      UPDATE teams SET lead_app_id = @lead_app_id, updated_at = @updated_at WHERE id = @id
    `)
    this.stmtUpdateTeamCurrentEpoch = db.prepare(`
      UPDATE teams SET current_epoch_id = @current_epoch_id, updated_at = @updated_at WHERE id = @id
    `)
    this.stmtDeleteTeam = db.prepare(`DELETE FROM teams WHERE id = ?`)

    // ── team_members ──────────────────────────────
    this.stmtAddMember = db.prepare(`
      INSERT INTO team_members (
        team_id, app_id, member_name, role, is_lead, ai_provisioned, added_at, owner_display_name,
        owner_node_id, origin, member_identity, scope_json, duty, delegated_policy_json, accepts_checks
      ) VALUES (
        @team_id, @app_id, @member_name, @role, @is_lead, @ai_provisioned, @added_at, @owner_display_name,
        @owner_node_id, @origin, @member_identity, @scope_json, @duty, @delegated_policy_json, @accepts_checks
      )
    `)
    this.stmtSetMemberScope = db.prepare(`
      UPDATE team_members SET scope_json = @scope_json WHERE team_id = @team_id AND app_id = @app_id
    `)
    this.stmtRemoveMember = db.prepare(`
      DELETE FROM team_members WHERE team_id = ? AND app_id = ?
    `)
    this.stmtListMembersByTeam = db.prepare(`
      SELECT * FROM team_members WHERE team_id = ? ORDER BY added_at ASC
    `)
    this.stmtGetMemberByName = db.prepare(`
      SELECT * FROM team_members WHERE team_id = ? AND member_name = ?
    `)
    this.stmtGetMember = db.prepare(`
      SELECT * FROM team_members WHERE team_id = ? AND app_id = ?
    `)
    this.stmtListMembersByAppId = db.prepare(`
      SELECT * FROM team_members WHERE app_id = ? ORDER BY added_at ASC
    `)
    this.stmtSetMemberLead = db.prepare(`
      UPDATE team_members SET is_lead = @is_lead WHERE team_id = @team_id AND app_id = @app_id
    `)

    // ── team_checks ───────────────────────────────
    this.stmtUpsertCheck = db.prepare(`
      INSERT INTO team_checks (
        id, team_id, epoch_id, target_app_id, created_by_app_id,
        instruction, schedule_json, run_count, created_at, updated_at, last_run_at
      ) VALUES (
        @id, @team_id, @epoch_id, @target_app_id, @created_by_app_id,
        @instruction, @schedule_json, @run_count, @created_at, @updated_at, @last_run_at
      )
      ON CONFLICT(id) DO UPDATE SET
        epoch_id = excluded.epoch_id,
        target_app_id = excluded.target_app_id,
        created_by_app_id = excluded.created_by_app_id,
        instruction = excluded.instruction,
        schedule_json = excluded.schedule_json,
        run_count = excluded.run_count,
        updated_at = excluded.updated_at,
        last_run_at = excluded.last_run_at
    `)
    this.stmtGetCheckById = db.prepare(`SELECT * FROM team_checks WHERE id = ?`)
    this.stmtDeleteCheck = db.prepare(`DELETE FROM team_checks WHERE id = ?`)
    this.stmtListChecksByEpoch = db.prepare(`
      SELECT * FROM team_checks WHERE team_id = ? AND epoch_id = ? ORDER BY created_at ASC
    `)
    this.stmtListChecksByTeam = db.prepare(`
      SELECT * FROM team_checks WHERE team_id = ? ORDER BY created_at ASC
    `)
    this.stmtListAllChecks = db.prepare(`SELECT * FROM team_checks ORDER BY created_at ASC`)

    // ── team_edges ────────────────────────────────
    this.stmtDeleteEdgesForTeam = db.prepare(`DELETE FROM team_edges WHERE team_id = ?`)
    this.stmtInsertEdge = db.prepare(`
      INSERT INTO team_edges (team_id, from_app_id, to_app_id, sync)
      VALUES (@team_id, @from_app_id, @to_app_id, @sync)
    `)
    this.stmtListEdgesByTeam = db.prepare(`SELECT * FROM team_edges WHERE team_id = ?`)
    this.stmtGetEdge = db.prepare(`
      SELECT * FROM team_edges WHERE team_id = ? AND from_app_id = ? AND to_app_id = ?
    `)

    // ── blackboard_tasks ──────────────────────────
    this.stmtInsertTask = db.prepare(`
      INSERT INTO blackboard_tasks (
        id, team_id, epoch_id, title, assignee_app_id, status,
        result_ref, note, parent_id, created_by_app_id, created_at, updated_at
      ) VALUES (
        @id, @team_id, @epoch_id, @title, @assignee_app_id, @status,
        @result_ref, @note, @parent_id, @created_by_app_id, @created_at, @updated_at
      )
    `)
    this.stmtGetTaskById = db.prepare(`SELECT * FROM blackboard_tasks WHERE id = ?`)
    this.stmtListTasksByEpoch = db.prepare(`
      SELECT * FROM blackboard_tasks
      WHERE team_id = ? AND epoch_id = ?
      ORDER BY created_at ASC
    `)
    this.stmtListTasksByTeam = db.prepare(`
      SELECT * FROM blackboard_tasks WHERE team_id = ? ORDER BY created_at ASC
    `)

    // ── blackboard_findings ───────────────────────
    this.stmtInsertFinding = db.prepare(`
      INSERT INTO blackboard_findings (
        id, team_id, epoch_id, author_app_id, body, ref, created_at
      ) VALUES (
        @id, @team_id, @epoch_id, @author_app_id, @body, @ref, @created_at
      )
    `)
    this.stmtListFindingsByEpoch = db.prepare(`
      SELECT * FROM blackboard_findings
      WHERE team_id = ? AND epoch_id = ?
      ORDER BY created_at ASC, rowid ASC
    `)

    // ── team_activity ─────────────────────────────
    // OR IGNORE, not a plain insert: the same immutable row can arrive twice
    // (an author's optimistic copy echoed back by replication, or a catch-up
    // redelivery). A primary-key throw there would abort a replica apply and
    // strand the log, so a duplicate id is the no-op it logically is.
    this.stmtInsertActivity = db.prepare(`
      INSERT OR IGNORE INTO team_activity (
        id, team_id, epoch_id, kind, actor_app_id, target_app_id,
        subject, body, ref_id, correlation_id, status, created_at
      ) VALUES (
        @id, @team_id, @epoch_id, @kind, @actor_app_id, @target_app_id,
        @subject, @body, @ref_id, @correlation_id, @status, @created_at
      )
    `)
    this.stmtDeleteActivity = db.prepare(`DELETE FROM team_activity WHERE id = ?`)
    this.stmtListActivityByEpoch = db.prepare(`
      SELECT * FROM team_activity
      WHERE team_id = ? AND epoch_id = ?
      ORDER BY created_at ASC, rowid ASC
    `)
    this.stmtListActivityByTeam = db.prepare(`
      SELECT * FROM team_activity WHERE team_id = ? ORDER BY created_at ASC, rowid ASC
    `)
    // ── team_epochs ───────────────────────────────
    this.stmtInsertEpoch = db.prepare(`
      INSERT INTO team_epochs (
        id, team_id, started_at, ended_at, end_reason, summary, trigger_type, lifecycle, chat_key, title, outcome,
        last_activity_at
      ) VALUES (
        @id, @team_id, @started_at, @ended_at, @end_reason, @summary, @trigger_type, @lifecycle, @chat_key, @title, @outcome,
        @last_activity_at
      )
    `)
    this.stmtGetEpochById = db.prepare(`SELECT * FROM team_epochs WHERE id = ?`)
    this.stmtEndEpoch = db.prepare(`
      UPDATE team_epochs
      SET ended_at = @ended_at, end_reason = @end_reason, summary = @summary,
          outcome = COALESCE(@outcome, outcome),
          last_activity_at = MAX(COALESCE(last_activity_at, 0), @ended_at)
      WHERE id = @id
    `)
    // Monotonic: activity only moves forward, so a late-arriving stamp (a
    // replicated row, an out-of-order turn) can never pull the epoch backwards.
    this.stmtTouchEpoch = db.prepare(`
      UPDATE team_epochs
      SET last_activity_at = MAX(COALESCE(last_activity_at, 0), @at)
      WHERE id = @id
    `)
    // Reversible seal: reopen a hibernated epoch (keep summary as last snapshot).
    this.stmtReopenEpoch = db.prepare(`
      UPDATE team_epochs
      SET ended_at = NULL, end_reason = NULL
      WHERE id = ?
    `)
    this.stmtListEpochsByTeam = db.prepare(`
      SELECT * FROM team_epochs WHERE team_id = ? ORDER BY started_at DESC
    `)
    // The single active RUN epoch (the one tracked by team.currentEpochId).
    // Conversation epochs are per-chat, may be many open at once, and are looked
    // up separately via getOpenConversationEpoch — so they must not shadow this.
    this.stmtGetCurrentEpochForTeam = db.prepare(`
      SELECT * FROM team_epochs
      WHERE team_id = ? AND ended_at IS NULL AND lifecycle = 'run'
      ORDER BY started_at DESC
      LIMIT 1
    `)
    // Deterministic tie-break by id: concurrent creation on two nodes can leave
    // two open epochs for one chatKey; every node must pick the SAME canonical
    // one ("later write wins", no conflict dialog).
    this.stmtGetOpenConversationEpoch = db.prepare(`
      SELECT * FROM team_epochs
      WHERE team_id = ? AND chat_key = ? AND ended_at IS NULL AND lifecycle = 'conversation'
      ORDER BY started_at DESC, id DESC
      LIMIT 1
    `)
    this.stmtListOpenConversationEpochs = db.prepare(`
      SELECT * FROM team_epochs
      WHERE team_id = ? AND ended_at IS NULL AND lifecycle = 'conversation'
      ORDER BY started_at DESC, id DESC
    `)
    this.stmtListOpenEpochs = db.prepare(`
      SELECT * FROM team_epochs
      WHERE team_id = ? AND ended_at IS NULL
      ORDER BY started_at DESC, id DESC
    `)
    this.stmtRenameEpoch = db.prepare(`UPDATE team_epochs SET title = @title WHERE id = @id`)

    // ── team_triggers ─────────────────────────────
    this.stmtInsertTrigger = db.prepare(`
      INSERT INTO team_triggers (id, team_id, source_type, config_json, enabled, created_at)
      VALUES (@id, @team_id, @source_type, @config_json, @enabled, @created_at)
    `)
    this.stmtDeleteTrigger = db.prepare(`DELETE FROM team_triggers WHERE id = ?`)
    this.stmtDeleteTriggersByTeam = db.prepare(`DELETE FROM team_triggers WHERE team_id = ?`)
    this.stmtGetTriggerById = db.prepare(`SELECT * FROM team_triggers WHERE id = ?`)
    this.stmtListTriggersByTeam = db.prepare(`
      SELECT * FROM team_triggers WHERE team_id = ? ORDER BY created_at ASC
    `)
    this.stmtListAllEnabledTriggers = db.prepare(`
      SELECT * FROM team_triggers WHERE enabled = 1 ORDER BY created_at ASC
    `)
  }

  // ── teams ───────────────────────────────────────

  insertTeam(team: Team): void {
    this.stmtInsertTeam.run({
      id: team.id,
      name: team.name,
      owning_space_id: team.owningSpaceId,
      goal: team.goal,
      lead_app_id: team.leadAppId,
      member_sourcing: team.memberSourcing,
      collab_mode: team.collabMode,
      escalation_routing: team.escalationRouting,
      status: team.status,
      current_epoch_id: team.currentEpochId,
      created_at: team.createdAt,
      updated_at: team.updatedAt,
      // Default to a locally-hosted office so existing callers need not change.
      host_node_id: team.hostNodeId ?? null,
    })
  }

  getTeamById(teamId: string): Team | null {
    const row = this.stmtGetTeamById.get(teamId) as TeamRow | undefined
    return row ? rowToTeam(row) : null
  }

  listTeams(): Team[] {
    return (this.stmtListTeams.all() as TeamRow[]).map(rowToTeam)
  }

  listTeamsBySpace(spaceId: string): Team[] {
    return (this.stmtListTeamsBySpace.all(spaceId) as TeamRow[]).map(rowToTeam)
  }

  /**
   * Patch the directly-editable team fields. Builds the SET clause from only
   * the provided keys so omitted fields are preserved. `updated_at` is always
   * bumped. No-op when no fields are supplied.
   */
  updateTeamFields(teamId: string, fields: TeamFieldUpdate): void {
    const sets: string[] = []
    const params: Record<string, unknown> = { id: teamId, updated_at: Date.now() }

    if (fields.name !== undefined) {
      sets.push('name = @name')
      params.name = fields.name
    }
    if (fields.goal !== undefined) {
      sets.push('goal = @goal')
      params.goal = fields.goal
    }
    if (fields.memberSourcing !== undefined) {
      sets.push('member_sourcing = @member_sourcing')
      params.member_sourcing = fields.memberSourcing
    }
    if (fields.collabMode !== undefined) {
      sets.push('collab_mode = @collab_mode')
      params.collab_mode = fields.collabMode
    }
    if (fields.escalationRouting !== undefined) {
      sets.push('escalation_routing = @escalation_routing')
      params.escalation_routing = fields.escalationRouting
    }
    if (sets.length === 0) return

    sets.push('updated_at = @updated_at')
    this.db.prepare(`UPDATE teams SET ${sets.join(', ')} WHERE id = @id`).run(params)
  }

  updateTeamStatus(teamId: string, status: TeamStatus): void {
    this.stmtUpdateTeamStatus.run({ id: teamId, status, updated_at: Date.now() })
  }

  updateTeamLeadAppId(teamId: string, leadAppId: string | null): void {
    this.stmtUpdateTeamLeadAppId.run({ id: teamId, lead_app_id: leadAppId, updated_at: Date.now() })
  }

  updateTeamCurrentEpoch(teamId: string, epochId: string | null): void {
    this.stmtUpdateTeamCurrentEpoch.run({ id: teamId, current_epoch_id: epochId, updated_at: Date.now() })
  }

  deleteTeam(teamId: string): boolean {
    return this.stmtDeleteTeam.run(teamId).changes > 0
  }

  /**
   * Remove a shadow office and all of its mirrored rows (members, edges,
   * triggers) in one transaction. Used when leaving a joined office — the rows
   * are projections of a remote authority, so no orphan-app cleanup applies.
   */
  purgeJoinedOffice(officeId: string): boolean {
    const purge = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM team_members WHERE team_id = ?`).run(officeId)
      this.stmtDeleteEdgesForTeam.run(officeId)
      this.deleteTriggersByTeam(officeId)
      this.db.prepare(`DELETE FROM team_checks WHERE team_id = ?`).run(officeId)
      this.db.prepare(`DELETE FROM team_activity WHERE team_id = ?`).run(officeId)
      return this.stmtDeleteTeam.run(officeId).changes > 0
    })
    const removed = purge()
    this.joinedMemberRuntime.delete(officeId)
    return removed
  }

  // ── team_members ────────────────────────────────

  /**
   * @throws If PRIMARY KEY (team_id, app_id) or the unique
   *   (team_id, member_name) index is violated.
   */
  addMember(member: TeamMember): void {
    this.stmtAddMember.run({
      team_id: member.teamId,
      app_id: member.appId,
      member_name: member.memberName,
      role: member.role,
      is_lead: member.isLead ? 1 : 0,
      ai_provisioned: member.aiProvisioned ? 1 : 0,
      added_at: member.addedAt,
      // Default to a locally-owned member so existing callers need not change.
      owner_node_id: member.ownerNodeId ?? SELF_NODE_ID,
      origin: member.origin ?? 'local',
      member_identity: member.memberIdentity ?? null,
      scope_json: member.scopeJson ?? null,
      owner_display_name: member.ownerDisplayName ?? null,
      duty: member.duty ?? null,
      delegated_policy_json: member.delegatedPolicy ? JSON.stringify(member.delegatedPolicy) : null,
      accepts_checks: member.acceptsChecks === false ? 0 : 1,
    })
  }

  removeMember(teamId: string, appId: string): boolean {
    return this.stmtRemoveMember.run(teamId, appId).changes > 0
  }

  setMemberScope(teamId: string, appId: string, scopeJson: string | null): void {
    this.stmtSetMemberScope.run({ team_id: teamId, app_id: appId, scope_json: scopeJson })
  }

  updateMemberFields(teamId: string, appId: string, fields: MemberFieldUpdate): void {
    const sets: string[] = []
    const params: Record<string, unknown> = { team_id: teamId, app_id: appId }
    if (fields.duty !== undefined) {
      sets.push('duty = @duty')
      params.duty = fields.duty
    }
    if (fields.delegatedPolicyJson !== undefined) {
      sets.push('delegated_policy_json = @delegated_policy_json')
      params.delegated_policy_json = fields.delegatedPolicyJson
    }
    if (fields.acceptsChecks !== undefined) {
      sets.push('accepts_checks = @accepts_checks')
      params.accepts_checks = fields.acceptsChecks ? 1 : 0
    }
    if (sets.length === 0) return
    this.db
      .prepare(`UPDATE team_members SET ${sets.join(', ')} WHERE team_id = @team_id AND app_id = @app_id`)
      .run(params)
  }

  /** Flip a member's lead flag (used when an existing member is named lead). */
  setMemberLead(teamId: string, appId: string, isLead: boolean): void {
    this.stmtSetMemberLead.run({ team_id: teamId, app_id: appId, is_lead: isLead ? 1 : 0 })
  }

  listMembersByTeam(teamId: string): TeamMember[] {
    return (this.stmtListMembersByTeam.all(teamId) as TeamMemberRow[]).map(rowToMember)
  }

  getMemberByName(teamId: string, memberName: string): TeamMember | null {
    const row = this.stmtGetMemberByName.get(teamId, memberName) as TeamMemberRow | undefined
    return row ? rowToMember(row) : null
  }

  getMember(teamId: string, appId: string): TeamMember | null {
    const row = this.stmtGetMember.get(teamId, appId) as TeamMemberRow | undefined
    return row ? rowToMember(row) : null
  }

  /** Cross-team lookup: every membership for an app (one app may join many teams). */
  listMembersByAppId(appId: string): TeamMember[] {
    return (this.stmtListMembersByAppId.all(appId) as TeamMemberRow[]).map(rowToMember)
  }

  /**
   * Mirror a host-driven roster into the local store as a joined ("shadow")
   * office. Idempotent: the team row is upserted in place and the member set is
   * replaced wholesale (the office is a host projection, so a whole-roster
   * replace matches the single-writer model and sidesteps every unique-index
   * collision on re-apply).
   *
   * SELF-relativity: wire owner node ids are ABSOLUTE; here each member's owner
   * is remapped to local-relative — a member owned by THIS node (ownerNodeId ===
   * selfNodeId) is stored as SELF/origin=local so this node's RelayCapture sees
   * it as its own; every other member is stored remote with the absolute owner.
   */
  materializeJoinedOffice(input: {
    hostNodeId: string
    selfNodeId: string
    snapshot: JoinedOfficeSnapshot
  }): void {
    const { hostNodeId, selfNodeId, snapshot } = input
    const officeId = snapshot.team.id
    const now = Date.now()

    // The transient runtime-status overlay for this office, rebuilt from the
    // snapshot and published after the row apply succeeds (so a failed apply does
    // not leave a stale-but-confident overlay).
    const runtime = new Map<
      string,
      { status: TeamMemberRuntimeStatus; taskTitle?: string; busy?: RosterBusyEntry[] }
    >()

    const apply = this.db.transaction(() => {
      const existing = this.stmtGetTeamById.get(officeId) as TeamRow | undefined
      if (existing) {
        this.db
          .prepare(
            `UPDATE teams
               SET name = @name, goal = @goal, lead_app_id = @lead_app_id,
                   collab_mode = @collab_mode, host_node_id = @host_node_id,
                   current_epoch_id = @current_epoch_id, status = @status,
                   updated_at = @updated_at
             WHERE id = @id`
          )
          .run({
            id: officeId,
            name: snapshot.team.name,
            goal: snapshot.team.goal,
            lead_app_id: snapshot.team.leadAppId,
            collab_mode: snapshot.team.collabMode,
            host_node_id: hostNodeId,
            // The host's currently-open run epoch, so the joiner can bind the
            // live run from its store; null when no run is open.
            current_epoch_id: snapshot.team.epochId ?? null,
            // The host's live run status so the joiner's run banner goes "running"
            // at run-start; default idle when the host did not stamp one.
            status: snapshot.team.status ?? 'idle',
            updated_at: now,
          })
      } else {
        // owning_space_id = officeId: a synthetic, non-colliding value that
        // satisfies NOT NULL + unique(owning_space_id, name) without clashing
        // with any real local team (whose space ids are real space uuids).
        this.stmtInsertTeam.run({
          id: officeId,
          name: snapshot.team.name,
          owning_space_id: officeId,
          goal: snapshot.team.goal,
          lead_app_id: snapshot.team.leadAppId,
          member_sourcing: 'manual',
          collab_mode: snapshot.team.collabMode,
          escalation_routing: 'user',
          status: snapshot.team.status ?? 'idle',
          current_epoch_id: snapshot.team.epochId ?? null,
          created_at: now,
          updated_at: now,
          host_node_id: hostNodeId,
        })
      }

      // Shadow the host's open run epoch as a local team_epochs row so the
      // joiner's message bus can route a 1:1 reply: completeTurn treats a missing
      // epoch row as sealed and drops the reply, and noteEpochTurn needs a row
      // to reopen. Without this, chatting a HOST-owned member would silently fail
      // ("sent, no reply"). Idempotent — only inserted when absent; a host-
      // generated epoch id never collides.
      const hostEpochId = snapshot.team.epochId ?? null
      if (hostEpochId) {
        const epochRow = this.stmtGetEpochById.get(hostEpochId) as TeamEpochRow | undefined
        if (!epochRow) {
          this.stmtInsertEpoch.run({
            id: hostEpochId,
            team_id: officeId,
            started_at: now,
            ended_at: null,
            end_reason: null,
            summary: null,
            trigger_type: 'manual',
            lifecycle: 'run',
            chat_key: null,
            title: null,
            outcome: null,
            last_activity_at: now,
          })
        }
      }

      // The authority is the single writer for the roster, so the member set is
      // replaced wholesale. Two fields are exempt for members THIS node owns:
      // their duty and delegated policy are authored here, and a snapshot taken
      // before the owner's latest edit reached the authority must not undo it.
      const ownRows = new Map<string, TeamMemberRow>()
      for (const row of this.stmtListMembersByTeam.all(officeId) as TeamMemberRow[]) {
        if (row.owner_node_id === SELF_NODE_ID) ownRows.set(row.app_id, row)
      }

      this.db.prepare(`DELETE FROM team_members WHERE team_id = ?`).run(officeId)
      for (const m of snapshot.members) {
        const ownedHere = m.ownerNodeId === selfNodeId
        const mine = ownedHere ? ownRows.get(m.appId) : undefined
        if ((m.status && m.status !== 'idle') || (m.busy && m.busy.length > 0)) {
          runtime.set(m.appId, {
            status: m.status ?? 'idle',
            ...(m.currentTaskTitle ? { taskTitle: m.currentTaskTitle } : {}),
            ...(m.busy && m.busy.length > 0 ? { busy: m.busy } : {}),
          })
        }
        this.stmtAddMember.run({
          team_id: officeId,
          app_id: m.appId,
          member_name: m.memberName,
          role: m.role,
          is_lead: m.isLead ? 1 : 0,
          ai_provisioned: 0,
          added_at: now,
          owner_node_id: ownedHere ? SELF_NODE_ID : m.ownerNodeId,
          origin: ownedHere ? 'local' : 'remote',
          member_identity: ownedHere ? null : m.memberIdentity,
          scope_json: null,
          owner_display_name: ownedHere ? null : m.ownerDisplayName ?? null,
          duty: mine ? mine.duty : m.duty ?? null,
          delegated_policy_json: mine ? mine.delegated_policy_json : null,
          accepts_checks: mine ? mine.accepts_checks : m.acceptsChecks === false ? 0 : 1,
        })
      }

      this.stmtDeleteEdgesForTeam.run(officeId)
      for (const edge of snapshot.edges) {
        this.stmtInsertEdge.run({
          team_id: officeId,
          from_app_id: edge.fromAppId,
          to_app_id: edge.toAppId,
          sync: 0,
        })
      }
    })
    apply()
    this.joinedMemberRuntime.set(officeId, runtime)
  }

  getJoinedMemberStatuses(teamId: string): Map<string, TeamMemberRuntimeStatus> {
    const runtime = this.joinedMemberRuntime.get(teamId)
    const out = new Map<string, TeamMemberRuntimeStatus>()
    if (runtime) for (const [appId, v] of runtime) out.set(appId, v.status)
    return out
  }

  getJoinedMemberTaskTitle(teamId: string, appId: string): string | undefined {
    return this.joinedMemberRuntime.get(teamId)?.get(appId)?.taskTitle
  }

  /** Live busy assignments from the last snapshot of a joined office. */
  getJoinedMemberBusy(teamId: string, appId: string): RosterBusyEntry[] {
    return this.joinedMemberRuntime.get(teamId)?.get(appId)?.busy ?? []
  }

  // ── team_edges ──────────────────────────────────

  /**
   * Replace the full adjacency set for a team. Edges are recomputed wholesale
   * when collaboration structure changes, so this clears then re-inserts inside
   * a single transaction to keep the topology consistent.
   */
  replaceEdgesForTeam(teamId: string, edges: TeamEdge[]): void {
    const replace = this.db.transaction((list: TeamEdge[]) => {
      this.stmtDeleteEdgesForTeam.run(teamId)
      for (const edge of list) {
        this.stmtInsertEdge.run({
          team_id: teamId,
          from_app_id: edge.fromAppId,
          to_app_id: edge.toAppId,
          sync: edge.sync ? 1 : 0,
        })
      }
    })
    replace(edges)
  }

  listEdgesByTeam(teamId: string): TeamEdge[] {
    return (this.stmtListEdgesByTeam.all(teamId) as TeamEdgeRow[]).map(rowToEdge)
  }

  /** True when a directed edge from→to exists for the team (structured-mode permission). */
  isEdgeAllowed(teamId: string, fromAppId: string, toAppId: string): boolean {
    return this.stmtGetEdge.get(teamId, fromAppId, toAppId) !== undefined
  }

  // ── blackboard_tasks ────────────────────────────

  insertTask(task: BlackboardTask): void {
    this.stmtInsertTask.run({
      id: task.id,
      team_id: task.teamId,
      epoch_id: task.epochId,
      title: task.title,
      assignee_app_id: task.assigneeAppId,
      status: task.status,
      result_ref: task.resultRef,
      note: task.note,
      parent_id: task.parentId,
      created_by_app_id: task.createdByAppId,
      created_at: task.createdAt,
      updated_at: task.updatedAt,
    })
  }

  getTaskById(taskId: string): BlackboardTask | null {
    const row = this.stmtGetTaskById.get(taskId) as BlackboardTaskRow | undefined
    return row ? rowToTask(row) : null
  }

  /**
   * Patch a single task by id. Only the provided fields are written; `updatedAt`
   * is always set. No-op when the patch carries no fields.
   */
  updateTask(taskId: string, patch: TaskPatch, updatedAt: number): void {
    const sets: string[] = []
    const params: Record<string, unknown> = { id: taskId, updated_at: updatedAt }

    if (patch.status !== undefined) {
      sets.push('status = @status')
      params.status = patch.status
    }
    if (patch.assigneeAppId !== undefined) {
      sets.push('assignee_app_id = @assignee_app_id')
      params.assignee_app_id = patch.assigneeAppId
    }
    if (patch.resultRef !== undefined) {
      sets.push('result_ref = @result_ref')
      params.result_ref = patch.resultRef
    }
    if (patch.note !== undefined) {
      sets.push('note = @note')
      params.note = patch.note
    }
    if (sets.length === 0) return

    sets.push('updated_at = @updated_at')
    this.db.prepare(`UPDATE blackboard_tasks SET ${sets.join(', ')} WHERE id = @id`).run(params)
  }

  deleteTask(taskId: string): void {
    this.db.prepare(`DELETE FROM blackboard_tasks WHERE id = ?`).run(taskId)
  }

  listTasksByEpoch(teamId: string, epochId: string): BlackboardTask[] {
    return (this.stmtListTasksByEpoch.all(teamId, epochId) as BlackboardTaskRow[]).map(rowToTask)
  }

  listTasksByTeam(teamId: string): BlackboardTask[] {
    return (this.stmtListTasksByTeam.all(teamId) as BlackboardTaskRow[]).map(rowToTask)
  }

  /**
   * The epoch id of the most recently written task or finding for a team, or null
   * when the board is empty. Used by a JOINED (shadow) office to bind its activity
   * feed directly to replicated data when the run-epoch pointer (current_epoch_id)
   * has not yet been materialized from a roster snapshot — so the feed populates
   * the instant tasks/findings replicate, independent of roster-refresh timing.
   */
  getLatestBoardEpochId(teamId: string): string | null {
    const row = this.db
      .prepare(
        `SELECT epoch_id, MAX(ts) AS ts FROM (
           SELECT epoch_id, updated_at AS ts FROM blackboard_tasks WHERE team_id = @teamId
           UNION ALL
           SELECT epoch_id, created_at AS ts FROM blackboard_findings WHERE team_id = @teamId
         )`
      )
      .get({ teamId }) as { epoch_id: string | null; ts: number | null } | undefined
    return row?.epoch_id ?? null
  }

  // ── blackboard_findings ─────────────────────────

  /** Append-only: findings are never updated or deleted. */
  insertFinding(finding: BlackboardFinding): void {
    this.stmtInsertFinding.run({
      id: finding.id,
      team_id: finding.teamId,
      epoch_id: finding.epochId,
      author_app_id: finding.authorAppId,
      body: finding.body,
      ref: finding.ref,
      created_at: finding.createdAt,
    })
  }

  deleteFinding(findingId: string): void {
    this.db.prepare(`DELETE FROM blackboard_findings WHERE id = ?`).run(findingId)
  }

  listFindingsByEpoch(teamId: string, epochId: string): BlackboardFinding[] {
    return (this.stmtListFindingsByEpoch.all(teamId, epochId) as BlackboardFindingRow[]).map(rowToFinding)
  }

  // ── team_activity ───────────────────────────────

  /** Append-only and idempotent by id (see the prepared statement's note). */
  insertActivity(activity: TeamActivity): void {
    this.stmtInsertActivity.run({
      id: activity.id,
      team_id: activity.teamId,
      epoch_id: activity.epochId,
      kind: activity.kind,
      actor_app_id: activity.actorAppId,
      target_app_id: activity.targetAppId,
      subject: activity.subject,
      body: activity.body,
      ref_id: activity.refId,
      correlation_id: activity.correlationId,
      status: activity.status,
      created_at: activity.createdAt,
    })
  }

  deleteActivity(activityId: string): void {
    this.stmtDeleteActivity.run(activityId)
  }

  listActivityByEpoch(teamId: string, epochId: string): TeamActivity[] {
    return (this.stmtListActivityByEpoch.all(teamId, epochId) as TeamActivityRow[]).map(rowToActivity)
  }

  listActivityByTeam(teamId: string): TeamActivity[] {
    return (this.stmtListActivityByTeam.all(teamId) as TeamActivityRow[]).map(rowToActivity)
  }

  // ── team_epochs ─────────────────────────────────

  insertEpoch(epoch: TeamEpoch, triggerType: TeamRunTriggerType = 'manual'): void {
    this.stmtInsertEpoch.run({
      id: epoch.id,
      team_id: epoch.teamId,
      started_at: epoch.startedAt,
      ended_at: epoch.endedAt,
      end_reason: epoch.endReason,
      summary: epoch.summary,
      trigger_type: triggerType,
      lifecycle: epoch.lifecycle ?? 'run',
      chat_key: epoch.chatKey ?? null,
      title: epoch.title ?? null,
      outcome: epoch.outcome ?? null,
      last_activity_at: epoch.lastActivityAt ?? epoch.startedAt,
    })
  }

  /** Stamp a turn entering this epoch, so a list of work can sort by recency. */
  touchEpoch(epochId: string, at: number): void {
    this.stmtTouchEpoch.run({ id: epochId, at })
  }

  getEpochById(epochId: string): TeamEpoch | null {
    const row = this.stmtGetEpochById.get(epochId) as TeamEpochRow | undefined
    return row ? rowToEpoch(row) : null
  }

  /** Seal an epoch: stamp its end time, reason, archival summary, and outcome. */
  endEpoch(
    epochId: string,
    endedAt: number,
    endReason: EpochEndReason,
    summary: string | null,
    outcome?: EpochOutcome | null
  ): void {
    this.stmtEndEpoch.run({
      id: epochId,
      ended_at: endedAt,
      end_reason: endReason,
      summary,
      outcome: outcome ?? null,
    })
  }

  /** Rename a conversation epoch (null clears the title back to a derived label). */
  renameEpoch(epochId: string, title: string | null): void {
    this.stmtRenameEpoch.run({ id: epochId, title })
  }

  /**
   * Idempotent whole-row apply of a replicated epoch. Insert when absent;
   * otherwise overwrite the mutable fields so a re-delivered or later write
   * converges (single writer = the office authority; later write wins).
   */
  upsertEpoch(epoch: TeamEpoch, triggerType?: TeamRunTriggerType): void {
    const existing = this.stmtGetEpochById.get(epoch.id) as TeamEpochRow | undefined
    if (!existing) {
      this.insertEpoch(epoch, triggerType ?? epoch.triggerType ?? 'manual')
      return
    }
    this.db
      .prepare(
        `UPDATE team_epochs
           SET ended_at = @ended_at, end_reason = @end_reason, summary = @summary,
               title = @title, outcome = @outcome, chat_key = @chat_key,
               lifecycle = @lifecycle,
               last_activity_at = MAX(COALESCE(last_activity_at, 0), @last_activity_at)
         WHERE id = @id`
      )
      .run({
        id: epoch.id,
        ended_at: epoch.endedAt,
        end_reason: epoch.endReason,
        summary: epoch.summary,
        title: epoch.title ?? null,
        outcome: epoch.outcome ?? null,
        chat_key: epoch.chatKey ?? null,
        lifecycle: epoch.lifecycle ?? 'run',
        // Every other field is "later write wins", but activity is monotonic and
        // both sides stamp it: a node serving its own member's turn must not have
        // that erased by an authority row that predates it.
        last_activity_at: epoch.lastActivityAt ?? epoch.startedAt,
      })
  }

  /** Reopen a sealed epoch (reversible-seal wake): clear ended_at/end_reason, keep summary. */
  reopenEpoch(epochId: string): void {
    this.stmtReopenEpoch.run(epochId)
  }

  listEpochsByTeam(teamId: string): TeamEpoch[] {
    return (this.stmtListEpochsByTeam.all(teamId) as TeamEpochRow[]).map(rowToEpoch)
  }

  /** The team's open (not-yet-sealed) epoch, or null when idle. */
  getCurrentEpochForTeam(teamId: string): TeamEpoch | null {
    const row = this.stmtGetCurrentEpochForTeam.get(teamId) as TeamEpochRow | undefined
    return row ? rowToEpoch(row) : null
  }

  /** The open 'conversation' epoch for a (team, chat), or null. */
  getOpenConversationEpoch(teamId: string, chatKey: string): TeamEpoch | null {
    const row = this.stmtGetOpenConversationEpoch.get(teamId, chatKey) as TeamEpochRow | undefined
    return row ? rowToEpoch(row) : null
  }

  /** All open 'conversation' epochs of a team, newest first. */
  listOpenConversationEpochs(teamId: string): TeamEpoch[] {
    return (this.stmtListOpenConversationEpochs.all(teamId) as TeamEpochRow[]).map(rowToEpoch)
  }

  /** All open epochs (run + conversation) of a team, newest first. */
  listOpenEpochs(teamId: string): TeamEpoch[] {
    return (this.stmtListOpenEpochs.all(teamId) as TeamEpochRow[]).map(rowToEpoch)
  }

  // ── team_checks ─────────────────────────────────

  upsertCheck(check: TeamCheck): void {
    this.stmtUpsertCheck.run({
      id: check.id,
      team_id: check.teamId,
      epoch_id: check.epochId,
      target_app_id: check.targetAppId,
      created_by_app_id: check.createdByAppId,
      instruction: check.instruction,
      schedule_json: JSON.stringify(check.schedule),
      run_count: check.runCount,
      created_at: check.createdAt,
      updated_at: check.updatedAt,
      last_run_at: check.lastRunAt,
    })
  }

  getCheckById(checkId: string): TeamCheck | null {
    const row = this.stmtGetCheckById.get(checkId) as TeamCheckRow | undefined
    return row ? rowToCheck(row) : null
  }

  deleteCheck(checkId: string): boolean {
    return this.stmtDeleteCheck.run(checkId).changes > 0
  }

  listChecksByEpoch(teamId: string, epochId: string): TeamCheck[] {
    return (this.stmtListChecksByEpoch.all(teamId, epochId) as TeamCheckRow[]).map(rowToCheck)
  }

  listChecksByTeam(teamId: string): TeamCheck[] {
    return (this.stmtListChecksByTeam.all(teamId) as TeamCheckRow[]).map(rowToCheck)
  }

  listAllChecks(): TeamCheck[] {
    return (this.stmtListAllChecks.all() as TeamCheckRow[]).map(rowToCheck)
  }

  /** Returns the removed rows so the caller can tear down their alarms. */
  deleteChecksByEpoch(teamId: string, epochId: string): TeamCheck[] {
    const removed = this.listChecksByEpoch(teamId, epochId)
    if (removed.length > 0) {
      this.db.prepare(`DELETE FROM team_checks WHERE team_id = ? AND epoch_id = ?`).run(teamId, epochId)
    }
    return removed
  }

  // ── team_triggers ───────────────────────────────

  insertTrigger(trigger: TeamTrigger): void {
    this.stmtInsertTrigger.run({
      id: trigger.id,
      team_id: trigger.teamId,
      source_type: trigger.sourceType,
      config_json: JSON.stringify(trigger.config ?? {}),
      enabled: trigger.enabled ? 1 : 0,
      created_at: trigger.createdAt,
    })
  }

  updateTrigger(id: string, patch: { config?: TeamTrigger['config']; enabled?: boolean }): void {
    const sets: string[] = []
    const params: Record<string, unknown> = { id }
    if (patch.config !== undefined) {
      sets.push('config_json = @config_json')
      params.config_json = JSON.stringify(patch.config)
    }
    if (patch.enabled !== undefined) {
      sets.push('enabled = @enabled')
      params.enabled = patch.enabled ? 1 : 0
    }
    if (sets.length === 0) return
    this.db.prepare(`UPDATE team_triggers SET ${sets.join(', ')} WHERE id = @id`).run(params)
  }

  deleteTrigger(id: string): boolean {
    return this.stmtDeleteTrigger.run(id).changes > 0
  }

  deleteTriggersByTeam(teamId: string): void {
    this.stmtDeleteTriggersByTeam.run(teamId)
  }

  getTriggerById(id: string): TeamTrigger | null {
    const row = this.stmtGetTriggerById.get(id) as TeamTriggerRow | undefined
    return row ? rowToTrigger(row) : null
  }

  listTriggersByTeam(teamId: string): TeamTrigger[] {
    return (this.stmtListTriggersByTeam.all(teamId) as TeamTriggerRow[]).map(rowToTrigger)
  }

  listAllEnabledTriggers(): TeamTrigger[] {
    return (this.stmtListAllEnabledTriggers.all() as TeamTriggerRow[]).map(rowToTrigger)
  }
}
