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
import { WsFederationClient, type FederationAuthProof } from './ws-federation-client'
import { createStreamReplay, type StreamReplay } from './relay'
import type { NodeBoundMember } from './coordinator'
import { GatewayAttachClient } from './gateway-attach'
import { createRemoteBusyOverlay } from './remote-busy-overlay'
import type { FederationStore, OfficeCredentialLike } from './deps'
import type { TeamStore, BlackboardTask } from '../../team'
import { createOfficeAuthority, type OfficeAuthority } from './authority/office-authority'
import type { ReadMemberHistory } from './authority/history-fetch'
import type { OwnerStatus } from './authority/reconcile'
import type { MemberWriteRecord } from './authority/replication'
import type { OutboundBlackboardWrite } from './authority/location-aware-blackboard'
import type { BlackboardWriteRecord } from '../team/blackboard'
import {
  DEFAULT_P2P_CAPS,
  PROTOCOL_VERSION_CURRENT,
  PROTOCOL_VERSION_MIN_SUPPORTED,
  CAP,
  type ArtifactRef,
  type BlackboardWriteFrame,
  type M2Frame,
  type SerializedHistoryMessage,
} from './protocol-m2'
import { createCtrlFeed, type CtrlFeed } from './ctrl-feed'
import { createSessionFeed, historyCacheKey, isSessionFeedFrame, type SessionFeed } from './session-feed'
import { isFeedSyncFrame, type FeedSyncFrame } from './log/types'
import { getFeedStore, type AuthorityStore, type FeedStore } from '../../federation'
import { SELF_NODE_ID, type TeamMemberRuntimeStatus } from '../../../../shared/apps/team-types'
import { parseTeamSessionKey } from '../../../../shared/apps/im-keys'
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
 * Cadence for the self-healing status re-projection. Member runtime status is a
 * live PROJECTION (working/idle derived from the local session ledger + the
 * remote-busy overlay), propagated to viewers on a best-effort roster broadcast.
 * A single dropped 'idle' edge would otherwise latch a stale working pulse on a
 * viewer forever (no periodic re-baseline, unlike presence heartbeat). While a
 * hosted office has any non-idle member, re-project on this cadence so a lost
 * edge self-corrects within one interval. Bounded to live work and coalesced
 * through scheduleRosterRefresh, so it is a floor — never a flood.
 */
const LIVENESS_REPROJECT_MS = 2500

/**
 * After an office's members all read idle, keep re-projecting for this many extra
 * ticks. The stuck-'working' failure is a TERMINAL-edge loss (the last member
 * finishes, the one event-driven idle projection is dropped, and the now-quiet
 * office never re-projects). These grace ticks guarantee the terminal idle still
 * reaches viewers; the counter self-terminates to zero and the office goes quiet.
 */
const LIVENESS_IDLE_GRACE_TICKS = 3

/**
 * A dialed peer connection: the outbound sender plus an optional disposer that
 * tears the underlying socket down when the link is re-pointed again or the
 * office exits. A rig may return a bare {@link WsSender} (nothing to dispose).
 */
export interface DialedPeer {
  sender: WsSender
  dispose?: () => void
}

/**
 * Resolves an outbound connection aimed at a freshly-elected authority. Given
 * the office and the new authority's node id, it returns a sender pointed at
 * that node (or null when it cannot be reached). This is the single seam the
 * transport uses to re-form after a host loss: production injects a dialer that
 * opens a WsFederationClient against the peer's ADVERTISED URL (learned via the
 * roster address book); a test rig injects one backed by its in-memory hub.
 */
export type PeerDialer = (officeId: string, authorityNodeId: NodeId) => WsSender | DialedPeer | null

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
   * Build the signed device-key proof answering a host's auth challenge (the
   * joiner leg of the node-identity handshake). Injected by bootstrap from
   * http/identity so this module never imports the key store. Absent → this
   * node cannot complete a federation-node handshake against an enforcing host.
   */
  makeAuthProof?: (nonce: string) => FederationAuthProof | null
  /**
   * Base URL of this node's own HTTP/WS server (remote-access lanUrl), advertised
   * at join/host time so peers can dial this node after a transport loss. Null
   * when no server is running — this node can then dial out but not be dialed.
   */
  getLocalAdvertisedUrl?: () => string | null
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
   * Everything a member is serving right now (run + conversations), each with a
   * human label the authority generated (P0-2), stamped into the roster snapshot
   * so a joiner can say "busy with another conversation". Bootstrap passes the
   * team runtime's getMemberBusy. Absent → no busy list projected.
   */
  getMemberBusy?: (appId: string, teamId: string) => import('../../../../shared/apps/team-types').RosterBusyEntry[]
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
   * roster also re-converges via the accompanying roster re-broadcast.
   * `ownMember` is true when the removed member is one THIS node brought — a
   * kick the local user did not initiate, which the renderer surfaces to them.
   * Absent → the roster still converges; no immediate per-member signal.
   */
  onMemberRemovedRemote?: (officeId: string, appId: string, ownMember: boolean) => void
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
  /**
   * Per-node feed store backing the ctrl/session feed planes. Injected like its
   * sibling stores; absent → the process-global `getFeedStore()` singleton (the
   * production wiring). A multi-node in-process bench injects one store per node
   * so each node's feed outbox/cursors stay isolated.
   */
  feedStore?: FeedStore
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
   * Owner-side: the same transcript read without the request-scoped seam, used
   * by the session-feed plane to proactively replicate an owned member's
   * transcript to every office node. Absent → no proactive replication (the
   * office stays on the pull-only history path).
   */
  readOwnedTranscript?: (teamId: string, appId: string, epochId: string) => SerializedHistoryMessage[] | null
  /**
   * Whether a chat turn is currently running for a session key on THIS node.
   * The session-feed publisher withholds an in-flight turn's provisional trailing
   * message until the turn ends (see session-feed.ts). Absent → treated as idle
   * (the publisher's revision entries still self-heal any snapshot race).
   */
  isSessionActive?: (sessionKey: string) => boolean
  /**
   * A hot-standby applied a replicated task/finding to its replica store.
   * Bootstrap maps this to a UI refresh event so the renderer shows the live
   * task/finding without a reload. Absent → no signal.
   */
  onReplicaApplied?: (info: { officeId: string; op: string; taskId?: string }) => void
  /**
   * A member's local transcript replica grew (session-feed apply or a
   * background tail refresh). Bootstrap maps this to a renderer event so an
   * open member panel silently reloads — the read path serves the local copy
   * instantly, and this signal is what keeps it live. Coalesced per member.
   */
  onMemberHistoryUpdated?: (info: { officeId: string; appId: string; epochId: string }) => void
  /** Ctrl-feed give-up override (ms); test seam, production uses the default. */
  ctrlGiveUpMs?: number
  /** Authority changed → neutral UI signal + re-point. */
  onAuthorityChange?: (officeId: string, authorityNodeId: NodeId, term: number) => void
  /** Office paused/resumed (partition minority) → neutral UI signal. */
  onOfficePaused?: (officeId: string, paused: boolean) => void
  /**
   * Joiner role: a recovery re-join was rejected AFTER the initial join had
   * settled — this node lost office membership (e.g. the authority no longer
   * recognizes it). Fired once per loss (re-armed by a later grant) so
   * bootstrap can tell the user instead of failing silently.
   */
  onOfficeAccessLost?: (officeId: string, reason: string) => void
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

  // ── Gateway relay (optional; absent → pure-LAN behaviour unchanged) ──
  /**
   * Effective federation gateway base URL, or null when relaying is off. When
   * set, hostOffice additionally attaches to the gateway so off-LAN members can
   * reach this office through the relay.
   */
  getGatewayUrl?: () => string | null
  /**
   * Ed25519 device-key signature (base64) over a gw:announce payload string.
   * Injected from http/identity by bootstrap. Absent → the gateway attachment
   * still relays frames but publishes no discovery announce.
   */
  signGatewayAnnounce?: (payload: string) => string
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

/**
 * Result of a member-history fetch. `stale` is true only when the messages are a
 * cached copy served because the owner was unreachable (or went silent mid-fetch)
 * — they may be missing the owner's latest messages, and the UI must say so. A
 * live fetch (even one merged with an immutable cached prefix) is not stale.
 */
export interface HistoryFetchResult {
  messages: SerializedHistoryMessage[]
  stale: boolean
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
   * Immediate reachability of a member's OWNER from this node's view: true for a
   * locally owned member, or a remote owner currently online + connected; false
   * when a remote owner is offline/unreachable. Drives the wait=false honest
   * "not delivered" gate so a send to an offline teammate is reported at once.
   */
  isMemberReachable(appId: string, teamId?: string): boolean
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
  /**
   * Replicate an epoch lifecycle write (open/seal/reopen/rename/outcome) office-
   * wide so conversations + run history stay consistent on every node (P0-1).
   * Authority → single-writer log; joiner → routed to the host as a member write.
   */
  routeEpochWrite(epoch: { id: string; teamId: string }): void
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
    /** Highest seq the viewer already holds; owner returns only the newer tail. */
    sinceSeq?: number
  }): Promise<HistoryFetchResult>
  /**
   * Viewer: pull a published artifact's bytes from the node that OWNS it, on
   * demand. The owner serves only PUBLISHED team artifacts it owns; a fetch for a
   * member owned by another joiner is relayed one hop through the host. Used by the
   * team runtime's `team_read_artifact` tool so a teammate can read a peer's
   * deliverable regardless of which machine produced it. Rejects when the office is
   * not present here / M2 off, or the owner refuses/times out.
   */
  fetchArtifact(params: { officeId: string; ref: ArtifactRef }): Promise<Uint8Array>
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
  /**
   * Re-drive a joined office's join-request to its current authority so a newly
   * elected authority enrolls this survivor (roster re-entry). Called after a
   * redial and on a dialed-leg reconnect. No-op for a host office.
   */
  reenrollWithAuthority(officeId: string): boolean
  /**
   * A peer node's dialable base URL from the office's address book (joined:
   * in-memory host-projected; hosted: persisted office_nodes). Null when unknown.
   */
  getNodeAddress(officeId: string, nodeId: NodeId): string | null
  /**
   * Inbound entry for frames arriving over a DIALED peer connection (production
   * PeerDialer). `fromNode` is the dialed peer's identity, used to attribute
   * frames that carry no payload source (feed-sync). Drops when the office is gone.
   */
  deliverInbound(officeId: string, frame: FederationMessage, fromNode?: NodeId): void
  /**
   * OS resume: grant every hosted and joined office a presence grace window so a
   * machine waking from sleep re-baselines its peers instead of mass-confirming
   * them offline. Wired to powerMonitor 'resume' in bootstrap.
   */
  handleSystemResume(): void
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
  /** Outbound gateway attachment when the office is relayed, else undefined. */
  gateway?: GatewayAttachClient
  /**
   * Nodes reachable via the gateway, learned from relayed inbound frames. Kept
   * exclusive with nodeToClient per node: whichever path a node's frames last
   * arrived on is its return path.
   */
  nodeToGateway: Set<NodeId>
  /** Reliable ctrl-plane transport (wake/turn-complete over the feed outbox); undefined only if the feed store is unavailable. */
  ctrlFeed?: CtrlFeed
  /** Multi-replica session-transcript plane; undefined when the feed store or transcript reader is unavailable. */
  sessionFeed?: SessionFeed
}

interface JoinedOffice {
  federation: Federation
  client: WsFederationClient
  /** The office's outbound link, kept so its sender can be repointed (transport seam). */
  link: LanMeshLink
  /**
   * The office's UPSTREAM outbound sender — initially the join client aimed at
   * the host, replaced by repointLink after an authority change. The link's
   * router falls back to it for any target without a more direct path, so the
   * ctrl shim and per-peer routing survive a repoint (a bare link.repoint would
   * discard both). Held as a mutable ref so the router closure follows swaps.
   */
  upstream: { send: WsSender }
  /**
   * nodeId ↔ clientId for PEERS whose frames arrive on this node's own WS
   * server (peer-dialed sessions during/after a host loss; the re-formed star
   * when this node is elected authority). Replies ride the same socket back.
   */
  peerClients: Map<NodeId, string>
  /**
   * Election-window direct dial legs to survivors, opened when the believed
   * authority is confirmed-offline so claims/votes ride reachable transports
   * instead of the dead upstream. A leg is torn down as soon as a better path
   * exists: the peer's own inbound session (peerClients) or the re-formed star
   * (followers close all legs after redialing the new authority).
   */
  electionLegs: Map<NodeId, DialedPeer>
  /** M2 per-office authority module (this node may be elected to host on handover). */
  authority?: OfficeAuthority
  /** Reliable ctrl-plane transport (wake/turn-complete over the feed outbox); undefined only if the feed store is unavailable. */
  ctrlFeed?: CtrlFeed
  /** Multi-replica session-transcript plane; undefined when the feed store or transcript reader is unavailable. */
  sessionFeed?: SessionFeed
  /** The join-request sent at join, kept so a redial/reconnect can re-drive it to a
   *  newly-elected authority (roster re-entry after a host loss). */
  joinRequest?: JoinRequest
  /**
   * Set when the upstream session proved to be a RELAY (the gateway sent
   * gw:host-lost): the gateway base URL this office rides. An election win
   * then claims the room over it (term-locked gw:host-attach) instead of
   * dialing WAN peers directly; an authority change re-enrolls over the same
   * relay session.
   */
  gatewayServerUrl?: string
  /** The room claim opened when THIS node wins an election on a relay office. */
  gateway?: GatewayAttachClient
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
  // Feed store: injected per-node (bench) or the process-global singleton (prod).
  const resolveFeedStore = (): FeedStore | null => deps.feedStore ?? getFeedStore()
  // Transport re-form seam: how a survivor reaches a newly-elected authority.
  const peerDialer: PeerDialer = deps.peerDialer ?? NO_PEER_DIALER
  // Live dialed-peer connections per office (from redialToAuthority). Disposed
  // when the office re-points again or exits, so an abandoned dial never keeps
  // reconnecting to a peer we no longer target.
  const dialedPeers = new Map<string, () => void>()
  // In-memory node address book per JOINED office, learned from the host's
  // roster projection — the fast lookup layer over the persisted office_nodes
  // rows (peer cards are persisted too, presence-untracked, so the book and the
  // election roster survive a restart; see isPresenceTracked on the coordinator).
  const officeAddressBooks = new Map<string, Map<NodeId, string>>()

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
  // delete the record so the next start does not auto-rejoin. Returns whether
  // the app was in this node's bring set (i.e. one of OUR members was removed).
  function dropBroughtApp(officeId: string, appId: string): boolean {
    const conn = deps.federationStore
      .listJoinedOfficeConnections()
      .find((c) => c.officeId === officeId)
    if (!conn) return false
    const remaining = conn.bringAppIds.filter((id) => id !== appId)
    if (remaining.length === conn.bringAppIds.length) return false
    if (remaining.length === 0) {
      deps.federationStore.removeJoinedOfficeConnection(officeId)
      return true
    }
    deps.federationStore.upsertJoinedOfficeConnection({
      ...conn,
      bringAppIds: remaining,
      updatedAt: Date.now(),
    })
    return true
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
        // The successor records itself as authority (term-state already did).
        // Mark its own node row online so its replication views include it,
        // then project the roster to the survivors over the direct legs — the
        // star re-forms around this node as peers redial + re-enroll (their
        // inbound sessions replace the legs one by one).
        ensureSelfNode(officeId)
        // Relay office: claim the room with the new term (the gateway's term
        // lock admits a higher tenure immediately and refuses a stale one).
        ensureJoinedGatewayTakeover(officeId)
        const successor = joined.get(officeId) ?? hosted.get(officeId)
        // Winning flips this node to full host-semantics presence tracking
        // (every ledger row). Peer rows may carry stale lastSeen from before
        // the handover — grant one fresh grace window so survivors get the
        // full re-enroll budget before any of them can be confirmed offline.
        successor?.federation.coordinator.notifyResume()
        successor?.federation.coordinator.broadcastRoster()
        console.log(`${LOG_TAG} became office authority office=${officeId} term=${term}`)
      },
      onAuthorityChange: (nodeId, term) => {
        // Transport re-form: when the authority moved to a PEER, point this
        // office's outbound leg at it (best-effort — an unreachable peer leaves
        // the office paused, honestly). A successful redial re-forms the star,
        // so the election-window dial legs are torn down (one route per peer,
        // no steady-state ambiguity). A move to SELF needs no dial; the
        // initial believed-authority alignment never fires this callback.
        if (nodeId !== deps.getLocalNodeId()) {
          const join = joined.get(officeId)
          if (join?.gatewayServerUrl) {
            // Relay office: the upstream gateway session routes member frames
            // to whichever host holds the room — the new authority claims it
            // with its term — so re-enroll over the relay; no WAN dial.
            join.gateway?.close()
            join.gateway = undefined
            reenrollWithAuthority(officeId)
            closeElectionLegs(officeId)
          } else if (redialToAuthority(officeId, nodeId)) {
            closeElectionLegs(officeId)
          }
        }
        deps.onAuthorityChange?.(officeId, nodeId, term)
      },
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
    const advertisedUrl = deps.getLocalAdvertisedUrl?.() ?? null
    const existing = deps.federationStore.getNode(officeId, self)
    // The row also feeds the roster's ownerDisplayName + the address book, so
    // refresh it when the advertised name/URL changed (or was never stamped).
    if (existing && existing.displayName === displayName && existing.advertisedUrl === advertisedUrl) return
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
      advertisedUrl,
    })
  }

  // Host-role overlay of members currently working on a REMOTE owner. Every
  // mutation schedules a throttled roster refresh so viewers animate the
  // working/idle transition (see remote-busy-overlay.ts).
  const remoteBusy = createRemoteBusyOverlay((officeId) => scheduleRosterRefresh(officeId))

  // ── Self-healing status renewal ────────────────────────────────────────────
  //
  // Member runtime status is a best-effort projection with no per-status ack; a
  // dropped 'idle' edge cannot self-correct on its own (unlike presence, which
  // re-baselines every heartbeat). This loop supplies the missing re-baseline:
  // while any member of a hosted office is non-idle it re-projects the roster,
  // and it keeps a bounded grace of extra projections after work ends so the
  // terminal idle is not lost either. Per-office grace counter, remaining ticks.
  const livenessGraceTicks = new Map<string, number>()

  /** Whether any member of a hosted office currently reads non-idle (working /
   *  waiting_user / error) — folds the local session ledger AND the remote-busy
   *  overlay through the injected getMemberRuntimeStatus, so a member working on
   *  a remote owner keeps the office "live" too. */
  function officeHasActiveMember(officeId: string): boolean {
    const getStatus = deps.getMemberRuntimeStatus
    if (!getStatus) return false
    for (const m of deps.teamStore.listMembersByTeam(officeId)) {
      if (getStatus(m.appId) !== 'idle') return true
    }
    return false
  }

  function livenessReprojectTick(): void {
    for (const officeId of hosted.keys()) {
      try {
        if (officeHasActiveMember(officeId)) {
          livenessGraceTicks.set(officeId, LIVENESS_IDLE_GRACE_TICKS)
          scheduleRosterRefresh(officeId)
          continue
        }
        const remaining = livenessGraceTicks.get(officeId) ?? 0
        if (remaining > 0) {
          livenessGraceTicks.set(officeId, remaining - 1)
          scheduleRosterRefresh(officeId)
        } else {
          livenessGraceTicks.delete(officeId)
        }
      } catch (err) {
        // A store closed mid-teardown or a transient projection error must never
        // break the renewal loop for the other offices.
        console.warn(
          `${LOG_TAG} liveness re-projection failed office=${officeId}: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
    }
  }

  const livenessTimer: ReturnType<typeof setInterval> = setInterval(
    livenessReprojectTick,
    LIVENESS_REPROJECT_MS
  )
  if (typeof livenessTimer.unref === 'function') livenessTimer.unref()

  function dispatchTurnComplete(correlationId: string, outcome: TurnCompletion): void {
    remoteBusy.clear(correlationId)
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
      remoteBusy.clear(correlationId)
    }
  }

  /**
   * Relay-office election win: claim the office's gateway room as its new host
   * with a term-locked gw:host-attach. Members keep their existing relay
   * sessions; the gateway routes their frames to this node once attached.
   * No-op for LAN offices (no gatewayServerUrl) or when already claimed.
   */
  function ensureJoinedGatewayTakeover(officeId: string): void {
    const join = joined.get(officeId)
    if (!join?.gatewayServerUrl || join.gateway) return
    if (!deps.makeAuthProof) {
      console.warn(`${LOG_TAG} relay takeover needs an auth proof factory office=${officeId}`)
      return
    }
    join.gateway = new GatewayAttachClient({
      gatewayUrl: join.gatewayServerUrl,
      officeId,
      makeAuthProof: deps.makeAuthProof,
      getTerm: () => join.authority?.getTerm() ?? 0,
      onFrame: (frame, from) => {
        const live = joined.get(officeId)
        if (!live) return
        if ((frame as { officeId?: unknown }).officeId !== officeId) return
        const src = resolveFromNode(frame) ?? from ?? deps.getLocalNodeId()
        ;(live.federation.link as LanMeshLink).deliver(src, frame)
      },
      onStateChange: (state) => {
        if (state !== 'attached') return
        console.log(`${LOG_TAG} relay room claimed office=${officeId} term=${join.authority?.getTerm() ?? 0}`)
        const live = joined.get(officeId)
        // Re-baseline presence (the takeover gap is not peer silence), then
        // project the roster so survivors converge on the new center.
        live?.federation.coordinator.notifyResume()
        live?.federation.coordinator.broadcastRoster()
      },
      signAnnounce: deps.signGatewayAnnounce,
      getIdentityId: () => deps.getLocalNodeId(),
      getEndpoints: () => {
        const url = deps.getLocalAdvertisedUrl?.() ?? null
        return url ? [url] : []
      },
      getDisplayName: () => deps.getLocalDisplayName?.() ?? undefined,
    })
  }

  /**
   * Idempotently open the host's gateway attachment for an office. Split out of
   * office creation so an office hosted BEFORE the gateway URL was configured
   * picks the gateway up on the next hostOffice() call (invite minting goes
   * through it) instead of staying LAN-only until an app restart. A live client
   * is kept as-is; a URL change while attached applies on restart.
   */
  function ensureGatewayAttach(officeId: string, entry: HostedOffice): void {
    if (entry.gateway) return
    const gatewayUrl = deps.getGatewayUrl?.() ?? null
    if (!gatewayUrl) return
    if (!deps.makeAuthProof) {
      console.warn(
        `${LOG_TAG} gateway configured but no auth proof factory; office=${officeId} stays LAN-only`
      )
      return
    }
    entry.gateway = new GatewayAttachClient({
      gatewayUrl,
      officeId,
      makeAuthProof: deps.makeAuthProof,
      getTerm: () => entry.authority?.getTerm() ?? 0,
      onFrame: (frame, from) => handleGatewayInbound(officeId, frame, from),
      // A relay outage silences every relayed peer at once; when the room is
      // re-claimed, grant presence grace so the outage is not mass-confirmed as
      // peer death the moment frames resume.
      onStateChange: (state) => {
        if (state === 'attached') entry.federation?.coordinator.notifyResume()
      },
      signAnnounce: deps.signGatewayAnnounce,
      getIdentityId: () => deps.getLocalNodeId(),
      getEndpoints: () => {
        const url = deps.getLocalAdvertisedUrl?.() ?? null
        return url ? [url] : []
      },
      getDisplayName: () => deps.getLocalDisplayName?.() ?? undefined,
    })
    console.log(`${LOG_TAG} gateway attach opened office=${officeId} url=${gatewayUrl}`)
  }

  /**
   * Build the reliable ctrl-plane transport for an office (wake / turn-complete
   * over the feed outbox). This is the SINGLE messaging path — wake/turn-complete
   * always ride the durable, effectively-once feed. Returns undefined only when the
   * feed store is unavailable (a misconfiguration), in which case the shim leaves
   * those frames on the raw transport rather than dropping them. `onWake` re-injects
   * the wake as a normal frame so the coordinator's existing handleWake (dedup /
   * coalescing / run) runs unchanged; `onTurnComplete` resolves the authority
   * waiter; `sendToPeer` routes feed-sync frames over the office link (those frames
   * are never intercepted by the link's ctrl shim).
   */
  function buildCtrlFeed(officeId: string, link: LanMeshLink): CtrlFeed | undefined {
    const feedStore = resolveFeedStore()
    if (!feedStore) return undefined
    const cf = createCtrlFeed({
      officeId,
      selfNodeId: deps.getLocalNodeId(),
      feedStore,
      sendToPeer: (peer, frame) => link.send(peer, frame),
      onWake: ({ correlationId, request, from }) =>
        link.deliver(from, { kind: 'wake', officeId, correlationId, request, fromNode: from }),
      onTurnComplete: ({ correlationId, outcome }) => dispatchTurnComplete(correlationId, outcome),
      // An undelivered wake (target gone before ack) resolves the sender's
      // completion waiter as `undelivered` — the sender learns "never arrived" in
      // bounded time instead of hanging on the long completion backstop.
      onUndeliverable: ({ correlationId, target, reason }) => {
        console.warn(
          `${LOG_TAG} wake undeliverable office=${officeId} target=${target} corr=${correlationId} reason=${reason}`
        )
        dispatchTurnComplete(correlationId, { kind: 'undelivered', reason })
      },
      ...(deps.ctrlGiveUpMs !== undefined ? { giveUpMs: deps.ctrlGiveUpMs } : {}),
    })
    cf.start()
    return cf
  }

  /**
   * Build the multi-replica session-transcript plane for an office. Every node
   * runs one: owners publish their members' transcripts into per-session feeds,
   * every peer replicates them locally (history opens from the local copy and
   * survives an offline owner), and the office authority additionally serves the
   * mirrored feeds onward so joiner↔joiner replication rides the star topology.
   * Returns undefined when the feed store or transcript reader is unavailable —
   * the office then stays on the pull-only history path.
   */
  function buildSessionFeed(
    officeId: string,
    link: LanMeshLink,
    servesMirror: () => boolean
  ): SessionFeed | undefined {
    const feedStore = resolveFeedStore()
    const readOwnedTranscript = deps.readOwnedTranscript
    if (!feedStore || !readOwnedTranscript) return undefined
    const sf = createSessionFeed({
      officeId,
      selfNodeId: deps.getLocalNodeId(),
      feedStore,
      sendToPeer: (peer, frame) => link.send(peer, frame),
      broadcast: (frame) => link.broadcast(frame),
      readOwnedTranscript,
      isSessionActive: (sessionKey) => deps.isSessionActive?.(sessionKey) ?? false,
      onApplied: ({ appId, epochId }) => notifyMemberHistoryUpdated(officeId, appId, epochId),
      servesMirror,
      // Entries may come from the author itself, from the office authority (the
      // star's serving replica), or over a joined office's single upstream leg —
      // which the transport labels with THIS node's id after authenticating it.
      acceptEntriesFrom: (from, author) =>
        from === author || from === deps.getLocalNodeId() || from === believedAuthorityNode(officeId),
    })
    sf.start()
    return sf
  }

  // Coalesce per-member history-updated signals: replica batches apply row by
  // row, and one renderer reload per burst is enough.
  const historyUpdateTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const HISTORY_UPDATE_COALESCE_MS = 400

  function notifyMemberHistoryUpdated(officeId: string, appId: string, epochId: string): void {
    if (!deps.onMemberHistoryUpdated) return
    const key = `${officeId}\u0000${appId}\u0000${epochId}`
    if (historyUpdateTimers.has(key)) return
    const timer = setTimeout(() => {
      historyUpdateTimers.delete(key)
      deps.onMemberHistoryUpdated!({ officeId, appId, epochId })
    }, HISTORY_UPDATE_COALESCE_MS)
    if (typeof timer.unref === 'function') timer.unref()
    historyUpdateTimers.set(key, timer)
  }

  /** The node this office's writes are believed to be served by (authority/host). */
  function believedAuthorityNode(officeId: string): NodeId | null {
    return (
      deps.authorityStore?.getAuthorityState(officeId)?.authorityNodeId ??
      deps.teamStore.getTeamById(officeId)?.hostNodeId ??
      null
    )
  }

  /**
   * Split one inbound feed-sync frame between the two feed planes: session
   * feeds (transcript replication) vs the ctrl feed (wake/turn-complete).
   */
  function routeFeedFrame(
    officeId: string,
    ctrlFeed: CtrlFeed | undefined,
    sessionFeed: SessionFeed | undefined,
    from: NodeId,
    frame: FeedSyncFrame
  ): void {
    // A joined office's single upstream leg labels inbound frames with THIS
    // node's own id (the transport has no per-frame source there). Feed cursors
    // are keyed by the label, while delivery accounting (deliveredUpTo /
    // give-up) queries by the peer's REAL node id — so normalize the self label
    // to the serving authority. Without this a joiner never credits the
    // authority's acks: every wake it publishes is falsely declared
    // undeliverable at the give-up backstop, its completion waiter is consumed,
    // and the real turn-complete later drops as "no waiter".
    const src = from === deps.getLocalNodeId() ? (believedAuthorityNode(officeId) ?? from) : from
    if (isSessionFeedFrame(officeId, frame)) sessionFeed?.handleFrame(src, frame)
    else ctrlFeed?.handleFrame(src, frame)
  }

  /**
   * The link's ctrl shim: a DIRECTED wake / turn-complete is published to the
   * reliable ctrl-feed outbox (durable, effectively-once) instead of a
   * fire-and-forget raw send; returns true when it consumed the frame. The feed's
   * outbox holds an entry until the peer subscribes and its cursor replays it, so a
   * send that races ahead of the join/subscribe is delivered, not lost — no per-peer
   * gate needed. Feed-sync frames and broadcasts (to === null) are never
   * intercepted. Only when the feed store is unavailable (ctrlFeed undefined) do
   * these frames stay on the raw transport.
   */
  function ctrlShimSend(ctrlFeed: CtrlFeed | undefined, to: NodeId | null, frame: FederationMessage): boolean {
    if (!ctrlFeed || to === null) return false
    if (frame.kind === 'wake') {
      ctrlFeed.publishWake(to, frame.correlationId, frame.request)
      return true
    }
    if (frame.kind === 'turn-complete') {
      ctrlFeed.publishTurnComplete(to, frame.correlationId, frame.outcome)
      return true
    }
    return false
  }

  function hostOffice(officeId: string): Federation {
    const existing = hosted.get(officeId)
    if (existing) {
      // The gateway URL may have been configured after this office was first
      // hosted; re-invoking host (e.g. minting an invite) heals the attachment.
      ensureGatewayAttach(officeId, existing)
      return existing.federation
    }

    const entry: HostedOffice = {
      federation: undefined as unknown as Federation,
      link: undefined as unknown as LanMeshLink,
      nodeToClient: new Map(),
      streamOriginClientId: null,
      nodeToGateway: new Set(),
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
        // Relayed members: the gateway fans a null-addressed frame out to every
        // admitted room member. A relayed producer cannot be excluded there;
        // the viewer's seq dedup guards that overlap.
        entry.gateway?.send(null, frame)
        return
      }
      // Reliable ctrl-plane: a directed wake / turn-complete rides the feed outbox
      // (durable, effectively-once) — the single messaging path.
      if (ctrlShimSend(entry.ctrlFeed, to, frame)) return
      const clientId = entry.nodeToClient.get(to)
      if (!clientId) {
        if (entry.gateway?.isAttached() && entry.nodeToGateway.has(to)) {
          entry.gateway.send(to, frame)
          return
        }
        console.warn(`${LOG_TAG} host send: no client for node=${to} office=${officeId}`)
        return
      }
      if (!deps.hostSend(clientId, frame)) {
        console.warn(`${LOG_TAG} host send failed node=${to} client=${clientId} office=${officeId}`)
      }
    })
    entry.link = link

    // Gateway relay: when a gateway is configured, the host also opens an
    // outbound attachment and claims the office's room so off-LAN members can
    // be relayed. Requires the device-key proof factory — the gateway admits a
    // host session on that proof alone.
    ensureGatewayAttach(officeId, entry)

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
        remoteBusy.clearForApp(appId)
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
      // Feed planes: route inbound feed-sync frames to this office's session or
      // ctrl feed (the coordinator supplies the delivering peer as the source).
      onFeedFrame: (from, frame) => routeFeedFrame(officeId, entry.ctrlFeed, entry.sessionFeed, from, frame),
      // A confirmed-offline node keeps its queued wakes PENDING in the durable
      // outbox (a WAN tunnel flap must not fail messages the outbox will deliver
      // on reconnect); the ctrl-feed give-up deadline is the sole undeliverable
      // arbiter. Forward the transition so the handover layer can react (M2). A
      // node coming online is advertised every session feed this authority
      // serves, so a late joiner backfills all transcripts without waiting for
      // the re-announce tick.
      onNodePresence: (nodeId, status) => {
        if (status === 'offline') entry.sessionFeed?.dropPeer(nodeId)
        if (status === 'online') entry.sessionFeed?.advertiseAllTo(nodeId)
        authority?.onNodePresence(nodeId, status)
      },
      // M2: stamp the join-grant with the current tenure + effective caps.
      getJoinGrantExtras: authority ? () => authority!.getJoinGrantExtras() : undefined,
      // Committed roster: a node admission rides the replicated blackboard log,
      // so every replica's quorum denominator converges to the committed set.
      onNodeAdmitted: authority ? (node) => authority!.replicateNodeAdmitted(node) : undefined,
      // Run-context: stamp the roster snapshot with the open run epoch so a joiner
      // derives the live session key and renders an in-progress run's history.
      getCurrentRunEpoch: () => deps.getCurrentRunEpoch?.(officeId)?.epochId ?? null,
      // Run-context: stamp each member's live status so a joiner's topology
      // animates the working pulse + run banner in step with the host. Bootstrap
      // passes the runtime's status (which already folds in this manager's
      // remote-busy overlay via isMemberRemoteBusy).
      getMemberRuntimeStatus: deps.getMemberRuntimeStatus,
      // Run-context: stamp each member's live busy assignments (run + conversations)
      // with authority-generated labels so a joiner's board can say "busy with
      // another conversation" truthfully (P0-2).
      ...(deps.getMemberBusy ? { getMemberBusy: (appId: string) => deps.getMemberBusy!(appId, officeId) } : {}),
    })
    entry.federation = federation
    entry.authority = authority
    entry.ctrlFeed = buildCtrlFeed(officeId, link)
    // The host is the office authority → it serves mirrored session feeds so
    // joiner↔joiner transcript replication rides the star topology.
    entry.sessionFeed = buildSessionFeed(officeId, link, () => true)
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
      // Not hosted here — but a JOINED office can also receive inbound WS
      // sessions: after a host loss, peers dial each other (election traffic,
      // re-form) and their frames arrive on this node's WS server. Route them
      // into the joined office's coordinator with the same edge assertions.
      const joinedEntry = joined.get(ctx.officeId)
      if (joinedEntry) {
        handleJoinedInbound(joinedEntry, ctx)
        return
      }
      console.warn(`${LOG_TAG} inbound for unhosted office=${ctx.officeId}; dropping frame`)
      return
    }
    const frame = ctx.frame as FederationMessage
    // The frame's inner officeId must match the office the session's credential
    // authenticated for (ctx.officeId is credential-derived) — a cross-office
    // frame smuggled over a valid session is dropped at the edge.
    if ((frame as { officeId?: unknown }).officeId !== ctx.officeId) {
      console.warn(`${LOG_TAG} inbound officeId mismatch office=${ctx.officeId}; dropping ${frame.kind}`)
      return
    }
    // The node identity the sending session PROVED at its auth handshake. Null
    // when the transport doesn't bind identities (e.g. an in-memory test rig);
    // a proven identity activates every origin assertion below.
    const sessionIdentity = deps.getSessionIdentity?.(ctx.clientId) ?? null
    const fromNode = resolveFromNode(frame)
    if (!fromNode) {
      // Feed-sync frames (subscribe/entries/ack/nack) carry no payload fromNode, so
      // attribute them to the sending peer's NODE id — the ctrl-feed producer keys
      // its per-peer cursors + push targets on that node id, so a raw clientId would
      // break the push back (the host resolves clientId FROM node id, not vice
      // versa). Prefer the proven session identity; else reverse-map the learned
      // nodeToClient binding for this client. Dropping them (as an unknown-source
      // frame) is what left a peer's subscribe unregistered → its pushes never sent.
      if (isFeedSyncFrame(frame)) {
        let peer = sessionIdentity
        if (!peer) {
          for (const [node, cid] of entry.nodeToClient) {
            if (cid === ctx.clientId) {
              peer = node
              break
            }
          }
        }
        if (peer) {
          ;(entry.federation.link as LanMeshLink).deliver(peer, frame)
        } else {
          console.warn(`${LOG_TAG} feed-sync frame from unmapped client=${ctx.clientId} office=${ctx.officeId}; dropping`)
        }
        return
      }
      // turn-complete and stream-frames carry no source node but must still
      // reach the host coordinator: turn-complete resolves the pending wait by
      // correlationId; stream-frames is replayed + re-broadcast by onStreamFrames.
      // Their origin is asserted against the session identity instead.
      if (frame.kind === 'stream-frames') {
        // Origin assertion: the producing session must OWN the member whose
        // session key it streams for — otherwise any member of the office could
        // inject fabricated activity for someone else's member.
        if (sessionIdentity !== null && !ownsStreamSession(ctx.officeId, sessionIdentity, frame.sessionKey)) {
          console.warn(
            `${LOG_TAG} stream-frames origin mismatch office=${ctx.officeId} session=${sessionIdentity} key=${frame.sessionKey}; dropping`
          )
          return
        }
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
        // Origin assertion: only the node the wake was sent TO may complete its
        // correlation — a peer must not be able to forge another member's turn
        // outcome. An unknown correlation passes through (the dispatcher warns
        // and drops it as a no-waiter completion).
        const expected = remoteBusy.ownerNodeId(frame.correlationId)
        if (sessionIdentity !== null && expected !== undefined && expected !== sessionIdentity) {
          console.warn(
            `${LOG_TAG} turn-complete origin mismatch office=${ctx.officeId} corr=${frame.correlationId} session=${sessionIdentity} expected=${expected}; dropping`
          )
          return
        }
        ;(entry.federation.link as LanMeshLink).deliver(ctx.clientId, frame)
        return
      }
      console.warn(`${LOG_TAG} inbound frame without source node office=${ctx.officeId}; dropping`)
      return
    }
    // Assert the frame's self-reported fromNode matches the session's
    // authenticated identity (see FederationManagerDeps.getSessionIdentity); a
    // mismatch is a spoof attempt — drop it here.
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
    // A direct client session supersedes any earlier gateway path for this node.
    entry.nodeToGateway.delete(fromNode)
    // Reliable ctrl-plane: subscribe to this peer's ctrl feed so its turn-completes
    // are consumed reliably (idempotent — a re-subscribe just replays from cursor).
    entry.ctrlFeed?.subscribePeer(fromNode)
    // …and the reverse direction: ensure this peer subscribes to OUR ctrl feed so
    // our wakes reach it even if its one-shot subscribe was lost in transit. Any
    // inbound frame (a heartbeat suffices) heals it — the always-on primary self-heal.
    entry.ctrlFeed?.ensurePeerSubscribed(fromNode)

    // The host link's inbound entrypoint forwards to the coordinator's handler.
    ;(entry.federation.link as LanMeshLink).deliver(fromNode, frame)
  }

  /**
   * Inbound frames relayed by the gateway for a hosted office. The gateway has
   * already bound the sending session to a proven identity and asserted each
   * frame's fromNode against it, so the LAN edge's spoof assertion is not
   * repeated here. Learning fromNode into nodeToGateway (and out of
   * nodeToClient) keeps the node's return path pointed at the relay.
   */
  function handleGatewayInbound(officeId: string, frame: FederationMessage, from?: string): void {
    const entry = hosted.get(officeId)
    if (!entry) return
    if ((frame as { officeId?: unknown }).officeId !== officeId) {
      console.warn(`${LOG_TAG} gateway inbound officeId mismatch office=${officeId}; dropping ${frame.kind}`)
      return
    }
    // Origin resolution order: the payload's own fromNode when the kind carries
    // one, else the gateway-stamped envelope `from` (already proven, §9.2). This
    // keeps presence-update/stream-frames/turn-complete — which carry no payload
    // fromNode — correctly attributed across the relay instead of being dropped.
    const fromNode = resolveFromNode(frame) ?? from ?? null
    if (!fromNode) {
      // Cross-version compatibility: an OLDER gateway that does not stamp `from`
      // leaves these two kinds without any source node. They carry none in their
      // payload by design and the coordinator does not route on the source label
      // for them, so deliver under a synthetic label (the pre-`from` behavior)
      // rather than silently dropping the relayed activity stream / turn-complete.
      if (frame.kind === 'stream-frames' || frame.kind === 'turn-complete') {
        ;(entry.federation.link as LanMeshLink).deliver('gateway', frame)
        return
      }
      console.warn(`${LOG_TAG} gateway inbound frame without source node office=${officeId}; dropping ${frame.kind}`)
      return
    }
    entry.nodeToGateway.add(fromNode)
    entry.nodeToClient.delete(fromNode)
    // Relayed peers get the same feed wiring as direct LAN clients: subscribe to
    // the sender's ctrl feed so its wakes/turn-completes are consumed reliably.
    // Without this, a gateway member's outbox is never served — its replies sit
    // undelivered forever while everything else looks connected.
    entry.ctrlFeed?.subscribePeer(fromNode)
    // Reverse direction: ensure this relayed peer subscribes to OUR ctrl feed so our
    // wakes reach it even if its subscribe was lost — heartbeat-driven primary heal.
    entry.ctrlFeed?.ensurePeerSubscribed(fromNode)
    ;(entry.federation.link as LanMeshLink).deliver(fromNode, frame)
  }

  /**
   * Inbound frames for a JOINED office arriving on this node's WS server (a
   * peer dialed us — election / re-form traffic after a host loss). Applies the
   * same officeId + proven-identity origin assertions as the hosted path, then
   * delivers into the joined office's coordinator.
   */
  function handleJoinedInbound(
    entry: JoinedOffice,
    ctx: { clientId: string; officeId: string; frame: unknown }
  ): void {
    const frame = ctx.frame as FederationMessage
    if ((frame as { officeId?: unknown }).officeId !== ctx.officeId) {
      console.warn(`${LOG_TAG} joined inbound officeId mismatch office=${ctx.officeId}; dropping ${frame.kind}`)
      return
    }
    const sessionIdentity = deps.getSessionIdentity?.(ctx.clientId) ?? null
    const fromNode = resolveFromNode(frame)
    if (fromNode && sessionIdentity !== null && fromNode !== sessionIdentity) {
      console.warn(
        `${LOG_TAG} joined inbound fromNode spoof office=${ctx.officeId} claimed=${fromNode} session=${sessionIdentity}; dropping`
      )
      return
    }
    // Learn the peer's return path: its own inbound session supersedes any
    // election dial leg to it (one route per peer — no routing ambiguity), and
    // is how an elected survivor answers the star that re-forms around it.
    const peer = sessionIdentity ?? fromNode
    if (peer && peer !== deps.getLocalNodeId()) {
      entry.peerClients.set(peer, ctx.clientId)
      const leg = entry.electionLegs.get(peer)
      if (leg) {
        leg.dispose?.()
        entry.electionLegs.delete(peer)
      }
      // Reliable ctrl-plane from this peer (mirrors the hosted inbound path).
      entry.ctrlFeed?.subscribePeer(peer)
      // Reverse direction: ensure this peer subscribes to OUR ctrl feed too, so a
      // wake we author (as elected authority) reaches it even if its subscribe was
      // lost — mirrors the hosted/gateway inbound heal.
      entry.ctrlFeed?.ensurePeerSubscribed(peer)
    }
    // Frames without a payload source (feed-sync et al) are attributed to the
    // proven session identity, so feed cursors key on the real peer node.
    ;(entry.federation.link as LanMeshLink).deliver(fromNode ?? peer ?? deps.getLocalNodeId(), frame)
  }

  /**
   * True when `nodeId` owns the member addressed by a stream batch's session
   * key: the key must parse, belong to this office, and its member's persisted
   * owner_node_id must equal the proven session identity. Host-owned members are
   * stored SELF-relative and therefore never match a remote session — a joiner
   * cannot stream as the host's members.
   */
  function ownsStreamSession(officeId: string, nodeId: NodeId, sessionKey: string): boolean {
    const parsed = parseTeamSessionKey(sessionKey)
    if (!parsed || parsed.teamId !== officeId) return false
    const owner = deps.teamStore
      .listMembersByTeam(officeId)
      .find((m) => m.appId === parsed.appId)?.ownerNodeId
    return owner === nodeId
  }

  /**
   * Send a wake to a member's owner. Reliable redelivery is owned by the ctrl-feed
   * outbox (durable, retransmits until acked), so this just publishes once via the
   * link's ctrl shim: `attemptWakeSend` returns true when the wake was reachable +
   * published (or false when the owner is unreachable, which surfaces as the
   * three-state "not delivered" upstream). No separate wake-retransmit loop — that
   * would re-publish duplicate feed entries; the feed handles resend correctly.
   */
  function sendWakeToMember(params: {
    officeId: string
    ownerNodeId: NodeId
    request: SerializedWakeRequest
    correlationId: string
  }): boolean {
    return attemptWakeSend(params)
  }

  function attemptWakeSend(params: {
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
      // Reachability gates apply ONLY on the raw-transport fallback (no feed
      // store): there a wake to an unreachable owner is silently dropped, so the
      // honest move is to refuse the send up front. WITH the durable ctrl outbox
      // the wake is published regardless — the entry is held and delivered when
      // the owner returns (a WAN tunnel flap must not fail a message the outbox
      // will deliver), and the give-up backstop bounds the wait honestly if the
      // owner never comes back.
      if (!host.ctrlFeed) {
        const directPath = host.nodeToClient.has(params.ownerNodeId)
        const gatewayPath = (host.gateway?.isAttached() ?? false) && host.nodeToGateway.has(params.ownerNodeId)
        if (
          (!directPath && !gatewayPath) ||
          deps.federationStore.getNode(params.officeId, params.ownerNodeId)?.status === 'offline'
        ) {
          console.warn(`${LOG_TAG} sendWake: owner unreachable node=${params.ownerNodeId} office=${params.officeId}`)
          return false
        }
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
      // The owner node id is also the ONLY session allowed to complete this
      // correlation (asserted on the inbound turn-complete).
      remoteBusy.mark(params.correlationId, params.officeId, params.request.appId, params.ownerNodeId)
      return true
    }
    // JOINER role: the office is joined here. In the star topology a joiner's
    // wake always travels via the office authority — the host runs a host-owned
    // target locally, or relays the wake one hop to the true owning joiner
    // (runOrForwardWakeOnHost) and refluxes the completion. The wake is therefore
    // addressed to the AUTHORITY, not the final owner: the ctrl feed applies
    // entries by target label, and the authority is the only peer consuming this
    // node's ctrl feed — an owner-labeled entry for another joiner would be
    // consumed-but-ignored there and never reach the owner (a silently lost
    // joiner→joiner message).
    const join = joined.get(params.officeId)
    if (join) {
      const believedAuthority = believedAuthorityNode(params.officeId)
      if (believedAuthority === selfNode) {
        // ELECTED-AUTHORITY role on a joined office: this node IS the star
        // center now, so a wake goes straight to the member's owner over the
        // router (peer session / dial leg) — addressing it to "the authority"
        // would loop it back to ourselves. Mirrors the hosted branch, including
        // the remote-busy overlay + the turn-complete origin assertion it feeds.
        join.federation.link.send(params.ownerNodeId, {
          kind: 'wake',
          officeId: params.officeId,
          correlationId: params.correlationId,
          request: params.request,
          fromNode: selfNode,
        })
        remoteBusy.mark(params.correlationId, params.officeId, params.request.appId, params.ownerNodeId)
        return true
      }
      const relayNode = believedAuthority ?? params.ownerNodeId
      // Symmetric with the host branch: the offline gate applies only on the
      // raw-transport fallback; with the outbox the wake is held + delivered on
      // recovery, bounded by the give-up backstop.
      if (!join.ctrlFeed && deps.federationStore.getNode(params.officeId, relayNode)?.status === 'offline') {
        console.warn(`${LOG_TAG} sendWake: authority unreachable node=${relayNode} office=${params.officeId}`)
        return false
      }
      join.federation.link.send(relayNode, {
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
    // Relay cleanup: the departed node's gateway session serves nothing now.
    const host = hosted.get(officeId)
    if (host?.nodeToGateway.delete(from)) host.gateway?.evict(from)
    // Committed roster: a node that took ALL its members out has left the
    // office — replicate the departure and drop its ledger row, so the quorum
    // denominator stops counting it (a stale row would inflate the majority a
    // future election needs and could wedge an otherwise-healthy office).
    const ownedTotal = members.filter((m) => m.ownerNodeId === from)
    if (ownedTotal.every((m) => owned.includes(m.appId))) {
      getOfficeAuthority(officeId)?.replicateNodeLeft(from)
      deps.federationStore.removeNode(officeId, from)
    }
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
      // If the host removed the last app this node brought to the office, this
      // node is no longer a member here → forget the re-join record so the next
      // start does not auto-rejoin an office that kicked it. Evaluated against the
      // persisted bring set (the local roster materializes asynchronously, so it
      // is not a reliable signal at frame time). Runs before the UI callback so
      // the callback learns whether the kick hit one of this node's own members.
      const ownMember = dropBroughtApp(officeId, frame.appId)
      deps.onMemberRemovedRemote?.(officeId, frame.appId, ownMember)
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
      // One access-lost notice per loss: re-armed by a later grant, so a flap
      // that recovers stays quiet while a real loss is never silent.
      let accessLostNotified = false
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

      // Set after createFederation; referenced by the link's ctrl shim + onFeedFrame.
      let ctrlFeed: CtrlFeed | undefined
      let sessionFeed: SessionFeed | undefined
      // Per-peer return paths (see the JoinedOffice fields for semantics). Bound
      // into the router closure below, then stored on the office entry.
      const peerClients = new Map<NodeId, string>()
      const electionLegs = new Map<NodeId, DialedPeer>()
      // The upstream leg starts at the join client; repointLink replaces it in
      // place after an authority change (the router keeps working unchanged).
      // The target rides the envelope so a HOSTLESS gateway room can deliver
      // addressed election frames to exactly one member (LAN hosts ignore it).
      const upstreamRef: { send: WsSender } = { send: (to, frame) => client.send(frame, to) }
      /**
       * Directed-send path resolution, best first:
       *   1. a live inbound session FROM that peer (peerClients — the re-formed
       *      star when this node is the authority, or a dialing candidate);
       *   2. an election-window dial leg to it;
       *   3. the upstream leg (steady-state star: everything rides the authority).
       * A dead inbound session falls through (and is forgotten) instead of
       * black-holing the frame.
       */
      const sendDirected = (to: NodeId, frame: FederationMessage): void => {
        const clientId = peerClients.get(to)
        if (clientId !== undefined) {
          if (deps.hostSend(clientId, frame)) return
          peerClients.delete(to)
        }
        const leg = electionLegs.get(to)
        if (leg) {
          leg.sender(to, frame)
          return
        }
        // Relay office, elected here: members reach us through the claimed
        // room, so addressed replies ride the same relay back.
        const roomClaim = joined.get(officeId)?.gateway
        if (roomClaim?.isAttached()) {
          roomClaim.send(to, frame)
          return
        }
        upstreamRef.send(to, frame)
      }
      const link: LanMeshLink = new LanMeshLink((to, frame) => {
        // Reliable ctrl-plane: a directed wake / turn-complete rides the feed outbox
        // (durable, effectively-once); feed-sync frames go raw over the router.
        if (ctrlShimSend(ctrlFeed, to, frame)) return
        if (to !== null) {
          sendDirected(to, frame)
          return
        }
        // Broadcast: upstream + every direct peer path, one copy per node
        // (an inbound session wins over a dial leg to the same peer). In the
        // steady state both maps are empty and this is exactly the old
        // single-upstream behaviour.
        const sent = new Set<NodeId>()
        for (const [node, clientId] of peerClients) {
          if (deps.hostSend(clientId, frame)) sent.add(node)
          else peerClients.delete(node)
        }
        for (const [node, leg] of electionLegs) {
          if (sent.has(node)) continue
          leg.sender(node, frame)
          sent.add(node)
        }
        const roomClaim = joined.get(officeId)?.gateway
        if (roomClaim?.isAttached()) {
          // The gateway fans out to every admitted room member. The upstream
          // member session is skipped: as the room's host, a frame sent over
          // it would be routed straight back to this node (a self-loop).
          roomClaim.send(null, frame)
          return
        }
        upstreamRef.send(null, frame)
      })
      // M2 authority module for this JOINED office: as a hot-standby it applies
      // replicated entries + acks, and tracks the host's presence so it can stand
      // for election if elected (undefined when M2 is off).
      const authority = buildAuthority(officeId, link)
      const client = new WsFederationClient({
        serverUrl,
        credentialToken,
        // Required by gateway sessions (the token is opaque there) and enables
        // roster re-entry on peers; a LAN host resolves it from the credential.
        officeId,
        // Node-identity handshake: answer the host's auth challenge with a
        // device-key signature so the session binds this node's portable id.
        makeAuthProof: deps.makeAuthProof,
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
        // The relay reported the room's host lost: remember this office rides a
        // gateway, so an election win claims the room (term-locked attach) and
        // an authority change re-enrolls over the relay instead of WAN-dialing.
        onGatewayHostLost: () => {
          const live = joined.get(officeId)
          if (live && !live.gatewayServerUrl) {
            live.gatewayServerUrl = serverUrl
            console.log(`${LOG_TAG} office=${officeId} marked relay-backed url=${serverUrl}`)
          }
        },
        // Reconnect re-auth (never the first auth): the host may have dropped this
        // node from the roster while it was gone, so re-drive the join-request to
        // re-enter + catch up rather than relying on heartbeats the host ignores.
        onReauth: () => {
          const live = joined.get(officeId)
          if (!live) return
          console.log(`${LOG_TAG} re-driving join after reconnect office=${officeId}`)
          // The outage silence must not be counted as peer death the moment
          // frames resume: re-baseline presence with a grace window (same
          // mechanism as OS resume) before re-entering the roster.
          live.federation.coordinator.notifyResume()
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
        // A joiner's only direct transport is its upstream (the believed
        // authority — which MOVES after an election). Persisted PEER rows have
        // no transport here: the FSM must not silence-sweep them, or every
        // peer would be false-confirmed offline ~13s after its row lands.
        //
        // ELECTED-AUTHORITY role: once this node IS the authority it becomes
        // the star center and the office's only presence source — nobody
        // projects presence to it anymore, so it adopts FULL host semantics
        // and silence-tracks every ledger row (peers heartbeat to it over
        // their re-enrolled sessions). A peer that dies a SECOND time is then
        // confirmed offline here, keeping member unblock / reconcile /
        // reachability gates working after a handover. Deliberately NOT keyed
        // on a live return session: a dead peer's session entry is pruned on
        // its first failed send, which would un-track it right before the FSM
        // could confirm it. Followers still track only their upstream.
        isPresenceTracked: (nodeId) => {
          const believedAuthority = believedAuthorityNode(officeId)
          return nodeId === believedAuthority || believedAuthority === deps.getLocalNodeId()
        },
        onMemberConfirmedOffline: deps.onMemberConfirmedOffline,
        onPresenceChange: deps.onPresenceChange
          ? (snap) => deps.onPresenceChange!(officeId, snap)
          : undefined,
        onJoinGrant: (assignedNodeId) => {
          console.log(`${LOG_TAG} joined office=${officeId}`)
          accessLostNotified = false
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
              advertisedUrl: deps.getLocalAdvertisedUrl?.() ?? null,
            })
          }
          // Persist the re-join record so a restart reconnects without re-prompting
          // for the invite. Written on grant (membership confirmed); refreshed on a
          // re-grant. Removed only on an explicit exit (leave / dissolved / kicked).
          writeJoinedConnection(officeId, serverUrl, credentialToken, bringMembers)
          // (Ctrl-feed subscribe to the host happens in onRoster, where the host's
          // node id is reliably known — the shadow team is not yet materialized at
          // grant time.)
          finish({ ok: true })
        },
        onJoinReject: (reason) => {
          console.warn(`${LOG_TAG} join rejected office=${officeId} reason=${reason}`)
          // A reject after the join settled is a lost membership (the authority
          // no longer recognizes this node) — surface it instead of leaving the
          // user with a silently wrong presence view.
          if (settled && !accessLostNotified) {
            accessLostNotified = true
            deps.onOfficeAccessLost?.(officeId, reason)
          }
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
          // Reliable ctrl-plane: subscribe to the host's ctrl feed here (not at
          // join-grant) — this is the first point the host's node id is reliably
          // known. Idempotent: a re-subscribe just replays from our cursor, so
          // firing on every roster is safe and also re-establishes after a reconnect.
          if (snapshot.team.hostNodeId) {
            ctrlFeed?.subscribePeer(snapshot.team.hostNodeId)
            // Session plane: announce this node's own transcript feeds so the
            // authority mirrors them (and serves them onward to other joiners).
            sessionFeed?.advertiseAllTo(snapshot.team.hostNodeId)
          }
          // Learn the office's node address book. The fast path stays in memory;
          // the rows are ALSO persisted below so the book survives a restart and
          // the election roster/quorum denominator is complete on every node.
          if (snapshot.nodes) {
            const book = officeAddressBooks.get(officeId) ?? new Map<NodeId, string>()
            for (const n of snapshot.nodes) {
              if (n.advertisedUrl) book.set(n.nodeId, n.advertisedUrl)
            }
            officeAddressBooks.set(officeId, book)
          }
          // M2: persist the FULL node roster from the authority's projection —
          // the authority row plus every PEER card. Peer rows carry the address
          // book + the authoritative joined_at (candidate order) so a survivor
          // can elect and dial after the authority is gone. Peer rows are
          // presence-UNTRACKED on this node (see isPresenceTracked): their
          // status is adopted from presence-update projections, never
          // silence-swept, so a row's existence no longer implies a transport.
          if (authority) {
            const host = snapshot.team.hostNodeId
            const ts = Date.now()
            for (const n of snapshot.nodes ?? []) {
              if (n.nodeId === selfContext.selfNodeId) continue
              const existing = deps.federationStore.getNode(officeId, n.nodeId)
              deps.federationStore.upsertNode({
                nodeId: n.nodeId,
                officeId,
                identity: n.nodeId,
                displayName: n.displayName ?? existing?.displayName ?? null,
                joinedAt: n.joinedAt ?? existing?.joinedAt ?? ts,
                lastSeen: existing?.lastSeen ?? ts,
                // A roster projection proves the node is KNOWN to the live
                // authority, not that it is reachable now — keep the adopted /
                // FSM-owned status on existing rows.
                status: n.nodeId === host ? 'online' : existing?.status ?? 'online',
                advertisedUrl: n.advertisedUrl ?? existing?.advertisedUrl ?? null,
              })
            }
            // Compatibility: an authority that projects no node cards (pre-
            // node-roster wire shape) still yields the authority row the
            // joiner's presence FSM must track.
            if (!snapshot.nodes?.some((n) => n.nodeId === host)) {
              const existing = deps.federationStore.getNode(officeId, host)
              deps.federationStore.upsertNode({
                nodeId: host,
                officeId,
                identity: host,
                displayName: snapshot.members.find((m) => m.ownerNodeId === host)?.ownerDisplayName ?? null,
                joinedAt: existing?.joinedAt ?? 0, // host/creator sorts earliest
                lastSeen: Date.now(),
                status: 'online',
                advertisedUrl: existing?.advertisedUrl ?? null,
              })
            }
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
        // Feed planes: route inbound feed-sync frames to this office's session
        // or ctrl feed.
        onFeedFrame: (from, frame) => routeFeedFrame(officeId, ctrlFeed, sessionFeed, from, frame),
        // Queued wakes for a confirmed-offline node stay PENDING in the outbox
        // (give-up is the sole undeliverable arbiter — see the hosted mirror of
        // this hook); forward the transition for M2 handover.
        // ELECTED-AUTHORITY role: survivors re-enroll with join-requests after
        // a handover; admissions + departures then ride the committed roster
        // the same way they do on a first-generation host.
        onNodeAdmitted: authority ? (node) => authority!.replicateNodeAdmitted(node) : undefined,
        onMemberLeave: (from, appIds) => {
          if (joined.get(officeId)?.authority?.isAuthoritySelf()) {
            handleMemberLeaveOnHost(officeId, from, appIds)
          } else {
            console.warn(`${LOG_TAG} member-leave ignored (not authority) office=${officeId} from=${from}`)
          }
        },
        onNodePresence: (nodeId, status) => {
          if (status === 'offline') sessionFeed?.dropPeer(nodeId)
          if (status === 'online') sessionFeed?.advertiseAllTo(nodeId)
          // Losing the AUTHORITY means losing the office's whole transport
          // (star center). Open direct dial legs to the survivors BEFORE the
          // handover layer reacts, so the election it starts sends its claims
          // and collects its votes over transports that still exist.
          if (status === 'offline' && nodeId === believedAuthorityNode(officeId)) {
            openElectionLegs(officeId)
          }
          authority?.onNodePresence(nodeId, status)
        },
        getJoinGrantExtras: authority ? () => authority!.getJoinGrantExtras() : undefined,
      })

      ctrlFeed = buildCtrlFeed(officeId, link)
      // A joiner replicates for itself; it serves mirrors onward only if it is
      // later elected the office authority (read live via the authority module).
      sessionFeed = buildSessionFeed(officeId, link, () => authority?.isAuthoritySelf() ?? false)
      joined.set(officeId, {
        federation,
        client,
        link,
        upstream: upstreamRef,
        peerClients,
        electionLegs,
        authority,
        ctrlFeed,
        sessionFeed,
      })
      federation.coordinator.start()

      const request: JoinRequest = {
        kind: 'join-request',
        officeId,
        fromNode: selfContext.selfNodeId,
        identityId: selfContext.selfNodeId,
        displayName: deps.getLocalDisplayName?.() ?? undefined,
        credentialToken,
        bringMembers,
        // Version/capability negotiation: the host computes the common version
        // (rejecting an incompatible node) and answers with the negotiated pv +
        // effective caps on the join-grant.
        pv: PROTOCOL_VERSION_CURRENT,
        minSupported: PROTOCOL_VERSION_MIN_SUPPORTED,
        caps: DEFAULT_P2P_CAPS,
        advertisedUrl: deps.getLocalAdvertisedUrl?.() ?? undefined,
      }
      // Keep the request so a redial/reconnect to a newly-elected authority can
      // re-drive it (roster re-entry after a host loss).
      const je = joined.get(officeId)
      if (je) je.joinRequest = request
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
    // Drop any dialed peer connection + the learned address book with the office.
    dialedPeers.get(officeId)?.()
    dialedPeers.delete(officeId)
    officeAddressBooks.delete(officeId)
    const host = hosted.get(officeId)
    if (host) {
      host.ctrlFeed?.stop()
      host.sessionFeed?.stop()
      host.authority?.stop()
      host.federation.coordinator.stop()
      host.gateway?.close()
      host.nodeToClient.clear()
      host.nodeToGateway.clear()
      hosted.delete(officeId)
      console.log(`${LOG_TAG} stopped hosting office=${officeId}`)
    }
    const join = joined.get(officeId)
    if (join) {
      join.ctrlFeed?.stop()
      join.sessionFeed?.stop()
      join.authority?.stop()
      join.federation.coordinator.stop()
      join.client.close()
      join.gateway?.close()
      for (const leg of join.electionLegs.values()) leg.dispose?.()
      join.electionLegs.clear()
      join.peerClients.clear()
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
    // JOINED office: swap only the UPSTREAM leg inside the router, so the ctrl
    // shim and the per-peer return paths keep working across the repoint.
    const join = joined.get(officeId)
    if (join) {
      join.upstream.send = newSendTarget
      console.log(`${LOG_TAG} repointed upstream office=${officeId}`)
      return true
    }
    const link = hosted.get(officeId)?.link
    if (!link) {
      console.warn(`${LOG_TAG} repointLink: office not hosted or joined office=${officeId}`)
      return false
    }
    link.repoint(newSendTarget)
    console.log(`${LOG_TAG} repointed link office=${officeId}`)
    return true
  }

  /**
   * Failure-window transport re-form, leg 1 of "one election, two kinds of
   * legs": when the believed authority is confirmed-offline, dial every known
   * survivor's advertised URL so election claims/votes ride reachable direct
   * transports instead of the dead upstream. Idempotent; peers already
   * reachable (an inbound session, or a live leg) are not re-dialed. The legs
   * are temporary — see closeElectionLegs and the peer-session takeover in
   * handleJoinedInbound.
   */
  function openElectionLegs(officeId: string): void {
    const join = joined.get(officeId)
    if (!join) return
    const self = deps.getLocalNodeId()
    let opened = 0
    for (const node of deps.federationStore.listNodesByOffice(officeId)) {
      if (node.nodeId === self) continue
      if (node.status === 'offline') continue // the dead authority / confirmed peers
      if (join.peerClients.has(node.nodeId) || join.electionLegs.has(node.nodeId)) continue
      const dialed = peerDialer(officeId, node.nodeId)
      if (!dialed) continue
      const leg: DialedPeer = typeof dialed === 'function' ? { sender: dialed } : dialed
      join.electionLegs.set(node.nodeId, leg)
      opened++
    }
    if (opened > 0) {
      console.log(`${LOG_TAG} opened ${opened} election leg(s) office=${officeId}`)
    }
  }

  /** Tear down every election-window dial leg for an office (star re-formed). */
  function closeElectionLegs(officeId: string): void {
    const join = joined.get(officeId)
    if (!join || join.electionLegs.size === 0) return
    for (const leg of join.electionLegs.values()) leg.dispose?.()
    join.electionLegs.clear()
    console.log(`${LOG_TAG} closed election legs office=${officeId}`)
  }

  function redialToAuthority(officeId: string, authorityNodeId: NodeId): boolean {
    const dialed = peerDialer(officeId, authorityNodeId)
    if (!dialed) {
      console.warn(`${LOG_TAG} redial: no route to authority node=${authorityNodeId} office=${officeId}`)
      return false
    }
    const sender = typeof dialed === 'function' ? dialed : dialed.sender
    const dispose = typeof dialed === 'function' ? undefined : dialed.dispose
    if (!repointLink(officeId, sender)) {
      dispose?.()
      return false
    }
    // Dispose the previous dialed connection (if any) AFTER the repoint so the
    // office never sits without an outbound leg; a dial we no longer target must
    // not keep reconnecting in the background.
    dialedPeers.get(officeId)?.()
    if (dispose) dialedPeers.set(officeId, dispose)
    else dialedPeers.delete(officeId)
    console.log(`${LOG_TAG} redialed to authority node=${authorityNodeId} office=${officeId}`)
    // Repointing only moves the outbound leg. The new authority still has NO record
    // of this survivor until it re-drives its join-request — otherwise the survivor
    // just streams heartbeats the new authority ignores: not enrolled, not counted
    // in quorum, its members orphaned. Re-enroll now (first dial); a later reconnect
    // of the dialed leg re-enrolls via the peer dialer's onReauth.
    reenrollWithAuthority(officeId)
    return true
  }

  /**
   * Re-drive this joined office's original join-request to the CURRENT authority
   * over the (possibly repointed) link, so a newly-elected authority enrolls this
   * survivor: adds its node row, counts it in quorum, materializes its members.
   * Idempotent (the authority dedups a re-join). No-op for a host office or before
   * the join-request is known.
   */
  function reenrollWithAuthority(officeId: string): boolean {
    const join = joined.get(officeId)
    if (!join?.joinRequest) return false
    console.log(`${LOG_TAG} re-enrolling with authority office=${officeId}`)
    join.federation.coordinator.requestJoin(join.joinRequest)
    return true
  }

  /**
   * A peer node's dialable base URL: the joined office's in-memory address book
   * first (host-projected), then the persisted office_nodes row (host side / own
   * ledger). Null when unknown — the peer cannot be dialed.
   */
  function getNodeAddress(officeId: string, nodeId: NodeId): string | null {
    return (
      officeAddressBooks.get(officeId)?.get(nodeId) ??
      deps.federationStore.getNode(officeId, nodeId)?.advertisedUrl ??
      null
    )
  }

  /**
   * Inbound entry for frames arriving over a DIALED peer connection (the
   * production PeerDialer's WsFederationClient). Source attribution, best
   * first: the frame's own fromNode, then the DIALED PEER's identity supplied
   * by the caller (the dialer knows which node it connected to), then the
   * legacy self label (normalized to the believed authority downstream).
   * Passing the peer matters for source-labelled frames without a payload
   * fromNode (feed-sync): during an election window the believed authority is
   * still the DEAD node, so the legacy label mis-attributed a live peer's
   * subscribe/ack to it and its feeds were never served.
   */
  function deliverInbound(officeId: string, frame: FederationMessage, fromNode?: NodeId): void {
    const office = hosted.get(officeId) ?? joined.get(officeId)
    if (!office) {
      console.warn(`${LOG_TAG} deliverInbound: office not present office=${officeId}; dropping ${frame.kind}`)
      return
    }
    const label = resolveFromNode(frame) ?? fromNode ?? deps.getLocalNodeId()
    ;(office.federation.link as LanMeshLink).deliver(label, frame)
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

  /**
   * Replicate an epoch lifecycle write (open/seal/reopen/rename/outcome) so
   * conversations + run history stay office-shared (P0-1). On the AUTHORITY this
   * captures into the single-writer log and fans out to standbys; on a JOINER it
   * rides the same member→authority `blackboard-write` path as a shadow board
   * write, so the authority applies + re-replicates it to every node. No-op when
   * the office is neither hosted nor joined here (single-machine team).
   */
  function routeEpochWrite(epoch: { id: string; teamId: string }): void {
    const host = hosted.get(epoch.teamId)
    if (host) {
      host.authority?.captureLocalWrite({
        teamId: epoch.teamId,
        epochId: epoch.id,
        op: 'epoch_upsert',
        payload: epoch as unknown as Record<string, unknown>,
      })
      scheduleRosterRefresh(epoch.teamId)
      return
    }
    const join = joined.get(epoch.teamId)
    if (!join) return // single-machine team (not federated) → local write is enough
    const frame: BlackboardWriteFrame = {
      kind: 'blackboard-write',
      officeId: epoch.teamId,
      fromNode: deps.getLocalNodeId(),
      term: join.authority?.getTerm() ?? 0,
      op: 'epoch_upsert',
      payload: epoch as unknown as Record<string, unknown>,
      fid: randomUUID(),
    }
    const hostNode = deps.teamStore.getTeamById(epoch.teamId)?.hostNodeId
    if (hostNode) join.federation.link.send(hostNode, frame)
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
    // Relay cleanup after a kick: the removed row is already gone, so evict any
    // gateway-path node that now owns nothing here (it can rejoin with a fresh
    // invite). Best-effort — an unevicted idle session is harmless.
    if (host.gateway && host.nodeToGateway.size > 0) {
      const owners = new Set(deps.teamStore.listMembersByTeam(officeId).map((m) => m.ownerNodeId))
      for (const nodeId of [...host.nodeToGateway]) {
        if (!owners.has(nodeId)) {
          host.nodeToGateway.delete(nodeId)
          host.gateway.evict(nodeId)
        }
      }
    }
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
    // Revoke every credential this office ever issued: the office no longer exists,
    // so a leaked invite / member token must not be replayable to re-enter it. The
    // revocation ledger is the authority on validity, so this closes the door even
    // for a holder who was offline during the dissolve broadcast.
    for (const cred of deps.federationStore.listCredentialsByOffice(officeId)) {
      if (!cred.revoked) deps.federationStore.revokeCredential(cred.jti)
    }
  }

  /** Cached transcript rows above afterSeq, oldest first; corrupt rows skipped. */
  function readHistoryCache(officeId: string, cacheKey: string, afterSeq: number): SerializedHistoryMessage[] {
    const feedStore = resolveFeedStore()
    if (!feedStore) return []
    const out: SerializedHistoryMessage[] = []
    for (const row of feedStore.listCache(officeId, cacheKey, afterSeq, 50_000)) {
      try {
        out.push(JSON.parse(row.entryJson) as SerializedHistoryMessage)
      } catch {
        // A corrupt row breaks contiguity; the integrity check below falls back
        // to a full owner fetch rather than serving a gapped transcript.
      }
    }
    return out
  }

  function fetchArtifact(params: { officeId: string; ref: ArtifactRef }): Promise<Uint8Array> {
    const authority = getOfficeAuthority(params.officeId)
    if (!authority) {
      return Promise.reject(new Error(`artifact: office not present or M2 off office=${params.officeId}`))
    }
    // No node-level cache: unlike an append-only transcript, an artifact's bytes
    // can change under a stable ref, so always pull fresh from the owner. The
    // viewer's fetch addresses ref.ownerNodeId directly (host) or routes to the
    // host which relays one hop to the true owner (joiner).
    return authority.artifact.fetch(params.ref)
  }

  function fetchMemberHistory(params: {
    officeId: string
    ownerNodeId: NodeId
    appId: string
    epochId: string
    sinceSeq?: number
  }): Promise<HistoryFetchResult> {
    const authority = getOfficeAuthority(params.officeId)
    if (!authority) {
      return Promise.reject(new Error(`history: office not present or M2 off office=${params.officeId}`))
    }

    // Node-level persistent cache: a transcript is append-only and immutable per
    // epoch, so cached rows never invalidate. Serve the span the caller lacks
    // from the local cache and ask the owner only for the tail beyond it — after
    // an app restart history opens instantly and the network carries a delta.
    const wantSince = params.sinceSeq ?? 0
    const feedStore = resolveFeedStore()
    const cacheKey = historyCacheKey(params.ownerNodeId, params.appId, params.epochId)
    const cachedMax = feedStore ? feedStore.getCacheMaxSeq(params.officeId, cacheKey) : 0
    const expectedSpan = cachedMax > wantSince ? cachedMax - wantSince : 0
    const cachedSpan = expectedSpan > 0 ? readHistoryCache(params.officeId, cacheKey, wantSince) : []
    // Integrity: the span must be contiguous (ordinal seq ⇒ exact count). A hole
    // means a partial past write — distrust the cache and fetch the full range.
    const cacheIntact = cachedSpan.length === expectedSpan

    const ownerNode = deps.federationStore.getNode(params.officeId, params.ownerNodeId)
    const ownerUnreachable = ownerNode?.status === 'offline' || ownerNode?.status === 'suspect'
    const host = hosted.get(params.officeId)
    const noHostRoute =
      host !== undefined &&
      !host.nodeToClient.has(params.ownerNodeId) &&
      !host.nodeToGateway.has(params.ownerNodeId)

    // Local-first: an intact replica is the first paint — return it immediately
    // and refresh the tail in the BACKGROUND (renderer reloads on the
    // member-history-updated signal if anything newer lands). Session-feed
    // replication keeps this copy near-live, so gating the response on an owner
    // round trip would make every open pay a WAN RTT (or hang on a flapping
    // tunnel) for data already on disk. stale only flags an unreachable owner —
    // the copy may then miss their latest rows and the UI says so.
    if (cacheIntact && cachedSpan.length > 0) {
      const stale = ownerUnreachable || noHostRoute
      if (!stale) refreshHistoryTailInBackground(params, cacheKey, cachedMax)
      return Promise.resolve({ messages: cachedSpan, stale })
    }

    // No usable local copy. Fail fast on a known-unreachable owner so the caller
    // does not hang the request deadline; the renderer maps the stable code to
    // calm, location-free copy.
    if (ownerUnreachable || noHostRoute) {
      return Promise.reject(new Error('history-owner-unreachable'))
    }

    const fetchSince = cacheIntact ? Math.max(cachedMax, wantSince) : wantSince
    return authority.history
      .fetch({
        ownerNodeId: params.ownerNodeId,
        teamId: params.officeId,
        appId: params.appId,
        epochId: params.epochId,
        sinceSeq: fetchSince > 0 ? fetchSince : undefined,
      })
      .then((tail): HistoryFetchResult => {
        writeHistoryCache(params.officeId, cacheKey, tail)
        return { messages: tail, stale: false }
      })
  }

  /** Persist fetched transcript rows into the local replica cache (upsert-idempotent). */
  function writeHistoryCache(officeId: string, cacheKey: string, rows: SerializedHistoryMessage[]): void {
    const feedStore = resolveFeedStore()
    if (!feedStore) return
    for (const m of rows) {
      try {
        feedStore.putCache(officeId, cacheKey, m.seq, JSON.stringify(m))
      } catch (err) {
        console.warn(`${LOG_TAG} history cache write failed seq=${m.seq}: ${(err as Error).message}`)
      }
    }
  }

  // In-flight background tail refreshes, keyed per member+epoch so an open panel
  // polling quickly never stacks concurrent owner round trips.
  const historyRefreshInFlight = new Set<string>()

  /**
   * Verify freshness AFTER the local copy was already served: pull the tail
   * beyond the replica's high-water from the owner, persist it, and signal the
   * renderer to reload if anything newer landed. Failures are silent — the
   * replica already painted, and session-feed replication is the primary
   * freshness channel anyway.
   */
  function refreshHistoryTailInBackground(
    params: { officeId: string; ownerNodeId: NodeId; appId: string; epochId: string },
    cacheKey: string,
    sinceSeq: number
  ): void {
    const authority = getOfficeAuthority(params.officeId)
    if (!authority) return
    const key = `${params.officeId}\u0000${params.appId}\u0000${params.epochId}`
    if (historyRefreshInFlight.has(key)) return
    historyRefreshInFlight.add(key)
    authority.history
      .fetch({
        ownerNodeId: params.ownerNodeId,
        teamId: params.officeId,
        appId: params.appId,
        epochId: params.epochId,
        ...(sinceSeq > 0 ? { sinceSeq } : {}),
      })
      .then((tail) => {
        if (tail.length === 0) return
        writeHistoryCache(params.officeId, cacheKey, tail)
        notifyMemberHistoryUpdated(params.officeId, params.appId, params.epochId)
      })
      .catch((err: Error) => {
        console.log(
          `${LOG_TAG} background history refresh skipped (${err.message}) office=${params.officeId} app=${params.appId}`
        )
      })
      .finally(() => historyRefreshInFlight.delete(key))
  }

  function relaySink(officeId: string, batch: StreamFramesFrame): void {
    const host = hosted.get(officeId)
    if (host) {
      // Hosted-and-owned-here: the producing member's events already fired
      // locally on the authority, so do NOT apply again (would double-replay the
      // authority's own renderer). Only re-broadcast to the office's clients.
      host.federation.link.broadcast(batch)
      // Activity implies the transcript grew: coalesce a session-feed publish so
      // the new messages replicate to every peer shortly after they land.
      host.sessionFeed?.schedulePublish(batch.sessionKey)
      return
    }
    const join = joined.get(officeId)
    if (join) {
      join.federation.link.broadcast(batch)
      join.sessionFeed?.schedulePublish(batch.sessionKey)
      return
    }
    console.warn(`${LOG_TAG} relaySink: office not hosted or joined office=${officeId} session=${batch.sessionKey}`)
  }

  function handleSystemResume(): void {
    let count = 0
    for (const entry of hosted.values()) {
      entry.federation.coordinator.notifyResume()
      count++
    }
    for (const entry of joined.values()) {
      entry.federation.coordinator.notifyResume()
      count++
    }
    if (count > 0) console.log(`${LOG_TAG} system resume: granted presence grace to ${count} office(s)`)
  }

  /**
   * Immediate reachability of a member's owner from this node's view. Local member
   * → always reachable. Remote member:
   *   - this node HOSTS the office → the owner (a joiner) is reachable over a live
   *     client mapping or the gateway relay AND not confirmed offline (same signal
   *     attemptWakeSend gates on).
   *   - this node JOINED the office → all sends route through the single upstream
   *     host, so reachability reduces to "the host is not confirmed offline".
   * Unknown member / not in any office here → not reachable.
   */
  function isMemberReachable(appId: string, teamId?: string): boolean {
    // Scoped to the asking team when given: the same app can be a member of
    // several teams with a different owner in each, and reachability is a
    // property of THAT team's owner/link, not of an arbitrary membership.
    const memberships = deps.teamStore.listMembersByAppId(appId)
    const member = teamId ? memberships.find((m) => m.teamId === teamId) : memberships[0]
    if (!member) return false
    const ownerNode = member.ownerNodeId
    if (!ownerNode || ownerNode === SELF_NODE_ID) return true // owned + run here
    const officeId = member.teamId
    const host = hosted.get(officeId)
    if (host) {
      const directPath = host.nodeToClient.has(ownerNode)
      const gatewayPath = (host.gateway?.isAttached() ?? false) && host.nodeToGateway.has(ownerNode)
      if (!directPath && !gatewayPath) return false
      return deps.federationStore.getNode(officeId, ownerNode)?.status !== 'offline'
    }
    const join = joined.get(officeId)
    if (join) {
      // The star center MOVES after an election: judge reachability against the
      // believed AUTHORITY (not the original team.hostNodeId, which may be the
      // dead creator). When this node is the authority itself, the owner must be
      // directly reachable (peer session / dial leg) and not confirmed offline.
      const believedAuthority = believedAuthorityNode(officeId)
      if (believedAuthority === deps.getLocalNodeId()) {
        if (!join.peerClients.has(ownerNode) && !join.electionLegs.has(ownerNode)) return false
        return deps.federationStore.getNode(officeId, ownerNode)?.status !== 'offline'
      }
      const relayNode = believedAuthority ?? deps.teamStore.getTeamById(officeId)?.hostNodeId
      if (!relayNode) return false
      return deps.federationStore.getNode(officeId, relayNode)?.status !== 'offline'
    }
    return false
  }

  function stopAll(): void {
    clearInterval(livenessTimer)
    livenessGraceTicks.clear()
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
    isMemberRemoteBusy: (appId) => remoteBusy.isBusy(appId),
    isMemberReachable,
    relaySink,
    routeAuthorityWrite,
    sendMemberWrite,
    routeEpochWrite,
    getOfficeAuthority,
    getOfficePresence,
    broadcastRosterFor,
    scheduleRosterRefresh,
    projectMemberRemoved,
    projectOfficeDissolved,
    fetchMemberHistory,
    fetchArtifact,
    repointLink,
    redialToAuthority,
    reenrollWithAuthority,
    getNodeAddress,
    deliverInbound,
    handleSystemResume,
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
    case 'authority-announce':
    case 'catchup-request':
    case 'catchup-response':
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
