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
  /**
   * Authority of this office. null = this node HOSTS the office (it is the
   * authority). A remote node id = this is a JOINED shadow office hosted
   * elsewhere; this node only mirrors the roster for display + relay ownership
   * and must not edit/run it. Optional on input — the store defaults to null —
   * and always populated on read.
   */
  hostNodeId?: string | null
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
  /**
   * Owning node of this member. SELF_NODE_ID sentinel for a locally-owned
   * member; a remote node id for a federated member. Optional on input — the
   * store defaults to SELF — and always populated on read.
   */
  ownerNodeId?: string
  origin?: 'local' | 'remote'
  /** Portable owner identity (Identity.id); null for legacy/local-only members. */
  memberIdentity?: string | null
  /**
   * Permission-overlay scope carried at join, stored as raw JSON so the shared
   * type stays renderer-safe. null/undefined = default-open. The AUTHORITY
   * parses + enforces it (contactable/visibility); the renderer treats it opaquely.
   */
  scopeJson?: string | null
  /**
   * Display name of the owning person for a remote member (the "brought by
   * Alice" badge). Denormalized onto the member row at join/materialization so
   * every node can label the owner from its own store — a joiner keeps no
   * office_nodes rows for its peers, only presence projections. null for local
   * members and for legacy rows written before the owner advertised a name.
   */
  ownerDisplayName?: string | null
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
  /**
   * The send originates from a HUMAN (1:1 member chat), not a teammate. The
   * turn is still attributed to the lead for bus accounting, but the woken
   * member receives the person's words verbatim — no "[Team message from …]"
   * header impersonating a teammate (parity with local app-chat).
   */
  humanOrigin?: boolean
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

// ── Joined-office materialization (host → joiner roster projection) ──

/**
 * One member of a joined office as supplied to the store for materialization.
 * `ownerNodeId` is ABSOLUTE (the true owning node id, never the SELF sentinel);
 * the store remaps it to SELF-relative for the receiving node. Structurally a
 * superset-compatible mirror of the federation RosterMemberSnap wire shape so
 * the manager can pass a roster frame's member straight through.
 */
export interface JoinedOfficeMemberSnap {
  appId: string
  memberName: string
  role: string
  isLead: boolean
  ownerNodeId: string
  memberIdentity: string | null
  /** Owner's display name, persisted for the badge on nodes without peer node rows. */
  ownerDisplayName?: string | null
  /**
   * The member's live runtime status on the authority, so a joiner's topology
   * animates the working pulse in step with the host. Authority-local
   * (idle/working/waiting_user/error) and transient — never persisted as a
   * column; the joiner overlays it onto the rendered roster. Absent → 'idle'.
   */
  status?: TeamMemberRuntimeStatus
  /** Title of the task a working member is on, for the node summary. */
  currentTaskTitle?: string
}

/**
 * The roster projection a joiner materializes into its local store as a shadow
 * office. Renderer-safe and federation-free so apps/team owns no upward import;
 * the federation RosterSnapshot is structurally compatible and passed through.
 */
export interface JoinedOfficeSnapshot {
  team: {
    id: string
    name: string
    goal: string
    leadAppId: string | null
    collabMode: CollabMode
    /**
     * The office's currently-open run epoch, if any. Persisted as the shadow
     * office's current_epoch_id so a joiner can bind the live run from its own
     * store (e.g. after a refresh), not only from the in-memory join.
     */
    epochId?: string
    /**
     * The office's live run status on the authority (idle/running/...), so a
     * joiner's run banner reflects "running" the moment the host starts a run.
     * Persisted as the shadow office's status. Absent → 'idle'.
     */
    status?: TeamStatus
  }
  members: JoinedOfficeMemberSnap[]
  edges: Array<{ fromAppId: string; toAppId: string }>
}

// ── Tool I/O shapes (MCP server "halo-team") ──

export interface TeamSendInput {
  to: string
  message: string
  wait?: boolean
}
export interface TeamSendAsyncResult {
  messageId: string
  /**
   * Set to 'undelivered' when an immediate reachability check found the target's
   * owner offline/unreachable at send time. Async (wait=false) sends have no
   * persistent offline outbox, so such a message will NOT auto-deliver later —
   * the sender is told NOW instead of falsely seeing "sent". Absent → accepted for
   * delivery (a busy-but-reachable target is buffered = queued).
   */
  delivery?: 'undelivered'
}
export interface TeamSendSyncResult {
  from: string
  message: string
  /**
   * Sender-facing delivery truth, so a teammate never mistakes a non-delivery for
   * a real (empty) reply:
   *   - 'ok'          the turn ran and reported back (message may still be empty).
   *   - 'timeout'     it was reachable but did not finish within the wait window.
   *   - 'undelivered' the wake never reached the owner (offline/unreachable) or no
   *                   completion signal ever came back — definitively NOT a reply.
   * This is the seam the durable feed outbox later feeds (delivered/pending/failed).
   */
  status: 'ok' | 'timeout' | 'undelivered'
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
  /**
   * Why the office left this node's list. Only set for a removal the user did NOT
   * initiate, so the renderer can tell them (vs staying silent for a self leave /
   * self dissolve). 'dissolved-remote' = the host closed an office this node joined.
   */
  removedReason?: 'dissolved-remote'
  /**
   * Set when the office host removed a member THIS node brought — a kick the
   * local user did not initiate, so the renderer tells them instead of the row
   * silently vanishing. Name is best-effort (the local mirror may have already
   * converged past the removed row).
   */
  memberKicked?: { appId: string; memberName?: string }
  /**
   * Set when an optimistic board write of this node could not be confirmed by
   * the office authority and was rolled back — the renderer tells the user a
   * recent board update did not stick (and refetches the open board).
   */
  boardWriteDiscarded?: boolean
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

/** One node's reachability within an office, as projected by the federation FSM. */
export interface TeamPresenceNode {
  nodeId: string
  /** Portable owner identity (Identity.id) of the node. */
  identity: string
  /** Human-readable owner name; null until the node advertises one. */
  displayName: string | null
  status: 'online' | 'suspect' | 'offline'
  lastSeen: number
}

/** Office-scoped presence frame (teamId === officeId). */
export interface TeamPresenceEvent {
  teamId: string
  nodes: TeamPresenceNode[]
}

/**
 * Office-level liveness signal, distinct from the persisted run TeamStatus. It is
 * a transient overlay describing whether the office is currently reachable:
 *   'paused'   — the office is resting (e.g. the person who runs it stepped away);
 *                work picks back up when someone is online again.
 *   'resumed'  — the office reconnected and is live again.
 *   'authority-changed' — coordination quietly moved between machines; surfaced
 *                the same calm way as a reconnect (no user action needed).
 * The renderer maps each kind to humanized, location-free copy; the wire kind
 * itself is code-only and never shown to a user.
 */
export type TeamOfficeStatusKind = 'paused' | 'resumed' | 'authority-changed'

export interface TeamOfficeStatusEvent {
  teamId: string
  kind: TeamOfficeStatusKind
}

// ── Name constants (frozen — do not rename) ──

export const TEAM_MCP_SERVER_NAME = 'halo-team'

/** Sentinel owner-node id for a locally-owned team member (not federated). */
export const SELF_NODE_ID = 'SELF'

/**
 * Whether a member runs on someone else's machine (federated), as opposed to
 * being locally owned. A remote member's run transcript is not locally reloadable
 * — it exists only as relayed live frames until owner-served history arrives.
 */
export function isRemoteMember(member: {
  origin?: 'local' | 'remote'
  ownerNodeId?: string
}): boolean {
  return member.origin === 'remote' && member.ownerNodeId !== SELF_NODE_ID
}

/**
 * Whether a remote member's relayed live activity should be shown as a transient
 * transcript. True only while the member is remote, nothing is actively streaming,
 * no locally-loaded messages exist yet (owner history not arrived), and some
 * relayed content/thoughts were captured. Yields automatically once real history
 * populates `messageCount`.
 */
export function shouldShowRelayedTranscript(args: {
  isRemote: boolean
  hasStreaming: boolean
  messageCount: number
  streamingContentLength: number
  thoughtCount: number
}): boolean {
  return (
    args.isRemote &&
    !args.hasStreaming &&
    args.messageCount === 0 &&
    (args.streamingContentLength > 0 || args.thoughtCount > 0)
  )
}

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
  presence: 'team:presence',
  officeStatus: 'team:office-status',
  /** A halo:// office-invite deep link arrived; payload: { link: string }. */
  inviteLink: 'team:invite-link',
  /** A member's local transcript replica grew; payload: { teamId, appId, epochId }. */
  memberHistory: 'team:member-history',
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
  generateInvite: 'team:generate-invite',
  revokeInvite: 'team:revoke-invite',
  joinOffice: 'team:join-office',
  leaveOffice: 'team:leave-office',
  sendToMember: 'team:send-to-member',
  /** One-shot pull of an invite link that arrived via halo:// before the renderer was up. */
  consumePendingInvite: 'team:consume-pending-invite',
} as const

export const TEAM_CIRCUIT_DEFAULTS = {
  maxMessages: 200,
  maxForwardDepth: 8,
  maxDurationMs: 2 * 60 * 60 * 1000,
} as const

// ── Session-key helper (re-exported SSOT) ──

export { buildTeamSessionKey, isTeamSessionKey, memberChatKey } from './im-keys'
