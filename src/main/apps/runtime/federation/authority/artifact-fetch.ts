/**
 * Cross-machine artifact on-demand fetch: artifacts live only on the owning
 * node, so a viewer asks the owner for the bytes behind a published
 * `ArtifactRef` and the owner streams them back base64-encoded. The owner only
 * serves a PUBLISHED team artifact of this office — never an arbitrary path,
 * never a shell-out. Runs on its own plane, isolated from the control/activity
 * queues. Byte resolution and authorization are injected so the module stays
 * Electron-free.
 */

import { randomUUID } from 'crypto'
import type { TeamStore } from '../../../team/types'
import { isPublishedArtifactRef } from '../../../team/artifact-refs'
import type {
  ArtifactRef,
  ArtifactFetchFrame,
  ArtifactBytesFrame,
  Fid,
} from '../protocol-m2'
import { createFidDedup } from '../protocol-m2'
import type { FederationMessage, NodeId } from '../types'
import { SELF_NODE_ID } from '../../../../../shared/apps/team-types'

/** Default ceiling for an unanswered viewer fetch before it rejects. */
const DEFAULT_FETCH_TIMEOUT_MS = 15000

/**
 * Rejection codes carried on the wire and thrown from {@link ArtifactService.fetch}
 * (technical, never user-facing). Exported so callers classify failures by code
 * instead of matching prose — see {@link classifyArtifactFetchFailure}.
 */
export const ARTIFACT_ERR_NOT_PUBLISHED = 'artifact-not-published'
export const ARTIFACT_ERR_NOT_FOUND = 'artifact-not-found'
export const ARTIFACT_ERR_RELAY_FAILED = 'artifact-relay-failed'
export const ARTIFACT_ERR_OWNER_UNREACHABLE = 'artifact-owner-unreachable'
export const ARTIFACT_ERR_FETCH_TIMEOUT = 'artifact-fetch-timeout'

const ERR_NOT_PUBLISHED = ARTIFACT_ERR_NOT_PUBLISHED
const ERR_NOT_FOUND = ARTIFACT_ERR_NOT_FOUND
const ERR_RELAY_FAILED = ARTIFACT_ERR_RELAY_FAILED
const ERR_OWNER_UNREACHABLE = ARTIFACT_ERR_OWNER_UNREACHABLE

/**
 * Classify a fetch failure message (a rejection code or transport prose) into
 * the categories a caller acts on. Lives here, next to the codes, so a wording
 * change can never silently break a caller's classification.
 */
export function classifyArtifactFetchFailure(
  message: string
): 'owner-unreachable' | 'not-published' | 'not-found' | 'error' {
  if (
    message === ARTIFACT_ERR_OWNER_UNREACHABLE ||
    message === ARTIFACT_ERR_RELAY_FAILED ||
    message.startsWith(ARTIFACT_ERR_FETCH_TIMEOUT)
  ) {
    return 'owner-unreachable'
  }
  if (message === ARTIFACT_ERR_NOT_PUBLISHED) return 'not-published'
  if (message === ARTIFACT_ERR_NOT_FOUND) return 'not-found'
  return 'error'
}

/**
 * Headroom subtracted from the fetch timeout for the relay's upstream leg, so the
 * host reports a definite relay failure to the requester BEFORE the requester's
 * own deadline fires (a raced double-timeout would surface as a silent drop).
 * Mirrors the history plane's relay headroom.
 */
const RELAY_TIMEOUT_HEADROOM_MS = 1500

export interface ArtifactServiceDeps {
  /** The office this node speaks for. */
  officeId: string
  /** This node's own id (the `fromNode` stamped on outgoing frames). */
  selfNodeId: NodeId
  /** Read-only access to team data — published refs are recognized via findings. */
  store: TeamStore
  /** Plane transport: deliver a federation frame to a target node. */
  send: (to: NodeId, frame: FederationMessage) => void
  /** Injectable clock (tests). */
  now?: () => number
  /**
   * OWNER side: resolve a published ref to its absolute bytes. Injected so this
   * module never imports `services/space`. Returns null when unresolvable.
   */
  resolveArtifactBytes: (ref: ArtifactRef) => Promise<Uint8Array | null>
  /** OWNER side: is this ref a published artifact of THIS office? Default: see {@link defaultIsPublished}. */
  isPublishedRef?: (ref: ArtifactRef) => boolean
  /**
   * HOST relay: whether the artifact's true owner is currently reachable, so a
   * relayed fetch fails fast with a definite code instead of waiting out the relay
   * timeout on a known-dead owner. Absent → always attempt the relay.
   */
  isNodeReachable?: (nodeId: NodeId) => boolean
  /** Viewer-side fetch timeout; defaults to {@link DEFAULT_FETCH_TIMEOUT_MS}. */
  fetchTimeoutMs?: number
}

export interface ArtifactService {
  /** VIEWER: request bytes by logical ref; resolves with bytes or rejects. */
  fetch(ref: ArtifactRef): Promise<Uint8Array>
  /** OWNER: validate + serve (or error) an incoming artifact-fetch. */
  handleFetch(from: NodeId, frame: ArtifactFetchFrame): Promise<void>
  /** VIEWER: resolve a pending fetch when artifact-bytes arrives. */
  handleBytes(from: NodeId, frame: ArtifactBytesFrame): void
  /** Single entry the Lead routes onM2Frame to (artifact plane only). */
  handleM2Frame(from: NodeId, frame: ArtifactFetchFrame | ArtifactBytesFrame): void
  /** Pending viewer fetches awaiting bytes (observability/tests). */
  pendingCount(): number
}

/** A viewer fetch awaiting its `artifact-bytes` reply, keyed by request fid. */
interface PendingFetch {
  resolve: (bytes: Uint8Array) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export function createArtifactService(deps: ArtifactServiceDeps): ArtifactService {
  // Clock reserved for future TTL bookkeeping; bound and underscored so the seam
  // stays stable without a `void` no-op.
  const _now = deps.now ?? (() => Date.now())
  const fetchTimeoutMs = deps.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
  const isPublished = deps.isPublishedRef ?? ((ref: ArtifactRef) => defaultIsPublished(deps.store, ref))

  // Owner-side dedup so an ack-loss retransmit of the same fetch is served once.
  const inboundDedup = createFidDedup()
  // Viewer-side pending table, keyed by the request fid we minted.
  const pending = new Map<Fid, PendingFetch>()

  function settle(fid: Fid): PendingFetch | undefined {
    const entry = pending.get(fid)
    if (entry) {
      clearTimeout(entry.timer)
      pending.delete(fid)
    }
    return entry
  }

  function fetch(ref: ArtifactRef): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      const fid = randomUUID()
      const timer = setTimeout(() => {
        if (settle(fid)) {
          reject(new Error(`${ARTIFACT_ERR_FETCH_TIMEOUT} after ${fetchTimeoutMs}ms`))
        }
      }, fetchTimeoutMs)
      // Do not keep the event loop alive solely for an in-flight fetch.
      if (typeof timer.unref === 'function') timer.unref()

      pending.set(fid, { resolve, reject, timer })

      const frame: ArtifactFetchFrame = {
        kind: 'artifact-fetch',
        officeId: deps.officeId,
        fromNode: deps.selfNodeId,
        ref,
        fid,
      }
      deps.send(ref.ownerNodeId, frame)
    })
  }

  /** Send an artifact-bytes reply (success or error) to `to` for `reqFrame`. */
  function reply(
    to: NodeId,
    reqFrame: ArtifactFetchFrame,
    body: { bytesBase64: string } | { error: string }
  ): void {
    const response: ArtifactBytesFrame = {
      kind: 'artifact-bytes',
      officeId: deps.officeId,
      fromNode: deps.selfNodeId,
      reFid: reqFrame.fid,
      ref: reqFrame.ref,
      ...body,
      fid: randomUUID(),
    }
    deps.send(to, response)
  }

  /**
   * HOST relay: a fetch for an artifact owned by ANOTHER node landed here because
   * joiners only link to the host — forward it one hop to the true owner and pipe
   * the owner's bytes back to the requester. The forwarded frame keeps the
   * original `fromNode`/`fid` (the owner's reply reFid then correlates the relay's
   * pending entry); `relayed` caps it to a single hop. Returns false when this node
   * cannot relay (already relayed / owner unknown or unreachable) → caller falls
   * back to the plain not-owned refusal. Mirrors history-fetch's relayRequest.
   */
  function relayFetch(from: NodeId, frame: ArtifactFetchFrame): boolean {
    if (frame.relayed) return false
    const owner = frame.ref.ownerNodeId
    if (!owner || owner === SELF_NODE_ID || owner === deps.selfNodeId || owner === from) return false

    if (deps.isNodeReachable && !deps.isNodeReachable(owner)) {
      reply(from, frame, { error: ERR_OWNER_UNREACHABLE })
      return true
    }

    const relayTimeoutMs = Math.max(1000, fetchTimeoutMs - RELAY_TIMEOUT_HEADROOM_MS)
    const timer = setTimeout(() => {
      if (settle(frame.fid)) {
        console.warn(
          `[ArtifactFetch] relay timed out office=${deps.officeId} owner=${owner} after ${relayTimeoutMs}ms`
        )
        reply(from, frame, { error: ERR_RELAY_FAILED })
      }
    }, relayTimeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    pending.set(frame.fid, {
      resolve: (bytes) => reply(from, frame, { bytesBase64: Buffer.from(bytes).toString('base64') }),
      reject: (err) => reply(from, frame, { error: err.message }),
      timer,
    })
    deps.send(owner, { ...frame, relayed: true })
    return true
  }

  async function handleFetch(from: NodeId, frame: ArtifactFetchFrame): Promise<void> {
    // Retransmit safety: a duplicate fetch is answered at most once.
    if (inboundDedup.seen(from, frame.fid)) return

    // Ownership gate: serve bytes ONLY for an artifact this node OWNS. A ref for a
    // member owned by another node is relayed to its true owner (host hop) when
    // possible, else refused. The owner id is carried on the ref itself. The local
    // SELF sentinel is meaningless on the wire (a viewer always addresses a real
    // node id), so it is NOT accepted as ownership.
    const owned = frame.ref.ownerNodeId === deps.selfNodeId
    if (frame.ref.teamId !== deps.officeId || !owned) {
      if (frame.ref.teamId === deps.officeId && relayFetch(from, frame)) return
      reply(from, frame, { error: ERR_NOT_PUBLISHED })
      return
    }

    // Only PUBLISHED team artifacts are servable — a ref with no backing finding
    // is refused before any path is resolved or read.
    if (!isPublished(frame.ref)) {
      reply(from, frame, { error: ERR_NOT_PUBLISHED })
      return
    }

    let bytes: Uint8Array | null = null
    try {
      bytes = await deps.resolveArtifactBytes(frame.ref)
    } catch {
      bytes = null
    }
    if (!bytes) {
      reply(from, frame, { error: ERR_NOT_FOUND })
      return
    }

    reply(from, frame, { bytesBase64: Buffer.from(bytes).toString('base64') })
  }

  function handleBytes(_from: NodeId, frame: ArtifactBytesFrame): void {
    const entry = settle(frame.reFid)
    if (!entry) return // unknown/duplicate/already-timed-out correlation — drop.

    if (frame.error !== undefined) {
      entry.reject(new Error(frame.error))
      return
    }
    if (frame.bytesBase64 === undefined) {
      entry.reject(new Error('artifact-bytes carried neither bytes nor error'))
      return
    }
    entry.resolve(new Uint8Array(Buffer.from(frame.bytesBase64, 'base64')))
  }

  function handleM2Frame(from: NodeId, frame: ArtifactFetchFrame | ArtifactBytesFrame): void {
    if (frame.kind === 'artifact-fetch') {
      void handleFetch(from, frame)
    } else {
      handleBytes(from, frame)
    }
  }

  return { fetch, handleFetch, handleBytes, handleM2Frame, pendingCount: () => pending.size }
}

/**
 * Default published-ref recognition, delegated to the team-domain SSOT
 * (`apps/team/artifact-refs`): a ref is published when a finding carries it or
 * a task delivers it as resultRef. Both anchor the ref to a producing app, so a
 * ref recognized here is necessarily owner-anchored — and the owner-serve gate
 * stays in lockstep with the viewer-side producer resolution, including its
 * refusal to serve a ref two members claim — each side must refuse on its own,
 * since their views of who claimed what can differ.
 */
function defaultIsPublished(store: TeamStore, ref: ArtifactRef): boolean {
  return isPublishedArtifactRef(store, ref.teamId, ref.epochId, ref.ref)
}
