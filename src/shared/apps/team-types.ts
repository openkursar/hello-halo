/**
 * Shared team types — single source of truth consumed by main + renderer.
 * Must stay dependency-free and renderer-safe (no Node/Electron APIs).
 */

import type { CapabilityPolicy } from './capability-policy'

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

/**
 * Business outcome of a sealed RUN epoch, stamped at seal time (P0-4):
 *   'output'     — the run produced at least one deliverable (task resultRef or
 *                  finding ref).
 *   'no_action'  — the team looked and judged nothing needed doing (quiet seal,
 *                  no deliverables, no pending decision).
 *   'escalation' — the run ended with a decision still waiting on the user.
 *   'failed'     — the run was cut short (error / timeout / member unreachable).
 * Null for conversation epochs and for runs sealed before this classification.
 */
export type EpochOutcome = 'output' | 'no_action' | 'escalation' | 'failed'

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
  /**
   * What this member is responsible for INSIDE this team, in the owner's own
   * words. Layered on top of the digital human's own persona, never replacing
   * it, and scoped to this team — the same app carries a different duty in
   * another team and none at all in its personal work. Only the owner writes it;
   * teammates read it in full. Null/empty = nothing written yet.
   */
  duty?: string | null
  /**
   * What a TEAMMATE may make this member do, decided by its owner and enforced
   * on the owner's own machine. Null = unrestricted (the shipped default, so an
   * existing team behaves exactly as before). Never replicated and never shown
   * to teammates — it protects one person's computer, so only that computer
   * needs it.
   */
  delegatedPolicy?: TeamDelegatedPolicy | null
  /**
   * Whether this member's owner lets teammates set a periodic check on it.
   * Derived from `delegatedPolicy` for a locally-owned member and adopted from
   * the roster snapshot for a remote one, so any node can refuse early with a
   * clear message instead of discovering it only at the owner. Absent = yes.
   */
  acceptsChecks?: boolean
}

/**
 * The owner's answer to "what may my teammates make this digital human do".
 * Read in permissive mode: an unset switch grants, so the switches only ever
 * take capabilities away.
 */
export interface TeamDelegatedPolicy extends CapabilityPolicy {
  /** Whether teammates may put a periodic check on this member. Unset = yes. */
  allowChecks?: boolean
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

// ── Activity (what actually happened, as opposed to what state things are in) ──

/**
 * What kind of coordination act an activity row records.
 *
 * Reads (`team_read_board`, `team_read_artifact`) are deliberately absent: they
 * change nothing, they are frequent, and a feed full of "X looked at the board"
 * pushes the acts that matter off the screen.
 */
export type TeamActivityKind =
  | 'message'
  | 'reply'
  | 'task_post'
  | 'task_update'
  | 'finding'
  | 'check_set'
  | 'check_stop'
  | 'run_end'

/**
 * The state an act recorded — one notion, read against the act's kind:
 *   a message  → 'sent' (accepted for delivery) or 'undelivered' (never arrived,
 *                which is the opposite of "no reply yet", not a flavour of it);
 *   a reply    → how the turn the message started ended;
 *   a task_update → the status the task was put into.
 */
export type TeamActivityStatus =
  | 'sent'
  | 'undelivered'
  | 'ok'
  | 'timeout'
  | 'error'
  | 'escalation'
  | TaskStatus

/**
 * One recorded coordination act. Append-only: a reply is a NEW row pointing back
 * at the message it answers (`correlationId`), never an edit of that message —
 * so the stream stays immutable, replicates as a single idempotent insert, and
 * needs no pre-image to roll back.
 *
 * The team's directed messages exist nowhere else as messages: each one only
 * passes through the sender's transcript (as a tool argument) and the receiver's
 * (as a turn input), on machines that may not be the same. This table is the
 * only place the office's own record of "who contacted whom" lives.
 */
export interface TeamActivity {
  id: string
  teamId: string
  epochId: string
  kind: TeamActivityKind
  /** Who acted. */
  actorAppId: string
  /** Who it was aimed at (message/reply/check); null for board writes. */
  targetAppId: string | null
  /** One line, already human-readable — what a feed row and a digest line show. */
  subject: string
  /** Full text, kept for detail-on-demand. Never rendered in a list or a digest. */
  body: string | null
  /** The task / finding / check / message id this act concerns. */
  refId: string | null
  /** Ties a reply to the message that caused it. */
  correlationId: string | null
  status: TeamActivityStatus | null
  createdAt: number
}

/** Subject lines are one line and short — a feed row, not a preview pane. */
export const TEAM_ACTIVITY_SUBJECT_MAX = 80

/** Collapse a message body to a single readable subject line. */
export function toActivitySubject(text: string, max = TEAM_ACTIVITY_SUBJECT_MAX): string {
  const firstLine = text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? ''
  const collapsed = firstLine.replace(/\s+/g, ' ')
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed
}

/**
 * The correlation ids that already have an answer. Shared by the board digest
 * (main) and the activity feed (renderer) so "answered / awaiting reply" is
 * decided by one rule in one place.
 */
export function answeredCorrelationIds(activities: readonly TeamActivity[]): Set<string> {
  const answered = new Set<string>()
  for (const a of activities) {
    if (a.kind === 'reply' && a.correlationId) answered.add(a.correlationId)
  }
  return answered
}

/**
 * Whether a sent message is still waiting. An undelivered message is NOT waiting
 * — it never arrived, so there is nobody to answer it, and telling the sender to
 * expect a reply would be a lie.
 */
export function isAwaitingReply(activity: TeamActivity, answered: ReadonlySet<string>): boolean {
  if (activity.kind !== 'message') return false
  if (activity.status === 'undelivered') return false
  return !activity.correlationId || !answered.has(activity.correlationId)
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
  /**
   * User-facing name of a conversation epoch (the session list label). Null →
   * the label is derived (IM chat name / member name / first-message digest).
   */
  title?: string | null
  /** Outcome classification of a sealed run epoch (see {@link EpochOutcome}). */
  outcome?: EpochOutcome | null
  /** What started a run epoch (mirrors team_epochs.trigger_type). */
  triggerType?: TeamRunTriggerType
  /**
   * When a turn last entered this epoch. A conversation outlives its creation by
   * weeks, so this — not `startedAt` — is how recent it actually is. Falls back
   * to `startedAt` for rows written before migration v11.
   */
  lastActivityAt?: number
}

// ── Periodic checks (member-level recurring wake, scoped to one epoch) ──

/**
 * A standing instruction one member left for another: "from now on, every N,
 * take a look at this". It exists only while the thing it belongs to (a run or
 * a conversation) is open, and any member — or the user — can stop it.
 *
 * The alarm itself lives on the machine that OWNS the target member, so the
 * person who set it can shut their computer without stopping it, and a target
 * whose owner is away simply does not wake (which is the honest outcome — that
 * digital human could not have done the work either).
 *
 * The row is office-shared: it rides the same replication plane as the board, so
 * every node — and every teammate's `team_read_board` — sees the same list.
 */
export interface TeamCheck {
  id: string
  teamId: string
  epochId: string
  targetAppId: string
  /** The member that asked for it (self-checks are allowed). */
  createdByAppId: string
  /** Verbatim standing instruction, delivered on every wake. */
  instruction: string
  schedule: TeamCheckSchedule
  runCount: number
  createdAt: number
  updatedAt: number
  lastRunAt: number | null
}

/**
 * Same expressive range as a digital human's own scheduled work, deliberately —
 * a check IS scheduled work, just aimed at a teammate. It mirrors the platform
 * scheduler's `Schedule` rather than importing it, because this file has to stay
 * renderer-safe and the scheduler is a main-process module.
 */
export type TeamCheckSchedule =
  | { kind: 'every'; every: string }
  | { kind: 'cron'; cron: string; timezone?: string }
  | { kind: 'once'; once: number }

/**
 * A check as shown to a person or read by an agent: ids resolved to member
 * names on the producing side, so neither a board nor a panel has to look them
 * up. `reachable` is false when the target's owner is offline — the check is
 * still set, but it will not fire until they are back.
 */
export interface TeamCheckView {
  id: string
  epochId: string
  targetAppId: string
  targetMemberName: string
  createdByMemberName: string
  instruction: string
  schedule: TeamCheckSchedule
  runCount: number
  lastRunAt: number | null
  reachable: boolean
  /** Display name of the person whose machine runs it; null when it is yours. */
  targetOwner?: string | null
}

// ── Conversations (office-shared session objects) ──

/**
 * Kind of a team conversation, derived from its chatKey namespace:
 *   'native' — created in the Halo UI ("New session"), user ↔ team (lead).
 *   'im'     — an inbound IM chat handled by the team (read-only in Halo).
 *   'member' — a 1:1 side-thread with a specific teammate (member direct chat).
 */
export type TeamConversationKind = 'native' | 'im' | 'member'

/**
 * A renderer-facing projection of one open conversation epoch. Labels are
 * resolved on the MAIN side (the down-send generates the human name; the
 * renderer performs zero translation). The list is office-shared: every node
 * sees the same conversations because the epochs replicate.
 */
export interface TeamConversation {
  epochId: string
  teamId: string
  kind: TeamConversationKind
  /** Human label: title, IM chat name, or the member's name. */
  label: string
  /** True when Halo can only watch (IM chats are answered in the IM app). */
  readonly: boolean
  /** For kind='member': the teammate this thread belongs to. */
  memberAppId?: string
  /** IM channel type for kind='im' (e.g. 'wecom-bot'), for the badge. */
  channel?: string
  startedAt: number
  /** When a turn last entered it — how recent this thread actually is. */
  lastActivityAt: number
  /** True while a member is actively serving this conversation right now. */
  active?: boolean
  /** True when a decision inside this conversation is waiting on the user. */
  waitingUser?: boolean
}

/** One busy assignment of a member: which thing it is serving, with a label. */
export interface RosterBusyEntry {
  epochId: string
  label: string
  kind: EpochLifecycle
}

/** A decision waiting on the user, aggregated per team (survives run seal). */
export interface TeamPendingEscalation {
  appId: string
  memberName: string
  entryId: string
  question: string
  epochId?: string
  taskId?: string
}

// ── Runtime-only structures (not persisted) ──

/** In-memory message envelope used by the Message Bus. */
export interface TeamEnvelope {
  id: string
  teamId: string
  epochId: string
  /** Null when a person wrote it: no digital human is behind the message. */
  fromAppId: string | null
  toAppId: string
  body: string
  correlationId: string
  taskRef?: string
  createdAt: number
}

/** Per-turn context injected by the Bus when waking a member. Transparent to the LLM. */
export interface TeamTriggerContext {
  teamId: string
  epochId: string
  correlationId: string
  /**
   * The teammate this turn came from. Null when no digital human is behind it:
   * a run start, a person's message or a self-wake. The office record and the
   * circuit budget both key on it.
   */
  fromAppId: string | null
  /**
   * Someone is holding a completion receipt for this turn. Only a non-agent
   * caller sets it (a person's cross-machine 1:1 chat); it changes nothing about
   * how the turn runs or what the member is told.
   */
  wait: boolean
  taskId?: string
  /**
   * Drives inbound header rendering. 'periodic_check' and 'human_message' are
   * delivered verbatim — the first already carries its own header, the second is
   * a person's words, which no teammate framing may impersonate.
   */
  kind?: 'run_start' | 'message' | 'periodic_check' | 'human_message'
  /**
   * Position of this turn in the chain that caused it; the circuit breaker's
   * `maxForwardDepth` counts it. Must travel with the trigger — a chain that
   * restarts at 0 on every hop never reaches the limit.
   */
  forwardDepth?: number
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

/**
 * Reachability of a teammate, orthogonal to its activity status. Derived from the
 * federation presence FSM: 'online' = the owner is reachable (a local member is
 * always online); 'offline' = the owner is confirmed unreachable. Deliberately
 * two-valued — the FSM's transient 'suspect' maps to 'online' so a brief network
 * flap never makes a teammate look gone (and never provokes a needless reassign).
 */
export type TeamMemberPresence = 'online' | 'offline'

export interface RosterMember {
  appId: string
  memberName: string
  role: string
  /** What this member is responsible for in this team, in its owner's words. */
  duty?: string | null
  isLead: boolean
  spaceId: string | null
  status: TeamMemberRuntimeStatus
  currentTaskTitle?: string
  /**
   * Display name of the person who owns/brought this teammate. Null when the
   * member runs on THIS machine (owned by you). Lets a teammate reason about
   * "whose digital human this is" for coordination and accountability.
   */
  owner?: string | null
  /**
   * True when this member runs on the same machine as the reader (shared
   * filesystem). False when it runs on a teammate's machine — a local file path
   * produced here is NOT readable there, so deliverables must be published as
   * team artifacts / findings instead of passed as bare paths.
   */
  sameMachine?: boolean
  /** Reachability (see {@link TeamMemberPresence}). Absent → treat as online. */
  presence?: TeamMemberPresence
  /**
   * Everything this member is serving RIGHT NOW (a run and/or conversations),
   * each with a human label generated on the producing side (P0-2). Lets a
   * board focused on one thing say "busy with another conversation" truthfully.
   */
  busy?: RosterBusyEntry[]
}

export interface BlackboardSnapshot {
  tasks: BlackboardTask[]
  findings: BlackboardFinding[]
  roster: RosterMember[]
  /** Periodic checks currently running in this epoch, so anyone can stop one. */
  checks: TeamCheckView[]
  /**
   * What has happened in this epoch, newest last. Distinct from the lists above:
   * those are current state, this is the record of the acts that produced it —
   * including the directed messages, which no other table holds.
   */
  activities: TeamActivity[]
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
  /**
   * The member's team duty as the authority knows it. A node keeps its OWN
   * members' duty (the owner writes it, and their edit may not have reached the
   * authority yet) and adopts this value for everyone else's.
   */
  duty?: string | null
  /**
   * Whether this member's owner lets teammates put a periodic check on it. Only
   * this one bit of the owner's policy travels — enough for another node to
   * refuse early with a clear message; the policy itself never leaves its owner.
   */
  acceptsChecks?: boolean
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
  /** Live busy assignments with authority-generated labels (see RosterBusyEntry). */
  busy?: RosterBusyEntry[]
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
}
export interface TeamSendAsyncResult {
  messageId: string
  /**
   * What happened to the send. Nothing is ever auto-delivered back, so this
   * receipt is all the sender learns:
   *   - 'undelivered' the target's owner was offline/unreachable at send time.
   *                   There is no offline outbox, so it will NOT arrive later.
   *   - 'queued'      the target is mid-turn; the message waits in its mailbox.
   *                   Only knowable for a locally-owned target — a remote one
   *                   queues on its OWNER, so it reads as a plain hand-over.
   * Absent → handed over to the target's session now.
   */
  delivery?: 'undelivered' | 'queued'
}
/**
 * Receipt for a send that waited on the woken turn's ending. Not reachable from
 * `team_send` — only a person's cross-machine 1:1 chat asks for one, so its UI
 * can distinguish "sent" from "never arrived".
 */
export interface TeamSendSyncResult {
  from: string
  message: string
  /**
   * Delivery truth, so a non-delivery is never mistaken for a real (empty) reply:
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
  duty?: string
}

/**
 * What the owner of a member may change about it inside one team. Omitted
 * fields are left alone; only the node that owns the member may apply this.
 */
export interface UpdateTeamMemberInput {
  duty?: string
  delegatedPolicy?: TeamDelegatedPolicy | null
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
  /** How many decisions are waiting on the user (drives the "N waiting" badge). */
  waitingCount?: number
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
  /** The office's own record of what happened, newest last (see TeamActivity). */
  activities?: TeamActivity[]
  /**
   * Decisions currently waiting on the user, persisted in the members' activity
   * feeds — they survive a run seal (P0-5) and drive the cross-tab banner.
   */
  pendingEscalations?: TeamPendingEscalation[]
  /** Periodic checks running across this office's open runs and conversations. */
  checks?: TeamCheckView[]
}

export interface TeamEpochSummary {
  id: string
  startedAt: number
  /** When a turn last entered it — the sort key for a list of work. */
  lastActivityAt: number
  endedAt: number | null
  endReason: EpochEndReason | null
  summary: string | null
  taskCount: number
  doneCount: number
  lifecycle: EpochLifecycle
  /** Human label for a conversation epoch (main-side resolved); null for runs. */
  label?: string | null
  outcome?: EpochOutcome | null
  triggerType?: TeamRunTriggerType
  /** Count of files the run produced (task resultRefs + finding refs, deduped). */
  artifactCount?: number
}

export interface EpochBoard {
  epoch: TeamEpoch
  tasks: BlackboardTask[]
  findings: BlackboardFinding[]
  members: TeamMember[]
  /** What happened during this run/conversation, newest last. */
  activities?: TeamActivity[]
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
  kind: 'task' | 'finding' | 'activity'
  task?: BlackboardTask
  finding?: BlackboardFinding
  activity?: TeamActivity
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
 *   'access-lost' — this machine's membership was refused on re-entry;
 *                reconnecting alone cannot fix it, the user needs a fresh invite.
 * The renderer maps each kind to humanized, location-free copy; the wire kind
 * itself is code-only and never shown to a user.
 */
export type TeamOfficeStatusKind = 'paused' | 'resumed' | 'authority-changed' | 'access-lost'

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
 * Whether a member's pending decision is THIS reader's to make. "Waiting for a
 * decision" is addressed to exactly one person — the one whose machine the
 * member runs on, since the question itself lives only in that machine's
 * activity feed. Every other node can be told the office is blocked, but must
 * never be asked to answer.
 *
 * Unknown ownership counts as ours: that is the single-machine case, where there
 * is no one else it could belong to.
 */
export function awaitsOurDecision(member: Pick<RosterMember, 'status' | 'sameMachine'>): boolean {
  return member.status === 'waiting_user' && member.sameMachine !== false
}

/**
 * The checks running on one member inside one piece of work.
 *
 * A check only exists within the run or conversation it was set in, while
 * `TeamDetail.checks` spans the whole office — so every surface bound to a
 * single piece of work has to narrow by both. Omitting `epochId` (a surface
 * showing the member across the team, or a floor with nothing focused) keeps
 * them all.
 */
export function checksForMember(
  checks: readonly TeamCheckView[],
  appId: string,
  epochId?: string | null
): TeamCheckView[] {
  return checks.filter((c) => c.targetAppId === appId && (!epochId || c.epochId === epochId))
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
  readArtifact: 'team_read_artifact',
  complete: 'team_complete',
  schedule: 'team_schedule',
  unschedule: 'team_unschedule',
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
  updateMember: 'team:update-member',
  removeMember: 'team:remove-member',
  cancelCheck: 'team:cancel-check',
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
  listConversations: 'team:list-conversations',
  openConversation: 'team:open-conversation',
  renameConversation: 'team:rename-conversation',
  archiveConversation: 'team:archive-conversation',
  /** One-shot pull of an invite link that arrived via halo:// before the renderer was up. */
  consumePendingInvite: 'team:consume-pending-invite',
} as const

export const TEAM_CIRCUIT_DEFAULTS = {
  maxMessages: 200,
  maxForwardDepth: 8,
  maxDurationMs: 2 * 60 * 60 * 1000,
} as const

/** Default member turn timeout (ms) when `agent.teamTurnTimeoutMs` is unset. */
export const TEAM_DEFAULT_TURN_TIMEOUT_MS = 60 * 60 * 1000

/** Default cap on team member turns running at once on this machine, when `agent.teamMaxConcurrentTurns` is unset. */
export const TEAM_DEFAULT_MAX_CONCURRENT_TURNS = 10

// ── Session-key helper (re-exported SSOT) ──

export {
  buildTeamSessionKey,
  isTeamSessionKey,
  memberChatKey,
  parseMemberChatKey,
  nativeConversationChatKey,
  isNativeConversationChatKey,
} from './im-keys'
