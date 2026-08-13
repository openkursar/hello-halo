/**
 * apps/runtime/federation -- Type Definitions
 *
 * Control-plane message shapes and presence types for the office federation
 * runtime. Covers the JOIN handshake (join-request/grant/reject) and PRESENCE
 * (online/suspect/offline via heartbeat + the two-threshold debounce machine),
 * trimmed to what join + presence need — version negotiation and capability
 * bits live in ./protocol-m2.
 *
 * Renderer-unaware: pure data shapes, no Node/Electron imports.
 */

import type { OfficeNode } from '../../federation'
import type {
  TeamTriggerContext,
  TeamStatus,
  TeamMemberRuntimeStatus,
  RosterBusyEntry,
} from '../../../../shared/apps/team-types'
import type { TurnCompletion } from '../team/message-bus'
import type { M2Frame } from './protocol-m2'
import type { FeedSyncFrame } from './log/types'

/** Stable per-node identifier (office_nodes.node_id). */
export type NodeId = string

/** The office this coordinator speaks for, plus this node's own id. */
export interface OfficeContext {
  officeId: string
  selfNodeId: NodeId
}

// ── Control messages (JSON-serializable) ──

/**
 * A member a joining node brings into the office. `spaceId` is optional and the
 * host caches it on the remote member row so a later wake can address the
 * member's own space without a round-trip; absent for callers that don't track
 * it (kept backward-compatible).
 */
export interface JoinMember {
  appId: string
  memberName: string
  role?: string
  spaceId?: string
}

/**
 * First handshake leg (node → host). Carries the office credential token, the
 * portable identity, and the members this node brings into the office.
 */
export interface JoinRequest {
  kind: 'join-request'
  officeId: string
  fromNode: NodeId
  identityId: string
  displayName?: string
  credentialToken: string
  bringMembers: JoinMember[]
  /** M2 version/capability negotiation. Absent → treated as v1 / core caps. */
  pv?: number
  minSupported?: number
  caps?: number
  /**
   * Base URL of this node's own HTTP/WS server, advertised so peers can dial it
   * after a transport loss (address book for re-form). Absent when the node
   * runs no reachable server.
   */
  advertisedUrl?: string
}

/** Second handshake leg on success (host → node): admits the node. */
export interface JoinGrant {
  kind: 'join-grant'
  officeId: string
  assignedNodeId: NodeId
  /** M2: negotiated version + effective caps + current authority tenure baseline. */
  pv?: number
  caps?: number
  /** Current authority tenure at admission, so a joiner aligns its term baseline. */
  term?: number
}

/** Second handshake leg on failure (host → node): rejects with a reason code. */
export interface JoinReject {
  kind: 'join-reject'
  officeId: string
  reason:
    | 'CREDENTIAL_INVALID'
    | 'CREDENTIAL_REVOKED'
    | 'OFFICE_MISMATCH'
    | 'MALFORMED'
    | 'VERSION_INCOMPATIBLE'
}

/**
 * Presence transition broadcast. `members` carries the identity ids affected by
 * this status change. The two-threshold debounce machine emits 'suspect' on the
 * buffer transition and 'offline' only on confirmed.
 */
export interface PresenceUpdate {
  kind: 'presence-update'
  officeId: string
  nodeId: NodeId
  status: 'online' | 'suspect' | 'offline'
  members: string[]
  since: number
}

/** Periodic liveness ping (any node → peers). */
export interface Heartbeat {
  kind: 'heartbeat'
  officeId: string
  fromNode: NodeId
  ts: number
}

/**
 * Host → node: "please re-handshake". Sent when the host receives a bare
 * heartbeat from a node it has confirmed-offline whose WS session is still
 * connected. Recovery from confirmed-offline requires a fresh JOIN — a node
 * with stale state must re-handshake, not silently revive — but a still-connected
 * node never triggers the joiner's reconnect-reauth path, so without this signal
 * it deadlocks — heartbeats keep arriving and keep being dropped. The node
 * responds by re-sending its join-request over the live socket. Control plane.
 */
export interface RejoinRequest {
  kind: 'rejoin-request'
  officeId: string
}

// ── Remote execution (position transparency) ──

/**
 * A wake payload reduced to pure data so it crosses the wire. Mirrors the
 * argument shape of OrchestrationSessionDeps.sendAppChatMessage minus anything
 * non-serializable; the owner reconstructs the turn locally from these fields.
 */
export interface SerializedWakeRequest {
  appId: string
  spaceId: string
  message: string
  conversationId: string
  teamContext: TeamTriggerContext
}

/**
 * Wake a member's turn on the node that OWNS it, regardless of direction:
 *   authority → owner   (the host wakes a joiner-owned member), and
 *   joiner    → authority (a joiner wakes a host-owned member over its upstream
 *                          link; the host owns the member and runs it locally).
 * `fromNode` is the originating node so the owner can reflux the turn-complete
 * back to it. Absent on links that resolve the source from the session binding.
 */
export interface WakeFrame {
  kind: 'wake'
  officeId: string
  correlationId: string
  request: SerializedWakeRequest
  fromNode?: NodeId
}

/** Owner → authority: the remote turn finished; carries the pure-data outcome. */
export interface TurnCompleteFrame {
  kind: 'turn-complete'
  officeId: string
  correlationId: string
  outcome: TurnCompletion
}

// ── Activity-stream relay (cross-node activity stream) ──

/**
 * One captured agent event, reduced to pure data so it crosses the wire. `seq`
 * is the per-sessionKey monotonic streamSeq; `kind` drives the
 * backpressure/gap-fill boundary (milestone kept, incremental droppable);
 * `channel`/`spaceId`/`payload` are replayed verbatim into the viewer's local
 * Emitter so the renderer is unchanged.
 */
export interface StreamFrame {
  seq: number
  kind: 'milestone' | 'incremental'
  channel: string
  spaceId: string
  payload: Record<string, unknown>
}

/**
 * A batch of activity frames for one team session (owner → authority → viewers).
 * `baseSeq` is the first frame's streamSeq (fast contiguity check).
 */
export interface StreamFramesFrame {
  kind: 'stream-frames'
  officeId: string
  sessionKey: string
  baseSeq: number
  frames: StreamFrame[]
  /**
   * The producing process's run id (fresh per process start). Stream seq is
   * in-memory on the owner, so an owner restart begins a NEW seq domain at 1;
   * viewers key their dedup watermark on this and reset it when the run
   * changes — otherwise every post-restart frame reads as a duplicate of the
   * previous run's higher seqs and is silently dropped. Absent on frames from
   * older producers (legacy watermark behavior preserved).
   */
  originRun?: string
}

/**
 * Classify an agent event channel into the relay's two-level droppability band.
 * Incremental = high-volume `*-delta` (droppable under backpressure); everything
 * else (tool-call/tool-result/message AND low-volume one-shots like
 * agent:thought) is a milestone — kept.
 */
export function classifyChannel(channel: string): 'milestone' | 'incremental' {
  return channel.endsWith('-delta') ? 'incremental' : 'milestone'
}

// ── Roster sync (host → joiner: materialize the shadow office) ──

/**
 * One member as seen on the wire. `ownerNodeId` is ABSOLUTE here: the host
 * resolves its own locally-owned members (stored as SELF) to its own node id
 * before sending, so every receiver knows the true owner. Each node remaps it
 * back to SELF-relative when it stores the row (the crux that lets a joiner's
 * RelayCapture recognize its own member as owned-by-SELF).
 */
export interface RosterMemberSnap {
  appId: string
  memberName: string
  role: string
  /** What this member is responsible for in this office, in its owner's words. */
  duty?: string | null
  /**
   * Whether this member's owner lets teammates put a periodic check on it. Only
   * this one bit of the owner's policy travels — enough to refuse early with a
   * readable message; the policy itself never leaves the machine it guards.
   */
  acceptsChecks?: boolean
  isLead: boolean
  ownerNodeId: NodeId
  memberIdentity: string | null
  ownerDisplayName: string | null
  /**
   * Live runtime status on the authority (idle/working/waiting_user/error), so a
   * joiner animates the working pulse in step with the host. Transient projection
   * (never persisted as a column); absent → 'idle' (default behaviour preserved).
   */
  status?: TeamMemberRuntimeStatus
  /** Title of the task a working member is on, for the node summary. */
  currentTaskTitle?: string
  /** Live busy assignments with authority-generated labels (see RosterBusyEntry). */
  busy?: RosterBusyEntry[]
}

/**
 * One office node's reachability entry in the roster's address book. Lets every
 * participant learn how to DIAL a peer (e.g. a newly-elected authority) without
 * a discovery protocol — the invite model stays intact, this is just "the
 * contact card of nodes already admitted".
 */
export interface RosterNodeSnap {
  nodeId: NodeId
  displayName: string | null
  advertisedUrl: string | null
  joinedAt: number
}

/** Full office roster the host projects to joiners (team meta + members + edges). */
export interface RosterSnapshot {
  team: {
    id: string
    name: string
    goal: string
    leadAppId: string | null
    collabMode: 'structured' | 'free'
    /** The host's own node id — the authority of this office (joiner stores it as host_node_id). */
    hostNodeId: NodeId
    /**
     * The office's currently-open run epoch, if any. A joiner uses it to derive
     * the live session key so an in-progress run's history renders immediately on
     * join. Absent when no run is open.
     */
    epochId?: string
    /**
     * The office's live run status on the authority (idle/running/...), so a
     * joiner's run banner goes "running" the moment the host starts a run. Absent
     * → 'idle' (default behaviour preserved).
     */
    status?: TeamStatus
  }
  members: RosterMemberSnap[]
  edges: Array<{ fromAppId: string; toAppId: string }>
  /**
   * Node address book (see RosterNodeSnap). Joiners keep it in memory only —
   * NEVER as office_nodes rows, whose presence FSM assumes a direct transport
   * to every row it sweeps. Absent on pre-address-book hosts.
   */
  nodes?: RosterNodeSnap[]
}

/** Host → joiner(s): the current office roster, sent on every membership change. */
export interface RosterFrame {
  kind: 'roster'
  officeId: string
  snapshot: RosterSnapshot
}

/**
 * Joiner → host: the joiner is leaving the office and asks the host to drop the
 * members it brought. The symmetric counterpart of a host `member-removed` kick:
 * a joiner can only remove members it OWNS (the host re-checks ownership). Sent
 * before the joiner tears down its own side so the host roster converges.
 */
export interface MemberLeaveFrame {
  kind: 'member-leave'
  officeId: string
  fromNode: NodeId
  appIds: string[]
}

export type FederationMessage =
  | JoinRequest
  | JoinGrant
  | JoinReject
  | PresenceUpdate
  | Heartbeat
  | RejoinRequest
  | WakeFrame
  | TurnCompleteFrame
  | StreamFramesFrame
  | RosterFrame
  | MemberLeaveFrame
  // ── M2 family (authority / replication / artifact), defined in ./protocol-m2 ──
  | M2Frame
  // ── Unified feed-log sync (control-plane outbox), defined in ./log/types ──
  // Type-only import; classified as the 'control' plane by framePlane's default.
  | FeedSyncFrame

// ── Transport planes (outbound prioritization) ──

/**
 * The three transport planes a frame belongs to, in strict priority order. A
 * congested link drains 'control' first and sheds 'artifact' first, so a large
 * artifact transfer can never head-of-line-block or starve coordination, and a
 * control frame (join / presence / election / replication / ack) is never the
 * one dropped on overflow.
 */
export type FramePlane = 'control' | 'stream' | 'artifact'

/** Classify a frame into its transport plane. Everything not stream/artifact is control. */
export function framePlane(frame: FederationMessage): FramePlane {
  switch (frame.kind) {
    case 'stream-frames':
      return 'stream'
    case 'artifact-fetch':
    case 'artifact-bytes':
      return 'artifact'
    default:
      return 'control'
  }
}

// ── Presence projection ──

/** A single node's presence as projected from office_nodes. */
export interface NodePresence {
  nodeId: NodeId
  identity: string
  displayName: string | null
  status: 'online' | 'suspect' | 'offline'
  lastSeen: number
}

/** The office-wide presence snapshot. */
export interface PresenceSnapshot {
  officeId: string
  nodes: NodePresence[]
}

/** Authority view for an office, surfaced read-only for observability. */
export interface OfficeAuthorityInfo {
  /** The node this office currently believes is the authority (null until known). */
  authorityNodeId: NodeId | null
  /** Current authority tenure. */
  term: number
  isSelf: boolean
  /** Whether the office is paused (partition minority). */
  paused: boolean
}

/**
 * Read-only presence + authority view for one office, assembled for the
 * federation observability surface. Combines the node presence snapshot with
 * this node's role in the office and the (M2) authority state; authority is null
 * when M2 is off (then authority is fixed to the host, conveyed by `role`).
 */
export interface OfficePresenceSnapshot {
  officeId: string
  role: 'host' | 'joined'
  nodes: NodePresence[]
  authority: OfficeAuthorityInfo | null
}

/** Projection helper kept here so consumers share one mapping. */
export function nodeToPresence(node: OfficeNode): NodePresence {
  return {
    nodeId: node.nodeId,
    identity: node.identity,
    displayName: node.displayName,
    status: node.status,
    lastSeen: node.lastSeen,
  }
}
