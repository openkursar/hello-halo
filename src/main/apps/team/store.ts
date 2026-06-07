/**
 * apps/team -- SQLite Store
 *
 * Low-level CRUD for the six Digital Team tables: teams, team_members,
 * team_edges, blackboard_tasks, blackboard_findings, team_epochs.
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
  TeamRow,
  TeamMemberRow,
  TeamEdgeRow,
  BlackboardTaskRow,
  BlackboardFindingRow,
  TeamEpochRow,
  TeamTriggerRow,
  TeamFieldUpdate,
  TaskPatch,
  TeamStore as ITeamStore,
} from './types'
import type { TeamTrigger, TeamRunTriggerType } from '../../../shared/apps/team-types'

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
  private readonly stmtRemoveMember: Database.Statement
  private readonly stmtListMembersByTeam: Database.Statement
  private readonly stmtGetMemberByName: Database.Statement
  private readonly stmtListMembersByAppId: Database.Statement
  private readonly stmtSetMemberLead: Database.Statement
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
  // team_epochs
  private readonly stmtInsertEpoch: Database.Statement
  private readonly stmtGetEpochById: Database.Statement
  private readonly stmtEndEpoch: Database.Statement
  private readonly stmtReopenEpoch: Database.Statement
  private readonly stmtListEpochsByTeam: Database.Statement
  private readonly stmtGetCurrentEpochForTeam: Database.Statement
  private readonly stmtGetOpenConversationEpoch: Database.Statement
  // team_triggers
  private readonly stmtInsertTrigger: Database.Statement
  private readonly stmtDeleteTrigger: Database.Statement
  private readonly stmtDeleteTriggersByTeam: Database.Statement
  private readonly stmtGetTriggerById: Database.Statement
  private readonly stmtListTriggersByTeam: Database.Statement
  private readonly stmtListAllEnabledTriggers: Database.Statement

  constructor(private readonly db: Database.Database) {
    // ── teams ─────────────────────────────────────
    this.stmtInsertTeam = db.prepare(`
      INSERT INTO teams (
        id, name, owning_space_id, goal, lead_app_id,
        member_sourcing, collab_mode, escalation_routing,
        status, current_epoch_id, created_at, updated_at
      ) VALUES (
        @id, @name, @owning_space_id, @goal, @lead_app_id,
        @member_sourcing, @collab_mode, @escalation_routing,
        @status, @current_epoch_id, @created_at, @updated_at
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
        team_id, app_id, member_name, role, is_lead, ai_provisioned, added_at
      ) VALUES (
        @team_id, @app_id, @member_name, @role, @is_lead, @ai_provisioned, @added_at
      )
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
    this.stmtListMembersByAppId = db.prepare(`
      SELECT * FROM team_members WHERE app_id = ? ORDER BY added_at ASC
    `)
    this.stmtSetMemberLead = db.prepare(`
      UPDATE team_members SET is_lead = @is_lead WHERE team_id = @team_id AND app_id = @app_id
    `)

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

    // ── team_epochs ───────────────────────────────
    this.stmtInsertEpoch = db.prepare(`
      INSERT INTO team_epochs (
        id, team_id, started_at, ended_at, end_reason, summary, trigger_type, lifecycle, chat_key
      ) VALUES (
        @id, @team_id, @started_at, @ended_at, @end_reason, @summary, @trigger_type, @lifecycle, @chat_key
      )
    `)
    this.stmtGetEpochById = db.prepare(`SELECT * FROM team_epochs WHERE id = ?`)
    this.stmtEndEpoch = db.prepare(`
      UPDATE team_epochs
      SET ended_at = @ended_at, end_reason = @end_reason, summary = @summary
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
    this.stmtGetOpenConversationEpoch = db.prepare(`
      SELECT * FROM team_epochs
      WHERE team_id = ? AND chat_key = ? AND ended_at IS NULL AND lifecycle = 'conversation'
      ORDER BY started_at DESC
      LIMIT 1
    `)

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
    })
  }

  removeMember(teamId: string, appId: string): boolean {
    return this.stmtRemoveMember.run(teamId, appId).changes > 0
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

  /** Cross-team lookup: every membership for an app (one app may join many teams). */
  listMembersByAppId(appId: string): TeamMember[] {
    return (this.stmtListMembersByAppId.all(appId) as TeamMemberRow[]).map(rowToMember)
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

  listTasksByEpoch(teamId: string, epochId: string): BlackboardTask[] {
    return (this.stmtListTasksByEpoch.all(teamId, epochId) as BlackboardTaskRow[]).map(rowToTask)
  }

  listTasksByTeam(teamId: string): BlackboardTask[] {
    return (this.stmtListTasksByTeam.all(teamId) as BlackboardTaskRow[]).map(rowToTask)
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

  listFindingsByEpoch(teamId: string, epochId: string): BlackboardFinding[] {
    return (this.stmtListFindingsByEpoch.all(teamId, epochId) as BlackboardFindingRow[]).map(rowToFinding)
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
    })
  }

  getEpochById(epochId: string): TeamEpoch | null {
    const row = this.stmtGetEpochById.get(epochId) as TeamEpochRow | undefined
    return row ? rowToEpoch(row) : null
  }

  /** Seal an epoch: stamp its end time, reason, and archival summary. */
  endEpoch(epochId: string, endedAt: number, endReason: EpochEndReason, summary: string | null): void {
    this.stmtEndEpoch.run({ id: epochId, ended_at: endedAt, end_reason: endReason, summary })
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
