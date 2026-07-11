/**
 * apps/runtime/federation -- Per-office FederationManager
 *
 * One node can simultaneously HOST offices it created and JOIN offices hosted
 * elsewhere. The manager holds a per-office Federation (the M1a coordinator) and
 * wires each one's transport to the correct pipe:
 *
 *   HOST role   — inbound 'federation' frames arrive on the host's WS server and
 *                 are routed here by the Lead's websocket.ts via handleHostInbound.
 *                 Outbound frames to a joiner go through the injected hostSend,
 *                 resolved nodeId → clientId from a per-office map learned when a
 *                 join-request first arrives on a clientId.
 *   JOINER role — an outbound WsFederationClient connects to the host's server,
 *                 authenticates with the office credential, and exchanges frames;
 *                 the coordinator's link is backed by that client.
 *
 * Dependency direction: this module imports no http/*. Host
 * send + office-client listing + local node id + credential verification are all
 * INJECTED by bootstrap (which lives in the transport tier above apps). The
 * joiner leg uses the `ws` library directly, which is a library, not http/*.
 */

import { performance } from 'perf_hooks'
import { randomUUID } from 'crypto'
import { createFederation, type Federation } from './index'
import type { FederationLink } from './link'
import { LanMeshLink, type WsSender } from './lan-mesh-provider'
import { WsFederationClient } from './ws-federation-client'
import { createStreamReplay, type StreamReplay } from './relay'
import type { NodeBoundMember } from './coordinator'
import type { FederationStore, OfficeCredentialLike } from './deps'
import type { TeamStore, BlackboardTask } from '../../team'
import { createOfficeAuthority, type OfficeAuthority } from './authority/office-authority'
import type { ReadMemberHistory } from './authority/history-fetch'
import type { OwnerStatus } from './authority/reconcile'
import type { MemberWriteRecord } from './authority/replication'
import type { OutboundBlackboardWrite } from './authority/location-aware-blackboard'
import type { BlackboardWriteRecord } from '../team/blackboard'
import type { ArtifactRef, BlackboardWriteFrame, M2Frame, SerializedHistoryMessage } from './protocol-m2'
import type { AuthorityStore } from '../../federation'
import { SELF_NODE_ID, type TeamMemberRuntimeStatus } from '../../../../shared/apps/team-types'
import type {
  FederationMessage,
  JoinMember,
  JoinRequest,
  NodeId,
  OfficeContext,
  OfficePresenceSnapshot,
  PresenceSnapshot,
  SerializedWakeRequest,
  StreamFramesFrame,
} from './types'
import type { TurnCompletion } from '../team/message-bus'

const LOG_TAG = '[FedManager]'

/** How long joinOffice waits for a grant/reject before resolving failed. */
const JOIN_TIMEOUT_MS = 15_000

/**
 * Backstop for a host-relayed cross-joiner wake: if the owning joiner never
 * refluxes a turn-complete (e.g. it died mid-turn before presence confirmed it
 * offline), resolve empty and drop the waiter rather than leaking it until the
 * hours-long bus sync timeout. Generous so a legitimately long member turn is
 * never cut off.
 */
const RELAY_WAKE_TIMEOUT_MS = 10 * 60_000

/**
 * Coalescing window for the throttled run-state roster refresh. A run flips
 * member status rapidly; this caps re-projections to one per window per office so
 * a busy team never floods the wire while still feeling live (sub-second).
 */
const ROSTER_REFRESH_COALESCE_MS = 750

/**
 * Resolves an outbound sender aimed at a freshly-elected authority. Given the
 * office and the new authority's node id, it returns a {@link WsSender} pointed
 * at that node (or null when it cannot be reached). This is the single seam the
 * transport uses to re-form after a host loss: production injects a real LAN
 * dialer; a test rig injects one backed by its in-memory hub. The default is a
 * no-op that returns null — production LAN discovery is deferred (tracked), so an
 * un-injected manager simply cannot redial (the office stays paused, honestly).
 */
export type PeerDialer = (officeId: string, authorityNodeId: NodeId) => WsSender | null

/** Default dialer: cannot reach any peer (see {@link PeerDialer}). */
const NO_PEER_DIALER: PeerDialer = () => null

export interface FederationManagerDeps {
  /** Host → joiner send; bootstrap passes websocket.ts sendFederationFrameToClient. */
  hostSend: (clientId: string, frame: FederationMessage) => boolean
  /** Authenticated office-member client ids for an office (host broadcast set). */
  hostListOfficeClients: (officeId: string) => string[]
  federationStore: FederationStore
  teamStore: TeamStore
  /** Office-credential verifier (injected so the manager never imports http/auth). */
  verifyCredential: (token: string) => OfficeCredentialLike | null
  /** Stable local node id; bootstrap passes () => getLocalIdentity().id. */
  getLocalNodeId: () => string
  /**
   * Human display name this node advertises when joining an office, shown as the
   * owner badge on the members it brings. Bootstrap passes
   * () => getLocalIdentity().displayName. Absent → the host renders a neutral
   * generic label.
   */
  getLocalDisplayName?: () => string | null
  /**
   * A member's live runtime status on this (authority) node, stamped into the
   * roster snapshot so a joiner animates the working pulse in step with the host.
   * Bootstrap passes the team runtime's getMemberStatus. Absent → 'idle' for every
   * member (M1 behaviour preserved).
   */
  getMemberRuntimeStatus?: (appId: string) => TeamMemberRuntimeStatus
  /**
   * Owner role: run a brought member's turn locally when a wake arrives over a
   * joined office. Bootstrap injects the local createDefaultSessionDeps adapter.
   * Absent → a wake on a joined office logs+drops (node owns no runnable member).
   */
  runLocalTurn?: (request: SerializedWakeRequest) => Promise<{ finalMessage: string | null }>
  /**
   * Fired once per bound member when its owner node is confirmed-offline.
   * Bootstrap wires this to bus.resolvePendingWaitsForMember so a waiting lead
   * unblocks immediately. Applied to every office (host + joined). Absent →
   * confirmed-offline still fans out presence, but no kernel unblock is signalled.
   */
  onMemberConfirmedOffline?: (appId: string) => void
  /**
   * Presence projection changed for an office. Bootstrap maps this to a UI
   * `team:presence` event. Applied to every office. Absent → no UI signal.
   */
  onPresenceChange?: (officeId: string, snap: PresenceSnapshot) => void
  /**
   * The office roster changed (host: a node joined; joiner: a roster snapshot
   * was materialized). Bootstrap maps this to a `team:updated` UI event so the
   * renderer re-fetches roster + relationship graph. Applied to host + joined
   * offices. Absent → no UI signal.
   */
  onRosterChanged?: (officeId: string) => void
  /**
   * Joiner role: the host removed a member from this office. Bootstrap maps
   * this to a UI signal so the renderer drops the row immediately. The shadow
   * roster also re-converges via the accompanying roster re-broadcast. Absent →
   * the roster still converges; no immediate per-member signal.
   */
  onMemberRemovedRemote?: (officeId: string, appId: string) => void
  /**
   * Joiner role: the host dissolved this office. Bootstrap maps this to a
   * neutral UI signal + tears down the joined office locally. Absent → the joiner
   * keeps a stale shadow office until the link drops.
   */
  onOfficeDissolvedRemote?: (officeId: string) => void
  /**
   * Host role: a joiner left the office → remove the members it brought. Bootstrap
   * maps this to teamService.removeMember per app (which re-projects member-removed
   * + re-broadcasts the roster, and reassigns the lead if one departed). The
   * manager has already verified each appId is owned by the leaving node.
   */
  onMemberLeft?: (officeId: string, appIds: string[]) => void

  // ── M2 authority/replication/resilience (all optional; absent → M1b behaviour) ──
  /** Durable replication log + tenure water marks (app_federation). Enables M2. */
  authorityStore?: AuthorityStore
  /** Apply an admitted member write through the authority's kernel blackboard. */
  applyMemberWrite?: (record: MemberWriteRecord) => void
  /** The office's open run epoch, for post-handover reconciliation. */
  getCurrentRunEpoch?: (officeId: string) => { teamId: string; epochId: string } | null
  /** Owner reachability for a member appId (presence + kernel busy). */
  getOwnerStatus?: (officeId: string, appId: string) => OwnerStatus
  /** Re-drive an orphaned in_progress task after a handover. */
  reassignTask?: (officeId: string, task: BlackboardTask) => void
  /** Owner-side: resolve a published artifact ref to bytes (services/space). */
  resolveArtifactBytes?: (ref: ArtifactRef) => Promise<Uint8Array | null>
  /**
   * Owner-side: read an owned member's run transcript for an epoch. Injected
   * by bootstrap from app-chat (the federation layer never imports app-chat).
   * Absent → this node serves no history.
   */
  readMemberHistory?: ReadMemberHistory
  /**
   * A hot-standby applied a replicated task/finding to its replica store.
   * Bootstrap maps this to a UI refresh event so the renderer shows the live
   * task/finding without a reload. Absent → no signal.
   */
  onReplicaApplied?: (info: { officeId: string; op: string; taskId?: string }) => void
  /** Authority changed → neutral UI signal + re-point. */
  onAuthorityChange?: (officeId: string, authorityNodeId: NodeId, term: number) => void
  /** Office paused/resumed (partition minority) → neutral UI signal. */
  onOfficePaused?: (officeId: string, paused: boolean) => void
  /**
   * Transport-only re-form seam: resolve a sender to a newly-elected authority
   * after a host loss. See {@link PeerDialer}. Absent → {@link NO_PEER_DIALER}.
   */
  peerDialer?: PeerDialer
  /**
   * The authenticated identity bound to a host-side WS client (established by the
   * office-credential handshake in websocket.ts). A joined node authenticates as
   * its portable Identity.id, which is also its node id on the wire, so the host
   * uses this to assert an inbound frame's self-reported `fromNode` matches the
   * session that carried it — closing the same-office node-spoofing hole (a member
   * node cannot forge another node's id). Absent (or returns null for a client) →
   * the binding is not yet available, so the assertion is skipped and M1 behaviour
   * is preserved; injected → a mismatched frame is dropped at the host edge.
   */
  getSessionIdentity?: (clientId: string) => NodeId | null
}

export interface JoinOfficeParams {
  officeId: string
  /** Host server base URL, e.g. http://host:3017 (the WsFederationClient upgrades it). */
  serverUrl: string
  credentialToken: string
  /** This node's own identity/context within the joined office. */
  selfContext: OfficeContext
  bringMembers: JoinMember[]
}

export interface FederationManager {
  /** Create (or return) the host-role coordinator for an office this node authorities. */
  hostOffice(officeId: string): Federation
  /** Route an inbound host-side federation frame to the office's host coordinator. */
  handleHostInbound(ctx: { clientId: string; officeId: string; frame: unknown }): void
  /** Join a remote office over an outbound WS client; resolve on grant/reject/timeout. */
  joinOffice(params: JoinOfficeParams): Promise<{ ok: boolean; reason?: string }>
  /** Stop + tear down a hosted or joined office. */
  leaveOffice(officeId: string): void
  /**
   * Joiner role: tell the host this node is leaving (drop the members it brought)
   * before tearing the joined office down locally, so the host roster converges.
   */
  signalLeave(officeId: string): void
  getOffice(officeId: string): Federation | null
  listHostedOffices(): string[]
  listJoinedOffices(): string[]
  /** Read a remote member's cached spaceId (host role; populated at join). */
  getRemoteMemberSpaceId(appId: string): string | undefined
  /**
   * Authority role: send a wake to the owner node of a remote member over the
   * host office's link. Returns false when the office isn't hosted here or the
   * owner node has no client mapping yet.
   */
  sendWakeToMember(params: {
    officeId: string
    ownerNodeId: NodeId
    request: SerializedWakeRequest
    correlationId: string
  }): boolean
  /**
   * Authority role: register a one-shot callback fired when the matching
   * turn-complete frame arrives. Returns an unsubscribe to drop a stale waiter.
   */
  registerTurnComplete(correlationId: string, cb: (outcome: TurnCompletion) => void): () => void
  /**
   * Authority role: whether a member's turn is currently in flight on a REMOTE
   * owner (wake sent, turn-complete pending). The team runtime folds this into
   * getMemberStatus so boards/rosters pulse remote members too — the local
   * session ledger only knows turns executing on this node.
   */
  isMemberRemoteBusy(appId: string): boolean
  /**
   * The RelayCapture sink: route a flushed activity batch for an owned member.
   * HOSTED here → re-broadcast to the office's other clients (the producing
   * member's events already fired locally, so do NOT apply again). JOINED →
   * forward to the host over the joined office's link. Bootstrap passes this to
   * createRelayCapture (sink = manager.relaySink).
   */
  relaySink(officeId: string, batch: StreamFramesFrame): void
  /**
   * M2: route an authoritative local blackboard write (from the global
   * onBlackboardWrite) to the hosting office's replication layer. No-op when the
   * office is not hosted here (this node is not its authority) or M2 is off.
   */
  routeAuthorityWrite(record: BlackboardWriteRecord): void
  /**
   * M2: a shadow office's location-aware blackboard routes a member write to its
   * host as a `blackboard-write` frame over the joined office's link.
   */
  sendMemberWrite(write: OutboundBlackboardWrite & { hostNodeId: NodeId }): void
  /** The per-office authority module (M2), or null when absent. */
  getOfficeAuthority(officeId: string): OfficeAuthority | null
  /**
   * Read-only presence + authority view for an office this node hosts or has
   * joined. Combines the coordinator's node presence snapshot with this node's
   * role and (when M2 is on) the authority state. Returns null when the office
   * is neither hosted nor joined here. Pure read — no state is created.
   */
  getOfficePresence(officeId: string): OfficePresenceSnapshot | null
  /**
   * Egress: re-project the full roster to every joiner of a hosted office on a
   * membership mutation. Wired to the team service's onRosterMutated hook.
   * No-op when the office is not hosted here.
   */
  broadcastRosterFor(officeId: string): void
  /**
   * Egress (throttled): coalesce a roster re-projection so the run-state plane —
   * team running status + per-member working/idle churn + the in-progress task
   * title — converges to joiners at a bounded rate during a run, without flooding
   * the wire on every member-status flip. Fired on run start/stop and on every
   * authoritative board write. No-op when the office is not hosted here.
   */
  scheduleRosterRefresh(officeId: string): void
  /**
   * Egress: project a `member-removed` frame to every joiner of a hosted office.
   * Wired to the team service's onMemberRemoved hook. No-op when not hosted.
   */
  projectMemberRemoved(officeId: string, appId: string): void
  /**
   * Egress: project an `office-dissolved` frame to every joiner of a hosted office.
   * Wired to the team service's onOfficeDissolved hook. Call BEFORE local
   * teardown so the frame still rides the live link. No-op when not hosted.
   */
  projectOfficeDissolved(officeId: string): void
  /**
   * Viewer: pull a member's run transcript from the node that OWNS it. The
   * owner authorizes the request (serves only members it owns) and replies over
   * the history plane. Used by the http read side (eng-perms) to serve a viewer's
   * history request. Rejects when the office is not present here, has M2 off, or
   * the owner refuses/times out.
   */
  fetchMemberHistory(params: {
    officeId: string
    ownerNodeId: NodeId
    appId: string
    epochId: string
  }): Promise<SerializedHistoryMessage[]>
  /**
   * Transport-only reconfiguration seam: swap the outbound sender of an office's
   * link in place. The coordinator, authority, and inbound handler are untouched;
   * only where outgoing frames go changes. Lets a survivor's outbound leg be
   * redirected to a new peer target after a host loss (or be driven end-to-end by
   * a test rig) without rebuilding the office. Returns false when no office with
   * that id is hosted or joined here.
   */
  repointLink(officeId: string, newSendTarget: WsSender): boolean
  /**
   * Resolve a sender to `authorityNodeId` via the injected {@link PeerDialer} and
   * repoint the office's link to it. The convenience path a survivor (or the test
   * rig) calls on "new authority elected/received". Returns false when the office
   * is not hosted/joined here OR the dialer cannot reach that node.
   */
  redialToAuthority(officeId: string, authorityNodeId: NodeId): boolean
  stopAll(): void
}

interface HostedOffice {
  federation: Federation
  /** The office's outbound link, kept so its sender can be repointed (transport seam). */
  link: LanMeshLink
  /** nodeId ↔ clientId, learned when a join-request arrives on a clientId. */
  nodeToClient: Map<NodeId, string>
  /**
   * The clientId a stream-frames batch is currently being processed for, set just
   * before delivering it into the coordinator so the host re-broadcast can exclude
   * the producing client. Without this the host fan-out echoes a producer's own
   * frames back to it, which (combined with relay re-capture) forms the A→B→A
   * amplification loop. Null when no stream batch is in flight.
   */
  streamOriginClientId: string | null
  /** M2 per-office authority module (election/replication/reconcile/scope/artifact). */
  authority?: OfficeAuthority
}

interface JoinedOffice {
  federation: Federation
  client: WsFederationClient
  /** The office's outbound link, kept so its sender can be repointed (transport seam). */
  link: LanMeshLink
  /** M2 per-office authority module (this node may be elected to host on handover). */
  authority?: OfficeAuthority
}

export function createFederationManager(deps: FederationManagerDeps): FederationManager {
  const hosted = new Map<string, HostedOffice>()
  const joined = new Map<string, JoinedOffice>()
  // Remote member appId → spaceId, cached at join for later wake addressing.
  const remoteMemberSpaceIds = new Map<string, string>()
  // Authority role: correlationId → one-shot turn-complete callback.
  const turnCompleteWaiters = new Map<string, (outcome: TurnCompletion) => void>()
  // Viewer-side replay: re-fires received activity frames as local agent events
  // (renderer zero-change). Shared across offices; dedup is keyed per-sessionKey.
  const streamReplay: StreamReplay = createStreamReplay()
  // Transport re-form seam: how a survivor reaches a newly-elected authority.
  // Default cannot dial (production LAN discovery deferred, tracked).
  const peerDialer: PeerDialer = deps.peerDialer ?? NO_PEER_DIALER

  // Per-office coalescing timers for throttled roster refresh: a busy run flips
  // member status many times a second, so the run-state plane is rate-limited to
  // at most one re-projection per ROSTER_REFRESH_COALESCE_MS per office.
  const rosterRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>()

  // Resolve a node's bound members for confirmed-offline fan-out via the
  // persistent owner_node_id binding. Per-office so the FSM only fans
  // out members that actually belong to the offline node in that office.
  function membersForNode(officeId: string, nodeId: NodeId): NodeBoundMember[] {
    return deps.teamStore
      .listMembersByTeam(officeId)
      .filter((m) => m.ownerNodeId === nodeId)
      .map((m) => ({ appId: m.appId, memberIdentity: m.memberIdentity ?? null }))
  }

  // Persist (or refresh) the re-join record for a joined office so a restart can
  // reconnect without the user re-entering the invite. The invite token is an
  // at-rest secret; the store envelope-encodes it on write.
  function writeJoinedConnection(
    officeId: string,
    serverUrl: string,
    inviteToken: string,
    bringMembers: JoinMember[]
  ): void {
    const existing = deps.federationStore
      .listJoinedOfficeConnections()
      .find((c) => c.officeId === officeId)
    const now = Date.now()
    deps.federationStore.upsertJoinedOfficeConnection({
      officeId,
      serverUrl,
      inviteToken,
      bringAppIds: bringMembers.map((m) => m.appId),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })
  }

  // Remove one brought app from a joined office's re-join record. When that
  // empties the record's bring set, the node no longer keeps any member here →
  // delete the record so the next start does not auto-rejoin.
  function dropBroughtApp(officeId: string, appId: string): void {
    const conn = deps.federationStore
      .listJoinedOfficeConnections()
      .find((c) => c.officeId === officeId)
    if (!conn) return
    const remaining = conn.bringAppIds.filter((id) => id !== appId)
    if (remaining.length === conn.bringAppIds.length) return
    if (remaining.length === 0) {
      deps.federationStore.removeJoinedOfficeConnection(officeId)
      return
    }
    deps.federationStore.upsertJoinedOfficeConnection({
      ...conn,
      bringAppIds: remaining,
      updatedAt: Date.now(),
    })
  }

  /**
   * Compose the per-office M2 authority module over a link. Returns undefined when
   * M2 is off (no authorityStore injected) → the office runs M1b behaviour only.
   * The module's send/broadcast ride the office's own link; its callbacks bridge
   * back to the manager/bootstrap (run epoch, owner status, reassign, member-write
   * apply, authority-change UI).
   */
  function buildAuthority(officeId: string, link: FederationLink): OfficeAuthority | undefined {
    const authorityStore = deps.authorityStore
    if (!authorityStore) return undefined
    return createOfficeAuthority({
      officeId,
      selfNodeId: deps.getLocalNodeId(),
      federationStore: deps.federationStore,
      authorityStore,
      teamStore: deps.teamStore,
      send: (to, frame) => link.send(to, frame),
      broadcast: (frame) => link.broadcast(frame),
      getCurrentRunEpoch: () => deps.getCurrentRunEpoch?.(officeId) ?? null,
      getOwnerStatus: (appId) => deps.getOwnerStatus?.(officeId, appId) ?? 'idle',
      reassignTask: (task) => deps.reassignTask?.(officeId, task),
      applyMemberWrite: (record) => deps.applyMemberWrite?.(record),
      onBecomeAuthority: (term) => {
        // The successor records itself as authority (term-state already did). Mark
        // its own node row online so its replication views include it. Full P2P
        // transport re-formation after a host loss is a LAN-discovery item; the
        // committed state is preserved here regardless (no lost write).
        ensureSelfNode(officeId)
        console.log(`${LOG_TAG} became office authority office=${officeId} term=${term}`)
      },
      onAuthorityChange: (nodeId, term) => deps.onAuthorityChange?.(officeId, nodeId, term),
      onStepdown: () => console.log(`${LOG_TAG} stepped down as authority office=${officeId}`),
      onPausedChange: (paused) => deps.onOfficePaused?.(officeId, paused),
      resolveArtifactBytes: (ref) => deps.resolveArtifactBytes?.(ref) ?? Promise.resolve(null),
      readMemberHistory: deps.readMemberHistory,
      onReplicaApplied: deps.onReplicaApplied,
    })
  }

  /** Ensure this node has its own office_nodes row (needed for election views). */
  function ensureSelfNode(officeId: string): void {
    const self = deps.getLocalNodeId()
    const displayName = deps.getLocalDisplayName?.() ?? null
    const existing = deps.federationStore.getNode(self)
    // The row also feeds the roster's ownerDisplayName for host-owned members,
    // so refresh it when the advertised name changed (or was never stamped).
    if (existing && existing.officeId === officeId && existing.displayName === displayName) return
    deps.federationStore.upsertNode({
      nodeId: self,
      officeId,
      identity: self,
      displayName,
      // The creator/host is the earliest joiner; a small stamp keeps it front in
      // candidate order while it is alive (and excluded once offline).
      joinedAt: existing?.joinedAt ?? 1,
      lastSeen: Date.now(),
      status: 'online',
    })
  }

  // ── Remote-busy overlay (host role) ──
  // Members whose turn is currently running on a REMOTE owner (a wake was sent,
  // its turn-complete has not come back). The host's local runtime only knows
  // turns it executes itself, so without this overlay the roster projected to
  // viewers pulses ONLY host-owned members — a joiner-owned member looked idle
  // everywhere while it was actually working. Keyed by wake correlationId;
  // entries clear on turn-complete/waiter-cleanup, with a TTL backstop against
  // a wake whose completion never arrives.
  const remoteBusyByCorr = new Map<string, { officeId: string; appId: string; startedAt: number }>()
  const REMOTE_BUSY_TTL_MS = 10 * 60_000

  function markRemoteBusy(correlationId: string, officeId: string, appId: string): void {
    remoteBusyByCorr.set(correlationId, { officeId, appId, startedAt: Date.now() })
    scheduleRosterRefresh(officeId)
  }

  function clearRemoteBusy(correlationId: string): void {
    const entry = remoteBusyByCorr.get(correlationId)
    if (!entry) return
    remoteBusyByCorr.delete(correlationId)
    scheduleRosterRefresh(entry.officeId)
  }

  /** Drop every in-flight entry for one member (its owner was confirmed offline). */
  function clearRemoteBusyForApp(appId: string): void {
    for (const [corr, entry] of remoteBusyByCorr) {
      if (entry.appId !== appId) continue
      remoteBusyByCorr.delete(corr)
      scheduleRosterRefresh(entry.officeId)
    }
  }

  function isRemoteBusy(appId: string): boolean {
    const now = Date.now()
    for (const [corr, entry] of remoteBusyByCorr) {
      if (now - entry.startedAt > REMOTE_BUSY_TTL_MS) {
        remoteBusyByCorr.delete(corr)
        continue
      }
      if (entry.appId === appId) return true
    }
    return false
  }

  function dispatchTurnComplete(correlationId: string, outcome: TurnCompletion): void {
    clearRemoteBusy(correlationId)
    const cb = turnCompleteWaiters.get(correlationId)
    if (!cb) {
      console.warn(`${LOG_TAG} turn-complete with no waiter corr=${correlationId}; dropping`)
      return
    }
    turnCompleteWaiters.delete(correlationId)
    cb(outcome)
  }

  function registerTurnComplete(
    correlationId: string,
    cb: (outcome: TurnCompletion) => void
  ): () => void {
    turnCompleteWaiters.set(correlationId, cb)
    return () => {
      turnCompleteWaiters.delete(correlationId)
      // Caller gave up on this wake (timeout/teardown) → its member is no longer
      // "working" from this node's point of view.
      clearRemoteBusy(correlationId)
    }
  }

  function hostOffice(officeId: string): Federation {
    const existing = hosted.get(officeId)
    if (existing) return existing.federation

    const entry: HostedOffice = {
      federation: undefined as unknown as Federation,
      link: undefined as unknown as LanMeshLink,
      nodeToClient: new Map(),
      streamOriginClientId: null,
    }

    // Host link: send(nodeId) resolves a clientId then hostSend; broadcast fans
    // out to every authenticated office-member client. A missing mapping is a
    // dropped frame with a warning (never a throw). On a broadcast, the client a
    // stream batch arrived on is EXCLUDED so the host never echoes a producer's
    // own frames back to it (loop prevention, layer 1).
    const link: LanMeshLink = new LanMeshLink((to: NodeId | null, frame: FederationMessage) => {
      if (to === null) {
        const exclude = frame.kind === 'stream-frames' ? entry.streamOriginClientId : null
        for (const clientId of deps.hostListOfficeClients(officeId)) {
          if (exclude !== null && clientId === exclude) continue
          deps.hostSend(clientId, frame)
        }
        return
      }
      const clientId = entry.nodeToClient.get(to)
      if (!clientId) {
        console.warn(`${LOG_TAG} host send: no client for node=${to} office=${officeId}`)
        return
      }
      if (!deps.hostSend(clientId, frame)) {
        console.warn(`${LOG_TAG} host send failed node=${to} client=${clientId} office=${officeId}`)
      }
    })
    entry.link = link

    // M2 authority module for this hosted office (undefined when M2 is off).
    const authority = buildAuthority(officeId, link)

    const federation = createFederation({
      context: { officeId, selfNodeId: deps.getLocalNodeId() },
      link,
      federationStore: deps.federationStore,
      teamStore: deps.teamStore,
      verifyCredential: deps.verifyCredential,
      // Suspend-safe silence clock so a host sleep does not mass-confirm peers.
      monotonicNow: () => performance.now(),
      listMembersForNode: (nodeId) => membersForNode(officeId, nodeId),
      // A confirmed-offline owner's members can no longer be "working": their
      // turn-complete will never arrive, so drop any in-flight remote-busy
      // entries FIRST — otherwise the roster keeps a dead member pulsing for
      // the full busy TTL. Then run the kernel unblock.
      onMemberConfirmedOffline: (appId) => {
        clearRemoteBusyForApp(appId)
        deps.onMemberConfirmedOffline?.(appId)
      },
      onPresenceChange: deps.onPresenceChange
        ? (snap) => deps.onPresenceChange!(officeId, snap)
        : undefined,
      onRemoteMemberSpaceId: (appId, spaceId) => remoteMemberSpaceIds.set(appId, spaceId),
      // Owner role on the HOST: a joiner woke a member this host OWNS. Run the turn
      // locally and reflux turn-complete to the joiner (symmetric with the joiner's
      // owner role). Absent → a wake for a host-owned member would log+drop.
      onWake: deps.runLocalTurn ? (request) => runOrForwardWakeOnHost(officeId, request) : undefined,
      onTurnComplete: (correlationId, outcome) => dispatchTurnComplete(correlationId, outcome),
      // Host role: a joiner left → drop the members it brought and re-converge.
      onMemberLeave: (from, appIds) => handleMemberLeaveOnHost(officeId, from, appIds),
      // Host: a join changed the roster → refresh the authority's renderer.
      onRosterChanged: deps.onRosterChanged
        ? () => deps.onRosterChanged!(officeId)
        : undefined,
      // HOST office: stream-frames from a joiner → replay so the authority's
      // renderer/WS see the remote member, then re-broadcast to the office's
      // other clients (the sender already has them locally; viewer dedup guards
      // any overlap). Broadcasting to all is acceptable for M1b.
      onStreamFrames: (batch) => {
        streamReplay.apply(batch)
        link.broadcast(batch)
      },
      // M2: route authority/replication/artifact frames to the per-office module.
      onM2Frame: authority ? (from, frame) => authority!.handle(from, frame) : undefined,
      // M2: forward node-presence transitions so the handover layer can react.
      onNodePresence: authority ? (nodeId, status) => authority!.onNodePresence(nodeId, status) : undefined,
      // M2: stamp the join-grant with the current tenure + effective caps.
      getJoinGrantExtras: authority ? () => authority!.getJoinGrantExtras() : undefined,
      // Run-context: stamp the roster snapshot with the open run epoch so a joiner
      // derives the live session key and renders an in-progress run's history.
      getCurrentRunEpoch: () => deps.getCurrentRunEpoch?.(officeId)?.epochId ?? null,
      // Run-context: stamp each member's live status so a joiner's topology
      // animates the working pulse + run banner in step with the host. Bootstrap
      // passes the runtime's status (which already folds in this manager's
      // remote-busy overlay via isMemberRemoteBusy).
      getMemberRuntimeStatus: deps.getMemberRuntimeStatus,
    })
    entry.federation = federation
    entry.authority = authority
    hosted.set(officeId, entry)
    // The host is this office's authority: make sure it has a node row + believes
    // it is the authority at the current tenure (term 0+ on first host).
    if (authority) {
      ensureSelfNode(officeId)
      authority.termState.setAuthority(deps.getLocalNodeId(), authority.termState.getTerm())
    }
    federation.coordinator.start()
    console.log(`${LOG_TAG} hosting office=${officeId}`)
    return federation
  }

  function handleHostInbound(ctx: { clientId: string; officeId: string; frame: unknown }): void {
    const entry = hosted.get(ctx.officeId)
    if (!entry) {
      console.warn(`${LOG_TAG} inbound for unhosted office=${ctx.officeId}; dropping frame`)
      return
    }
    const frame = ctx.frame as FederationMessage
    const fromNode = resolveFromNode(frame)
    if (!fromNode) {
      // turn-complete and stream-frames carry no source node but must still
      // reach the host coordinator: turn-complete resolves the pending wait by
      // correlationId; stream-frames is replayed + re-broadcast by onStreamFrames.
      if (frame.kind === 'stream-frames') {
        // Mark the producing client so the synchronous re-broadcast inside
        // onStreamFrames excludes it (no echo back to the producer → no loop).
        // Delivery is synchronous, so clear it immediately after.
        entry.streamOriginClientId = ctx.clientId
        try {
          ;(entry.federation.link as LanMeshLink).deliver(ctx.clientId, frame)
        } finally {
          entry.streamOriginClientId = null
        }
        return
      }
      if (frame.kind === 'turn-complete') {
        ;(entry.federation.link as LanMeshLink).deliver(ctx.clientId, frame)
        return
      }
      console.warn(`${LOG_TAG} inbound frame without source node office=${ctx.officeId}; dropping`)
      return
    }
    // Assert the frame's self-reported fromNode matches the session's
    // authenticated identity (see FederationManagerDeps.getSessionIdentity); a
    // mismatch is a spoof attempt — drop it here.
    const sessionIdentity = deps.getSessionIdentity?.(ctx.clientId) ?? null
    if (sessionIdentity !== null && fromNode !== sessionIdentity) {
      console.warn(
        `${LOG_TAG} inbound fromNode spoof office=${ctx.officeId} claimed=${fromNode} session=${sessionIdentity}; dropping`
      )
      return
    }
    // Learn (or refresh) the nodeId → clientId mapping so subsequent host sends
    // resolve. A join-request is the first frame that carries the binding, but
    // refreshing on every frame keeps the map correct across reconnects.
    entry.nodeToClient.set(fromNode, ctx.clientId)

    // The host link's inbound entrypoint forwards to the coordinator's handler.
    ;(entry.federation.link as LanMeshLink).deliver(fromNode, frame)
  }

  function sendWakeToMember(params: {
    officeId: string
    ownerNodeId: NodeId
    request: SerializedWakeRequest
    correlationId: string
  }): boolean {
    const selfNode = deps.getLocalNodeId()
    // HOST role: the office is hosted here and the owner is a joiner → resolve its
    // per-node client and send down the host link (host → owner wake).
    const host = hosted.get(params.officeId)
    if (host) {
      // A confirmed-offline owner's client mapping can linger after its socket
      // dropped, so `has()` alone would report it reachable and the wake would be
      // sent into the void — the caller then waits forever (the offline-confirm
      // that would unblock it is edge-triggered and already fired). Treat a
      // confirmed-offline owner as unreachable so the caller resolves fast.
      if (!host.nodeToClient.has(params.ownerNodeId) || deps.federationStore.getNode(params.ownerNodeId)?.status === 'offline') {
        console.warn(`${LOG_TAG} sendWake: owner unreachable node=${params.ownerNodeId} office=${params.officeId}`)
        return false
      }
      host.federation.link.send(params.ownerNodeId, {
        kind: 'wake',
        officeId: params.officeId,
        correlationId: params.correlationId,
        request: params.request,
        fromNode: selfNode,
      })
      // The member now runs on its owner: overlay 'working' into the roster
      // projection so every viewer animates it, not just host-owned members.
      markRemoteBusy(params.correlationId, params.officeId, params.request.appId)
      return true
    }
    // JOINER role: the office is joined here and the target member is owned by the
    // host (the office authority). A joiner has a single upstream link to the host,
    // so the wake rides that link; the host owns the member, runs it locally, and
    // refluxes the turn-complete back over the same link (symmetric with the host
    // → joiner path). `ownerNodeId` is the host node; the joiner link routes only
    // to its one peer, so the target is effectively a label here.
    const join = joined.get(params.officeId)
    if (join) {
      join.federation.link.send(params.ownerNodeId, {
        kind: 'wake',
        officeId: params.officeId,
        correlationId: params.correlationId,
        request: params.request,
        fromNode: selfNode,
      })
      return true
    }
    console.warn(`${LOG_TAG} sendWake: office not hosted or joined office=${params.officeId}`)
    return false
  }

  /**
   * Host role: a joiner asked to leave. Drop ONLY the members it actually owns
   * (re-checked against the roster so a joiner cannot remove peers) and let
   * bootstrap run the same removal path as a kick (member-removed projection +
   * roster re-broadcast + lead reassignment).
   */
  function handleMemberLeaveOnHost(officeId: string, from: NodeId, appIds: string[]): void {
    const members = deps.teamStore.listMembersByTeam(officeId)
    const owned = appIds.filter((id) => members.find((m) => m.appId === id)?.ownerNodeId === from)
    if (owned.length === 0) {
      console.warn(`${LOG_TAG} member-leave from=${from} office=${officeId}: no owned members to remove`)
      return
    }
    console.log(`${LOG_TAG} member-leave from=${from} office=${officeId} apps=${owned.length}`)
    deps.onMemberLeft?.(officeId, owned)
  }

  /**
   * Joiner role: announce departure to the host before tearing down locally, so
   * the host removes the members this node brought and the roster converges on
   * both sides. Broadcasts over the joined link (its single peer is the host).
   */
  function signalLeave(officeId: string): void {
    const join = joined.get(officeId)
    if (!join) return
    const conn = deps.federationStore.listJoinedOfficeConnections().find((c) => c.officeId === officeId)
    const appIds = conn?.bringAppIds ?? []
    if (appIds.length === 0) return
    join.federation.link.broadcast({
      kind: 'member-leave',
      officeId,
      fromNode: deps.getLocalNodeId(),
      appIds,
    })
    console.log(`${LOG_TAG} signalLeave office=${officeId} apps=${appIds.length}`)
  }

  /**
   * Host's owner-role wake handler. A joiner woke a member over this host. The
   * star topology routes every joiner's frames through the host, so the target
   * may be owned by THIS host OR by a DIFFERENT joiner:
   *   - host-owned   → run the turn locally (the original assumption).
   *   - joiner-owned → forward the wake to the real owner and await its
   *                    completion, so handleWake can reflux the reply to the
   *                    sender. Without this, the host ran every woken member
   *                    locally, so a joiner→joiner dispatch produced an empty
   *                    reply and the real owner never executed.
   */
  async function runOrForwardWakeOnHost(
    officeId: string,
    request: SerializedWakeRequest
  ): Promise<{ finalMessage: string | null }> {
    const self = deps.getLocalNodeId()
    const owner = deps.teamStore.listMembersByTeam(officeId).find((m) => m.appId === request.appId)?.ownerNodeId
    // A host-owned member is stored SELF-relative (SELF sentinel), not under the
    // host's absolute node id — both mean "run it here".
    if (!owner || owner === SELF_NODE_ID || owner === self) return deps.runLocalTurn!(request)

    const correlationId = request.teamContext?.correlationId
    if (!correlationId) {
      console.warn(`${LOG_TAG} relay wake without correlation app=${request.appId} owner=${owner}; running locally`)
      return deps.runLocalTurn!(request)
    }
    console.log(`${LOG_TAG} relay wake app=${request.appId} → owner=${owner} office=${officeId} corr=${correlationId}`)
    return await new Promise<{ finalMessage: string | null }>((resolve) => {
      let done = false
      let timer: ReturnType<typeof setTimeout>
      const finish = (finalMessage: string | null) => {
        if (done) return
        done = true
        clearTimeout(timer)
        unregister()
        resolve({ finalMessage })
      }
      const unregister = registerTurnComplete(correlationId, (outcome) =>
        finish(outcome.kind === 'result' ? outcome.content : null)
      )
      timer = setTimeout(() => {
        console.warn(`${LOG_TAG} relay wake timed out app=${request.appId} owner=${owner} corr=${correlationId}`)
        finish(null)
      }, RELAY_WAKE_TIMEOUT_MS)
      const sent = sendWakeToMember({ officeId, ownerNodeId: owner, request, correlationId })
      if (!sent) {
        console.warn(`${LOG_TAG} relay wake unsent app=${request.appId} owner=${owner}; resolving empty`)
        finish(null)
      }
    })
  }

  /**
   * Joiner-side M2 dispatch: governance egress frames (member-removed /
   * office-dissolved) are consumed HERE (UI signal + local teardown) since they
   * are membership/lifecycle, not authority-tenure logic; every other M2 frame is
   * delegated to the office's authority module (election/replication/artifact/
   * history). An office with M2 off (no authority) ignores the rest.
   */
  function handleJoinerM2Frame(
    officeId: string,
    authority: OfficeAuthority | undefined,
    from: NodeId,
    frame: M2Frame
  ): void {
    if (frame.kind === 'member-removed') {
      deps.onMemberRemovedRemote?.(officeId, frame.appId)
      // If the host removed the last app this node brought to the office, this
      // node is no longer a member here → forget the re-join record so the next
      // start does not auto-rejoin an office that kicked it. Evaluated against the
      // persisted bring set (the local roster materializes asynchronously, so it
      // is not a reliable signal at frame time).
      dropBroughtApp(officeId, frame.appId)
      return
    }
    if (frame.kind === 'office-dissolved') {
      deps.onOfficeDissolvedRemote?.(officeId)
      leaveOffice(officeId)
      return
    }
    authority?.handle(from, frame)
  }

  async function joinOffice(params: JoinOfficeParams): Promise<{ ok: boolean; reason?: string }> {
    const { officeId, serverUrl, credentialToken, selfContext, bringMembers } = params

    // A re-join replaces any prior client/coordinator for the same office. This
    // is NOT an exit — keep the persisted re-join record (it is rewritten on the
    // new grant), so use teardown rather than leaveOffice.
    teardownOffice(officeId)

    return await new Promise<{ ok: boolean; reason?: string }>((resolve) => {
      let settled = false
      let authedOnce = false
      const finish = (result: { ok: boolean; reason?: string }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }

      const timer = setTimeout(() => {
        console.warn(`${LOG_TAG} join timed out office=${officeId} url=${serverUrl}`)
        finish({ ok: false, reason: 'TIMEOUT' })
      }, JOIN_TIMEOUT_MS)
      if (typeof timer.unref === 'function') timer.unref()

      const link: LanMeshLink = new LanMeshLink((_to, frame) => client.send(frame))
      // M2 authority module for this JOINED office: as a hot-standby it applies
      // replicated entries + acks, and tracks the host's presence so it can stand
      // for election if elected (undefined when M2 is off).
      const authority = buildAuthority(officeId, link)
      const client = new WsFederationClient({
        serverUrl,
        credentialToken,
        onFrame: (frame) => link.deliver(selfContext.selfNodeId, frame),
        onStateChange: (state) => {
          if (state === 'open') authedOnce = true
          // A close before any successful auth means the host rejected the
          // credential (the auth gate closes the socket); fail fast rather than
          // waiting out the join timeout.
          if (state === 'closed' && !authedOnce) {
            finish({ ok: false, reason: 'AUTH_REJECTED' })
          }
        },
        // Reconnect re-auth (never the first auth): the host may have dropped this
        // node from the roster while it was gone, so re-drive the join-request to
        // re-enter + catch up rather than relying on heartbeats the host ignores.
        onReauth: () => {
          const live = joined.get(officeId)
          if (!live) return
          console.log(`${LOG_TAG} re-driving join after reconnect office=${officeId}`)
          live.federation.coordinator.requestJoin(request)
        },
      })

      const federation = createFederation({
        context: selfContext,
        link,
        federationStore: deps.federationStore,
        teamStore: deps.teamStore,
        verifyCredential: deps.verifyCredential,
        // Suspend-safe silence clock so a host sleep does not mass-confirm peers.
        monotonicNow: () => performance.now(),
        listMembersForNode: (nodeId) => membersForNode(officeId, nodeId),
        onMemberConfirmedOffline: deps.onMemberConfirmedOffline,
        onPresenceChange: deps.onPresenceChange
          ? (snap) => deps.onPresenceChange!(officeId, snap)
          : undefined,
        onJoinGrant: (assignedNodeId) => {
          console.log(`${LOG_TAG} joined office=${officeId}`)
          // M2: record self in the node ledger so election views include it.
          if (authority) {
            deps.federationStore.upsertNode({
              nodeId: assignedNodeId,
              officeId,
              identity: selfContext.selfNodeId,
              displayName: null,
              joinedAt: Date.now(),
              lastSeen: Date.now(),
              status: 'online',
            })
          }
          // Persist the re-join record so a restart reconnects without re-prompting
          // for the invite. Written on grant (membership confirmed); refreshed on a
          // re-grant. Removed only on an explicit exit (leave / dissolved / kicked).
          writeJoinedConnection(officeId, serverUrl, credentialToken, bringMembers)
          finish({ ok: true })
        },
        onJoinReject: (reason) => {
          console.warn(`${LOG_TAG} join rejected office=${officeId} reason=${reason}`)
          finish({ ok: false, reason })
        },
        onWake: deps.runLocalTurn
          ? (request) => deps.runLocalTurn!(request)
          : undefined,
        // JOINED office: the joiner woke a HOST-owned member over its upstream link;
        // the host ran it and refluxed turn-complete back here. Dispatch it to the
        // one-shot waiter registered by the joiner's session-deps (the manager-level
        // waiter map is shared across host/joined roles). Without this a joiner →
        // host-member reply would log "turn-complete for non-authority; dropping".
        onTurnComplete: (correlationId, outcome) => dispatchTurnComplete(correlationId, outcome),
        // JOINED office: stream-frames from the host (another node's member,
        // relayed via the host) → replay so this joiner's renderer sees it.
        onStreamFrames: (batch) => streamReplay.apply(batch),
        // JOINED office: materialize the host's roster projection into the local
        // store as a shadow office. This gives the joiner's renderer a full
        // office to show AND lets its RelayCapture recognize its own brought
        // member as owned-by-SELF (so it relays). The host's node id rides in
        // snapshot.team.hostNodeId; owner ids are remapped SELF-relative inside.
        onRoster: (snapshot) => {
          deps.teamStore.materializeJoinedOffice({
            hostNodeId: snapshot.team.hostNodeId,
            selfNodeId: selfContext.selfNodeId,
            snapshot,
          })
          // M2: the host is the believed authority; record its node row (so the
          // joiner's presence FSM tracks it and can detect it going offline) and
          // align the believed authority + tenure baseline.
          if (authority) {
            const host = snapshot.team.hostNodeId
            const existing = deps.federationStore.getNode(host)
            deps.federationStore.upsertNode({
              nodeId: host,
              officeId,
              identity: host,
              displayName: snapshot.members.find((m) => m.ownerNodeId === host)?.ownerDisplayName ?? null,
              joinedAt: existing?.joinedAt ?? 0, // host/creator sorts earliest
              lastSeen: Date.now(),
              status: 'online',
            })
            authority.termState.setAuthority(host, authority.termState.getTerm())
          }
          deps.onRosterChanged?.(officeId)
        },
        onRosterChanged: deps.onRosterChanged
          ? () => deps.onRosterChanged!(officeId)
          : undefined,
        // M2: route authority/replication/artifact/history frames + presence +
        // grant extras. Governance egress (member-removed / office-dissolved) is a
        // JOINER-side consumer concern (not authority logic), so intercept those
        // and surface them to bootstrap before delegating the rest.
        onM2Frame: (from, frame) => handleJoinerM2Frame(officeId, authority, from, frame),
        onNodePresence: authority ? (nodeId, status) => authority!.onNodePresence(nodeId, status) : undefined,
        getJoinGrantExtras: authority ? () => authority!.getJoinGrantExtras() : undefined,
      })

      joined.set(officeId, { federation, client, link, authority })
      federation.coordinator.start()

      const request: JoinRequest = {
        kind: 'join-request',
        officeId,
        fromNode: selfContext.selfNodeId,
        identityId: selfContext.selfNodeId,
        displayName: deps.getLocalDisplayName?.() ?? undefined,
        credentialToken,
        bringMembers,
      }
      federation.coordinator.requestJoin(request)
    })
  }

  // Stop + drop the in-memory office (host or joined) WITHOUT touching the
  // persisted re-join record. Used by the re-join replace and full shutdown,
  // where the node still intends to stay in the office across the restart/replace.
  function teardownOffice(officeId: string): void {
    const pendingRefresh = rosterRefreshTimers.get(officeId)
    if (pendingRefresh) {
      clearTimeout(pendingRefresh)
      rosterRefreshTimers.delete(officeId)
    }
    const host = hosted.get(officeId)
    if (host) {
      host.authority?.stop()
      host.federation.coordinator.stop()
      host.nodeToClient.clear()
      hosted.delete(officeId)
      console.log(`${LOG_TAG} stopped hosting office=${officeId}`)
    }
    const join = joined.get(officeId)
    if (join) {
      join.authority?.stop()
      join.federation.coordinator.stop()
      join.client.close()
      joined.delete(officeId)
      console.log(`${LOG_TAG} left office=${officeId}`)
    }
  }

  // Explicit exit (user leaves): forget the re-join record so the next start does
  // NOT auto-rejoin, then tear the office down.
  function leaveOffice(officeId: string): void {
    deps.federationStore.removeJoinedOfficeConnection(officeId)
    teardownOffice(officeId)
  }

  function getOffice(officeId: string): Federation | null {
    return hosted.get(officeId)?.federation ?? joined.get(officeId)?.federation ?? null
  }

  function getOfficeAuthority(officeId: string): OfficeAuthority | null {
    return hosted.get(officeId)?.authority ?? joined.get(officeId)?.authority ?? null
  }

  function getOfficePresence(officeId: string): OfficePresenceSnapshot | null {
    const hostedOffice = hosted.get(officeId)
    const joinedOffice = joined.get(officeId)
    const office = hostedOffice?.federation ?? joinedOffice?.federation
    if (!office) return null

    const role: 'host' | 'joined' = hostedOffice ? 'host' : 'joined'
    const nodes = office.coordinator.getPresence().nodes

    // Authority view (M2). When M2 is off there is no authority module and no
    // persisted state → null, and `role` alone conveys the M1 fixed-host model.
    // The believed authority node id is read from the persisted state (the SSOT
    // the OfficeAuthority module does not re-expose), the live self/paused flags
    // from the module.
    const authorityModule = hostedOffice?.authority ?? joinedOffice?.authority ?? null
    const state = deps.authorityStore?.getAuthorityState(officeId) ?? null
    const authority = authorityModule || state
      ? {
          authorityNodeId: state?.authorityNodeId ?? null,
          term: state?.term ?? authorityModule?.getTerm() ?? 0,
          isSelf: authorityModule?.isAuthoritySelf() ?? false,
          paused: authorityModule?.isPaused() ?? false,
        }
      : null

    return { officeId, role, nodes, authority }
  }

  function repointLink(officeId: string, newSendTarget: WsSender): boolean {
    const link = hosted.get(officeId)?.link ?? joined.get(officeId)?.link
    if (!link) {
      console.warn(`${LOG_TAG} repointLink: office not hosted or joined office=${officeId}`)
      return false
    }
    link.repoint(newSendTarget)
    console.log(`${LOG_TAG} repointed link office=${officeId}`)
    return true
  }

  function redialToAuthority(officeId: string, authorityNodeId: NodeId): boolean {
    const sender = peerDialer(officeId, authorityNodeId)
    if (!sender) {
      console.warn(`${LOG_TAG} redial: no route to authority node=${authorityNodeId} office=${officeId}`)
      return false
    }
    return repointLink(officeId, sender)
  }

  /** M2: route to the replication layer (assign seq, append log, fan-out to standbys). */
  function routeAuthorityWrite(record: BlackboardWriteRecord): void {
    const host = hosted.get(record.teamId)
    host?.authority?.captureLocalWrite(record)
    // A board write coincides with a member's working/idle churn (assign, work,
    // done); coalesce a roster re-projection so joiners' topology + run banner
    // follow the run live, independent of the blackboard replication plane.
    scheduleRosterRefresh(record.teamId)
  }

  /** The host (authority) applies + replicates this write on receipt. */
  function sendMemberWrite(write: OutboundBlackboardWrite & { hostNodeId: NodeId }): void {
    const join = joined.get(write.teamId)
    if (!join) {
      console.warn(`${LOG_TAG} sendMemberWrite: office not joined office=${write.teamId}`)
      return
    }
    const frame: BlackboardWriteFrame = {
      kind: 'blackboard-write',
      officeId: write.teamId,
      fromNode: deps.getLocalNodeId(),
      term: join.authority?.getTerm() ?? 0,
      op: write.op,
      payload: write.payload,
      ...(write.taskId !== undefined ? { taskId: write.taskId } : {}),
      fid: write.fid,
    }
    join.federation.link.send(write.hostNodeId, frame)
  }

  /**
   * Converges the roster on EVERY membership mutation (edge/role change), not
   * only on join. No-op on a joiner (it projects no roster).
   */
  function broadcastRosterFor(officeId: string): void {
    const host = hosted.get(officeId)
    if (!host) return
    host.federation.coordinator.broadcastRoster()
  }

  /**
   * Throttled variant of broadcastRosterFor: coalesces bursts into one
   * re-projection per ROSTER_REFRESH_COALESCE_MS. No-op on a joiner.
   */
  function scheduleRosterRefresh(officeId: string): void {
    if (!hosted.has(officeId)) return
    if (rosterRefreshTimers.has(officeId)) return
    const timer = setTimeout(() => {
      rosterRefreshTimers.delete(officeId)
      broadcastRosterFor(officeId)
    }, ROSTER_REFRESH_COALESCE_MS)
    if (typeof timer.unref === 'function') timer.unref()
    rosterRefreshTimers.set(officeId, timer)
  }

  /**
   * The roster re-broadcast that follows still converges state; this dedicated
   * frame lets a joiner react immediately (drop the row) without diffing the
   * roster. No-op when not hosted.
   */
  function projectMemberRemoved(officeId: string, appId: string): void {
    const host = hosted.get(officeId)
    if (!host) return
    host.federation.link.broadcast({
      kind: 'member-removed',
      officeId,
      fromNode: deps.getLocalNodeId(),
      term: host.authority?.getTerm() ?? 0,
      appId,
      fid: randomUUID(),
    })
  }

  function projectOfficeDissolved(officeId: string): void {
    const host = hosted.get(officeId)
    if (!host) return
    host.federation.link.broadcast({
      kind: 'office-dissolved',
      officeId,
      fromNode: deps.getLocalNodeId(),
      term: host.authority?.getTerm() ?? 0,
      fid: randomUUID(),
    })
  }

  function fetchMemberHistory(params: {
    officeId: string
    ownerNodeId: NodeId
    appId: string
    epochId: string
  }): Promise<SerializedHistoryMessage[]> {
    const authority = getOfficeAuthority(params.officeId)
    if (!authority) {
      return Promise.reject(new Error(`history: office not present or M2 off office=${params.officeId}`))
    }
    // Fail fast on a known-unreachable owner so the caller does not hang the full
    // request timeout (the history-fetch deadline is only a backstop). An owner is
    // unreachable when its node row is offline OR suspect (a killed owner sits in
    // the suspect window for ~13s before it is confirmed offline — without this it
    // would hang the whole deadline), or — for a hosted office — when there is no
    // live client mapping to send the request over. Reject with a stable technical
    // code; the renderer maps it to calm, location-free copy.
    const ownerNode = deps.federationStore.getNode(params.ownerNodeId)
    const ownerUnreachable = ownerNode?.status === 'offline' || ownerNode?.status === 'suspect'
    const host = hosted.get(params.officeId)
    const noHostRoute = host !== undefined && !host.nodeToClient.has(params.ownerNodeId)
    if (ownerUnreachable || noHostRoute) {
      return Promise.reject(new Error('history-owner-unreachable'))
    }
    return authority.history.fetch({
      ownerNodeId: params.ownerNodeId,
      teamId: params.officeId,
      appId: params.appId,
      epochId: params.epochId,
    })
  }

  function relaySink(officeId: string, batch: StreamFramesFrame): void {
    const host = hosted.get(officeId)
    if (host) {
      // Hosted-and-owned-here: the producing member's events already fired
      // locally on the authority, so do NOT apply again (would double-replay the
      // authority's own renderer). Only re-broadcast to the office's clients.
      host.federation.link.broadcast(batch)
      return
    }
    const join = joined.get(officeId)
    if (join) {
      join.federation.link.broadcast(batch)
      return
    }
    console.warn(`${LOG_TAG} relaySink: office not hosted or joined office=${officeId} session=${batch.sessionKey}`)
  }

  function stopAll(): void {
    for (const officeId of [...hosted.keys(), ...joined.keys()]) {
      // Shutdown, not an exit: keep every re-join record for next-start recovery.
      teardownOffice(officeId)
    }
    remoteMemberSpaceIds.clear()
    console.log(`${LOG_TAG} stopped all offices`)
  }

  return {
    hostOffice,
    handleHostInbound,
    joinOffice,
    leaveOffice,
    getOffice,
    listHostedOffices: () => [...hosted.keys()],
    listJoinedOffices: () => [...joined.keys()],
    getRemoteMemberSpaceId: (appId) => remoteMemberSpaceIds.get(appId),
    sendWakeToMember,
    signalLeave,
    registerTurnComplete,
    isMemberRemoteBusy: isRemoteBusy,
    relaySink,
    routeAuthorityWrite,
    sendMemberWrite,
    getOfficeAuthority,
    getOfficePresence,
    broadcastRosterFor,
    scheduleRosterRefresh,
    projectMemberRemoved,
    projectOfficeDissolved,
    fetchMemberHistory,
    repointLink,
    redialToAuthority,
    stopAll,
  }
}

/**
 * The source node of an inbound frame. join-request/heartbeat carry their own
 * fromNode; presence carries nodeId. join-grant/reject originate from the host
 * and never arrive on the host inbound path, so they have no source here.
 */
function resolveFromNode(frame: FederationMessage): NodeId | null {
  switch (frame.kind) {
    case 'join-request':
    case 'heartbeat':
      return frame.fromNode
    case 'wake':
      // A joiner→host-member wake carries its originating node so the host can
      // both route it (deliver with the joiner's node id) and reflux the
      // turn-complete back over the same link. A host→joiner wake never reaches
      // the host inbound path, so this branch only sees the joiner→host case.
      return frame.fromNode ?? null
    case 'presence-update':
      return frame.nodeId
    // M2 control/artifact frames all carry their own fromNode.
    case 'authority-claim':
    case 'authority-confirm':
    case 'blackboard-write':
    case 'blackboard-replicate':
    case 'ack':
    case 'reject':
    case 'artifact-fetch':
    case 'artifact-bytes':
    case 'member-removed':
    case 'office-dissolved':
    case 'history-request':
    case 'history-response':
    case 'member-leave':
      return frame.fromNode
    default:
      return null
  }
}

// ── Module-level accessor (mirrors setActiveTeamRuntime) ──

let _activeManager: FederationManager | null = null

export function setFederationManager(manager: FederationManager | null): void {
  _activeManager = manager
}

export function getFederationManager(): FederationManager | null {
  return _activeManager
}
