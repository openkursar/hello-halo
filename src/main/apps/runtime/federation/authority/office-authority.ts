/**
 * Per-office authority composition: the integration root that composes term
 * state, handover (election + reconcile), replication, the scope gate, and the
 * artifact service for ONE office behind a single dispatcher the manager routes
 * `onM2Frame` to. It derives the election/replication "views" (candidate order,
 * last-known roster, online standbys, heir) from the office_nodes ledger.
 *
 * Node-ledger invariants this relies on (the manager maintains the rows):
 *   - every participant node (incl. self) has an office_nodes row with a stable
 *     joined_at, so candidate order and the last-known-roster quorum denominator
 *     are well-defined and do not shrink on partition (offline rows persist).
 *   - the presence FSM keeps each row's status fresh; suspect/offline transitions
 *     are forwarded here via onNodePresence.
 *
 * Everything is injected; this module imports no http/manager/bootstrap, so the
 * dependency direction stays downward-only and it is testable with in-memory
 * stores + an in-process link.
 */

import type { NodeId, FederationMessage } from '../types'
import type { M2Frame } from '../protocol-m2'
import { DEFAULT_P2P_CAPS } from '../protocol-m2'
import type { AuthorityStore, FederationStore } from '../../../federation'
import type { TeamStore, BlackboardTask } from '../../../team'
import type { BlackboardWriteRecord } from '../../team/blackboard'
import { SELF_NODE_ID } from '../../../../../shared/apps/team-types'
import { createTermState, type TermState } from './term-state'
import { createReconciler, type OwnerStatus } from './reconcile'
import { createHandover, type Handover } from './handover'
import { createReplication, type Replication, type MemberWriteRecord } from './replication'
import { createScopeGate, type ScopeGate } from './scope-gate'
import { createArtifactService, type ArtifactService } from './artifact-fetch'
import { createHistoryService, type HistoryService, type ReadMemberHistory } from './history-fetch'
import { handleShadowWriteReject, confirmShadowWrite } from './location-aware-blackboard'
import type { ArtifactRef } from '../protocol-m2'

const LOG_TAG = '[OfficeAuthority]'

export interface OfficeAuthorityDeps {
  officeId: string
  selfNodeId: NodeId
  federationStore: FederationStore
  authorityStore: AuthorityStore
  teamStore: TeamStore
  /** The office's link (control + replication ride it; artifact rides its own send). */
  send: (to: NodeId, frame: FederationMessage) => void
  broadcast: (frame: FederationMessage) => void
  now?: () => number

  // ── role + run context ──
  /** The office's open run epoch, for post-handover reconciliation. */
  getCurrentRunEpoch: () => { teamId: string; epochId: string } | null
  /** Owner reachability for a member (presence FSM + kernel busy). */
  getOwnerStatus: (appId: string) => OwnerStatus
  /** Re-drive an orphaned in_progress task after a handover. */
  reassignTask: (task: BlackboardTask) => void
  /** Apply an admitted member write through the authority's kernel blackboard. */
  applyMemberWrite: (record: MemberWriteRecord) => void

  // ── lifecycle callbacks (manager/bootstrap) ──
  /** This node won the election → start hosting + heartbeating as the authority. */
  onBecomeAuthority: (term: number) => void
  /** Authority changed → neutral UI signal + re-point transport. */
  onAuthorityChange: (authorityNodeId: NodeId, term: number) => void
  /** This node must stop acting as authority (resurrected old authority steps down). */
  onStepdown?: () => void
  /** Office paused/resumed (partition minority) → neutral UI signal. */
  onPausedChange?: (paused: boolean) => void

  // ── artifact plane ──
  /** Owner-side: resolve a published artifact ref to bytes (Lead injects services/space). */
  resolveArtifactBytes: (ref: ArtifactRef) => Promise<Uint8Array | null>

  // ── history plane ──
  /**
   * Owner-side: read an owned member's run transcript. Injected so the
   * federation layer never imports app-chat. Absent → this node serves no
   * history (every request is refused as not-found).
   */
  readMemberHistory?: ReadMemberHistory

  // ── replication observability ──
  /**
   * Fired after a hot-standby applies a replicated task/finding to its replica
   * store, so the renderer refreshes tasks/findings live. Not fired for
   * roster-only ops (no blackboard row changes). Passed through to replication.
   */
  onReplicaApplied?: (info: { officeId: string; op: string; taskId?: string }) => void

  // ── test seams ──
  schedule?: (ms: number, fn: () => void) => () => void
  jitter?: (ms: number) => number
}

export interface OfficeAuthority {
  /** Single entry the manager routes onM2Frame to. */
  handle: (from: NodeId, frame: M2Frame) => void
  /** Forward node-presence transitions (manager wires from coordinator.onNodePresence). */
  onNodePresence: (nodeId: NodeId, status: 'online' | 'suspect' | 'offline') => void
  /** Authority capture: the global onBlackboardWrite routes a hosted office's write here. */
  captureLocalWrite: (record: BlackboardWriteRecord) => void
  /** join-grant enrichment (current tenure + effective caps). */
  getJoinGrantExtras: () => { term: number; caps: number }
  /** Scope gate (shared with the tool-layer enforcement the manager wires). */
  scopeGate: ScopeGate
  termState: TermState
  handover: Handover
  replication: Replication
  artifact: ArtifactService
  history: HistoryService
  isAuthoritySelf: () => boolean
  isPaused: () => boolean
  getTerm: () => number
  getCommittedSeq: () => number
  stop: () => void
}

export function createOfficeAuthority(deps: OfficeAuthorityDeps): OfficeAuthority {
  const { officeId, selfNodeId, federationStore, authorityStore, teamStore } = deps
  const now = deps.now ?? (() => Date.now())

  const termState = createTermState({ store: authorityStore, officeId, now })
  const scopeGate = createScopeGate({ store: teamStore })

  // ── Node-ledger derived views ──
  function onlineNodes(): NodeId[] {
    return federationStore
      .listNodesByOffice(officeId) // already ordered by joined_at asc
      .filter((n) => n.status === 'online')
      .map((n) => n.nodeId)
  }
  // Candidate order = online nodes by joined_at (the dead authority is offline →
  // excluded). Self may or may not be in the ledger as an explicit row; ensure it
  // participates by appending it when absent (it is always reachable to itself).
  function getOnlineCandidatesOrdered(): NodeId[] {
    const ordered = onlineNodes()
    if (!ordered.includes(selfNodeId)) ordered.push(selfNodeId)
    return ordered
  }
  // Last-known roster = ALL known nodes (never shrinks on partition) + self.
  function getLastKnownRoster(): NodeId[] {
    const all = federationStore.listNodesByOffice(officeId).map((n) => n.nodeId)
    if (!all.includes(selfNodeId)) all.push(selfNodeId)
    return all
  }
  // Online hot-standbys for replication = online nodes other than self (authority).
  function getOnlineStandbys(): NodeId[] {
    return onlineNodes().filter((n) => n !== selfNodeId)
  }
  // The heir = the online standby with the earliest joined_at (first in order).
  function getHeir(): NodeId | null {
    return getOnlineStandbys()[0] ?? null
  }

  const reconciler = createReconciler({
    officeId,
    store: teamStore,
    getOwnerStatus: deps.getOwnerStatus,
    reassign: deps.reassignTask,
    schedule: deps.schedule,
    now,
  })

  const replication = createReplication({
    officeId,
    selfNodeId,
    authorityStore,
    replicaStore: teamStore,
    send: (to, frame) => deps.send(to, frame),
    broadcast: (frame) => deps.broadcast(frame),
    now,
    getTerm: () => termState.getTerm(),
    getCommittedSeq: () => termState.getCommittedSeq(),
    setCommittedSeq: (seq) => termState.setCommittedSeq(seq),
    getOnlineStandbys,
    getHeir,
    // Known standbys in the last-known roster (excl. self), reachability-blind,
    // so a partitioned authority does NOT optimistically commit unreplicated writes.
    getKnownStandbyCount: () => Math.max(0, getLastKnownRoster().filter((n) => n !== selfNodeId).length),
    applyMemberWrite: deps.applyMemberWrite,
    admitMemberWrite: (frame) => {
      // A member's coordination write is admitted only if its scope allows it
      // (read-only spectators cannot write). Enforced HERE on the authority, not
      // in the UI.
      //
      // The scope SUBJECT is resolved from the AUTHENTICATED sender node
      // (frame.fromNode, established by the office-credential WS handshake), NOT
      // from client-self-reported payload fields. A node may only write on behalf
      // of a member it actually owns (team_members.owner_node_id === fromNode);
      // any self-reported author the sending node does not own is rejected. This
      // closes the confused-deputy hole where a read-only spectator omits its
      // author fields to borrow the open default.
      const payload = frame.payload as { teamId?: string }
      const teamId = typeof payload.teamId === 'string' ? payload.teamId : officeId
      const subjectAppId = resolveWriteSubjectAppId(teamId, frame)
      if (!subjectAppId) return false
      return scopeGate.canCoordinationWrite(teamId, subjectAppId)
    },
    bumpRosterEpoch: () => termState.setRosterEpoch(termState.getRosterEpoch() + 1),
    onReplicaApplied: deps.onReplicaApplied
      ? (info) => deps.onReplicaApplied!({ officeId, op: info.op, taskId: info.taskId })
      : undefined,
    // Positive-ack a member's own shadow write once the authority replicates it
    // back, so the unconfirmed-rollback backstop only fires for genuinely lost writes.
    onReplicatedFid: (fid) => confirmShadowWrite(fid),
  })

  const handover = createHandover({
    officeId,
    selfNodeId,
    termState,
    reconciler,
    getOnlineCandidatesOrdered,
    getLastKnownRoster,
    send: (to, frame) => deps.send(to, frame),
    broadcast: (frame) => deps.broadcast(frame),
    getCurrentRunEpoch: deps.getCurrentRunEpoch,
    onBecomeAuthority: deps.onBecomeAuthority,
    onAuthorityChange: deps.onAuthorityChange,
    onStepdown: deps.onStepdown,
    onPausedChange: deps.onPausedChange,
    now,
    schedule: deps.schedule,
    jitter: deps.jitter,
  })

  const artifact = createArtifactService({
    officeId,
    selfNodeId,
    store: teamStore,
    send: (to, frame) => deps.send(to, frame as FederationMessage),
    now,
    resolveArtifactBytes: deps.resolveArtifactBytes,
    // HOST relay fast-fail: an owner whose presence row is suspect/offline is not
    // worth a relay round-trip — reply owner-unreachable immediately (parity with
    // the history plane).
    isNodeReachable: (nodeId) => {
      const status = federationStore.getNode(officeId, nodeId)?.status
      return status !== 'offline' && status !== 'suspect'
    },
  })

  const history = createHistoryService({
    officeId,
    selfNodeId,
    store: teamStore,
    send: (to, frame) => deps.send(to, frame as FederationMessage),
    // No reader injected → this node owns no servable history (refused not-found).
    readMemberHistory: deps.readMemberHistory ?? (() => null),
    // Relay fast-fail: an owner whose presence row is suspect/offline is not
    // worth a relay round-trip — reply owner-unreachable immediately.
    isNodeReachable: (nodeId) => {
      const status = federationStore.getNode(officeId, nodeId)?.status
      return status !== 'offline' && status !== 'suspect'
    },
  })

  /**
   * Resolve the scope subject for a member write from the AUTHENTICATED sender
   * node, server-side. Returns the subject appId only when:
   *   - the write originates from a remote node (self-originated authority writes
   *     bypass member-scope: the authority is the single writer), AND
   *   - the sending node actually owns members in this team, AND
   *   - any self-reported author appId is one of those owned members.
   * Returns null (→ deny) otherwise. A node that owns exactly one member needs no
   * self-report; a node owning several must self-report a member it owns.
   */
  function resolveWriteSubjectAppId(
    teamId: string,
    frame: { fromNode: NodeId; payload: Record<string, unknown> }
  ): string | null {
    // Self-originated writes are the authority's own single-writer captures, not
    // member-admission writes; they are not gated by member scope.
    if (frame.fromNode === selfNodeId) return null
    const ownedByNode = teamStore
      .listMembersByTeam(teamId)
      .filter((m) => m.ownerNodeId === frame.fromNode)
    if (ownedByNode.length === 0) return null
    const p = frame.payload as { createdByAppId?: string; callerAppId?: string; authorAppId?: string }
    const claimed = p.createdByAppId ?? p.callerAppId ?? p.authorAppId
    if (claimed) {
      // A self-reported author is honoured ONLY if the authenticated node owns it.
      return ownedByNode.some((m) => m.appId === claimed) ? claimed : null
    }
    // No self-report: a single-owner node is unambiguous; a multi-owner node is
    // ambiguous and must name its subject → deny.
    return ownedByNode.length === 1 ? ownedByNode[0].appId : null
  }

  function handle(from: NodeId, frame: M2Frame): void {
    switch (frame.kind) {
      case 'authority-claim':
        // Do NOT observe the claim's term here — it is a PROPOSED tenure not yet
        // won. Adopting it would make this voter reject the very claim it should
        // confirm. Step-down is driven only by ESTABLISHED-authority frames
        // (replicate/write) below.
        handover.handleClaim(from, frame)
        break
      case 'authority-confirm':
        handover.handleConfirm(from, frame)
        break
      case 'blackboard-replicate':
      case 'blackboard-write':
        // An established authority writing at a higher tenure → a handover I
        // missed → re-align / step down if I was the old authority.
        handover.observeFrameTerm(from, frame.term)
        replication.handleM2Frame(from, frame)
        break
      case 'ack':
        replication.handleM2Frame(from, frame)
        break
      case 'catchup-request':
      case 'catchup-response':
        // Gap-fill replay between a standby and the authority (both directions
        // owned by replication). A response may carry a newer tenure → re-align.
        if (frame.kind === 'catchup-response') handover.observeFrameTerm(from, frame.term)
        replication.handleM2Frame(from, frame)
        break
      case 'artifact-fetch':
      case 'artifact-bytes':
        artifact.handleM2Frame(from, frame)
        break
      case 'history-request':
      case 'history-response':
        history.handleM2Frame(from, frame)
        break
      case 'reject':
        // A reject is observed (e.g. EPOCH_STALE → step down / re-align). The
        // term-observe above already handled the common case; log for diagnostics.
        console.debug(`${LOG_TAG} reject office=${officeId} reason=${frame.reason} from=${from}`)
        // Consume a shadow-write reject: EPOCH_STALE (retryable) resends the
        // member's optimistic write to the re-resolved authority so a write made
        // mid-handover is not silently lost (the local row would otherwise fork).
        handleShadowWriteReject(frame.reFid, frame.retryable)
        break
    }
  }

  return {
    handle,
    onNodePresence: (nodeId, status) => handover.onNodePresence(nodeId, status),
    captureLocalWrite: (record) => replication.captureLocalWrite(record),
    getJoinGrantExtras: () => ({ term: termState.getTerm(), caps: DEFAULT_P2P_CAPS }),
    scopeGate,
    termState,
    handover,
    replication,
    artifact,
    history,
    isAuthoritySelf: () => handover.isAuthoritySelf(),
    isPaused: () => handover.isPaused(),
    getTerm: () => termState.getTerm(),
    getCommittedSeq: () => termState.getCommittedSeq(),
    stop: () => {
      handover.stop()
    },
  }
}

export { SELF_NODE_ID }
