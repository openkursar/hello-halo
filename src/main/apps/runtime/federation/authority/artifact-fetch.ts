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
import type {
  ArtifactRef,
  ArtifactFetchFrame,
  ArtifactBytesFrame,
  Fid,
} from '../protocol-m2'
import { createFidDedup } from '../protocol-m2'
import type { FederationMessage, NodeId } from '../types'

/** Default ceiling for an unanswered viewer fetch before it rejects. */
const DEFAULT_FETCH_TIMEOUT_MS = 15000

/** Owner-side rejection messages (technical, never user-facing). */
const ERR_NOT_PUBLISHED = 'artifact-not-published'
const ERR_NOT_FOUND = 'artifact-not-found'

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
          reject(new Error(`artifact-fetch timed out after ${fetchTimeoutMs}ms`))
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

  async function handleFetch(from: NodeId, frame: ArtifactFetchFrame): Promise<void> {
    // Retransmit safety: a duplicate fetch is answered at most once.
    if (inboundDedup.seen(from, frame.fid)) return

    const replyError = (error: string) => {
      const reply: ArtifactBytesFrame = {
        kind: 'artifact-bytes',
        officeId: deps.officeId,
        fromNode: deps.selfNodeId,
        reFid: frame.fid,
        ref: frame.ref,
        error,
        fid: randomUUID(),
      }
      deps.send(from, reply)
    }

    // Only PUBLISHED team artifacts of THIS office are servable — a ref for a
    // different office or with no backing finding is refused outright, before
    // any path is ever resolved or read.
    if (frame.ref.teamId !== deps.officeId || !isPublished(frame.ref)) {
      replyError(ERR_NOT_PUBLISHED)
      return
    }

    let bytes: Uint8Array | null = null
    try {
      bytes = await deps.resolveArtifactBytes(frame.ref)
    } catch {
      bytes = null
    }
    if (!bytes) {
      replyError(ERR_NOT_FOUND)
      return
    }

    const reply: ArtifactBytesFrame = {
      kind: 'artifact-bytes',
      officeId: deps.officeId,
      fromNode: deps.selfNodeId,
      reFid: frame.fid,
      ref: frame.ref,
      bytesBase64: Buffer.from(bytes).toString('base64'),
      fid: randomUUID(),
    }
    deps.send(from, reply)
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
 * Default published-ref recognition: a ref is a published team artifact iff some
 * finding in its epoch carries that exact `ref`. Findings are how an authored
 * artifact is published to the office, and they carry the authoring app's id, so
 * a ref recognized here is necessarily owner-anchored.
 */
function defaultIsPublished(store: TeamStore, ref: ArtifactRef): boolean {
  return store.listFindingsByEpoch(ref.teamId, ref.epochId).some((f) => f.ref === ref.ref)
}
