/**
 * Owner-served turn abort. A member's turn runs only in the process that owns
 * that member, so "stop" pressed on another node's teammate must travel to the
 * owner — aborting locally would look for a session that was never here and
 * silently succeed while the teammate kept working. The owner aborts ONLY a
 * member it actually owns in this office, through the injected `stopMemberTurn`;
 * it never reaches into chat storage itself.
 *
 * Shaped like ./history-fetch (same pending table, host relay and ownership
 * gate) because it is the same question asked of the same owner — only the
 * answer is a fact rather than a payload.
 *
 * Renderer-unaware: pure data + Node `crypto`, no Electron deps.
 */

import { randomUUID } from 'crypto'
import type { TeamStore } from '../../../team/types'
import type { StopTurnRequestFrame, StopTurnResponseFrame, Fid } from '../protocol-m2'
import { createFidDedup } from '../protocol-m2'
import type { FederationMessage, NodeId } from '../types'
import { SELF_NODE_ID } from '../../../../../shared/apps/team-types'

const LOG_TAG = '[StopTurn]'

/**
 * Ceiling for an unanswered stop before it rejects. Shorter than the history
 * plane's: stop is a button under someone's finger, and an owner that cannot
 * answer in this window is one whose turn the user cannot be told about either.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 6000

/** Owner-side rejection codes (technical, never user-facing). */
const ERR_NOT_OWNED = 'stop-not-owned'
const ERR_RELAY_FAILED = 'stop-relay-failed'
export const STOP_ERR_OWNER_UNREACHABLE = 'stop-owner-unreachable'

/**
 * Headroom subtracted from the request timeout for the relay's upstream leg, so
 * the host reports a definite relay failure to the requester BEFORE the
 * requester's own deadline fires (a raced double-timeout would surface as a
 * silent drop instead of an error code).
 */
const RELAY_TIMEOUT_HEADROOM_MS = 1500

/**
 * OWNER side: abort the turn running for one of this node's members. Injected so
 * this module never imports app-chat. `requester` carries the authenticated
 * source so a future scope filter can refuse a viewer that may not interrupt.
 * Returns whether a turn was actually running.
 */
export type StopMemberTurn = (args: {
  teamId: string
  appId: string
  epochId: string
  requester: { nodeId: NodeId; frame: StopTurnRequestFrame }
}) => Promise<boolean>

export interface StopTurnServiceDeps {
  /** The office this node speaks for. */
  officeId: string
  /** This node's own id (the `fromNode` stamped on outgoing frames). */
  selfNodeId: NodeId
  /** Read-only access to team data — ownership is checked via team_members. */
  store: TeamStore
  /** Plane transport: deliver a federation frame to a target node. */
  send: (to: NodeId, frame: FederationMessage) => void
  /** OWNER side: abort a member's turn (scope-aware seam). */
  stopMemberTurn: StopMemberTurn
  /**
   * HOST relay: whether a member's true owner is currently reachable, so a
   * relayed stop fails fast with a definite code instead of waiting out the
   * relay timeout on a known-dead owner. Absent → always attempt the relay.
   */
  isNodeReachable?: (nodeId: NodeId) => boolean
  /** Requester-side timeout; defaults to {@link DEFAULT_REQUEST_TIMEOUT_MS}. */
  requestTimeoutMs?: number
}

export interface StopTurnService {
  /**
   * REQUESTER: ask the owner to abort a member's turn. Resolves with whether a
   * turn was running, or rejects when the owner refuses / cannot be reached.
   */
  stop(args: { ownerNodeId: NodeId; teamId: string; appId: string; epochId: string }): Promise<boolean>
  /** OWNER: authorize + carry out (or refuse) an incoming stop request. */
  handleRequest(from: NodeId, frame: StopTurnRequestFrame): void
  /** REQUESTER: settle a pending stop when its response arrives. */
  handleResponse(from: NodeId, frame: StopTurnResponseFrame): void
  /** Single entry the authority routes onM2Frame to (stop plane only). */
  handleM2Frame(from: NodeId, frame: StopTurnRequestFrame | StopTurnResponseFrame): void
  /** Pending stops awaiting a response (observability/tests). */
  pendingCount(): number
}

/** A requester's stop awaiting its `stop-turn-response`, keyed by request fid. */
interface PendingStop {
  resolve: (stopped: boolean) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export function createStopTurnService(deps: StopTurnServiceDeps): StopTurnService {
  const requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS

  // Owner-side dedup: a double-press retransmit is carried out at most once.
  const inboundDedup = createFidDedup()
  // Requester-side pending table, keyed by the request fid we minted.
  const pending = new Map<Fid, PendingStop>()

  function settle(fid: Fid): PendingStop | undefined {
    const entry = pending.get(fid)
    if (entry) {
      clearTimeout(entry.timer)
      pending.delete(fid)
    }
    return entry
  }

  function stop(args: {
    ownerNodeId: NodeId
    teamId: string
    appId: string
    epochId: string
  }): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const fid = randomUUID()
      const timer = setTimeout(() => {
        if (settle(fid)) {
          reject(new Error(`stop-turn-request timed out after ${requestTimeoutMs}ms`))
        }
      }, requestTimeoutMs)
      if (typeof timer.unref === 'function') timer.unref()

      pending.set(fid, { resolve, reject, timer })

      const frame: StopTurnRequestFrame = {
        kind: 'stop-turn-request',
        officeId: deps.officeId,
        fromNode: deps.selfNodeId,
        teamId: args.teamId,
        appId: args.appId,
        epochId: args.epochId,
        fid,
      }
      deps.send(args.ownerNodeId, frame)
    })
  }

  /** Send a stop-turn-response (outcome or error) to `to` for the given request. */
  function reply(
    to: NodeId,
    frame: StopTurnRequestFrame,
    body: { stopped: boolean } | { error: string }
  ): void {
    const response: StopTurnResponseFrame = {
      kind: 'stop-turn-response',
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
   * HOST relay: a stop for a member owned by ANOTHER node landed here because
   * joiners only link to the host — forward it one hop to the true owner and pipe
   * the owner's answer back. The forwarded frame keeps the original `fromNode`
   * (the true requester, preserved for the scope seam) and `fid` (the owner's
   * reply reFid then correlates the relay's pending entry); `relayed` caps it to a
   * single hop. Returns false when this node cannot relay → the caller falls back
   * to the plain not-owned refusal.
   */
  function relayRequest(from: NodeId, frame: StopTurnRequestFrame): boolean {
    if (frame.relayed) return false
    const member = deps.store.listMembersByTeam(frame.teamId).find((m) => m.appId === frame.appId)
    const owner = member?.ownerNodeId
    if (!owner || owner === SELF_NODE_ID || owner === deps.selfNodeId || owner === from) return false

    if (deps.isNodeReachable && !deps.isNodeReachable(owner)) {
      reply(from, frame, { error: STOP_ERR_OWNER_UNREACHABLE })
      return true
    }

    const relayTimeoutMs = Math.max(1000, requestTimeoutMs - RELAY_TIMEOUT_HEADROOM_MS)
    const timer = setTimeout(() => {
      if (settle(frame.fid)) {
        console.warn(
          `${LOG_TAG} relay timed out office=${deps.officeId} app=${frame.appId} owner=${owner} after ${relayTimeoutMs}ms`
        )
        reply(from, frame, { error: ERR_RELAY_FAILED })
      }
    }, relayTimeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    pending.set(frame.fid, {
      resolve: (stopped) => reply(from, frame, { stopped }),
      reject: (err) => reply(from, frame, { error: err.message }),
      timer,
    })
    deps.send(owner, { ...frame, relayed: true })
    return true
  }

  function handleRequest(from: NodeId, frame: StopTurnRequestFrame): void {
    // Retransmit safety: a duplicate stop is carried out at most once. Aborting
    // twice would reach past the turn the user meant into the one after it.
    if (inboundDedup.seen(from, frame.fid)) return

    // Ownership gate: abort a turn ONLY for a member this node owns in this
    // office. A member stored SELF-relative is owned here; a real remote owner is
    // relayed to its true owner when possible (host hop), else refused.
    const owned = deps.store
      .listMembersByTeam(frame.teamId)
      .some(
        (m) =>
          m.appId === frame.appId &&
          (m.ownerNodeId === SELF_NODE_ID || m.ownerNodeId === deps.selfNodeId)
      )
    if (frame.teamId !== deps.officeId || !owned) {
      if (frame.teamId === deps.officeId && relayRequest(from, frame)) return
      // Refused, and nothing was aborted anywhere. The requester only learns a
      // code, so without this line the machine that actually dropped the request
      // keeps no record of it — and a roster that disagrees about who owns the
      // member looks, from every side, like a stop button that does nothing.
      console.warn(
        `${LOG_TAG} refused office=${deps.officeId} reqTeam=${frame.teamId} app=${frame.appId} from=${from} reason=${ERR_NOT_OWNED}`
      )
      reply(from, frame, { error: ERR_NOT_OWNED })
      return
    }

    void deps
      .stopMemberTurn({
        teamId: frame.teamId,
        appId: frame.appId,
        epochId: frame.epochId,
        requester: { nodeId: from, frame },
      })
      .then(
        (stopped) => {
          console.log(
            `${LOG_TAG} served office=${deps.officeId} app=${frame.appId} from=${from} stopped=${stopped}`
          )
          reply(from, frame, { stopped })
        },
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          console.error(`${LOG_TAG} abort failed office=${deps.officeId} app=${frame.appId}:`, message)
          reply(from, frame, { error: message })
        }
      )
  }

  function handleResponse(_from: NodeId, frame: StopTurnResponseFrame): void {
    const entry = settle(frame.reFid)
    if (!entry) return // unknown/duplicate/already-timed-out correlation — drop.

    if (frame.error !== undefined) {
      entry.reject(new Error(frame.error))
      return
    }
    entry.resolve(frame.stopped === true)
  }

  function handleM2Frame(from: NodeId, frame: StopTurnRequestFrame | StopTurnResponseFrame): void {
    if (frame.kind === 'stop-turn-request') {
      handleRequest(from, frame)
    } else {
      handleResponse(from, frame)
    }
  }

  return { stop, handleRequest, handleResponse, handleM2Frame, pendingCount: () => pending.size }
}
