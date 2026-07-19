/**
 * apps/runtime/federation -- M2 protocol contract (authority / replication / artifact)
 *
 * The SINGLE source of truth for every M2 control frame shape, capability bit,
 * reject reason and the cross-cutting envelope fields (term / fid / seq). M1
 * frames (join / presence / wake / turn-complete / stream-frames / roster) stay
 * exactly as defined in `./types.ts`; this file ADDS the M2 family without
 * touching their wire shape.
 *
 * Design rules honoured here:
 *   - `term` is the authority tenure (a monotonic integer), distinct from the
 *     kernel's run-`epochId` (a string). State-change control frames carry it so
 *     a stale tenure's frame is rejected (EPOCH_STALE) after a handover.
 *   - `fid` is a cross-restart globally-unique frame id (UUIDv4) used for
 *     ack/reject correlation and bounded dedup. It is orthogonal to `seq`: `seq`
 *     orders & idempotently de-dups replication writes; `fid` guards against
 *     ack-loss retransmits.
 *   - Engineers building the authority/* logic modules IMPORT the shapes they
 *     need from here and never redefine them, so node ↔ authority ↔ future Go
 *     server stay wire-compatible.
 *
 * Renderer-unaware: pure data shapes + small pure helpers, no Node/Electron deps.
 */

import type { NodeId } from './types'

// ── Protocol version ──
//
// `pv` is the monotonic major version. A bump = a non-backward-compatible
// envelope/handshake change. Backward-compatible additions ride capability bits,
// never a `pv` bump. Nodes that omit `pv` are treated as version 1.
//
// History:
//   1 — M1 join/presence/wake/relay (no negotiation on the wire).
//   2 — M2 authority/replication/artifact family.
//   3 — device-key node-identity handshake (WS auth challenge–response) +
//       negotiation enforced at join. Pre-3 nodes cannot prove a node identity,
//       so the minimum supported version is 3: an unprovable node is rejected at
//       join (VERSION_INCOMPATIBLE) instead of being half-admitted and then
//       having every federation frame dropped at the transport gate.

export const PROTOCOL_VERSION_CURRENT = 3
export const PROTOCOL_VERSION_MIN_SUPPORTED = 3

/**
 * Gateway WIRE protocol version (v2-gw), a separate namespace from `pv` above:
 * it versions the node ↔ relay envelope vocabulary (term-locked host attach,
 * hostless election relay), not the node ↔ node federation protocol. Declared
 * on gateway auth; a gateway rejects a declared-and-incompatible client
 * explicitly instead of running a silent mixed-version session.
 */
export const GATEWAY_WIRE_PV = 2

// ── Capability bits ──
//
// 64-bit space conceptually; we only allocate the low bits M1/M2 use, which stay
// inside the JS safe-integer range, so a plain number bitmask is correct here.
// Meaning is append-only: an allocated bit's meaning is NEVER reused/rewritten.

export const CAP = {
  /** Baseline control family (join/presence/wake/turn-complete). Always set. */
  CORE_CONTROL: 1 << 0,
  /** Activity-stream relay (`stream-frames`). */
  ACTIVITY_STREAM: 1 << 1,
  /** Artifact lazy fetch (`artifact-fetch`/`artifact-bytes`). */
  ARTIFACT_FETCH: 1 << 2,
  /** Blackboard replication (`blackboard-replicate`/`ack`) — hot-standbys set it. */
  REPLICATION: 1 << 3,
  /** Authority election (`authority-claim`/`confirm`) — P2P sets it; central does not. */
  AUTHORITY_ELECTION: 1 << 4,
  /** Governance egress (`member-removed`/`office-dissolved` + roster re-broadcast on every mutation). */
  GOVERNANCE_EGRESS: 1 << 5,
  /** Owner-served run history pull (`history-request`/`history-response`). */
  HISTORY_PULL: 1 << 6,
  /**
   * Unified feed-log sync for the control plane (`feed-subscribe`/`feed-entries`/
   * `feed-ack`/`feed-nack`): effectively-once wake / turn-complete delivery over a
   * persistent per-author outbox. Advertised in DEFAULT_P2P_CAPS; see the mask
   * comment below for how routing actually behaves.
   */
  FEED_SYNC: 1 << 7,
  /**
   * Session-transcript feed replication (`feed-advertise` + `session:<key>`
   * feeds): every member's run transcript is proactively replicated to every
   * office node (multi-replica, IM-style), so history opens from the local copy
   * and survives an offline owner. Advertised in DEFAULT_P2P_CAPS; like
   * FEED_SYNC the bit is informational — an older node simply ignores the
   * frames (forward-compatible) and stays on the pull path.
   */
  SESSION_FEED: 1 << 8,
} as const

export type CapMask = number

/** All baseline caps a P2P node advertises by default. */
export const DEFAULT_P2P_CAPS: CapMask =
  CAP.CORE_CONTROL |
  CAP.ACTIVITY_STREAM |
  CAP.ARTIFACT_FETCH |
  CAP.REPLICATION |
  CAP.AUTHORITY_ELECTION |
  CAP.GOVERNANCE_EGRESS |
  CAP.HISTORY_PULL |
  // Control-plane feed sync ON by default: a directed wake/turn-complete always
  // rides the durable, effectively-once feed outbox (the manager's ctrl shim).
  // The cap bit is advertised but NOT consulted for routing — the only fallback
  // to the raw send path is a node whose feed store is unavailable.
  CAP.FEED_SYNC |
  CAP.SESSION_FEED

export function negotiateCaps(a: CapMask, b: CapMask): CapMask {
  return (a & b) >>> 0
}

/** Negotiated protocol version = min(requested current, our current), floored. */
export function negotiateVersion(
  requestCurrent: number,
  requestMin: number,
  selfCurrent: number = PROTOCOL_VERSION_CURRENT,
  selfMin: number = PROTOCOL_VERSION_MIN_SUPPORTED
): number | null {
  const negotiated = Math.min(requestCurrent, selfCurrent)
  if (negotiated >= Math.max(requestMin, selfMin)) return negotiated
  return null
}

export function hasCap(mask: CapMask, bit: number): boolean {
  return (mask & bit) === bit
}

// ── Tenure (authority term) & frame id ──

/** The authority tenure: a per-office monotonic integer, +1 on each election. */
export type AuthorityTerm = number

/** A cross-restart globally-unique frame id (UUIDv4) for ack/reject + dedup. */
export type Fid = string

// ── Reject reason codes ──

export type RejectReason =
  // Handshake / framing
  | 'CREDENTIAL_INVALID'
  | 'CREDENTIAL_REVOKED'
  | 'CREDENTIAL_EXPIRED'
  | 'OFFICE_MISMATCH'
  | 'OFFICE_UNKNOWN'
  | 'MALFORMED_FRAME'
  | 'FRAME_TOO_LARGE'
  | 'VERSION_INCOMPATIBLE'
  | 'CAPABILITY_REQUIRED_MISSING'
  // Authority / scope
  | 'EPOCH_STALE'
  | 'STALE_ROSTER'
  | 'NOT_A_CANDIDATE'
  | 'NOT_AUTHORITY'
  | 'SCOPE_DENIED'
  /**
   * Election restriction (Raft-style): a voter refuses a candidate whose
   * committed log is behind the voter's own known committed water mark — i.e. the
   * candidate is missing a write the voter knows is committed. Prevents electing a
   * stale leader while an up-to-date voter is reachable (degrades to pause, never
   * a committed-write loss via a behind leader).
   */
  | 'STALE_LOG'

// ── Replication ops ──

export type ReplicationOp =
  | 'post_task'
  | 'update_task'
  | 'post_finding'
  | 'roster_join'
  | 'roster_leave'

// ── Artifact reference ──

/**
 * A logical, owner-anchored artifact handle — NOT a bare path. The owner node is
 * the single source of truth; viewers fetch on demand. `ref` is the owner-local
 * handle (e.g. a relative artifact path) the owner resolves against its store.
 */
export interface ArtifactRef {
  ownerNodeId: NodeId
  teamId: string
  epochId: string
  ref: string
}

// ── M2 control frames ──

/** Candidate → peers: claim the authority for a new tenure. */
export interface AuthorityClaimFrame {
  kind: 'authority-claim'
  officeId: string
  fromNode: NodeId
  /** Proposed new tenure (currentTerm + 1). */
  term: AuthorityTerm
  /** Candidate's last committed replication seq (handover continuity baseline). */
  baseSeq: number
  /** Candidate's known roster version (last-known-roster quorum basis). */
  rosterEpoch: number
  /** Candidate's known last-roster node set (so a receiver can judge quorum basis). */
  rosterNodes: NodeId[]
  fid: Fid
}

/** Peer → candidate: accept (or reject via `accept:false`) a claim. */
export interface AuthorityConfirmFrame {
  kind: 'authority-confirm'
  officeId: string
  fromNode: NodeId
  term: AuthorityTerm
  accept: boolean
  reFid: Fid
  fid: Fid
}

/**
 * Winner → peers: an election concluded at `term`, `fromNode` is the new
 * authority. A pure convergence accelerator: receivers run the SAME
 * observe-frame-term path that any established-authority frame drives (realign
 * believed authority, redial, step a resurrected old authority down), so a
 * loser/late voter re-forms its transport immediately instead of waiting for
 * the next replicate frame. A stale term is ignored there — a resurrected old
 * authority cannot use this to reclaim the office.
 */
export interface AuthorityAnnounceFrame {
  kind: 'authority-announce'
  officeId: string
  fromNode: NodeId
  term: AuthorityTerm
  fid: Fid
}

/** Member node → authority: a blackboard write to be sequenced + persisted. */
export interface BlackboardWriteFrame {
  kind: 'blackboard-write'
  officeId: string
  fromNode: NodeId
  term: AuthorityTerm
  op: ReplicationOp
  payload: Record<string, unknown>
  taskId?: string
  fid: Fid
}

/** Authority → hot-standby: a committed/append replication log entry. */
export interface BlackboardReplicateFrame {
  kind: 'blackboard-replicate'
  officeId: string
  fromNode: NodeId
  term: AuthorityTerm
  /** per-office monotonic replication seq assigned by the single writer. */
  seq: number
  op: ReplicationOp
  payload: Record<string, unknown>
  taskId?: string
  /**
   * The authority's committed water mark at send time (Raft leaderCommit). Lets a
   * hot-standby learn how far the log is committed so it can later enforce the
   * election restriction (refuse a candidate behind this mark).
   */
  committedSeq?: number
  fid: Fid
}

/** Generic reliable-control ack. */
export interface AckFrame {
  kind: 'ack'
  officeId: string
  fromNode: NodeId
  reFid: Fid
  /** Highest replication seq the sender has applied (replication ack). */
  ackedSeq?: number
  fid: Fid
}

/**
 * Hot-standby → authority: a standby whose applied seq fell behind (it missed
 * `blackboard-replicate` frames while briefly disconnected) asks the authority
 * to replay the gap. Without this a missed frame left a PERMANENT hole — the
 * standby applied later, higher seqs on top of the gap and never backfilled it.
 */
export interface CatchupRequestFrame {
  kind: 'catchup-request'
  officeId: string
  fromNode: NodeId
  /** Highest contiguous seq the standby holds; the authority replays above it. */
  lastAckedSeq: number
  fid: Fid
}

/** One replayed log entry inside a catch-up response (a replicate frame's core). */
export interface CatchupEntry {
  seq: number
  term: AuthorityTerm
  op: ReplicationOp
  payload: Record<string, unknown>
  taskId?: string
  fid: Fid
}

/**
 * Authority → hot-standby: the gap replay. `incremental` carries the missing log
 * entries (contiguous above the request's lastAckedSeq); `snapshot` is sent when
 * the gap predates the retained log, carrying the full board to replace-apply.
 */
export interface CatchupResponseFrame {
  kind: 'catchup-response'
  officeId: string
  fromNode: NodeId
  term: AuthorityTerm
  reFid: Fid
  mode: 'incremental' | 'snapshot'
  /** Present when mode='incremental'. */
  entries?: CatchupEntry[]
  /**
   * The responder's committed water mark. The consumer adopts it (capped at its
   * own applied seq) after replay, so a freshness-vetoed election candidate can
   * re-claim with a baseSeq that passes the voters' STALE_LOG check.
   */
  committedSeq?: number
  /** Present when mode='snapshot' (opaque board state the standby replace-applies). */
  snapshot?: {
    tasks: unknown[]
    findings: unknown[]
    roster: unknown[]
    appliedSeq: number
    term: number
  }
  fid: Fid
}

/** Generic reliable-control reject with a reason code. */
export interface RejectFrame {
  kind: 'reject'
  officeId: string
  fromNode: NodeId
  reFid: Fid
  reason: RejectReason
  detail?: Record<string, unknown>
  retryable: boolean
  fid: Fid
}

/** Viewer → owner: request artifact bytes by logical ref. */
export interface ArtifactFetchFrame {
  kind: 'artifact-fetch'
  officeId: string
  fromNode: NodeId
  ref: ArtifactRef
  /**
   * Set by the host when forwarding a joiner's fetch to the artifact's true owner
   * (joiners only link to the host, so a joiner-to-joiner read must hop through
   * it). One hop max: a relayed fetch is never relayed again. Mirrors
   * {@link HistoryRequestFrame.relayed}.
   */
  relayed?: boolean
  fid: Fid
}

/** Owner → viewer: artifact bytes (base64) or an error. */
export interface ArtifactBytesFrame {
  kind: 'artifact-bytes'
  officeId: string
  fromNode: NodeId
  reFid: Fid
  ref: ArtifactRef
  /** base64-encoded bytes; absent when `error` is set. */
  bytesBase64?: string
  /** Non-null when the owner refuses/cannot serve (not found / not published). */
  error?: string
  fid: Fid
}

// ── Governance egress frames ──
//
// Membership/lifecycle mutations the owning side projects to participants so a
// joiner's roster converges WITHOUT re-requesting it. They are authority-tenure
// stamped (`term`) like other state-change frames; a stale-tenure projection is
// ignored the same way replication is. They carry no payload bytes beyond the
// subject id — the receiver re-derives state from its own roster.

/** Authority → participants: a member was removed (kicked) from the office. */
export interface MemberRemovedFrame {
  kind: 'member-removed'
  officeId: string
  fromNode: NodeId
  term: AuthorityTerm
  /** The removed member's app id (self-relative on the wire is meaningless here:
   * this is a team-member app id, not a node id). */
  appId: string
  fid: Fid
}

/** Authority → participants: the office was dissolved by its owner. */
export interface OfficeDissolvedFrame {
  kind: 'office-dissolved'
  officeId: string
  fromNode: NodeId
  term: AuthorityTerm
  fid: Fid
}

// ── Owner-served run history ──
//
// A viewer pulls a member's run transcript from the node that OWNS that member,
// mirroring the artifact plane's owner-served authorization: the owner serves
// only history for members it actually owns; everything else returns an `error`
// code (never a bare file, never another node's transcript). The reply is the
// already-serialized transcript the owner reads from its local store via an
// injected reader; the federation layer never opens chat storage itself.

/**
 * A rendered thought carried with a transcript message. Transport-opaque: mirrors
 * the renderer Thought shape so a viewer renders it without an adaptation layer.
 */
export interface SerializedThought {
  id: string
  type: 'thinking' | 'text' | 'tool_use' | 'tool_result' | 'system' | 'result' | 'error'
  content: string
  timestamp: string
  toolName?: string
  toolInput?: Record<string, unknown>
  toolOutput?: string
  isError?: boolean
  toolResult?: { output: string; isError: boolean; timestamp: string }
}

/** Lightweight thought summary carried with a transcript message. */
export interface SerializedThoughtsSummary {
  count: number
  types: Partial<Record<string, number>>
  duration?: number
}

/** A single serialized transcript message (owner-local shape, transport-opaque). */
export interface SerializedHistoryMessage {
  /**
   * 1-based ordinal position in the member's full transcript. The transcript is
   * append-only and immutable, so this is stable across reads — it is the anchor
   * a viewer sends back as `sinceSeq` to pull only the tail instead of the whole
   * transcript every time (the fix for slow full re-pulls).
   */
  seq: number
  role: string
  content: string
  /**
   * Full thinking / tool-call trace for an assistant message, so a remote viewer's
   * post-run history backfill shows the SAME thought process the live relay did —
   * not just the final text. Without this, a finished remote member's thinking
   * vanishes the moment the live stream is replaced by the backfilled transcript.
   * Absent for user messages and pre-thoughts transcripts.
   */
  thoughts?: SerializedThought[]
  thoughtsSummary?: SerializedThoughtsSummary
  /** epoch-ms timestamp; optional for messages that predate timestamping. */
  ts?: number
}

/** Viewer → owner: request a member's run history for an epoch. */
export interface HistoryRequestFrame {
  kind: 'history-request'
  officeId: string
  fromNode: NodeId
  teamId: string
  /** The member whose transcript is requested (must be owned by the receiver). */
  appId: string
  epochId: string
  /**
   * Highest transcript seq the viewer already holds cached. The owner replies
   * with only messages whose seq is greater — an incremental tail pull. Absent
   * or 0 means "send the whole transcript" (first load / no cache).
   */
  sinceSeq?: number
  /**
   * Set by the host when forwarding a joiner's request to the member's true
   * owner (joiners only link to the host, so a joiner-to-joiner read must hop
   * through it). One hop max: a relayed request is never relayed again.
   */
  relayed?: boolean
  fid: Fid
}

/** Owner → viewer: the requested transcript, or an `error` code. */
export interface HistoryResponseFrame {
  kind: 'history-response'
  officeId: string
  fromNode: NodeId
  reFid: Fid
  teamId: string
  appId: string
  epochId: string
  /** Present only on success; absent when `error` is set. */
  messages?: SerializedHistoryMessage[]
  /** Technical code (e.g. 'not-owned' / 'not-found'); NEVER surfaced to users. */
  error?: string
  fid: Fid
}

/** The union of all M2-added frames (folded into FederationMessage in ./types). */
export type M2Frame =
  | AuthorityClaimFrame
  | AuthorityConfirmFrame
  | AuthorityAnnounceFrame
  | BlackboardWriteFrame
  | BlackboardReplicateFrame
  | AckFrame
  | RejectFrame
  | CatchupRequestFrame
  | CatchupResponseFrame
  | ArtifactFetchFrame
  | ArtifactBytesFrame
  | MemberRemovedFrame
  | OfficeDissolvedFrame
  | HistoryRequestFrame
  | HistoryResponseFrame

/** Frame kinds the M2 dispatch layer owns (everything outside the M1 set). */
export const M2_FRAME_KINDS: ReadonlySet<string> = new Set<M2Frame['kind']>([
  'authority-claim',
  'authority-confirm',
  'authority-announce',
  'blackboard-write',
  'blackboard-replicate',
  'ack',
  'reject',
  'catchup-request',
  'catchup-response',
  'artifact-fetch',
  'artifact-bytes',
  'member-removed',
  'office-dissolved',
  'history-request',
  'history-response',
])

export function isM2Frame(frame: { kind: string }): frame is M2Frame {
  return M2_FRAME_KINDS.has(frame.kind)
}

// ── Bounded frame-id dedup ──

/**
 * Bounded `(fromNode, fid)` dedup so an ack-loss retransmit is recognised as a
 * duplicate instead of double-applied. Eviction is insertion-order (FIFO): the
 * window must exceed the max retransmit timeout, which `maxEntries` bounds by
 * capacity rather than time (cheaper, deterministic for tests).
 */
export interface FidDedup {
  /** True if this (fromNode, fid) was already seen; otherwise records + returns false. */
  seen(fromNode: NodeId, fid: Fid): boolean
  size(): number
}

export function createFidDedup(maxEntries = 4096): FidDedup {
  const order: string[] = []
  const set = new Set<string>()
  return {
    seen(fromNode, fid) {
      const key = `${fromNode}\u0000${fid}`
      if (set.has(key)) return true
      set.add(key)
      order.push(key)
      if (order.length > maxEntries) {
        const evicted = order.shift()
        if (evicted !== undefined) set.delete(evicted)
      }
      return false
    },
    size: () => set.size,
  }
}
