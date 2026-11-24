/**
 * Owner-served run history pull. A member's run transcript lives only on the
 * node that owns that member; a viewer asks the owning node on demand, mirroring
 * the artifact plane's owner-served authorization (see ./artifact-fetch.ts). The
 * owner serves a transcript ONLY for a member it actually owns in this office,
 * reading bytes through the injected `readMemberHistory` — it never reads
 * another node's transcript and never opens chat storage itself.
 *
 * Scope seam (defense-in-depth): `readMemberHistory` receives the AUTHENTICATED
 * requester so a future per-invite narrow scope can filter what a read-only
 * viewer may pull. Today ownership is the sole gate; the seam is pre-wired so
 * scope filtering later needs no shape change.
 *
 * Renderer-unaware: pure data + Node `crypto`, no Electron deps.
 */

import { randomUUID } from 'crypto'
import type { TeamStore } from '../../../team/types'
import type {
  HistoryRequestFrame,
  HistoryResponseFrame,
  SerializedHistoryMessage,
  Fid,
} from '../protocol-m2'
import { createFidDedup } from '../protocol-m2'
import type { FederationMessage, NodeId } from '../types'
import { SELF_NODE_ID } from '../../../../../shared/apps/team-types'

/**
 * Default ceiling for an unanswered viewer request before it rejects. Kept under
 * the renderer's patience window so an owner that goes silent mid-request surfaces
 * a neutral "unavailable" quickly instead of stalling the history pane.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 8000

/** Owner-side rejection codes (technical, never user-facing). */
const ERR_NOT_OWNED = 'history-not-owned'
const ERR_NOT_FOUND = 'history-not-found'
const ERR_RELAY_FAILED = 'history-relay-failed'

/**
 * Headroom subtracted from the request timeout for the relay's upstream leg, so
 * the host reports a definite relay failure to the requester BEFORE the
 * requester's own deadline fires (a raced double-timeout would surface as a
 * silent drop instead of an error code).
 */
const RELAY_TIMEOUT_HEADROOM_MS = 1500

/**
 * OWNER side: read a member's serialized transcript for an epoch. Injected so
 * this module never imports app-chat. `requester` carries the authenticated
 * source so a future scope filter can narrow the result. Returns null when
 * there is nothing to serve.
 */
export type ReadMemberHistory = (args: {
  teamId: string
  appId: string
  epochId: string
  requester: { nodeId: NodeId; frame: HistoryRequestFrame }
}) => SerializedHistoryMessage[] | null

export interface HistoryServiceDeps {
  /** The office this node speaks for. */
  officeId: string
  /** This node's own id (the `fromNode` stamped on outgoing frames). */
  selfNodeId: NodeId
  /** Read-only access to team data — ownership is checked via team_members. */
  store: TeamStore
  /** Plane transport: deliver a federation frame to a target node. */
  send: (to: NodeId, frame: FederationMessage) => void
  /** OWNER side: read a member transcript (scope-aware seam). */
  readMemberHistory: ReadMemberHistory
  /**
   * HOST relay: whether a member's true owner is currently reachable, so a
   * relayed request fails fast with a definite code instead of waiting out the
   * relay timeout on a known-dead owner. Absent → always attempt the relay.
   */
  isNodeReachable?: (nodeId: NodeId) => boolean
  /** Viewer-side request timeout; defaults to {@link DEFAULT_REQUEST_TIMEOUT_MS}. */
  requestTimeoutMs?: number
}

export interface HistoryService {
  /** VIEWER: request a member's transcript; resolves with messages or rejects. */
  fetch(args: {
    ownerNodeId: NodeId
    teamId: string
    appId: string
    epochId: string
    /** Highest seq already cached; the owner replies with only the tail above it. */
    sinceSeq?: number
  }): Promise<SerializedHistoryMessage[]>
  /** OWNER: authorize + serve (or error) an incoming history-request. */
  handleRequest(from: NodeId, frame: HistoryRequestFrame): void
  /** VIEWER: resolve a pending request when history-response arrives. */
  handleResponse(from: NodeId, frame: HistoryResponseFrame): void
  /** Single entry the authority routes onM2Frame to (history plane only). */
  handleM2Frame(from: NodeId, frame: HistoryRequestFrame | HistoryResponseFrame): void
  /** Pending viewer requests awaiting a response (observability/tests). */
  pendingCount(): number
}

/** A viewer request awaiting its `history-response`, keyed by request fid. */
interface PendingRequest {
  resolve: (messages: SerializedHistoryMessage[]) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export function createHistoryService(deps: HistoryServiceDeps): HistoryService {
  const requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS

  // Owner-side dedup so an ack-loss retransmit of the same request is served once.
  const inboundDedup = createFidDedup()
  // Viewer-side pending table, keyed by the request fid we minted.
  const pending = new Map<Fid, PendingRequest>()

  function settle(fid: Fid): PendingRequest | undefined {
    const entry = pending.get(fid)
    if (entry) {
      clearTimeout(entry.timer)
      pending.delete(fid)
    }
    return entry
  }

  function fetch(args: {
    ownerNodeId: NodeId
    teamId: string
    appId: string
    epochId: string
    sinceSeq?: number
  }): Promise<SerializedHistoryMessage[]> {
    return new Promise<SerializedHistoryMessage[]>((resolve, reject) => {
      const fid = randomUUID()
      const timer = setTimeout(() => {
        if (settle(fid)) {
          reject(new Error(`history-request timed out after ${requestTimeoutMs}ms`))
        }
      }, requestTimeoutMs)
      if (typeof timer.unref === 'function') timer.unref()

      pending.set(fid, { resolve, reject, timer })

      const frame: HistoryRequestFrame = {
        kind: 'history-request',
        officeId: deps.officeId,
        fromNode: deps.selfNodeId,
        teamId: args.teamId,
        appId: args.appId,
        epochId: args.epochId,
        ...(args.sinceSeq ? { sinceSeq: args.sinceSeq } : {}),
        fid,
      }
      deps.send(args.ownerNodeId, frame)
    })
  }

  /** Send a history-response (success or error) to `to` for the given request. */
  function reply(
    to: NodeId,
    frame: HistoryRequestFrame,
    body: { messages: SerializedHistoryMessage[] } | { error: string }
  ): void {
    const response: HistoryResponseFrame = {
      kind: 'history-response',
      officeId: deps.officeId,
      fromNode: deps.selfNodeId,
      reFid: frame.fid,
      teamId: frame.teamId,
      appId: frame.appId,
      epochId: frame.epochId,
      ...body,
      fid: randomUUID(),
    }
    deps.send(to, response)
  }

  /**
   * HOST relay: a request for a member owned by ANOTHER node landed here because
   * joiners only link to the host — forward it one hop to the true owner and
   * pipe the owner's answer back to the requester. The forwarded frame keeps the
   * original `fromNode` (the true requester, preserved for the scope seam) and
   * `fid` (the owner's reply reFid then correlates the relay's pending entry);
   * `relayed` caps it to a single hop. Returns false when this node cannot relay
   * (already relayed / owner unknown or unreachable) → the caller falls back to
   * the plain not-owned refusal.
   */
  function relayRequest(from: NodeId, frame: HistoryRequestFrame): boolean {
    if (frame.relayed) return false
    const member = deps.store.listMembersByTeam(frame.teamId).find((m) => m.appId === frame.appId)
    const owner = member?.ownerNodeId
    if (!owner || owner === SELF_NODE_ID || owner === deps.selfNodeId || owner === from) return false

    // Fail fast on a known-dead owner (same semantics as the manager's direct
    // fetch) — a definite code now beats a relay-timeout later.
    if (deps.isNodeReachable && !deps.isNodeReachable(owner)) {
      reply(from, frame, { error: 'history-owner-unreachable' })
      return true
    }

    const relayTimeoutMs = Math.max(1000, requestTimeoutMs - RELAY_TIMEOUT_HEADROOM_MS)
    const timer = setTimeout(() => {
      if (settle(frame.fid)) {
        console.warn(
          `[HistoryFetch] relay timed out office=${deps.officeId} app=${frame.appId} owner=${owner} after ${relayTimeoutMs}ms`
        )
        reply(from, frame, { error: ERR_RELAY_FAILED })
      }
    }, relayTimeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    pending.set(frame.fid, {
      resolve: (messages) => reply(from, frame, { messages }),
      reject: (err) => reply(from, frame, { error: err.message }),
      timer,
    })
    deps.send(owner, { ...frame, relayed: true })
    return true
  }

  function handleRequest(from: NodeId, frame: HistoryRequestFrame): void {
    // Retransmit safety: a duplicate request is answered at most once.
    if (inboundDedup.seen(from, frame.fid)) return

    const replyError = (error: string) => reply(from, frame, { error })

    // Ownership gate: serve a transcript ONLY for a member this node owns in this
    // office. A member stored SELF-relative (owner_node_id === SELF) is owned
    // here; a real remote owner is relayed to its true owner when possible (host
    // hop), else refused.
    const owned = deps.store
      .listMembersByTeam(frame.teamId)
      .some((m) => m.appId === frame.appId && (m.ownerNodeId === SELF_NODE_ID || m.ownerNodeId === deps.selfNodeId))
    if (frame.teamId !== deps.officeId || !owned) {
      if (frame.teamId === deps.officeId && relayRequest(from, frame)) return
      replyError(ERR_NOT_OWNED)
      return
    }

    const messages = deps.readMemberHistory({
      teamId: frame.teamId,
      appId: frame.appId,
      epochId: frame.epochId,
      requester: { nodeId: from, frame },
    })
    if (!messages) {
      replyError(ERR_NOT_FOUND)
      return
    }

    // Incremental tail: when the viewer already holds up to sinceSeq, send only
    // the newer messages. The transcript is append-only so a cached prefix never
    // changes — this is what turns a full re-pull into a small delta.
    const since = frame.sinceSeq ?? 0
    const tail = since > 0 ? messages.filter((m) => m.seq > since) : messages
    reply(from, frame, { messages: tail })
  }

  function handleResponse(_from: NodeId, frame: HistoryResponseFrame): void {
    const entry = settle(frame.reFid)
    if (!entry) return // unknown/duplicate/already-timed-out correlation — drop.

    if (frame.error !== undefined) {
      entry.reject(new Error(frame.error))
      return
    }
    if (frame.messages === undefined) {
      entry.reject(new Error('history-response carried neither messages nor error'))
      return
    }
    entry.resolve(frame.messages)
  }

  function handleM2Frame(from: NodeId, frame: HistoryRequestFrame | HistoryResponseFrame): void {
    if (frame.kind === 'history-request') {
      handleRequest(from, frame)
    } else {
      handleResponse(from, frame)
    }
  }

  return { fetch, handleRequest, handleResponse, handleM2Frame, pendingCount: () => pending.size }
}
