/**
 * Shared team types — single source of truth consumed by main + renderer.
 * Must stay dependency-free and renderer-safe (no Node/Electron APIs).
 */

// ── Enumerations ──

export type MemberSourcing = 'manual' | 'ai'
export type CollabMode = 'structured' | 'free'
export type EscalationRouting = 'user' | 'lead'
export type TeamStatus = 'idle' | 'running' | 'waiting_user' | 'error'
export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'rejected' | 'blocked'
export type EpochEndReason = 'completed' | 'stopped' | 'timeout' | 'error'

/**
 * Execution mode of an epoch:
 *   'run'          — a triggered one-shot run (schedule/http/webhook/file). The
 *                    lead is woken once; quiescence (all tasks terminal + idle)
 *                    auto-seals it.
 *   'conversation' — a long-lived, message-driven epoch (e.g. an IM-backed team).
 *                    Resumed per inbound message; quiescence is the normal
 *                    "waiting for the next message" state and never auto-seals.
 */
export type EpochLifecycle = 'run' | 'conversation'

// ── Persistent entities ──

export interface Team {
  id: string
  name: string
  owningSpaceId: string
  goal: string
  /** Null until the system provisions a lead app. */
  leadAppId: string | null
  memberSourcing: MemberSourcing
  collabMode: CollabMode
  escalationRouting: EscalationRouting
  status: TeamStatus
  currentEpochId: string | null
  createdAt: number
  updatedAt: number
}

export interface TeamMember {
  teamId: string
  appId: string
  memberName: string
  role: string
  isLead: boolean
  /** Drives orphan cleanup on dissolve — only AI-sourced apps are auto-deleted. */
  aiProvisioned: boolean
  addedAt: number
}

/** Directed collaboration edge (structured mode only). */
export interface TeamEdge {
  teamId: string
  fromAppId: string
  toAppId: string
  sync: boolean
}

export interface BlackboardTask {
  id: string
  teamId: string
  epochId: string
  title: string
  assigneeAppId: string | null
  status: TaskStatus
  /** File path to a produced artifact, not inline content. */
  resultRef: string | null
  note: string | null
  parentId: string | null
  createdByAppId: string
  createdAt: number
  updatedAt: number
}

export interface BlackboardFinding {
  id: string
  teamId: string
  epochId: string
  authorAppId: string
  body: string | null
  ref: string | null
  createdAt: number
}

export interface TeamEpoch {
  id: string
  teamId: string
  startedAt: number
  endedAt: number | null
  endReason: EpochEndReason | null
  summary: string | null
  /** Execution mode; defaults to 'run' for rows created before migration v3. */
  lifecycle: EpochLifecycle
  /**
   * For 'conversation' epochs: the chat this epoch serves, so each IM chat gets
   * its own long-lived epoch (independent context). Format is opaque to the
   * store; dispatch uses `${instanceId}:${chatId}`. Null for 'run' epochs.
   */
  chatKey?: string | null
}

// ── Runtime-only structures (not persisted) ──

/** In-memory message envelope used by the Message Bus. */
export interface TeamEnvelope {
  id: string
  teamId: string
  epochId: string
  fromAppId: string
  toAppId: string
  body: string
  /** wait=true → sender blocks until reply; wait=false → fire-and-forget. */
  wait: boolean
  correlationId: string
  taskRef?: string
  createdAt: number
}

/** Per-turn context injected by the Bus when waking a member. Transparent to the LLM. */
export interface TeamTriggerContext {
  teamId: string
  epochId: string
  correlationId: string
  /** Null for the initial lead wake (run_start). */
  fromAppId: string | null
  wait: boolean
  taskId?: string
  /**
   * Drives inbound header rendering. 'completion' carries the finisher identity
   * in envelope.fromAppId, not trigger.fromAppId.
   */
  kind?: 'run_start' | 'message' | 'completion'
}

export interface TeamContext {
  teamId: string
  epochId: string
  taskId?: string
}

// ── Triggers ──

/**
 * A team is triggerable the same ways a single digital human is. 'schedule'
 * maps to a scheduler job; 'webhook' | 'file' | 'wecom' map to EventRouter
 * subscriptions (same multi-subscriber path the app runtime uses). All share the
 * team_triggers table — adding one needs no migration.
 */
export type TeamTriggerSourceType = 'schedule' | 'webhook' | 'file' | 'wecom'

/** Config for a 'schedule' trigger (mirrors the platform scheduler). */
export interface TeamScheduleConfig {
  every?: string
  cron?: string
}

/** Config for a 'webhook' trigger. Field names mirror the app WebhookSourceConfig. */
export interface TeamWebhookConfig {
  /** Path segment under POST /hooks/* this team listens on. */
  path?: string
  /** Optional HMAC secret used by the WebhookSource to verify signatures. */
  secret?: string
}

/** Config for a 'file' trigger. Field names mirror the app FileSourceConfig. */
export interface TeamFileConfig {
  /** Glob matched against the changed file's relative path, e.g. "*.csv". */
  pattern?: string
  /** Directory substring the changed file's absolute path must contain. */
  path?: string
}

/** Config for a 'wecom' trigger. Field names mirror the app WecomSourceConfig. */
export interface TeamWecomConfig {
  /** Chat id to match; omitted = any inbound WeCom message. */
  chatId?: string
}

/** Discriminated config union for a team trigger, by sourceType. */
export type TeamTriggerConfig =
  | TeamScheduleConfig
  | TeamWebhookConfig
  | TeamFileConfig
  | TeamWecomConfig

export interface TeamTrigger {
  id: string
  teamId: string
  sourceType: TeamTriggerSourceType
  config: TeamTriggerConfig | Record<string, unknown>
  enabled: boolean
  createdAt: number
}

export interface TeamTriggerInput {
  sourceType: TeamTriggerSourceType
  config: TeamTriggerConfig | Record<string, unknown>
  enabled?: boolean
}

export type TeamRunTriggerType = 'manual' | 'schedule' | 'http' | 'event'

/** Distinct from TeamTriggerContext, which is the per-turn envelope inside an epoch. */
export interface TeamRunTrigger {
  type: TeamRunTriggerType
  triggerId?: string
}

// ── Roster projection (derived, not persisted) ──

export type TeamMemberRuntimeStatus = 'working' | 'idle' | 'error' | 'waiting_user'

export interface RosterMember {
  appId: string
  memberName: string
  role: string
  isLead: boolean
  spaceId: string | null
  status: TeamMemberRuntimeStatus
  currentTaskTitle?: string
}

export interface BlackboardSnapshot {
  tasks: BlackboardTask[]
  findings: BlackboardFinding[]
  roster: RosterMember[]
}

// ── Tool I/O shapes (MCP server "halo-team") ──

export interface TeamSendInput {
  to: string
  message: string
  wait?: boolean
}
export interface TeamSendAsyncResult {
  messageId: string
}
export interface TeamSendSyncResult {
  from: string
  message: string
  status: 'ok' | 'timeout'
}

export interface TeamPostTaskInput {
  title: string
  assignee: string
  parentId?: string
}
export interface TeamPostTaskResult {
  taskId: string
}

export interface TeamUpdateTaskInput {
  taskId: string
  status: TaskStatus
  resultRef?: string
  note?: string
}

export interface TeamPostFindingInput {
  content?: string
  ref?: string
}
export interface TeamPostFindingResult {
  findingId: string
}

export interface TeamReadBoardFilter {
  mine?: boolean
  status?: TaskStatus
}

// ── Service-layer inputs ──

export interface TeamMemberInput {
  appId: string
  memberName?: string
  role?: string
}

export interface CreateTeamInput {
  name: string
  goal: string
  owningSpaceId: string
  memberSourcing: MemberSourcing
  collabMode: CollabMode
  escalationRouting: EscalationRouting
  members?: TeamMemberInput[]
  leadAppId?: string | null
}

export interface UpdateTeamInput {
  name?: string
  goal?: string
  memberSourcing?: MemberSourcing
  collabMode?: CollabMode
  escalationRouting?: EscalationRouting
  leadAppId?: string | null
}

export interface ProposedMember {
  memberName: string
  role: string
  responsibility: string
}

export const AI_MEMBER_HARD_LIMIT = 5

// ── Renderer aggregates (team.store projections) ──

export interface TeamListItem {
  id: string
  name: string
  status: TeamStatus
  memberCount: number
  hasWaitingUser: boolean
  /**
   * Surfaced so the renderer can hide lead apps from the digital-humans list
   * (leads are an internal coordination role, not standalone humans).
   */
  leadAppId: string | null
  updatedAt: number
}

export interface TeamDetail {
  team: Team
  members: TeamMember[]
  edges: TeamEdge[]
  roster: RosterMember[]
  tasks: BlackboardTask[]
  findings: BlackboardFinding[]
}

export interface TeamEpochSummary {
  id: string
  startedAt: number
  endedAt: number | null
  endReason: EpochEndReason | null
  summary: string | null
  taskCount: number
  doneCount: number
}

export interface EpochBoard {
  epoch: TeamEpoch
  tasks: BlackboardTask[]
  findings: BlackboardFinding[]
  members: TeamMember[]
}

/**
 * A produced file/folder. Renderer-safe mirror of the services `Artifact` shape
 * so both the team service (producer) and the renderer (consumer) share one
 * contract; structurally identical to the renderer `Artifact` type so it can be
 * passed straight to the shared ArtifactCard.
 */
export interface TeamArtifact {
  id: string
  spaceId: string
  conversationId: string
  name: string
  type: 'file' | 'folder'
  path: string
  relativePath: string
  extension: string
  icon: string
  createdAt: string
  preview?: string
  size?: number
}

/** Files produced by one member during a run, grouped for the team artifacts view. */
export interface TeamArtifactGroup {
  appId: string
  memberName: string
  spaceId: string | null
  artifacts: TeamArtifact[]
}

// ── Observability event payloads ──

export interface TeamUpdatedEvent {
  teamId: string
  team?: Team
  removed?: boolean
}

export interface TeamBlackboardEvent {
  teamId: string
  epochId: string
  kind: 'task' | 'finding'
  task?: BlackboardTask
  finding?: BlackboardFinding
}

export interface TeamMessageEvent {
  teamId: string
  epochId: string
  fromAppId: string
  toAppId: string
  fromMemberName: string
  toMemberName: string
  messageId: string
  ts: number
}

// ── Name constants (frozen — do not rename) ──

export const TEAM_MCP_SERVER_NAME = 'halo-team'

export const TEAM_TOOL_NAMES = {
  send: 'team_send',
  postTask: 'team_post_task',
  updateTask: 'team_update_task',
  postFinding: 'team_post_finding',
  readBoard: 'team_read_board',
  complete: 'team_complete',
} as const

export const TEAM_MIGRATION_NAMESPACE = 'app_team'

export const TEAM_EVENTS = {
  updated: 'team:updated',
  blackboard: 'team:blackboard',
  message: 'team:message',
} as const

export const TEAM_IPC = {
  list: 'team:list',
  get: 'team:get',
  create: 'team:create',
  update: 'team:update',
  dissolve: 'team:dissolve',
  addMember: 'team:add-member',
  removeMember: 'team:remove-member',
  setEdges: 'team:set-edges',
  proposeMembers: 'team:propose-members',
  run: 'team:run',
  pause: 'team:pause',
  getDetail: 'team:get-detail',
  listArtifacts: 'team:list-artifacts',
  listTriggers: 'team:list-triggers',
  setTrigger: 'team:set-trigger',
  removeTrigger: 'team:remove-trigger',
} as const

export const TEAM_CIRCUIT_DEFAULTS = {
  maxMessages: 200,
  maxForwardDepth: 8,
  maxDurationMs: 2 * 60 * 60 * 1000,
} as const

// ── Session-key helper (re-exported SSOT) ──

export { buildTeamSessionKey, isTeamSessionKey } from './im-keys'
