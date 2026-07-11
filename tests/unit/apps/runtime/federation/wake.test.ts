/**
 * Unit tests for apps/runtime/federation -- position-transparent remote wake.
 *
 * Two in-process nodes wired by a FAKE transport (no real sockets, timer-free),
 * mirroring manager.test.ts:
 *   - A is the AUTHORITY + HOST of the office.
 *   - B is the JOINER + OWNER of a brought member M; its runLocalTurn stub plays
 *     the member's turn and returns a final message.
 *
 * Proven:
 *   - remote wake closure: A's LocationAwareSessionDeps.sendAppChatMessage for a
 *     B-owned member routes wake → B.runLocalTurn → turn-complete → resolves with
 *     the member's final message, and B received the serialized request.
 *   - local path unchanged: a SELF-owned member delegates to the local impl with
 *     no wake sent.
 *   - getMemberSpaceId stays synchronous and returns a non-null sentinel for a
 *     remote member.
 *   - M-1 kernel addition: resolvePendingWaitsForMember unblocks a wait=true send
 *     immediately (status:timeout + descriptive message), is idempotent, and
 *     ignores unrelated members.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const { broadcastToAll, sendToRenderer } = vi.hoisted(() => ({
  broadcastToAll: vi.fn(),
  sendToRenderer: vi.fn(),
}))
vi.mock('../../../../../src/main/http/websocket', () => ({ broadcastToAll }))
vi.mock('../../../../../src/main/foundation/window.service', () => ({ sendToRenderer }))

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
import { createFederation } from '../../../../../src/main/apps/runtime/federation/index'
import { LanMeshLink } from '../../../../../src/main/apps/runtime/federation/lan-mesh-provider'
import { makeLocationAwareSessionDeps, withOwnerResolvedSpace } from '../../../../../src/main/apps/runtime/federation/session-deps'
import { createMessageBus } from '../../../../../src/main/apps/runtime/team/message-bus'
import type {
  TeamDeliveryHooks,
  TurnCompletion,
} from '../../../../../src/main/apps/runtime/team/message-bus'
import type {
  FederationMessage,
  JoinRequest,
  SerializedWakeRequest,
  OfficeCredentialLike,
} from '../../../../../src/main/apps/runtime/federation'
import type { OrchestrationSessionDeps } from '../../../../../src/main/apps/runtime/team'
import { SELF_NODE_ID } from '../../../../../src/shared/apps/team-types'
import type { Team, TeamMember, TeamEpoch, TeamTriggerContext } from '../../../../../src/main/apps/team/types'

const OFFICE = 'office-1'
const NODE_A = 'node-a-authority'
const NODE_B = 'node-b-owner'
const B_CLIENT_ID = 'ws-client-b'
const VALID_TOKEN = 'valid-token'
const MEMBER_M = 'app-b-member'
const EPOCH_ID = 'epoch-1'

/**
 * Wire host/authority A + owner/joiner B with a faked WS hop, then have B join
 * bringing member M (so A persists M as a remote member owned by B). runLocalTurn
 * is B's owner-side turn runner.
 */
function wireNodes(
  federationStore: FederationStore,
  teamStore: TeamStore,
  runLocalTurn: (req: SerializedWakeRequest) => Promise<{ finalMessage: string | null }>
) {
  const verify = (token: string) => (token === VALID_TOKEN ? ({ officeId: OFFICE } as OfficeCredentialLike) : null)

  // B's joiner link: outbound send simulates B's WS client → A.handleHostInbound.
  const bLink = new LanMeshLink((_to, frame) => {
    hostManager.handleHostInbound({ clientId: B_CLIENT_ID, officeId: OFFICE, frame })
  })

  const hostManager = createFederationManager({
    hostSend: (clientId, frame) => {
      if (clientId !== B_CLIENT_ID) return false
      // Host → joiner: deliver onto B's inbound link.
      bLink.deliver(NODE_A, frame)
      return true
    },
    hostListOfficeClients: () => [B_CLIENT_ID],
    federationStore,
    teamStore,
    verifyCredential: verify,
    getLocalNodeId: () => NODE_A,
  })
  hostManager.hostOffice(OFFICE)

  // B's joiner coordinator owns member M and runs its turns locally.
  const bFed = createFederation({
    context: { officeId: OFFICE, selfNodeId: NODE_B },
    link: bLink,
    federationStore,
    teamStore,
    verifyCredential: () => null,
    onWake: runLocalTurn,
  })
  bFed.coordinator.start()

  const request: JoinRequest = {
    kind: 'join-request',
    officeId: OFFICE,
    fromNode: NODE_B,
    identityId: 'identity-b',
    displayName: 'Node B',
    credentialToken: VALID_TOKEN,
    bringMembers: [{ appId: MEMBER_M, memberName: 'b-analyst', role: 'Analyst', spaceId: 'space-b' }],
  }
  bFed.coordinator.requestJoin(request)

  return { hostManager }
}

function makeRequest(appId: string): Parameters<OrchestrationSessionDeps['sendAppChatMessage']>[0] {
  const teamContext: TeamTriggerContext = {
    teamId: OFFICE,
    epochId: EPOCH_ID,
    correlationId: 'c1',
    fromAppId: null,
    wait: true,
    kind: 'message',
  }
  return {
    appId,
    spaceId: 'authority-ignored',
    message: 'do the analysis',
    conversationId: `team:${appId}:${OFFICE}:${EPOCH_ID}`,
    teamContext,
  }
}

describe('federation remote wake (position transparency)', () => {
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

  it('resolves with the owner-run final message after the wake round-trip', async () => {
    const runLocalTurn = vi.fn(async (_req: SerializedWakeRequest) => ({ finalMessage: 'done: 42' }))
    const { hostManager } = wireNodes(federationStore, teamStore, runLocalTurn)

    // Owner resolution reads the persisted remote member row (owner = NODE_B).
    const resolveOwnerNode = (appId: string) =>
      teamStore.listMembersByTeam(OFFICE).find((m) => m.appId === appId)?.ownerNodeId ?? SELF_NODE_ID

    const local: OrchestrationSessionDeps = {
      sendAppChatMessage: vi.fn(async () => ({ finalMessage: 'LOCAL-should-not-run' })),
      isSessionActive: () => false,
      closeTeamSession: async () => {},
      getMemberSpaceId: () => 'local-space',
    }

    const locationAware = makeLocationAwareSessionDeps({
      local,
      resolveOwnerNode,
      selfNodeId: NODE_A,
      sendWake: (p) => hostManager.sendWakeToMember(p),
      registerTurnComplete: (corr, cb) => hostManager.registerTurnComplete(corr, cb),
      getRemoteSpaceId: (appId) => hostManager.getRemoteMemberSpaceId(appId),
      resolveOfficeId: () => OFFICE,
    })

    const result = await locationAware.sendAppChatMessage(makeRequest(MEMBER_M))

    expect(result).toEqual({ finalMessage: 'done: 42' })
    expect(local.sendAppChatMessage).not.toHaveBeenCalled()
    expect(runLocalTurn).toHaveBeenCalledTimes(1)
    expect(runLocalTurn.mock.calls[0][0]).toMatchObject({
      appId: MEMBER_M,
      message: 'do the analysis',
      teamContext: expect.objectContaining({ correlationId: 'c1' }),
    })
  })

  it('marks a member remote-busy while its wake is in flight, and clears on turn-complete', async () => {
    // Deferred owner turn: the wake stays in flight until the test releases it.
    let releaseTurn: (v: { finalMessage: string | null }) => void = () => {}
    const runLocalTurn = vi.fn(
      () => new Promise<{ finalMessage: string | null }>((resolve) => { releaseTurn = resolve })
    )
    const { hostManager } = wireNodes(federationStore, teamStore, runLocalTurn)

    expect(hostManager.isMemberRemoteBusy(MEMBER_M)).toBe(false)

    const sent = hostManager.sendWakeToMember({
      officeId: OFFICE,
      ownerNodeId: NODE_B,
      correlationId: 'busy-1',
      request: makeRequest(MEMBER_M) as unknown as SerializedWakeRequest,
    })
    expect(sent).toBe(true)
    // In flight on the owner → the roster projection reads it as working.
    expect(hostManager.isMemberRemoteBusy(MEMBER_M)).toBe(true)

    releaseTurn({ finalMessage: 'done' })
    // The owner's turn-complete rides the (synchronous) fake transport back.
    await new Promise((r) => setTimeout(r, 0))
    expect(hostManager.isMemberRemoteBusy(MEMBER_M)).toBe(false)
  })

  it('delegates a SELF-owned member to the local impl with no wake sent', async () => {
    const runLocalTurn = vi.fn(async () => ({ finalMessage: 'remote' }))
    const { hostManager } = wireNodes(federationStore, teamStore, runLocalTurn)

    const sendWake = vi.fn(() => true)
    const local: OrchestrationSessionDeps = {
      sendAppChatMessage: vi.fn(async () => ({ finalMessage: 'local-final' })),
      isSessionActive: () => false,
      closeTeamSession: async () => {},
      getMemberSpaceId: () => 'local-space',
    }

    const locationAware = makeLocationAwareSessionDeps({
      local,
      resolveOwnerNode: () => SELF_NODE_ID,
      selfNodeId: NODE_A,
      sendWake,
      registerTurnComplete: (corr, cb) => hostManager.registerTurnComplete(corr, cb),
      getRemoteSpaceId: () => undefined,
      resolveOfficeId: () => OFFICE,
    })

    const result = await locationAware.sendAppChatMessage(makeRequest('app-local'))

    expect(result).toEqual({ finalMessage: 'local-final' })
    expect(local.sendAppChatMessage).toHaveBeenCalledTimes(1)
    expect(sendWake).not.toHaveBeenCalled()
    expect(runLocalTurn).not.toHaveBeenCalled()
  })

  it('getMemberSpaceId returns a non-null sentinel synchronously for a remote member', () => {
    const { hostManager } = wireNodes(federationStore, teamStore, async () => ({ finalMessage: 'x' }))
    const locationAware = makeLocationAwareSessionDeps({
      local: {
        sendAppChatMessage: async () => ({ finalMessage: null }),
        isSessionActive: () => false,
        closeTeamSession: async () => {},
        getMemberSpaceId: () => 'local-space',
      },
      resolveOwnerNode: () => NODE_B,
      selfNodeId: NODE_A,
      sendWake: () => true,
      registerTurnComplete: () => {},
      getRemoteSpaceId: (appId) => hostManager.getRemoteMemberSpaceId(appId),
      resolveOfficeId: () => OFFICE,
    })

    const spaceId = locationAware.getMemberSpaceId(MEMBER_M)
    expect(spaceId).toBe('space-b') // cached at join
    expect(spaceId).not.toBeNull()

    // Unknown remote member: still synchronous + non-null (falls back to appId).
    expect(locationAware.getMemberSpaceId('app-unknown')).toBe('app-unknown')
  })

  it('resolves empty (not rejected) when the owner is unreachable', async () => {
    const locationAware = makeLocationAwareSessionDeps({
      local: {
        sendAppChatMessage: async () => ({ finalMessage: null }),
        isSessionActive: () => false,
        closeTeamSession: async () => {},
        getMemberSpaceId: () => 'local-space',
      },
      resolveOwnerNode: () => NODE_B,
      selfNodeId: NODE_A,
      sendWake: () => false, // unreachable
      registerTurnComplete: () => {},
      getRemoteSpaceId: () => undefined,
      resolveOfficeId: () => OFFICE,
    })
    await expect(locationAware.sendAppChatMessage(makeRequest(MEMBER_M))).resolves.toEqual({
      finalMessage: null,
    })
  })
})

// A wake's request.spaceId is the SENDER's value; for a member the sender does
// not own it is the appId sentinel (getMemberSpaceId fallback). The OWNER runs
// the member locally and MUST substitute its own real space, else the turn
// persists under getSpace(appId) — which does not exist — and the transcript is
// silently never written (the root of "history-not-found" + a member's reply
// flashing then vanishing with no record on either side).

describe('owner-side wake: spaceId is re-resolved locally (not the wire sentinel)', () => {
  it('withOwnerResolvedSpace overrides the sentinel with the owner-resolved space', () => {
    const sentinel: SerializedWakeRequest = {
      appId: 'app-x',
      spaceId: 'app-x', // sentinel: equals the appId (sender does not own it)
      message: 'go',
      conversationId: 'team:app-x:office:epoch',
      teamContext: {
        teamId: 'office', epochId: 'epoch', correlationId: 'c', fromAppId: null, wait: true, kind: 'message',
      },
    }
    // Owner knows the member's real installed space.
    const resolved = withOwnerResolvedSpace(sentinel, (appId) => (appId === 'app-x' ? 'real-space' : null))
    expect(resolved.spaceId).toBe('real-space')
    // Everything else is preserved verbatim.
    expect(resolved.appId).toBe('app-x')
    expect(resolved.conversationId).toBe(sentinel.conversationId)
    expect(resolved.message).toBe('go')
  })

  it('keeps the wire value when this node does not own the member (graceful degrade)', () => {
    const req: SerializedWakeRequest = {
      appId: 'app-y',
      spaceId: 'whatever',
      message: 'go',
      conversationId: 'team:app-y:office:epoch',
      teamContext: {
        teamId: 'office', epochId: 'epoch', correlationId: 'c', fromAppId: null, wait: true, kind: 'message',
      },
    }
    const unchanged = withOwnerResolvedSpace(req, () => null) // not owned here
    expect(unchanged).toBe(req) // same reference: no copy, no mutation
  })

  it('end-to-end: the owner runs its member with the real space even when the wake carries the appId sentinel', async () => {
    const dbm = createDatabaseManager(':memory:')
    const db = dbm.getAppDatabase()
    dbm.runMigrations(db, FED_NS, fedMigrations)
    dbm.runMigrations(db, TEAM_NS, teamMigrations)
    const fed = new FederationStore(db)
    const team = new TeamStore(db)

    try {
      // The owner's local resolver: member M lives in 'space-b' (its installed space).
      const OWNED_SPACE = 'space-b'
      const resolveOwnSpaceId = (appId: string) => (appId === MEMBER_M ? OWNED_SPACE : null)

      // runLocalTurn mirrors the bootstrap wiring: apply withOwnerResolvedSpace
      // before running, and record the spaceId the member actually ran under.
      const ranWith: Array<{ spaceId: string; appId: string }> = []
      const runLocalTurn = vi.fn(async (req: SerializedWakeRequest) => {
        const resolved = withOwnerResolvedSpace(req, resolveOwnSpaceId)
        ranWith.push({ spaceId: resolved.spaceId, appId: resolved.appId })
        return { finalMessage: 'persisted-ok' }
      })

      const { hostManager } = wireNodes(fed, team, runLocalTurn)

      const resolveOwnerNode = (appId: string) =>
        team.listMembersByTeam(OFFICE).find((m) => m.appId === appId)?.ownerNodeId ?? SELF_NODE_ID

      const local: OrchestrationSessionDeps = {
        sendAppChatMessage: vi.fn(async () => ({ finalMessage: 'LOCAL-should-not-run' })),
        isSessionActive: () => false,
        closeTeamSession: async () => {},
        getMemberSpaceId: () => 'authority-local-space',
      }

      const locationAware = makeLocationAwareSessionDeps({
        local,
        resolveOwnerNode,
        selfNodeId: NODE_A,
        sendWake: (p) => hostManager.sendWakeToMember(p),
        registerTurnComplete: (corr, cb) => hostManager.registerTurnComplete(corr, cb),
        // Force the sentinel: the authority has NO cached remote space, so the wire
        // request.spaceId becomes the appId — exactly the production failure input.
        getRemoteSpaceId: () => undefined,
        resolveOfficeId: () => OFFICE,
      })

      const result = await locationAware.sendAppChatMessage(makeRequest(MEMBER_M))
      expect(result).toEqual({ finalMessage: 'persisted-ok' })

      // The wake carried the appId sentinel, but the owner ran with its REAL space.
      expect(ranWith).toHaveLength(1)
      expect(ranWith[0].appId).toBe(MEMBER_M)
      expect(ranWith[0].spaceId).toBe(OWNED_SPACE)
      expect(ranWith[0].spaceId).not.toBe(MEMBER_M) // never the sentinel
    } finally {
      dbm.closeAll()
    }
  })
})

const TEAM_ID = 'team-m1'
const M1_EPOCH = 'epoch-m1'
const M1_LEAD = 'app-lead'
const M1_MEMBER = 'app-member'

function seedTeam(store: TeamStore): void {
  const now = Date.now()
  const team: Team = {
    id: TEAM_ID,
    name: 'M1 Team',
    owningSpaceId: 'space-a',
    goal: 'g',
    leadAppId: M1_LEAD,
    memberSourcing: 'manual',
    collabMode: 'free',
    escalationRouting: 'user',
    status: 'running',
    currentEpochId: M1_EPOCH,
    createdAt: now,
    updatedAt: now,
  }
  store.insertTeam(team)
  const members: TeamMember[] = [
    { teamId: TEAM_ID, appId: M1_LEAD, memberName: 'lead', role: 'Lead', isLead: true, aiProvisioned: false, addedAt: now },
    { teamId: TEAM_ID, appId: M1_MEMBER, memberName: 'member', role: 'Worker', isLead: false, aiProvisioned: false, addedAt: now },
  ]
  for (const m of members) store.addMember(m)
  const epoch: TeamEpoch = { id: M1_EPOCH, teamId: TEAM_ID, startedAt: now, endedAt: null, endReason: null, summary: null, lifecycle: 'run' }
  store.insertEpoch(epoch)
}

describe('message-bus M-1: resolvePendingWaitsForMember', () => {
  let dbManager: DatabaseManager
  let store: TeamStore

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, TEAM_NS, teamMigrations)
    store = new TeamStore(db)
    seedTeam(store)
    broadcastToAll.mockClear()
    sendToRenderer.mockClear()
  })

  afterEach(() => {
    dbManager.closeAll()
  })

  function makeHooks(): TeamDeliveryHooks {
    return {
      // Never completes: simulates a turn whose member then goes offline.
      wakeTarget: vi.fn(async () => {}),
      isBusy: () => false,
    }
  }

  it('unblocks a wait=true sender immediately with status=timeout + a reassign hint', async () => {
    const bus = createMessageBus({ store, hooks: makeHooks() })

    const pending = bus.send({
      teamId: TEAM_ID,
      epochId: M1_EPOCH,
      fromAppId: M1_LEAD,
      to: 'member',
      message: 'do it',
      wait: true,
    })
    await Promise.resolve() // let deliver register the waiter

    const resolvedCount = bus.resolvePendingWaitsForMember(M1_MEMBER, { kind: 'timeout' })
    expect(resolvedCount).toBe(1)

    const result = await pending
    expect(result.status).toBe('timeout')
    expect(result.from).toBe('member')
    expect(result.message).toMatch(/unavailable/i)

    // Idempotent: a second pass resolves nothing.
    expect(bus.resolvePendingWaitsForMember(M1_MEMBER, { kind: 'timeout' })).toBe(0)
  })

  it('resolves nothing for an unrelated member', async () => {
    const bus = createMessageBus({ store, hooks: makeHooks() })

    const pending = bus.send({
      teamId: TEAM_ID,
      epochId: M1_EPOCH,
      fromAppId: M1_LEAD,
      to: 'member',
      message: 'do it',
      wait: true,
    })
    await Promise.resolve()

    expect(bus.resolvePendingWaitsForMember('app-someone-else', { kind: 'timeout' })).toBe(0)

    // The original waiter is still pending; complete it to avoid a dangling timer.
    bus.resolvePendingWaitsForMember(M1_MEMBER, { kind: 'timeout' })
    await pending
  })
})
