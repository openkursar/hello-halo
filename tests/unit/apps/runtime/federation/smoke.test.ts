/**
 * Multi-node SMOKE rig (D8) -- the M1b capstone end-to-end integration test.
 *
 * This proves the WHOLE distributed-office chain in ONE process with a stub
 * agent and a deterministic in-process bridge (no real sockets, timers, or
 * sleeps), composing the building blocks the earlier slices each verified in
 * isolation (manager / wake / relay / presence) into a single signed-off
 * scenario suite:
 *
 *   join (persist) → remote dispatch + result (wake→turn-complete back to the lead)
 *   → activity-stream relay delivery across the bridge → M-1 offline unblock
 *   → presence two-threshold FSM (online→suspect→confirmed / jitter rollback).
 *
 * ── Shared in-process emitter (shapes the rig) ───────────────────────────────
 * services/agent/events.ts is a PROCESS-WIDE singleton, so two in-process nodes
 * cannot own isolated agent-event buses. The relay's FINAL local re-fire is
 * therefore NOT asserted by "emit on B, observe on A through the global" — they
 * share it. Instead the relay scenario asserts DELIVERY at the replay boundary:
 * B's captured batch traverses the bridge to A's host coordinator, whose
 * onStreamFrames → StreamReplay.apply re-fires the frames; we tap the global
 * emitter and confirm A's path produced them in seq order (mirroring
 * relay.test.ts, which disposes B's capture before the relay reaches A so the
 * shared-emitter artifact does not re-capture). The final ipc/agent re-fire is
 * already covered by relay.test.ts; the real-WS frame transport by
 * manager-ws.test.ts. The runbook documents the manual two-instance equivalent.
 *
 * ── Bridge ──────────────────────────────────────────────────────────────────
 * The real WsFederationClient/`ws` socket is replaced by a deterministic
 * two-way in-memory bridge between the host's LanMeshLink and the joiner's
 * LanMeshLink (the proven manager.test.ts/wake.test.ts/relay.test.ts pattern).
 * The manager's own joinOffice() constructs a real WsFederationClient, which
 * cannot run in-process; so the rig drives the joiner's coordinator directly
 * over the bridge, exercising the SAME host-side manager end-to-end path
 * (hostOffice → nodeId↔clientId learning → persistence → grant/wake/relay).
 *
 * ── Determinism / fault injection (§14.1) ───────────────────────────────────
 * Presence scenarios use a fake clock + small thresholds and a coordinator built
 * directly (the manager wires real Date.now-based coordinators). Fault-injection
 * helpers — advanceClock / dropHeartbeats / restoreHeartbeats / partition — keep
 * the scenarios readable.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// The team bus/orchestration emit UI events through these transport seams; mock
// them so the rig needs no Electron window / WS server (mirrors wake.test.ts).
const { broadcastToAll, sendToRenderer } = vi.hoisted(() => ({
  broadcastToAll: vi.fn(),
  sendToRenderer: vi.fn(),
}))
vi.mock('../../../../../src/main/http/websocket', () => ({ broadcastToAll }))
vi.mock('../../../../../src/main/foundation/window.service', () => ({ sendToRenderer }))

import {
  onAgentEvent,
  emitAgentEvent,
  type AgentEvent,
} from '../../../../../src/main/services/agent/events'
import { createDatabaseManager } from '../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../src/main/platform/store/types'
import { FederationStore } from '../../../../../src/main/apps/federation/store'
import {
  MIGRATION_NAMESPACE as FED_NS,
  migrations as fedMigrations,
} from '../../../../../src/main/apps/federation/migrations'
import { TeamStore } from '../../../../../src/main/apps/team/store'
import {
  MIGRATION_NAMESPACE as TEAM_NS,
  migrations as teamMigrations,
} from '../../../../../src/main/apps/team/migrations'
import { createFederationManager } from '../../../../../src/main/apps/runtime/federation/manager'
import type { FederationManager } from '../../../../../src/main/apps/runtime/federation/manager'
import { createFederation } from '../../../../../src/main/apps/runtime/federation/index'
import { LanMeshLink } from '../../../../../src/main/apps/runtime/federation/lan-mesh-provider'
import { createFederationCoordinator } from '../../../../../src/main/apps/runtime/federation/coordinator'
import type {
  FederationCoordinator,
  NodeBoundMember,
} from '../../../../../src/main/apps/runtime/federation/coordinator'
import { createRelayCapture } from '../../../../../src/main/apps/runtime/federation/relay'
import { makeLocationAwareSessionDeps } from '../../../../../src/main/apps/runtime/federation/session-deps'
import { createMessageBus } from '../../../../../src/main/apps/runtime/team/message-bus'
import { createOrchestration } from '../../../../../src/main/apps/runtime/team/orchestration'
import type { OrchestrationSessionDeps } from '../../../../../src/main/apps/runtime/team/orchestration'
import type {
  FederationMessage,
  JoinRequest,
  OfficeCredentialLike,
  SerializedWakeRequest,
  StreamFramesFrame,
} from '../../../../../src/main/apps/runtime/federation'
import { SELF_NODE_ID, buildTeamSessionKey } from '../../../../../src/shared/apps/team-types'
import type {
  Team,
  TeamMember,
  TeamEpoch,
} from '../../../../../src/main/apps/team/types'
import type { TeamSendSyncResult } from '../../../../../src/shared/apps/team-types'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const OFFICE = 'office-weekly-report'
const NODE_A = 'node-a-owner'
const NODE_B = 'node-b-joiner'
const B_CLIENT_ID = 'ws-client-b'
const VALID_TOKEN = 'valid-office-credential'

const LEAD_APP = 'app-a-lead'
const LOCAL_MEMBER = 'app-a-local'
const REMOTE_MEMBER = 'app-b-analyst'
const REMOTE_MEMBER_NAME = 'industry-analyst'
const REMOTE_MEMBER_SPACE = 'space-b'
const EPOCH_ID = 'epoch-1'

const STUB_RESULT = 'STUB RESULT 42'

/** The team session key the bus/relay use for the remote member's turn. */
const REMOTE_SESSION = buildTeamSessionKey(REMOTE_MEMBER, OFFICE, EPOCH_ID)

// ── Test node (host/authority A) + in-process bridge to joiner B ─────────────

interface TestNode {
  nodeId: string
  manager: FederationManager
  /** B's joiner-side coordinator link; drive B's join/relay over it. */
  bLink: LanMeshLink
  /** Host→joiner frames captured for assertions. */
  bReceived: FederationMessage[]
  /** Cut/restore the in-process bridge (network partition fault injection). */
  partition(cut: boolean): void
}

/**
 * Build host/authority A with a faked WS hop to a single joiner B. A's hostSend
 * delivers onto B's link; B's link outbound delivers into A.handleHostInbound.
 * runLocalTurn is B's owner-side turn runner (the stub agent).
 */
function makeNode(opts: {
  federationStore: FederationStore
  teamStore: TeamStore
  runLocalTurn: (req: SerializedWakeRequest) => Promise<{ finalMessage: string | null }>
  onMemberConfirmedOffline?: (appId: string) => void
}): TestNode {
  const { federationStore, teamStore, runLocalTurn } = opts
  const verify = (token: string): OfficeCredentialLike | null =>
    token === VALID_TOKEN ? { officeId: OFFICE } : null

  const bReceived: FederationMessage[] = []
  let bridgeCut = false

  // B's joiner link: outbound send simulates B's WS client → A.handleHostInbound.
  const bLink = new LanMeshLink((_to, frame) => {
    if (bridgeCut) return
    manager.handleHostInbound({ clientId: B_CLIENT_ID, officeId: OFFICE, frame })
  })

  const manager = createFederationManager({
    hostSend: (clientId, frame) => {
      if (clientId !== B_CLIENT_ID) return false
      if (bridgeCut) return false
      bReceived.push(frame)
      bLink.deliver(NODE_A, frame) // host → joiner
      return true
    },
    hostListOfficeClients: () => [B_CLIENT_ID],
    federationStore,
    teamStore,
    verifyCredential: verify,
    getLocalNodeId: () => NODE_A,
    runLocalTurn,
    onMemberConfirmedOffline: opts.onMemberConfirmedOffline,
  })
  manager.hostOffice(OFFICE)

  return {
    nodeId: NODE_A,
    manager,
    bLink,
    bReceived,
    partition: (cut) => {
      bridgeCut = cut
    },
  }
}

/**
 * Drive B's join over the bridge bringing member M. Returns B's federation so a
 * test can later push relay frames over its link. runLocalTurn was injected on A
 * via manager (the joiner here owns the turn via its own onWake).
 */
function joinFromB(
  node: TestNode,
  federationStore: FederationStore,
  teamStore: TeamStore,
  runLocalTurn: (req: SerializedWakeRequest) => Promise<{ finalMessage: string | null }>,
  handlers: { onGrant?: () => void; onReject?: (reason: string) => void } = {}
) {
  const bFed = createFederation({
    context: { officeId: OFFICE, selfNodeId: NODE_B },
    link: node.bLink,
    federationStore,
    teamStore,
    verifyCredential: () => null, // joiner never verifies; host does
    onWake: runLocalTurn,
    onJoinGrant: () => handlers.onGrant?.(),
    onJoinReject: (reason) => handlers.onReject?.(reason),
  })
  bFed.coordinator.start()

  const request: JoinRequest = {
    kind: 'join-request',
    officeId: OFFICE,
    fromNode: NODE_B,
    identityId: NODE_B,
    displayName: 'Bob',
    credentialToken: VALID_TOKEN,
    bringMembers: [
      {
        appId: REMOTE_MEMBER,
        memberName: REMOTE_MEMBER_NAME,
        role: 'Analyst',
        spaceId: REMOTE_MEMBER_SPACE,
      },
    ],
  }
  bFed.coordinator.requestJoin(request)
  return bFed
}

/** Seed A's team store so the bus can resolve names/spaces/epoch for the lead. */
function seedTeam(teamStore: TeamStore): void {
  const now = Date.now()
  const team: Team = {
    id: OFFICE,
    name: '竞品周报',
    owningSpaceId: 'space-a',
    goal: 'weekly competitor report',
    leadAppId: LEAD_APP,
    memberSourcing: 'manual',
    collabMode: 'free',
    escalationRouting: 'user',
    status: 'running',
    currentEpochId: EPOCH_ID,
    createdAt: now,
    updatedAt: now,
  }
  teamStore.insertTeam(team)
  const members: TeamMember[] = [
    { teamId: OFFICE, appId: LEAD_APP, memberName: 'lead', role: 'Lead', isLead: true, aiProvisioned: false, addedAt: now },
    { teamId: OFFICE, appId: LOCAL_MEMBER, memberName: 'local-writer', role: 'Writer', isLead: false, aiProvisioned: false, addedAt: now },
  ]
  for (const m of members) teamStore.addMember(m)
  const epoch: TeamEpoch = {
    id: EPOCH_ID,
    teamId: OFFICE,
    startedAt: now,
    endedAt: null,
    endReason: null,
    summary: null,
    lifecycle: 'run',
  }
  teamStore.insertEpoch(epoch)
}

/**
 * Compose the authority-side location-aware session deps for A: a real local
 * impl for self-owned members and the manager-backed wake/turn-complete path for
 * remote ones. Owner resolution reads the persisted remote member row.
 */
function makeAuthoritySession(
  node: TestNode,
  teamStore: TeamStore,
  local: OrchestrationSessionDeps
): OrchestrationSessionDeps {
  return makeLocationAwareSessionDeps({
    local,
    selfNodeId: NODE_A,
    resolveOwnerNode: (appId) =>
      teamStore.listMembersByTeam(OFFICE).find((m) => m.appId === appId)?.ownerNodeId ?? SELF_NODE_ID,
    resolveOfficeId: () => OFFICE,
    getRemoteSpaceId: (appId) => node.manager.getRemoteMemberSpaceId(appId),
    sendWake: (p) => node.manager.sendWakeToMember(p),
    registerTurnComplete: (corr, cb) => node.manager.registerTurnComplete(corr, cb),
  })
}

/** A no-op local impl: self members never run in these remote-focused scenarios. */
function inertLocal(): OrchestrationSessionDeps {
  return {
    sendAppChatMessage: vi.fn(async () => ({ finalMessage: 'LOCAL-should-not-run' })),
    isSessionActive: () => false,
    closeTeamSession: async () => {},
    getMemberSpaceId: () => 'local-space',
  }
}

/** Collect every agent event fired on the shared hub during a test. */
function tapEvents(): { events: AgentEvent[]; dispose: () => void } {
  const events: AgentEvent[] = []
  const sub = onAgentEvent((e) => events.push(e))
  return { events, dispose: () => sub.dispose() }
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe('M1b multi-node smoke rig (end-to-end distributed office)', () => {
  let dbManager: DatabaseManager
  let federationStore: FederationStore
  let teamStore: TeamStore

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, FED_NS, fedMigrations)
    dbManager.runMigrations(db, TEAM_NS, teamMigrations)
    federationStore = new FederationStore(db)
    teamStore = new TeamStore(db)
    broadcastToAll.mockClear()
    sendToRenderer.mockClear()
  })

  afterEach(() => {
    dbManager.closeAll()
  })

  it('S1 join: B joins A bringing M; A persists B online + M as a remote member, B is granted', () => {
    seedTeam(teamStore)
    const node = makeNode({ federationStore, teamStore, runLocalTurn: async () => ({ finalMessage: STUB_RESULT }) })
    const onGrant = vi.fn()
    joinFromB(node, federationStore, teamStore, async () => ({ finalMessage: STUB_RESULT }), { onGrant })

    const bNode = federationStore.getNode(NODE_B)!
    expect(bNode).toBeTruthy()
    expect(bNode.status).toBe('online')
    expect(bNode.officeId).toBe(OFFICE)

    const m = teamStore.listMembersByTeam(OFFICE).find((x) => x.appId === REMOTE_MEMBER)!
    expect(m).toBeTruthy()
    expect(m.ownerNodeId).toBe(NODE_B)
    expect(m.origin).toBe('remote')
    expect(m.memberName).toBe(REMOTE_MEMBER_NAME)

    // Its spaceId is cached for wake.
    expect(onGrant).toHaveBeenCalledTimes(1)
    expect(node.manager.getRemoteMemberSpaceId(REMOTE_MEMBER)).toBe(REMOTE_MEMBER_SPACE)
  })

  it('S2 remote dispatch: lead waits on M; M runs on B and the stub result flows back to the lead', async () => {
    seedTeam(teamStore)
    const runLocalTurn = vi.fn(async (_req: SerializedWakeRequest) => ({ finalMessage: STUB_RESULT }))
    const node = makeNode({ federationStore, teamStore, runLocalTurn })
    joinFromB(node, federationStore, teamStore, runLocalTurn)

    // Real bus + orchestration on A, whose session deps are location-aware.
    // Late-bind orchestration onto the bus's hooks (the createTeamRuntime wiring)
    // so completeTurn lands on the SAME bus that holds the pending wait.
    const session = makeAuthoritySession(node, teamStore, inertLocal())
    let orch!: ReturnType<typeof createOrchestration>
    const bus = createMessageBus({
      store: teamStore,
      hooks: { wakeTarget: (p) => orch.wakeTarget(p), isBusy: (k) => orch.isBusy(k) },
    })
    orch = createOrchestration({ store: teamStore, bus, session })

    const result = (await bus.send({
      teamId: OFFICE,
      epochId: EPOCH_ID,
      fromAppId: LEAD_APP,
      to: REMOTE_MEMBER_NAME,
      message: 'do X',
      wait: true,
    })) as TeamSendSyncResult

    expect(result.status).toBe('ok')
    expect(result.message).toContain(STUB_RESULT)
    // The turn really ran on B (the owner), not on A's local impl.
    expect(runLocalTurn).toHaveBeenCalledTimes(1)
    expect(runLocalTurn.mock.calls[0][0].appId).toBe(REMOTE_MEMBER)
    // Orchestration frames the envelope with a team header; the lead's body rides inside.
    expect(runLocalTurn.mock.calls[0][0].message).toContain('do X')
  })

  it("S3 relay delivery: M's activity on B crosses the bridge and A's replay re-fires the frames in seq order", () => {
    seedTeam(teamStore)
    const node = makeNode({ federationStore, teamStore, runLocalTurn: async () => ({ finalMessage: STUB_RESULT }) })
    joinFromB(node, federationStore, teamStore, async () => ({ finalMessage: STUB_RESULT }))

    // B's RelayCapture owns M's team session. Its sink HOLDS the batch — in one
    // process both nodes share the global emitter, so we deliver to A only after
    // disposing B's capture (faithful to owner-only isolation across machines).
    const held: StreamFramesFrame[] = []
    const bCapture = createRelayCapture({
      isOwnTeamSession: (id) => id === REMOTE_SESSION,
      resolveOffice: () => OFFICE,
      sink: (_officeId, batch) => held.push(batch),
    })
    const bSub = bCapture.start()

    emitAgentEvent('agent:thought-delta', REMOTE_MEMBER_SPACE, REMOTE_SESSION, { d: 'thinking' })
    emitAgentEvent('agent:tool-call', REMOTE_MEMBER_SPACE, REMOTE_SESSION, { id: 'search-1' })
    emitAgentEvent('agent:message', REMOTE_MEMBER_SPACE, REMOTE_SESSION, { text: STUB_RESULT })
    bCapture.flushAll()
    bSub.dispose()

    expect(held).toHaveLength(1)
    expect(held[0].frames.map((f) => f.seq)).toEqual([1, 2, 3])

    const tap = tapEvents()
    node.bLink.broadcast(held[0] as unknown as FederationMessage)
    tap.dispose()

    // A's onStreamFrames → StreamReplay.apply → emitAgentEvent: A re-fired the
    // relayed frames locally, in seq order, carrying M's channels. This is the
    // replay-boundary proof that B's member's stream crossed to A.
    const relayed = tap.events.filter((e) => e.conversationId === REMOTE_SESSION)
    expect(relayed.map((e) => e.channel)).toEqual([
      'agent:thought-delta',
      'agent:tool-call',
      'agent:message',
    ])
    expect(relayed[2]).toMatchObject({ data: { text: STUB_RESULT }, spaceId: REMOTE_MEMBER_SPACE })
  })

  it('S4 offline unblock: a lead waiting on M unblocks promptly with timeout when B is confirmed offline (not a 2h hang)', async () => {
    seedTeam(teamStore)

    // The stub turn NEVER completes — simulate B going dark mid-turn.
    const neverComplete = vi.fn(() => new Promise<{ finalMessage: string | null }>(() => {}))
    const node = makeNode({ federationStore, teamStore, runLocalTurn: neverComplete })
    // B joins (so the wake actually reaches B and the lead genuinely blocks on a
    // remote turn) bringing M; its turn will never complete.
    joinFromB(node, federationStore, teamStore, neverComplete)

    const SUSPECT_MS = 100
    const CONFIRMED_MS = 200
    // Base the fake clock on B's persisted lastSeen (stamped at join with real
    // Date.now) so the silence math is anchored to the actual node row.
    let clock = federationStore.getNode(NODE_B)!.lastSeen
    const now = () => clock

    // Bus + orchestration on A. The bus's syncWait timeout is left at default
    // (2h) on purpose: the test proves the M-1 path resolves it FIRST, fast.
    const session = makeAuthoritySession(node, teamStore, inertLocal())
    let orch!: ReturnType<typeof createOrchestration>
    const bus = createMessageBus({
      store: teamStore,
      hooks: { wakeTarget: (p) => orch.wakeTarget(p), isBusy: (k) => orch.isBusy(k) },
    })
    orch = createOrchestration({ store: teamStore, bus, session })

    // A fake-clock host coordinator drives the presence FSM deterministically
    // over the SAME stores (B online + M bound from the join above); its
    // confirmed-offline fan-out unblocks the bus (the M-1 seam bootstrap wires).
    const coordinator = makePresenceCoordinator({
      federationStore,
      teamStore,
      now,
      suspectMs: SUSPECT_MS,
      confirmedMs: CONFIRMED_MS,
      onMemberConfirmedOffline: (appId) => bus.resolvePendingWaitsForMember(appId, { kind: 'timeout' }),
    })

    const pending = bus.send({
      teamId: OFFICE,
      epochId: EPOCH_ID,
      fromAppId: LEAD_APP,
      to: REMOTE_MEMBER_NAME,
      message: 'do X',
      wait: true,
    }) as Promise<TeamSendSyncResult>
    await Promise.resolve() // let deliver register the waiter

    clock += SUSPECT_MS + 1
    coordinator.sweepPresence()
    expect(federationStore.getNode(NODE_B)!.status).toBe('suspect')
    clock += CONFIRMED_MS - SUSPECT_MS
    coordinator.sweepPresence()
    expect(federationStore.getNode(NODE_B)!.status).toBe('offline')

    const result = await pending
    expect(result.status).toBe('timeout')
    expect(result.message).toMatch(/unavailable/i)
  })

  it('S5 presence FSM: heartbeat keeps online; silence → suspect (no offline action); confirmed fires once; suspect heartbeat rolls back clean', () => {
    seedTeam(teamStore)
    const SUSPECT_MS = 100
    const CONFIRMED_MS = 200
    let clock = 1_000_000
    const now = () => clock
    const onMemberConfirmedOffline = vi.fn<[string], void>()

    teamStore.addMember({
      teamId: OFFICE,
      appId: REMOTE_MEMBER,
      memberName: REMOTE_MEMBER_NAME,
      role: 'Analyst',
      isLead: false,
      aiProvisioned: false,
      addedAt: clock,
      ownerNodeId: NODE_B,
      origin: 'remote',
      memberIdentity: NODE_B,
    })
    federationStore.upsertNode({
      nodeId: NODE_B,
      officeId: OFFICE,
      identity: NODE_B,
      displayName: 'Bob',
      joinedAt: clock,
      lastSeen: clock,
      status: 'online',
    })

    let dropBeats = false
    const coordinator = makePresenceCoordinator({
      federationStore,
      teamStore,
      now,
      suspectMs: SUSPECT_MS,
      confirmedMs: CONFIRMED_MS,
      onMemberConfirmedOffline,
    })
    const heartbeat = () => {
      if (dropBeats) return
      coordinator.handleHeartbeatFromB(clock)
    }

    clock += SUSPECT_MS - 1
    heartbeat()
    coordinator.sweepPresence()
    expect(federationStore.getNode(NODE_B)!.status).toBe('online')

    dropBeats = true
    clock += SUSPECT_MS + 1
    coordinator.sweepPresence()
    expect(federationStore.getNode(NODE_B)!.status).toBe('suspect')
    expect(onMemberConfirmedOffline).not.toHaveBeenCalled()

    dropBeats = false
    clock += 1
    heartbeat()
    expect(federationStore.getNode(NODE_B)!.status).toBe('online')
    expect(onMemberConfirmedOffline).not.toHaveBeenCalled()

    dropBeats = true
    clock += CONFIRMED_MS + 1
    coordinator.sweepPresence()
    expect(federationStore.getNode(NODE_B)!.status).toBe('offline')
    expect(onMemberConfirmedOffline).toHaveBeenCalledTimes(1)
    expect(onMemberConfirmedOffline).toHaveBeenCalledWith(REMOTE_MEMBER)

    clock += CONFIRMED_MS
    coordinator.sweepPresence()
    expect(onMemberConfirmedOffline).toHaveBeenCalledTimes(1)
  })

  it('S6 partition: cutting the bridge drops B→A relay frames without throwing (network-partition fault injection)', () => {
    seedTeam(teamStore)
    const node = makeNode({ federationStore, teamStore, runLocalTurn: async () => ({ finalMessage: STUB_RESULT }) })
    joinFromB(node, federationStore, teamStore, async () => ({ finalMessage: STUB_RESULT }))

    const batch: StreamFramesFrame = {
      kind: 'stream-frames',
      officeId: OFFICE,
      sessionKey: REMOTE_SESSION,
      baseSeq: 1,
      frames: [{ seq: 1, kind: 'milestone', channel: 'agent:message', spaceId: REMOTE_MEMBER_SPACE, payload: { text: 'x' } }],
    }

    node.partition(true)
    const tap = tapEvents()
    expect(() => node.bLink.broadcast(batch as unknown as FederationMessage)).not.toThrow()
    tap.dispose()
    expect(tap.events.filter((e) => e.conversationId === REMOTE_SESSION)).toHaveLength(0)
  })
})

// ── Helpers (fault-injection + presence harness) ─────────────────────────────

interface PresenceHarness {
  coordinator: FederationCoordinator
  sweepPresence(): void
  handleHeartbeatFromB(ts: number): void
}

/**
 * Build a host coordinator over an in-memory link with a fake clock + small
 * thresholds, tracking B's node (already persisted by the caller). The link's
 * inbound entrypoint lets the test inject heartbeats from B deterministically.
 */
function makePresenceCoordinator(opts: {
  federationStore: FederationStore
  teamStore: TeamStore
  now: () => number
  suspectMs: number
  confirmedMs: number
  onMemberConfirmedOffline: (appId: string) => void
}): PresenceHarness {
  const link = new LanMeshLink(() => {
    /* host→peer sends are inert in the presence harness */
  })
  const listMembersForNode = (nodeId: string): NodeBoundMember[] =>
    opts.teamStore
      .listMembersByTeam(OFFICE)
      .filter((m) => m.ownerNodeId === nodeId)
      .map((m) => ({ appId: m.appId, memberIdentity: m.memberIdentity ?? null }))

  const coordinator = createFederationCoordinator({
    context: { officeId: OFFICE, selfNodeId: NODE_A },
    link,
    federationStore: opts.federationStore,
    teamStore: opts.teamStore,
    verifyCredential: (t) => (t === VALID_TOKEN ? { officeId: OFFICE } : null),
    now: opts.now,
    presence: { suspectAfterMs: opts.suspectMs, confirmedOfflineMs: opts.confirmedMs },
    onMemberConfirmedOffline: opts.onMemberConfirmedOffline,
    listMembersForNode,
  })
  coordinator.start()

  return {
    coordinator,
    sweepPresence: () => coordinator.sweepPresence(),
    // Deliver a heartbeat from B into the host coordinator's inbound handler.
    handleHeartbeatFromB: (ts: number) =>
      link.deliver(NODE_B, { kind: 'heartbeat', officeId: OFFICE, fromNode: NODE_B, ts }),
  }
}
