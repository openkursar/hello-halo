/**
 * apps/team -- Type Definitions
 *
 * Internal types for the Digital Team data/persistence layer.
 *
 * The persistent domain entities (Team, TeamMember, TeamEdge, BlackboardTask,
 * BlackboardFinding, TeamEpoch) and the creation/update input shapes are owned
 * by the frozen contract in `src/shared/apps/team-types.ts`. This module
 * re-exports those names so consumers of apps/team have a single import surface,
 * and adds the SQLite row interfaces plus the TeamStore interface that are
 * specific to the persistence layer.
 */

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
  TeamTrigger,
  TeamTriggerInput,
  TeamRunTriggerType,
  JoinedOfficeSnapshot,
  TeamMemberRuntimeStatus,
} from '../../../shared/apps/team-types'

// Re-export the frozen domain contract for apps/team consumers.
export type {
  Team,
  TeamMember,
  TeamEdge,
  BlackboardTask,
  BlackboardFinding,
  TeamEpoch,
  TeamStatus,
  TaskStatus,
  EpochEndReason,
  EpochLifecycle,
  MemberSourcing,
  CollabMode,
  EscalationRouting,
  TeamTrigger,
  TeamTriggerInput,
  TeamTriggerSourceType,
  TeamScheduleConfig,
  TeamRunTrigger,
  TeamRunTriggerType,
  JoinedOfficeSnapshot,
  JoinedOfficeMemberSnap,
} from '../../../shared/apps/team-types'

// ── SQLite Row Types (flat DB representation) ──

/** Row shape from the `teams` table. */
export interface TeamRow {
  id: string
  name: string
  owning_space_id: string
  goal: string
  lead_app_id: string | null
  member_sourcing: string
  collab_mode: string
  escalation_routing: string
  status: string
  current_epoch_id: string | null
  created_at: number
  updated_at: number
  /** Office authority; added in migration v6 (null = hosted here). */
  host_node_id: string | null
}

/** Row shape from the `team_members` table. */
export interface TeamMemberRow {
  team_id: string
  app_id: string
  member_name: string
  role: string
  is_lead: number
  ai_provisioned: number
  added_at: number
  /** Owning node; added in migration v5 (default 'SELF' for local members). */
  owner_node_id: string
  /** Member origin; added in migration v5 (default 'local'). */
  origin: string
  /** Portable owner identity; added in migration v5 (null for local-only). */
  member_identity: string | null
  /** Permission-overlay scope JSON; added in migration v7 (null = default-open). */
  scope_json: string | null
  /** Owner's display name for a remote member; added in migration v8 (null = local). */
  owner_display_name: string | null
}

/** Row shape from the `team_edges` table. */
export interface TeamEdgeRow {
  team_id: string
  from_app_id: string
  to_app_id: string
  sync: number
}

/** Row shape from the `blackboard_tasks` table. */
export interface BlackboardTaskRow {
  id: string
  team_id: string
  epoch_id: string
  title: string
  assignee_app_id: string | null
  status: string
  result_ref: string | null
  note: string | null
  parent_id: string | null
  created_by_app_id: string
  created_at: number
  updated_at: number
}

/** Row shape from the `blackboard_findings` table. */
export interface BlackboardFindingRow {
  id: string
  team_id: string
  epoch_id: string
  author_app_id: string
  body: string | null
  ref: string | null
  created_at: number
}

/** Row shape from the `team_epochs` table. */
export interface TeamEpochRow {
  id: string
  team_id: string
  started_at: number
  ended_at: number | null
  end_reason: string | null
  summary: string | null
  /** What initiated the run; added in migration v2 (default 'manual'). */
  trigger_type?: string
  /** Execution mode; added in migration v3 (default 'run'). */
  lifecycle?: string
  /** Chat scope for conversation epochs; added in migration v4 (null for runs). */
  chat_key?: string | null
}

/** Row shape from the `team_triggers` table. */
export interface TeamTriggerRow {
  id: string
  team_id: string
  source_type: string
  config_json: string
  enabled: number
  created_at: number
}

// ── Store-level partial updates ──

/**
 * Mutable persisted team fields. `name` and `goal` are the only directly
 * editable text fields; the strategy enums and lead/epoch pointers have
 * dedicated setters because they carry lifecycle meaning.
 */
export interface TeamFieldUpdate {
  name?: string
  goal?: string
  memberSourcing?: Team['memberSourcing']
  collabMode?: Team['collabMode']
  escalationRouting?: Team['escalationRouting']
}

/** Fields a member or the lead may change on a single blackboard task. */
export interface TaskPatch {
  status?: TaskStatus
  assigneeAppId?: string | null
  resultRef?: string | null
  note?: string | null
}

// ── TeamStore Interface ──

/**
 * Persistence contract for the Digital Team data layer.
 *
 * All methods are synchronous (better-sqlite3). The store performs no business
 * validation beyond SQLite constraints — lifecycle rules (epoch transitions,
 * topology enforcement, AI member caps) live in the future apps/team service.
 *
 * Concurrency: writes are scoped by primary key and findings are append-only,
 * so no in-process locking is required (see DESIGN.md).
 */
export interface TeamStore {
  // ── teams ─────────────────────────────────────
  insertTeam(team: Team): void
  getTeamById(teamId: string): Team | null
  listTeams(): Team[]
  listTeamsBySpace(spaceId: string): Team[]
  updateTeamFields(teamId: string, fields: TeamFieldUpdate): void
  updateTeamStatus(teamId: string, status: TeamStatus): void
  updateTeamLeadAppId(teamId: string, leadAppId: string | null): void
  updateTeamCurrentEpoch(teamId: string, epochId: string | null): void
  deleteTeam(teamId: string): boolean

  // ── team_members ──────────────────────────────
  addMember(member: TeamMember): void
  removeMember(teamId: string, appId: string): boolean
  setMemberLead(teamId: string, appId: string, isLead: boolean): void
  setMemberScope(teamId: string, appId: string, scopeJson: string | null): void
  listMembersByTeam(teamId: string): TeamMember[]
  getMemberByName(teamId: string, memberName: string): TeamMember | null
  listMembersByAppId(appId: string): TeamMember[]

  // ── joined-office projection ──────────────────
  /**
   * Idempotently mirror a host-driven roster into the local store as a joined
   * ("shadow") office (teams.host_node_id = the host's node id). Owner node ids
   * arrive ABSOLUTE and are remapped SELF-relative for this node. A re-apply
   * upserts in place — no duplicate members, no constraint error.
   */
  materializeJoinedOffice(input: {
    hostNodeId: string
    selfNodeId: string
    snapshot: JoinedOfficeSnapshot
  }): void
  /**
   * The transient per-member runtime status (appId → working/idle/...) captured
   * from the last materialized roster snapshot of a joined office. Run-state is a
   * live projection, not a persisted column, so the joiner's status board overlays
   * it onto the rendered roster. Empty for a locally-hosted office or before any
   * snapshot has arrived.
   */
  getJoinedMemberStatuses(teamId: string): Map<string, TeamMemberRuntimeStatus>
  /** The in-progress task title a working member is on, from the last snapshot. */
  getJoinedMemberTaskTitle(teamId: string, appId: string): string | undefined

  // ── team_edges ────────────────────────────────
  replaceEdgesForTeam(teamId: string, edges: TeamEdge[]): void
  listEdgesByTeam(teamId: string): TeamEdge[]
  isEdgeAllowed(teamId: string, fromAppId: string, toAppId: string): boolean

  // ── blackboard_tasks ──────────────────────────
  insertTask(task: BlackboardTask): void
  getTaskById(taskId: string): BlackboardTask | null
  updateTask(taskId: string, patch: TaskPatch, updatedAt: number): void
  listTasksByEpoch(teamId: string, epochId: string): BlackboardTask[]
  listTasksByTeam(teamId: string): BlackboardTask[]

  // ── blackboard_findings ───────────────────────
  insertFinding(finding: BlackboardFinding): void
  listFindingsByEpoch(teamId: string, epochId: string): BlackboardFinding[]

  // ── team_epochs ───────────────────────────────
  insertEpoch(epoch: TeamEpoch, triggerType?: TeamRunTriggerType): void
  getEpochById(epochId: string): TeamEpoch | null
  endEpoch(epochId: string, endedAt: number, endReason: EpochEndReason, summary: string | null): void
  /** Reopen a sealed epoch (clear ended_at/end_reason; keep summary) for reversible-seal wake. */
  reopenEpoch(epochId: string): void
  listEpochsByTeam(teamId: string): TeamEpoch[]
  getCurrentEpochForTeam(teamId: string): TeamEpoch | null
  /** The open (not sealed) 'conversation' epoch for a (team, chat), or null. */
  getOpenConversationEpoch(teamId: string, chatKey: string): TeamEpoch | null

  // ── team_triggers ─────────────────────────────
  insertTrigger(trigger: TeamTrigger): void
  updateTrigger(id: string, patch: { config?: TeamTrigger['config']; enabled?: boolean }): void
  deleteTrigger(id: string): boolean
  deleteTriggersByTeam(teamId: string): void
  getTriggerById(id: string): TeamTrigger | null
  listTriggersByTeam(teamId: string): TeamTrigger[]
  /** All enabled triggers across all teams — used for boot rehydration. */
  listAllEnabledTriggers(): TeamTrigger[]
}
