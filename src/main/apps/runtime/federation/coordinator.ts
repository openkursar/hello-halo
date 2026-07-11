/**
 * apps/runtime/federation -- Federation Coordinator
 *
 * All join + presence logic. Transport-agnostic: drives a FederationLink (dumb
 * pipe) and persists through FederationStore (office_nodes) + TeamStore (remote
 * team_members). Owns no transport, no HTTP, and no team-coordination kernel
 * state.
 */

import type { FederationStore, OfficeCredentialLike } from './deps'
import type { TeamStore } from '../../team'
import type { FederationLink } from './link'
import {
  nodeToPresence,
  type FederationMessage,
  type JoinReject,
  type JoinRequest,
  type NodeId,
  type NodePresence,
  type OfficeContext,
  type PresenceSnapshot,
  type RosterSnapshot,
  type SerializedWakeRequest,
  type StreamFramesFrame,
  type WakeFrame,
} from './types'
import { isM2Frame, type M2Frame } from './protocol-m2'
import { SELF_NODE_ID, type TeamMemberRuntimeStatus } from '../../../../shared/apps/team-types'
import {
  PRESENCE_CONFIRMED_OFFLINE_MS,
  PRESENCE_HEARTBEAT_INTERVAL_MS,
  PRESENCE_SUSPECT_AFTER_MS,
} from './presence-constants'
import type { TurnCompletion } from '../team/message-bus'

const LOG_TAG = '[Federation]'

/** A node's bound member for confirmed-offline fan-out (resolved via owner_node_id). */
export interface NodeBoundMember {
  appId: string
  memberIdentity: string | null
}

export interface FederationCoordinatorDeps {
  context: OfficeContext
  link: FederationLink
  federationStore: FederationStore
  teamStore: TeamStore
  /** Injected so the coordinator never imports http/auth (dependency direction). */
  verifyCredential: (token: string) => OfficeCredentialLike | null
  now?: () => number
  /**
   * Monotonic clock for presence silence measurement. Unlike now()
   * — which stamps persisted wall-clock timestamps (joinedAt/lastSeen/since) and
   * must stay wall-clock for display + restart ordering — this drives the
   * suspect/confirmed FSM, so it MUST NOT advance across a host suspend
   * (CLOCK_MONOTONIC, not BOOTTIME). Production injects performance.now();
   * deterministic tests that inject only now() inherit it as the silence clock,
   * preserving their fake-clock semantics. A laptop sleep then does not register
   * as transport silence, preventing a wake-up storm of false confirmed-offline.
   */
  monotonicNow?: () => number
  /**
   * Override the suspect/confirmed thresholds (and derived heartbeat interval)
   * for deterministic tests with a fake clock + small values. Defaults to the
   * LAN constants.
   */
  presence?: {
    suspectAfterMs?: number
    confirmedOfflineMs?: number
    heartbeatIntervalMs?: number
  }
  onPresenceChange?: (snap: PresenceSnapshot) => void
  /**
   * Fired EXACTLY ONCE per bound member when its owner node is confirmed-offline
   * (bootstrap wires this to bus.resolvePendingWaitsForMember so a waiting
   * lead unblocks immediately instead of hanging on the 2h sync timeout). suspect
   * never fires this. The coordinator stays free of the bus by injection.
   */
  onMemberConfirmedOffline?: (appId: string) => void
  /**
   * Resolve a node's bound members for confirmed-offline fan-out, using the
   * persistent team_members.owner_node_id binding. Defaults to an empty
   * array (an office that tracks no member ownership). Bootstrap/manager pass a
   * teamStore-backed resolver.
   */
  listMembersForNode?: (nodeId: NodeId) => NodeBoundMember[]
  /** Surfaced join-grant/reject for the client side (no crash on reject). */
  onJoinGrant?: (assignedNodeId: NodeId) => void
  onJoinReject?: (reason: JoinReject['reason']) => void
  /**
   * Host-side notification of a brought member's spaceId, when the joiner
   * supplied one. The spaceId is not persisted on the member row (no schema
   * for it here); the manager caches it for later wake addressing. Skipped when
   * a member carries no spaceId.
   */
  onRemoteMemberSpaceId?: (appId: string, spaceId: string) => void
  /**
   * Owner role: run a brought member's turn locally when a wake arrives. Set only
   * on the node that owns the member; a non-owner that receives a wake logs+drops.
   */
  onWake?: (request: SerializedWakeRequest) => Promise<{ finalMessage: string | null }>
  /**
   * Authority role: a remote turn finished. Set only on the authority node so the
   * pending wait keyed by correlationId resolves; elsewhere logs+drops.
   */
  onTurnComplete?: (correlationId: string, outcome: TurnCompletion) => void
  /**
   * Host role: a joiner is leaving and asks to drop the members it brought.
   * Set only on the host coordinator; the manager re-checks ownership against
   * `from` before removing, then re-broadcasts the converged roster.
   */
  onMemberLeave?: (from: NodeId, appIds: string[]) => void
  /**
   * Activity relay: a batch of stream-frames arrived over this office's link.
   * The manager replays + re-broadcasts as appropriate. Absent → the frame
   * is dropped (an office that does not relay activity).
   */
  onStreamFrames?: (batch: StreamFramesFrame) => void
  /**
   * Host role: the office roster changed (a node joined / membership shifted).
   * Bootstrap wires this to emit a `team:updated` UI event so the authority's
   * renderer re-fetches the roster + relationship graph. Set on the host
   * coordinator (and, on the joiner, after a roster is materialized).
   */
  onRosterChanged?: (officeId: string) => void
  /**
   * Joiner role: a roster snapshot arrived from the host. The manager provides a
   * function that materializes the office into the LOCAL team store (shadow
   * office). Set only on the joiner coordinator; absent on the host (a host
   * never receives roster frames).
   */
  onRoster?: (snapshot: RosterSnapshot) => void
  /**
   * M2 dispatch seam: every authority/replication/artifact frame (the M2 family,
   * outside the M1 join+presence+relay set) is delegated here verbatim. The
   * manager wires this to the per-office authority module so the coordinator
   * stays focused on M1 join+presence and never imports the authority logic.
   * Absent → an M2 frame is dropped with a debug log (an office that does not run
   * the M2 layer, e.g. an M1-only build).
   */
  onM2Frame?: (from: NodeId, frame: M2Frame) => void
  /**
   * M2 join enrichment: the authority's current tenure (term) + effective caps at
   * admission, folded into the join-grant so a joiner aligns its term baseline.
   * Absent → grant carries no term (M1 behaviour).
   */
  getJoinGrantExtras?: () => { term?: number; caps?: number }
  /**
   * Run-context seam: the office's currently-open run epoch id (or null when no
   * run is open). Stamped into the roster snapshot so a joiner can derive the live
   * session key and render an in-progress run's history on join. Read-only
   * pass-through from the kernel run-epoch; the coordinator never owns epoch state.
   */
  getCurrentRunEpoch?: () => string | null
  /**
   * Run-context seam: a member's live runtime status on the authority
   * (idle/working/waiting_user/error), stamped per-member into the roster snapshot
   * so a joiner animates the working pulse + run banner in step with the host.
   * Read-only pass-through from the kernel's getMemberStatus; the coordinator owns
   * no member-status state. Absent → 'idle' for every member (M1 behaviour).
   */
  getMemberRuntimeStatus?: (appId: string) => TeamMemberRuntimeStatus
  /**
   * M2 authority-presence seam: invoked from the presence FSM when a peer node's
   * reachability transitions. Unlike onMemberConfirmedOffline (member-keyed, for
   * that unblock), this is NODE-keyed and lets the handover layer notice the
   * AUTHORITY node going suspect/confirmed so it can drive an election. Fired on
   * every transition (online/suspect/offline). Absent → no election driver.
   */
  onNodePresence?: (nodeId: NodeId, status: 'online' | 'suspect' | 'offline') => void
}

export interface FederationCoordinator {
  start(): void
  stop(): void
  /** Client-side helper: send a join-request to the host via the link. */
  requestJoin(req: JoinRequest): void
  /** Broadcast one heartbeat for this node. Exposed for deterministic tests. */
  sendHeartbeat(): void
  /**
   * Advance the per-node debounce FSM against the current clock: online → suspect
   * → confirmed-offline as silence crosses each threshold. Exposed for
   * deterministic tests; `tick` is an alias.
   */
  sweepPresence(): void
  tick(): void
  getPresence(): PresenceSnapshot
  /**
   * Host role: re-project the full roster to every joiner + refresh local UI.
   * Exposed so the manager's egress can re-broadcast on EVERY membership mutation
   * (kick / edge change / dissolve), not only on join. No-op effect on a
   * joiner coordinator (it has no joiners to project to).
   */
  broadcastRoster(): void
}

export function createFederationCoordinator(
  deps: FederationCoordinatorDeps
): FederationCoordinator {
  const {
    context,
    link,
    federationStore,
    teamStore,
    verifyCredential,
    onPresenceChange,
    onMemberConfirmedOffline,
    onJoinGrant,
    onJoinReject,
    onRemoteMemberSpaceId,
    onWake,
    onTurnComplete,
    onMemberLeave,
    onStreamFrames,
    onRosterChanged,
    onRoster,
    onM2Frame,
    getJoinGrantExtras,
    getCurrentRunEpoch,
    getMemberRuntimeStatus,
    onNodePresence,
  } = deps
  const now = deps.now ?? (() => Date.now())
  // Silence clock: monotonic in production; falls back to now() so tests that
  // inject only a fake now() keep measuring silence off that same clock.
  const monotonicNow = deps.monotonicNow ?? now
  const suspectAfterMs = deps.presence?.suspectAfterMs ?? PRESENCE_SUSPECT_AFTER_MS
  const confirmedOfflineMs = deps.presence?.confirmedOfflineMs ?? PRESENCE_CONFIRMED_OFFLINE_MS
  const heartbeatIntervalMs = deps.presence?.heartbeatIntervalMs ?? PRESENCE_HEARTBEAT_INTERVAL_MS
  const listMembersForNode = deps.listMembersForNode ?? (() => [])
  const { officeId } = context

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null

  // Per-node debounce flag: a node confirmed-offline only acts ONCE and only
  // returns to online via a fresh join. The office_nodes row carries the
  // reachability projection (online/suspect/offline); this set guards the
  // single-fire + bare-heartbeat-drop semantics that the row alone can't express.
  const confirmedNodes = new Set<NodeId>()

  // Per-node monotonic last-seen, the silence numerator for the FSM. Kept here
  // (not in the persisted office_nodes row) so the wall-clock lastSeen the store
  // holds for display/ordering is never conflated with the monotonic measurement.
  // A node with no record yet (e.g. it was upserted online without a heartbeat
  // having flowed through this coordinator) is seeded lazily by projecting its
  // persisted wall-silence into monotonic space, so first-sweep timing matches.
  const monotonicLastSeen = new Map<NodeId, number>()
  // Last sweep's (wall, monotonic) pair, for host suspend/resume detection.
  let lastSweep: { wall: number; mono: number } | null = null

  // Host-side rejoin-request rate limit: when a confirmed-offline node keeps
  // heartbeating on a live socket, the host nudges it to re-handshake — but at
  // most once per window per node, not on every 2s heartbeat, so a stuck peer is
  // not spammed. Keyed by nodeId → last monotonic send time.
  const lastRejoinNudge = new Map<NodeId, number>()
  const REJOIN_NUDGE_INTERVAL_MS = Math.max(suspectAfterMs, 5000)

  // Joiner-side: the last join-request this node sent, so it can re-send on a
  // host `rejoin-request` (or any future self-driven rejoin) without the manager
  // re-supplying it. Set by requestJoin; null on a pure host coordinator.
  let lastJoinRequest: JoinRequest | null = null

  function markSeen(nodeId: NodeId): void {
    monotonicLastSeen.set(nodeId, monotonicNow())
  }

  /** Monotonic last-seen for a node, seeding lazily from persisted wall-silence. */
  function monotonicLastSeenOf(node: { nodeId: NodeId; lastSeen: number }): number {
    const recorded = monotonicLastSeen.get(node.nodeId)
    if (recorded !== undefined) return recorded
    const seeded = monotonicNow() - Math.max(0, now() - node.lastSeen)
    monotonicLastSeen.set(node.nodeId, seeded)
    return seeded
  }

  // ── Presence projection / notification ──

  // Host-authoritative peer presence adopted from inbound `presence-update`
  // frames. A joiner's own FSM only tracks its direct link (the host); its node
  // ledger has no rows for the OTHER joiners, so without this overlay every
  // peer looked permanently online on a joiner's UI while the host already saw
  // it suspect/offline. In-memory only — never persisted — so it cannot perturb
  // the node ledger (candidate order, reconciliation). Ledger rows always win.
  const adoptedPeerPresence = new Map<NodeId, NodePresence>()

  function snapshot(): PresenceSnapshot {
    const rows = federationStore.listNodesByOffice(officeId).map(nodeToPresence)
    const known = new Set(rows.map((n) => n.nodeId))
    const peers = [...adoptedPeerPresence.values()].filter((p) => !known.has(p.nodeId))
    return {
      officeId,
      nodes: [...rows, ...peers],
    }
  }

  function notifyPresence(): void {
    onPresenceChange?.(snapshot())
  }

  /** Identity ids of every member owned by a node (drives offline fan-out). */
  function memberIdentitiesForNode(nodeId: NodeId): string[] {
    const ids = new Set<string>()
    for (const m of teamStore.listMembersByTeam(officeId)) {
      if (m.ownerNodeId === nodeId && m.memberIdentity) ids.add(m.memberIdentity)
    }
    return [...ids]
  }

  // ── Host side: handle a join-request ──

  function rejectJoin(to: NodeId, reason: JoinReject['reason']): void {
    console.warn(`${LOG_TAG} join rejected node=${to} reason=${reason} ts=${now()}`)
    link.send(to, { kind: 'join-reject', officeId, reason })
  }

  /**
   * Structured mode only: link the lead to each newly-joined remote member with
   * the SAME edge shape the recommended topology uses for local members — a
   * single lead → member sync edge (replies ride the wake/turn-complete
   * correlation, so no reverse edge is needed; a reverse edge would also form a
   * cycle that scrambles the topology auto-layout). Merges into the existing
   * edge set — never drops edges. No-op in free mode (no topology) or when no
   * lead exists yet.
   */
  function ensureLeadEdges(joinedAppIds: string[]): void {
    const team = teamStore.getTeamById(officeId)
    if (!team || team.collabMode !== 'structured' || !team.leadAppId) return
    const leadAppId = team.leadAppId

    const edges = teamStore.listEdgesByTeam(officeId)
    const seen = new Set(edges.map((e) => `${e.fromAppId}→${e.toAppId}`))
    let changed = false
    for (const appId of joinedAppIds) {
      if (appId === leadAppId) continue
      if (seen.has(`${leadAppId}→${appId}`)) continue
      edges.push({ teamId: officeId, fromAppId: leadAppId, toAppId: appId, sync: true })
      seen.add(`${leadAppId}→${appId}`)
      changed = true
    }
    if (changed) teamStore.replaceEdgesForTeam(officeId, edges)
  }

  /**
   * Build the office roster from the local store. Owner node ids are emitted
   * ABSOLUTE (the crux of SELF-relativity on the wire): a member stored as SELF
   * here is owned by the HOST → emit the host's own node id; a member with a real
   * remote node id is emitted as-is. The receiver remaps back to SELF-relative.
   */
  function buildRosterSnapshot(): RosterSnapshot {
    const team = teamStore.getTeamById(officeId)
    const epochId = getCurrentRunEpoch?.() ?? undefined
    // The run epoch's in-progress tasks resolve the title shown beneath a working
    // member, so a joiner's node reads "writing report.md" — not just a pulse.
    const inProgressByAppId = new Map<string, string>()
    if (epochId) {
      for (const task of teamStore.listTasksByEpoch(officeId, epochId)) {
        if (task.status === 'in_progress' && task.assigneeAppId) {
          inProgressByAppId.set(task.assigneeAppId, task.title)
        }
      }
    }
    const members = teamStore.listMembersByTeam(officeId).map((m) => {
      const absoluteOwner = m.ownerNodeId === SELF_NODE_ID ? context.selfNodeId : m.ownerNodeId ?? context.selfNodeId
      const status = getMemberRuntimeStatus?.(m.appId) ?? 'idle'
      const currentTaskTitle = status === 'working' ? inProgressByAppId.get(m.appId) : undefined
      return {
        appId: m.appId,
        memberName: m.memberName,
        role: m.role,
        isLead: m.isLead,
        ownerNodeId: absoluteOwner,
        memberIdentity: m.memberIdentity ?? null,
        // Prefer the live node ledger, fall back to the name persisted on the
        // member row at join (covers rows written before the ledger had a name).
        ownerDisplayName: federationStore.getNode(absoluteOwner)?.displayName ?? m.ownerDisplayName ?? null,
        status,
        ...(currentTaskTitle ? { currentTaskTitle } : {}),
      }
    })
    return {
      team: {
        id: officeId,
        name: team?.name ?? officeId,
        goal: team?.goal ?? '',
        leadAppId: team?.leadAppId ?? null,
        collabMode: (team?.collabMode as 'structured' | 'free') ?? 'structured',
        hostNodeId: context.selfNodeId,
        ...(epochId ? { epochId } : {}),
        status: team?.status ?? 'idle',
      },
      members,
      edges: teamStore.listEdgesByTeam(officeId).map((e) => ({
        fromAppId: e.fromAppId,
        toAppId: e.toAppId,
      })),
    }
  }

  /** Host: refresh local UI + project the full roster to every joiner. */
  function broadcastRoster(): void {
    link.broadcast({ kind: 'roster', officeId, snapshot: buildRosterSnapshot() })
    onRosterChanged?.(officeId)
  }

  /**
   * Resolve a unique member name for a NEW brought member. Member names are the
   * team-wide addressing key (the lead dispatches by name), so two members must
   * never share one. Preference order: the name as brought → "name·owner" (the
   * joiner's display name, the same identity the owner badge shows) → a numeric
   * suffix as the last resort.
   */
  function disambiguateMemberName(preferred: string, ownerDisplayName?: string): string {
    const base = preferred.trim() || 'member'
    if (!teamStore.getMemberByName(officeId, base)) return base
    const owner = ownerDisplayName?.trim()
    const withOwner = owner ? `${base}·${owner}` : base
    if (withOwner !== base && !teamStore.getMemberByName(officeId, withOwner)) return withOwner
    for (let i = 2; i < 100; i++) {
      const candidate = `${withOwner}-${i}`
      if (!teamStore.getMemberByName(officeId, candidate)) return candidate
    }
    return `${base}-${Date.now().toString(36)}`
  }

  function handleJoinRequest(req: JoinRequest): void {
    const cred = verifyCredential(req.credentialToken)
    if (!cred) {
      rejectJoin(req.fromNode, 'CREDENTIAL_INVALID')
      return
    }
    if (cred.officeId !== officeId || req.officeId !== officeId) {
      rejectJoin(req.fromNode, 'OFFICE_MISMATCH')
      return
    }

    const ts = now()

    // Preserve original join order on rejoin: only the first join stamps joinedAt.
    const existing = federationStore.getNode(req.fromNode)
    federationStore.upsertNode({
      nodeId: req.fromNode,
      officeId,
      identity: req.identityId,
      displayName: req.displayName ?? null,
      joinedAt: existing?.joinedAt ?? ts,
      lastSeen: ts,
      status: 'online',
    })
    // Rejoin is the ONLY exit from confirmed-offline. Clearing the flag here
    // re-arms the node so a later confirmed transition can fire again. Reset its
    // monotonic last-seen so the fresh tenure starts with a full grace window.
    confirmedNodes.delete(req.fromNode)
    lastRejoinNudge.delete(req.fromNode)
    markSeen(req.fromNode)

    // Persist brought members as remote team_members. An appId already present
    // is a rejoin (keep its existing row/name); a colliding NEW name is admitted
    // under a disambiguated name (see disambiguateMemberName) — never silently
    // dropped.
    const presentAppIds = new Set(teamStore.listMembersByTeam(officeId).map((m) => m.appId))
    const joinedAppIds: string[] = []
    for (const m of req.bringMembers) {
      if (presentAppIds.has(m.appId)) {
        // Rejoin: the row (and any disambiguated name) is already persisted.
        if (m.spaceId) onRemoteMemberSpaceId?.(m.appId, m.spaceId)
        joinedAppIds.push(m.appId)
        continue
      }
      const memberName = disambiguateMemberName(m.memberName, req.displayName)
      if (memberName !== m.memberName) {
        console.log(
          `${LOG_TAG} member name taken team=${officeId} app=${m.appId}: "${m.memberName}" → "${memberName}"`
        )
      }
      try {
        teamStore.addMember({
          teamId: officeId,
          appId: m.appId,
          memberName,
          role: m.role ?? '',
          isLead: false,
          aiProvisioned: false,
          addedAt: ts,
          ownerNodeId: req.fromNode,
          origin: 'remote',
          memberIdentity: req.identityId,
          // Persisted for the owner badge: joiners keep no office_nodes rows for
          // their peers, so the name must travel with the member row itself.
          ownerDisplayName: req.displayName ?? null,
          // Persist the invite's permission overlay so the authority's scope gate
          // reads it off the member row; without it a narrowly-invited guest would
          // resolve to the open default and bypass the scope.
          scopeJson: JSON.stringify(cred.scope),
        })
        if (m.spaceId) onRemoteMemberSpaceId?.(m.appId, m.spaceId)
        presentAppIds.add(m.appId) // a repeated appId later in this request is a duplicate, not a new member
        joinedAppIds.push(m.appId)
      } catch (err) {
        // A real persistence failure: the member is NOT in the roster, so do not
        // link it into the topology (a phantom edge would point at nobody).
        console.error(
          `${LOG_TAG} failed to persist remote member team=${officeId} app=${m.appId} node=${req.fromNode}`,
          err instanceof Error ? err.message : err
        )
      }
    }

    // Structured mode: link the lead to each joined member before snapshotting so
    // the roster carries the new edges.
    ensureLeadEdges(joinedAppIds)

    console.log(`${LOG_TAG} node joined node=${req.fromNode} identity=${req.identityId} ts=${ts}`)
    const grantExtras = getJoinGrantExtras?.() ?? {}
    link.send(req.fromNode, {
      kind: 'join-grant',
      officeId,
      assignedNodeId: req.fromNode,
      ...(grantExtras.term !== undefined ? { term: grantExtras.term } : {}),
      ...(grantExtras.caps !== undefined ? { caps: grantExtras.caps } : {}),
    })

    link.broadcast({
      kind: 'presence-update',
      officeId,
      nodeId: req.fromNode,
      status: 'online',
      members: [req.identityId],
      since: ts,
    })
    notifyPresence()
    broadcastRoster()
  }

  // ── Presence: inbound heartbeat ──

  function handleHeartbeat(fromNode: NodeId, ts: number): void {
    const node = federationStore.getNode(fromNode)
    if (!node) return

    // Once confirmed-offline, a bare heartbeat must NOT silently revive the
    // node — recovery requires a fresh join handshake (the node may hold stale
    // state while a reassigned member already runs the turn). Drop it; do not
    // even refresh lastSeen, so the row stays consistently offline until rejoin.
    //
    // BUT the heartbeat arriving proves the node's WS session is still LIVE. The
    // joiner's reconnect-reauth path (which would re-drive the join) only fires on
    // a socket DROP, so a still-connected confirmed-offline node would otherwise
    // deadlock forever (heartbeats arrive, are dropped, never re-join). Break the
    // deadlock by nudging the node to re-handshake — a `rejoin-request` control
    // frame the node answers by re-sending its join-request. This preserves the
    // no-silent-revive invariant while guaranteeing liveness on a live socket.
    // Rate-limited so a stuck peer is not spammed.
    if (confirmedNodes.has(fromNode)) {
      const mono = monotonicNow()
      const last = lastRejoinNudge.get(fromNode) ?? -Infinity
      if (mono - last >= REJOIN_NUDGE_INTERVAL_MS) {
        lastRejoinNudge.set(fromNode, mono)
        console.warn(
          `${LOG_TAG} heartbeat from confirmed-offline node=${fromNode} on live session; sending rejoin-request`
        )
        link.send(fromNode, { kind: 'rejoin-request', officeId })
      }
      return
    }

    federationStore.touchNode(fromNode, ts)
    markSeen(fromNode)

    // Recovery: a single heartbeat while in suspect rolls back to online with
    // NO side effects (the jitter was absorbed; no member was ever reassigned).
    if (node.status === 'suspect') {
      federationStore.setNodeStatus(fromNode, 'online', ts)
      console.log(`${LOG_TAG} node recovered suspect→online node=${fromNode} ts=${ts}`)
      link.broadcast({
        kind: 'presence-update',
        officeId,
        nodeId: fromNode,
        status: 'online',
        members: memberIdentitiesForNode(fromNode),
        since: ts,
      })
      onNodePresence?.(fromNode, 'online')
      notifyPresence()
    }
  }

  // ── Owner side: run a remote member's turn, then report completion ──

  function handleWake(from: NodeId, msg: WakeFrame): void {
    if (!onWake) {
      console.warn(`${LOG_TAG} wake for non-owner office=${officeId} corr=${msg.correlationId}; dropping`)
      return
    }
    console.log(`${LOG_TAG} wake received office=${officeId} app=${msg.request.appId} corr=${msg.correlationId}`)
    void onWake(msg.request)
      .then((res): TurnCompletion => ({ kind: 'result', content: res.finalMessage ?? '' }))
      .catch((err): TurnCompletion => ({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      }))
      .then((outcome) => {
        // The joiner link routes only to its single host peer, so the target node
        // id is a label; `from` keeps it consistent with the wake's origin.
        link.send(from, { kind: 'turn-complete', officeId, correlationId: msg.correlationId, outcome })
      })
  }

  // ── Inbound dispatch ──

  function onMessage(from: NodeId, msg: FederationMessage): void {
    switch (msg.kind) {
      case 'join-request':
        handleJoinRequest(msg)
        break
      case 'join-grant':
        console.log(`${LOG_TAG} join granted assignedNodeId=${msg.assignedNodeId}`)
        onJoinGrant?.(msg.assignedNodeId)
        break
      case 'join-reject':
        onJoinReject?.(msg.reason)
        break
      case 'heartbeat':
        handleHeartbeat(msg.fromNode, msg.ts)
        break
      case 'rejoin-request':
        // Joiner role: host confirmed us offline while our socket stayed up;
        // re-send the last join-request to re-admit and re-arm the FSM. A host
        // coordinator never sends itself a rejoin-request.
        if (lastJoinRequest) {
          console.log(`${LOG_TAG} rejoin-request received office=${officeId}; re-sending join-request`)
          link.send(lastJoinRequest.fromNode, lastJoinRequest)
        } else {
          console.warn(`${LOG_TAG} rejoin-request received office=${officeId} but no prior join-request to re-send`)
        }
        break
      case 'presence-update':
        // Presence is host-authoritative and projected from office_nodes; most
        // inbound frames are observational (the local FSM owns this node's own
        // view). PEER nodes with no local ledger row adopt the host's projection
        // so a joiner's UI shows them going away/offline (self excluded — a
        // node's own presence is never remote-driven). A confirmed-OFFLINE
        // projection also drives the local unblock: a joiner-lead waiting on a
        // member owned by ANOTHER joiner only learns of that peer's loss this
        // way; otherwise the wait hangs until the hours-long sync timeout.
        if (msg.nodeId !== context.selfNodeId) {
          adoptedPeerPresence.set(msg.nodeId, {
            nodeId: msg.nodeId,
            identity: msg.nodeId,
            displayName: null,
            status: msg.status,
            lastSeen: msg.since,
          })
          notifyPresence()
        }
        if (msg.status === 'offline') applyRemoteOffline(msg)
        break
      case 'wake':
        handleWake(from, msg)
        break
      case 'turn-complete':
        if (onTurnComplete) onTurnComplete(msg.correlationId, msg.outcome)
        else console.warn(`${LOG_TAG} turn-complete for non-authority office=${officeId} corr=${msg.correlationId}; dropping`)
        break
      case 'stream-frames':
        if (onStreamFrames) onStreamFrames(msg)
        else console.warn(`${LOG_TAG} stream-frames with no relay office=${officeId} session=${msg.sessionKey}; dropping`)
        break
      case 'roster':
        // Joiner role: materialize the shadow office from the host's projection.
        // A host never receives roster frames (it is the sole authority), so a
        // roster with no handler is dropped with a warning.
        if (onRoster) onRoster(msg.snapshot)
        else console.warn(`${LOG_TAG} roster with no handler office=${officeId}; dropping`)
        break
      case 'member-leave':
        // Host role: a joiner left → drop the members it brought and re-converge.
        if (onMemberLeave) onMemberLeave(from, msg.appIds)
        else console.warn(`${LOG_TAG} member-leave with no handler office=${officeId}; dropping`)
        break
      default:
        // M2 family (authority / replication / artifact): delegated verbatim to
        // the injected authority module. Unknown future frames are ignored
        // (forward-compat: an unknown optional frame never crashes the node).
        if (isM2Frame(msg)) {
          if (onM2Frame) onM2Frame(from, msg)
          else console.debug(`${LOG_TAG} M2 frame with no authority module office=${officeId} kind=${msg.kind}; dropping`)
        } else {
          console.debug(`${LOG_TAG} unknown frame office=${officeId} kind=${(msg as { kind?: string }).kind}; ignoring`)
        }
        break
    }
  }

  // ── Public surface ──

  function sendHeartbeat(): void {
    link.broadcast({ kind: 'heartbeat', officeId, fromNode: context.selfNodeId, ts: now() })
  }

  /** online → suspect (HOLD). Persist + broadcast(suspect); NO side effects. */
  function enterSuspect(nodeId: NodeId, ts: number, lastSeen: number): void {
    federationStore.setNodeStatus(nodeId, 'suspect', lastSeen)
    console.log(`${LOG_TAG} node suspect node=${nodeId} lastSeen=${lastSeen} ts=${ts}`)
    link.broadcast({
      kind: 'presence-update',
      officeId,
      nodeId,
      status: 'suspect',
      members: memberIdentitiesForNode(nodeId),
      since: ts,
    })
    onNodePresence?.(nodeId, 'suspect')
    notifyPresence()
  }

  /**
   * suspect → confirmed-offline. The single source of confirmed-offline. NOW
   * act: persist offline, fan out each bound member (unblock via the injected
   * onMemberConfirmedOffline), and broadcast presence(offline, members[]). Guarded
   * to fire exactly once per node until a rejoin re-arms it.
   */
  function confirmOffline(nodeId: NodeId, ts: number, lastSeen: number): void {
    confirmedNodes.add(nodeId)
    federationStore.setNodeStatus(nodeId, 'offline', lastSeen)

    // Fan out via the persistent owner_node_id binding (not the last presence
    // frame) so the unblock never misses a member.
    const bound = listMembersForNode(nodeId)
    for (const member of bound) {
      onMemberConfirmedOffline?.(member.appId)
    }

    const members = bound
      .map((m) => m.memberIdentity)
      .filter((id): id is string => id != null)
    const memberIds = members.length > 0 ? [...new Set(members)] : memberIdentitiesForNode(nodeId)

    console.log(
      `${LOG_TAG} node confirmed-offline node=${nodeId} lastSeen=${lastSeen} ts=${ts} members=${bound.length}`
    )
    link.broadcast({
      kind: 'presence-update',
      officeId,
      nodeId,
      status: 'offline',
      members: memberIds,
      since: ts,
    })
    onNodePresence?.(nodeId, 'offline')
    notifyPresence()
  }

  /**
   * Drive the local confirmed-offline side-effect from a host-projected
   * presence(offline) frame. Used when this node has no direct FSM over the
   * offline node (a joiner observing a PEER joiner's loss via the host). Resolves
   * the affected members to local appIds — by the persistent owner_node_id
   * binding and by the identity ids the frame carries — and unblocks each waiting
   * lead exactly once. Guarded by confirmedNodes so a repeated offline projection
   * does not re-fire; this node's OWN nodeId is skipped (the local FSM owns it).
   * No re-broadcast and no FSM mutation here: this is a pure local unblock,
   * keeping presence host-authoritative and avoiding a fan-out loop.
   */
  function applyRemoteOffline(msg: { nodeId: NodeId; members: string[] }): void {
    if (msg.nodeId === context.selfNodeId) return
    if (confirmedNodes.has(msg.nodeId)) return
    confirmedNodes.add(msg.nodeId)

    const affectedIdentities = new Set(msg.members)
    const appIds = new Set<string>()
    for (const m of teamStore.listMembersByTeam(officeId)) {
      const ownedByOfflineNode = m.ownerNodeId === msg.nodeId
      const namedByFrame = m.memberIdentity != null && affectedIdentities.has(m.memberIdentity)
      if (ownedByOfflineNode || namedByFrame) appIds.add(m.appId)
    }

    console.log(
      `${LOG_TAG} remote offline projection office=${officeId} node=${msg.nodeId} members=${appIds.size}`
    )
    for (const appId of appIds) onMemberConfirmedOffline?.(appId)
  }

  /**
   * Advance every tracked node's debounce FSM against the current clock. A
   * transport-silence sequence always passes online → suspect → confirmed; there
   * is no online → offline direct jump. A node already
   * confirmed-offline is inert until a rejoin.
   */
  function sweepPresence(): void {
    const ts = now()
    const mono = monotonicNow()

    // Host suspend/resume guard: the monotonic clock does not advance
    // while the machine sleeps, so a sweep across a resume shows the wall clock
    // jumping far more than the monotonic clock. On such a gap, do NOT escalate
    // any node this tick — instead grant every node a fresh grace window so a
    // wake-up does not register a sleep as transport silence and mass-confirm
    // healthy peers offline. Real departures re-confirm on later normal ticks.
    if (lastSweep) {
      const wallDelta = ts - lastSweep.wall
      const monoDelta = mono - lastSweep.mono
      if (wallDelta - monoDelta >= confirmedOfflineMs) {
        for (const node of federationStore.listNodesByOffice(officeId)) {
          if (!confirmedNodes.has(node.nodeId)) markSeen(node.nodeId)
        }
        console.warn(
          `${LOG_TAG} presence resume guard office=${officeId} wallDelta=${wallDelta} monoDelta=${monoDelta}; granting grace`
        )
        lastSweep = { wall: ts, mono }
        return
      }
    }
    lastSweep = { wall: ts, mono }

    for (const node of federationStore.listNodesByOffice(officeId)) {
      // Never sweep this node's OWN row: a node does not heartbeat to itself,
      // so its self-silence grows unboundedly and would "confirm" it offline
      // ~13s after it records itself (host at hostOffice, joiner at join-grant).
      // A joiner then BROADCASTS that phantom offline up to the host, poisoning
      // the host's confirmedNodes guard — when the node later dies for real,
      // applyRemoteOffline short-circuits and no unblock/busy-clear ever fires.
      if (node.nodeId === context.selfNodeId) continue
      if (confirmedNodes.has(node.nodeId)) continue
      const silence = mono - monotonicLastSeenOf(node)
      if (node.status === 'online') {
        // online → suspect always broadcasts first, even when silence already
        // exceeds confirmedOfflineMs in this same tick, so downstream observers
        // never see a bare online→offline transition.
        if (silence >= confirmedOfflineMs) {
          enterSuspect(node.nodeId, ts, node.lastSeen)
          confirmOffline(node.nodeId, ts, node.lastSeen)
        } else if (silence >= suspectAfterMs) {
          enterSuspect(node.nodeId, ts, node.lastSeen)
        }
      } else if (node.status === 'suspect') {
        if (silence >= confirmedOfflineMs) {
          confirmOffline(node.nodeId, ts, node.lastSeen)
        }
      }
    }
  }

  function requestJoin(req: JoinRequest): void {
    // Remember it so an inbound rejoin-request can re-send it without the manager
    // re-supplying the payload (the host-driven recovery from confirmed-offline).
    lastJoinRequest = req
    link.send(req.fromNode, req) // peers resolve the host; in M1a the link routes it.
  }

  function start(): void {
    link.onMessage(onMessage)
    if (heartbeatTimer) return
    // The heartbeat period also drives the silence sweep; at 2s it is well below
    // the 6s suspect threshold so a single missed beat never trips the FSM.
    const interval = Math.max(1, heartbeatIntervalMs)
    heartbeatTimer = setInterval(() => {
      sendHeartbeat()
      sweepPresence()
    }, interval)
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref()
    console.log(`${LOG_TAG} started office=${officeId} self=${context.selfNodeId}`)
  }

  function stop(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
    link.close()
    console.log(`${LOG_TAG} stopped office=${officeId}`)
  }

  return {
    start,
    stop,
    requestJoin,
    sendHeartbeat,
    sweepPresence,
    tick: sweepPresence,
    getPresence: snapshot,
    broadcastRoster,
  }
}
