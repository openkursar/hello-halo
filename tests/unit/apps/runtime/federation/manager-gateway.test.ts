/**
 * Unit tests for apps/runtime/federation -- FederationManager gateway routing.
 *
 * The host manager attaches to a fake gateway (real `ws` server) and the tests
 * prove the host-side routing rules the relay adds on top of the LAN path:
 *   - a gateway-relayed join is admitted and the grant rides back ADDRESSED
 *     through the gateway (nodeToGateway learned from the inbound frame);
 *   - unicast prefers a direct client mapping and falls back to the gateway;
 *   - broadcast fans out to BOTH local clients and the gateway (to: null);
 *   - a member-leave from a gateway node drives gw:evict.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
import {
  createFederationManager,
  type FederationManager,
} from '../../../../../src/main/apps/runtime/federation/manager'
import type {
  FederationMessage,
  SerializedWakeRequest,
} from '../../../../../src/main/apps/runtime/federation/types'
import { startFakeGateway, waitFor, type FakeGateway } from './_fake-gateway'

const OFFICE = 'office-gwm-1'
const NODE_A = 'node-a-host'
const NODE_B = 'node-b-relayed'
const NODE_C = 'node-c-lan'
const C_CLIENT_ID = 'ws-client-c'
const VALID_TOKEN = 'valid-token'

function heartbeat(fromNode: string): FederationMessage {
  return { kind: 'heartbeat', officeId: OFFICE, fromNode, ts: Date.now() } as FederationMessage
}

describe('FederationManager gateway routing (fake gateway over real ws)', () => {
  let dbManager: DatabaseManager
  let federationStore: FederationStore
  let teamStore: TeamStore
  let gateway: FakeGateway
  let manager: FederationManager
  let localSent: Array<{ clientId: string; frame: FederationMessage }>

  beforeEach(async () => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, FED_NS, fedMigrations)
    dbManager.runMigrations(db, TEAM_NS, teamMigrations)
    federationStore = new FederationStore(db)
    teamStore = new TeamStore(db)

    gateway = await startFakeGateway()
    localSent = []

    manager = createFederationManager({
      hostSend: (clientId, frame) => {
        localSent.push({ clientId, frame })
        return clientId === C_CLIENT_ID
      },
      hostListOfficeClients: () => [C_CLIENT_ID],
      federationStore,
      teamStore,
      verifyCredential: (token) => (token === VALID_TOKEN ? { officeId: OFFICE } : null),
      getLocalNodeId: () => NODE_A,
      getGatewayUrl: () => gateway.url,
      makeAuthProof: (nonce) => ({ method: 'device-key', identityId: NODE_A, challenge: nonce }),
    })
    manager.hostOffice(OFFICE)
    await waitFor(() => gateway.attachCount() >= 1)
  })

  afterEach(async () => {
    manager.stopAll()
    await gateway.close()
    dbManager.closeAll()
  })

  function relayJoinFromB(): void {
    gateway.relayToHost({
      kind: 'join-request',
      officeId: OFFICE,
      fromNode: NODE_B,
      identityId: 'identity-b',
      displayName: 'Node B',
      credentialToken: VALID_TOKEN,
      bringMembers: [
        { appId: 'app-b-1', memberName: 'b-writer', role: 'Writer', spaceId: 'space-b-1' },
      ],
    })
  }

  it('admits a gateway-relayed join and answers with an ADDRESSED grant through the gateway', async () => {
    relayJoinFromB()
    await waitFor(() =>
      gateway.hostFrames.some((f) => (f.payload as { kind?: string }).kind === 'join-grant')
    )

    const grant = gateway.hostFrames.find(
      (f) => (f.payload as { kind?: string }).kind === 'join-grant'
    )!
    expect(grant.to).toBe(NODE_B)

    const node = federationStore.getNode(OFFICE, NODE_B)!
    expect(node.status).toBe('online')
    const members = teamStore.listMembersByTeam(OFFICE)
    expect(members).toHaveLength(1)
    expect(members[0]).toMatchObject({ appId: 'app-b-1', origin: 'remote', ownerNodeId: NODE_B })
  })

  it('attributes a relayed frame with no payload fromNode via the gateway-stamped `from`', async () => {
    // Admit B first so a turn-complete has a home.
    relayJoinFromB()
    await waitFor(() => federationStore.getNode(OFFICE, NODE_B) != null)

    // turn-complete carries no fromNode; only the envelope `from` identifies it.
    // Before the fix this was dropped ("without source node"); now it is routed.
    gateway.relayToHost(
      { kind: 'turn-complete', officeId: OFFICE, correlationId: 'no-corr', outcome: { kind: 'result', content: '' } },
      NODE_B
    )

    // The node's return path is learned as gateway-reachable from the stamped
    // origin — a subsequent unicast to it must ride the gateway, proving the
    // frame was attributed to NODE_B rather than discarded.
    await waitFor(() => manager.getOffice(OFFICE)!.link != null)
    const before = gateway.hostFrames.length
    manager.getOffice(OFFICE)!.link.send(NODE_B, heartbeat(NODE_A))
    await waitFor(() => gateway.hostFrames.length > before)
    expect(gateway.hostFrames.at(-1)!.to).toBe(NODE_B)
  })

  it('unicast prefers a direct client mapping and falls back to the gateway', async () => {
    // NODE_B is known via the gateway; NODE_C via a direct WS client.
    relayJoinFromB()
    await waitFor(() => federationStore.getNode(OFFICE, NODE_B) != null)
    manager.handleHostInbound({
      clientId: C_CLIENT_ID,
      officeId: OFFICE,
      frame: heartbeat(NODE_C),
    })

    const link = manager.getOffice(OFFICE)!.link
    const before = gateway.hostFrames.length
    localSent = []

    link.send(NODE_C, heartbeat(NODE_A))
    expect(localSent).toHaveLength(1)
    expect(localSent[0].clientId).toBe(C_CLIENT_ID)

    link.send(NODE_B, heartbeat(NODE_A))
    await waitFor(() => gateway.hostFrames.length > before)
    const relayed = gateway.hostFrames.at(-1)!
    expect(relayed.to).toBe(NODE_B)
    // The gateway leg did not double-send locally.
    expect(localSent).toHaveLength(1)
  })

  it('a direct client session supersedes the gateway path for the same node', async () => {
    relayJoinFromB()
    await waitFor(() => federationStore.getNode(OFFICE, NODE_B) != null)

    // NODE_B's frames start arriving on a direct client — the return path flips.
    manager.handleHostInbound({
      clientId: 'ws-client-b-direct',
      officeId: OFFICE,
      frame: heartbeat(NODE_B),
    })

    localSent = []
    manager.getOffice(OFFICE)!.link.send(NODE_B, heartbeat(NODE_A))
    expect(localSent).toHaveLength(1)
    expect(localSent[0].clientId).toBe('ws-client-b-direct')
  })

  it('broadcast fans out to local clients AND the gateway with to=null', async () => {
    const before = gateway.hostFrames.length
    localSent = []

    manager.getOffice(OFFICE)!.link.broadcast(heartbeat(NODE_A))

    expect(localSent).toHaveLength(1)
    expect(localSent[0].clientId).toBe(C_CLIENT_ID)
    await waitFor(() => gateway.hostFrames.length > before)
    expect(gateway.hostFrames.at(-1)!.to).toBeNull()
  })

  it('sendWakeToMember reaches an owner connected via the GATEWAY (no direct client mapping)', async () => {
    // NODE_B is admitted through the relay only — nodeToClient never learns it.
    relayJoinFromB()
    await waitFor(() => federationStore.getNode(OFFICE, NODE_B) != null)

    const before = gateway.hostFrames.length
    const sent = manager.sendWakeToMember({
      officeId: OFFICE,
      ownerNodeId: NODE_B,
      correlationId: 'wake-corr-1',
      request: {
        appId: 'app-b-1',
        spaceId: 'space-b-1',
        message: 'run it',
        conversationId: 'conv-1',
        teamContext: { teamId: OFFICE } as SerializedWakeRequest['teamContext'],
      },
    })

    // Pre-fix this returned false ("owner unreachable"): the reachability check
    // only consulted nodeToClient, blind to the gateway path.
    expect(sent).toBe(true)
    await waitFor(() => gateway.hostFrames.length > before)
    const wake = gateway.hostFrames.at(-1)!
    expect(wake.to).toBe(NODE_B)
    expect((wake.payload as { kind?: string }).kind).toBe('wake')
  })

  it('a member-leave from a gateway node evicts its gateway session', async () => {
    relayJoinFromB()
    await waitFor(() => teamStore.listMembersByTeam(OFFICE).length === 1)

    gateway.relayToHost({
      kind: 'member-leave',
      officeId: OFFICE,
      fromNode: NODE_B,
      appIds: ['app-b-1'],
    })

    await waitFor(() => gateway.evictions.length >= 1)
    expect(gateway.evictions[0]).toBe(NODE_B)
  })

  it('an office hosted BEFORE the gateway URL was configured attaches on the next hostOffice call', async () => {
    // Fresh manager whose gateway URL starts unset (simulates: user hosts an
    // office first, saves the gateway setting afterwards, then mints an invite).
    let configuredUrl: string | null = null
    const lateManager = createFederationManager({
      hostSend: () => true,
      hostListOfficeClients: () => [],
      federationStore,
      teamStore,
      verifyCredential: (token) => (token === VALID_TOKEN ? { officeId: 'office-late-gw' } : null),
      getLocalNodeId: () => NODE_A,
      getGatewayUrl: () => configuredUrl,
      makeAuthProof: (nonce) => ({ method: 'device-key', identityId: NODE_A, challenge: nonce }),
    })
    try {
      const attachesBefore = gateway.attachCount()
      lateManager.hostOffice('office-late-gw')
      // No URL yet → no attachment is opened.
      await new Promise((r) => setTimeout(r, 100))
      expect(gateway.attachCount()).toBe(attachesBefore)

      // The user saves the gateway setting; minting an invite re-invokes
      // hostOffice, which must heal the missing attachment.
      configuredUrl = gateway.url
      lateManager.hostOffice('office-late-gw')
      await waitFor(() => gateway.attachCount() > attachesBefore)
    } finally {
      lateManager.stopAll()
    }
  })

  it('joinOffice auth payload carries officeId (gateway sessions require it, §9.1)', async () => {
    const joinerOffice = 'office-joined-via-gw'
    const before = gateway.authPayloads.length

    // Fire the join; the fake gateway grants auth but never a join-grant, so we
    // only assert the handshake and let teardown reap the pending join.
    void manager.joinOffice({
      officeId: joinerOffice,
      serverUrl: gateway.url,
      credentialToken: 'opaque-invite-token',
      selfContext: { officeId: joinerOffice, selfNodeId: NODE_A },
      bringMembers: [{ appId: 'app-a-1', memberName: 'a-writer' }],
    })

    await waitFor(() => gateway.authPayloads.length > before)
    const payload = gateway.authPayloads[gateway.authPayloads.length - 1]
    expect(payload.federation).toBe(true)
    // The regression this guards: the joiner client MUST carry officeId — a
    // gateway cannot read it out of the (opaque) invite token like a LAN host.
    expect(payload.officeId).toBe(joinerOffice)

    manager.leaveOffice(joinerOffice)
  })
})
