/**
 * Unit tests for apps/runtime/federation -- FederationManager (host role).
 *
 * Two in-process nodes wired by FAKE transports that simulate the WS hop without
 * real sockets (deterministic, timer-free):
 *   - A is the HOST. Its injected hostSend(clientId, frame) pushes into B's
 *     joiner link inbound; hostListOfficeClients returns B's clientId.
 *   - B is the JOINER, driven through a coordinator over a LanMeshLink whose
 *     outbound send pushes into A.handleHostInbound (simulating B's outbound WS
 *     client). This exercises A's manager end-to-end (hostOffice, nodeId↔clientId
 *     learning, link resolution) while staying fully synchronous.
 *
 * The real WsFederationClient + real `ws` socket path is covered separately in
 * manager-ws.test.ts; here the network hop is faked so the host-side manager
 * logic is the unit under test.
 *
 * Proven: B's join → A persists office_nodes(B online) + remote team_members
 * (origin=remote, owner_node_id=B, identity) and B receives a join-grant;
 * a bad credential → join-reject with a reason and no persistence; remote member
 * spaceId is cached on the host for later wake addressing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
import type {
  FederationMessage,
  JoinRequest,
  OfficeCredentialLike,
} from '../../../../../src/main/apps/runtime/federation'

const OFFICE = 'office-1'
const NODE_A = 'node-a-host'
const NODE_B = 'node-b-joiner'
const B_CLIENT_ID = 'ws-client-b'
const VALID_TOKEN = 'valid-token'

function makeStores(db: ReturnType<DatabaseManager['getAppDatabase']>) {
  return { federationStore: new FederationStore(db), teamStore: new TeamStore(db) }
}

describe('FederationManager (host role, faked WS hop)', () => {
  let dbManager: DatabaseManager
  let federationStore: FederationStore
  let teamStore: TeamStore

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, FED_NS, fedMigrations)
    dbManager.runMigrations(db, TEAM_NS, teamMigrations)
    const stores = makeStores(db)
    federationStore = stores.federationStore
    teamStore = stores.teamStore
  })

  afterEach(() => {
    dbManager.closeAll()
  })

  /**
   * Wire host A + a joiner B. A's hostSend delivers into B's joiner link; B's
   * joiner link send delivers into A.handleHostInbound. Returns handles to drive
   * a join and observe what B received.
   */
  function wireTwoNodes(opts?: { verify?: (token: string) => OfficeCredentialLike | null }) {
    const verify =
      opts?.verify ?? ((token: string) => (token === VALID_TOKEN ? { officeId: OFFICE } : null))

    // B's inbound frames (host → joiner), captured for assertions.
    const bReceived: FederationMessage[] = []

    // B's joiner link: outbound send simulates B's WS client sending to A.
    const bLink = new LanMeshLink((_to, frame) => {
      hostManager.handleHostInbound({ clientId: B_CLIENT_ID, officeId: OFFICE, frame })
    })

    const hostManager = createFederationManager({
      hostSend: (clientId, frame) => {
        if (clientId !== B_CLIENT_ID) return false
        bReceived.push(frame)
        // Simulate the frame arriving on B's outbound client → B's link inbound.
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

    return { hostManager, bLink, bReceived, verify }
  }

  /** Build B's joiner coordinator over bLink and request a join. */
  function joinFromB(
    bLink: LanMeshLink,
    req: Partial<JoinRequest> = {},
    handlers: {
      onGrant?: () => void
      onReject?: (reason: string) => void
    } = {}
  ) {
    const fed = createFederation({
      context: { officeId: OFFICE, selfNodeId: NODE_B },
      link: bLink,
      federationStore,
      teamStore,
      verifyCredential: () => null, // joiner never verifies; host does
      onJoinGrant: () => handlers.onGrant?.(),
      onJoinReject: (reason) => handlers.onReject?.(reason),
    })
    fed.coordinator.start()
    const request: JoinRequest = {
      kind: 'join-request',
      officeId: OFFICE,
      fromNode: NODE_B,
      identityId: 'identity-b',
      displayName: 'Node B',
      credentialToken: VALID_TOKEN,
      bringMembers: [
        { appId: 'app-b-1', memberName: 'b-analyst', role: 'Analyst', spaceId: 'space-b-1' },
      ],
      ...req,
    }
    fed.coordinator.requestJoin(request)
    return fed
  }

  it('admits B: host persists node + remote member, B gets a join-grant', () => {
    const { hostManager, bLink } = wireTwoNodes()
    const onGrant = vi.fn()
    joinFromB(bLink, {}, { onGrant })

    const node = federationStore.getNode(OFFICE, NODE_B)!
    expect(node).toBeTruthy()
    expect(node.status).toBe('online')
    expect(node.identity).toBe('identity-b')
    expect(node.officeId).toBe(OFFICE)

    const members = teamStore.listMembersByTeam(OFFICE)
    expect(members).toHaveLength(1)
    expect(members[0]).toMatchObject({
      appId: 'app-b-1',
      memberName: 'b-analyst',
      role: 'Analyst',
      ownerNodeId: NODE_B,
      origin: 'remote',
      memberIdentity: 'identity-b',
    })

    expect(onGrant).toHaveBeenCalledTimes(1)

    // Host learned the nodeId → clientId binding (proves host send can resolve).
    expect(hostManager.listHostedOffices()).toEqual([OFFICE])
  })

  it('caches the remote member spaceId on the host for later wake addressing', () => {
    const { hostManager, bLink } = wireTwoNodes()
    joinFromB(bLink)
    expect(hostManager.getRemoteMemberSpaceId('app-b-1')).toBe('space-b-1')
  })

  it('host send to a learned node resolves to its client id', () => {
    const { hostManager, bLink, bReceived } = wireTwoNodes()
    joinFromB(bLink)
    bReceived.length = 0

    // After join, the host coordinator's link can address B by nodeId; a
    // heartbeat sweep or presence send would route through hostSend(clientId).
    const office = hostManager.getOffice(OFFICE)!
    office.link.send(NODE_B, { kind: 'heartbeat', officeId: OFFICE, fromNode: NODE_A, ts: 1 })
    expect(bReceived).toHaveLength(1)
    expect(bReceived[0]).toMatchObject({ kind: 'heartbeat', fromNode: NODE_A })
  })

  it('rejects a bad credential with a reason and persists nothing', () => {
    const { bLink } = wireTwoNodes()
    const onReject = vi.fn()
    const onGrant = vi.fn()
    joinFromB(bLink, { credentialToken: 'forged' }, { onGrant, onReject })

    expect(onReject).toHaveBeenCalledWith('CREDENTIAL_INVALID')
    expect(onGrant).not.toHaveBeenCalled()
    expect(federationStore.getNode(OFFICE, NODE_B)).toBeNull()
    expect(teamStore.listMembersByTeam(OFFICE)).toHaveLength(0)
  })

  it('drops an inbound frame for an unhosted office without throwing', () => {
    const { hostManager } = wireTwoNodes()
    expect(() =>
      hostManager.handleHostInbound({
        clientId: 'x',
        officeId: 'unknown-office',
        frame: { kind: 'heartbeat', officeId: 'unknown-office', fromNode: 'ghost', ts: 1 },
      })
    ).not.toThrow()
  })

  it('leaveOffice tears down the hosted office', () => {
    const { hostManager, bLink } = wireTwoNodes()
    joinFromB(bLink)
    expect(hostManager.listHostedOffices()).toEqual([OFFICE])
    hostManager.leaveOffice(OFFICE)
    expect(hostManager.listHostedOffices()).toEqual([])
    expect(hostManager.getOffice(OFFICE)).toBeNull()
  })
})
