/**
 * Host-edge identity binding: a frame's self-reported source node must match the
 * node id the credential handshake bound to THIS session. Without this an
 * already-admitted same-office member could forge ANOTHER node's id and spoof a
 * write/election/governance frame as that peer.
 *
 * The seam is FederationManager.handleHostInbound: when an injected
 * getSessionIdentity(clientId) returns a bound node id and the frame's resolved
 * source disagrees, the frame is dropped at the host edge — it never reaches the
 * office coordinator. This suite drives a real host manager over the deterministic
 * faked-WS hop (manager.test.ts wiring) and proves the drop by its ABSENCE of
 * effect:
 *   - a forged join-request (claims node id X while the session is bound to Y) is
 *     dropped: no office_nodes row, no remote team_member, no nodeId→client binding;
 *   - a frame whose fromNode MATCHES the bound session identity is admitted normally
 *     (the gate is identity-equality, not a blanket reject);
 *   - when no binding is available (getSessionIdentity returns null) the gate is
 *     inert — the frame is admitted (the host has not yet bound the session, so the
 *     first join-request is allowed to establish the binding upstream).
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
import { LanMeshLink } from '../../../../../src/main/apps/runtime/federation/lan-mesh-provider'
import { DEFAULT_OFFICE_SCOPE } from '../../../../../src/main/apps/federation/types'
import type { FederationMessage, JoinRequest, OfficeCredentialLike } from '../../../../../src/main/apps/runtime/federation'

const OFFICE = 'office-spoof'
const NODE_A = 'node-a-host'
const NODE_B = 'node-b-joiner'
const NODE_EVIL = 'node-evil-claimed'
const B_CLIENT_ID = 'ws-client-b'
const VALID_TOKEN = 'valid-token'

describe('AC-6 / F1 — host-edge fromNode anti-spoof (identity binding)', () => {
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
  })

  afterEach(() => {
    dbManager.closeAll()
  })

  /**
   * Host A over the faked WS hop. `sessionIdentity` is what getSessionIdentity
   * reports for B_CLIENT_ID (the node id the handshake bound to this session);
   * pass null to model "not yet bound".
   */
  function wireHost(sessionIdentity: string | null) {
    const verify =
      (token: string): OfficeCredentialLike | null =>
        token === VALID_TOKEN ? { officeId: OFFICE, scope: DEFAULT_OFFICE_SCOPE } : null

    const bReceived: FederationMessage[] = []
    // B's outbound link is unused here — we feed handleHostInbound directly so we
    // control the exact frame on the wire (a real client could never set a foreign
    // fromNode, but a malicious one could; the host must not trust it).
    const bLink = new LanMeshLink(() => {})

    const hostManager = createFederationManager({
      hostSend: (clientId, frame) => {
        if (clientId !== B_CLIENT_ID) return false
        bReceived.push(frame)
        bLink.deliver(NODE_A, frame)
        return true
      },
      hostListOfficeClients: () => [B_CLIENT_ID],
      federationStore,
      teamStore,
      verifyCredential: verify,
      getLocalNodeId: () => NODE_A,
      getSessionIdentity: vi.fn((clientId: string) => (clientId === B_CLIENT_ID ? sessionIdentity : null)),
    })
    hostManager.hostOffice(OFFICE)
    return { hostManager, bReceived }
  }

  function joinRequest(fromNode: string): JoinRequest {
    return {
      kind: 'join-request',
      officeId: OFFICE,
      fromNode,
      identityId: 'identity-b',
      displayName: 'Node B',
      credentialToken: VALID_TOKEN,
      bringMembers: [{ appId: 'app-b-1', memberName: 'b-analyst', role: 'Analyst', spaceId: 'space-b-1' }],
    }
  }

  it('drops a forged join-request whose fromNode disagrees with the bound session identity', () => {
    const { hostManager, bReceived } = wireHost(NODE_B)

    hostManager.handleHostInbound({
      clientId: B_CLIENT_ID,
      officeId: OFFICE,
      frame: joinRequest(NODE_EVIL),
    })

    expect(federationStore.getNode(NODE_EVIL)).toBeNull()
    expect(federationStore.getNode(NODE_B)).toBeNull()
    expect(teamStore.listMembersByTeam(OFFICE)).toHaveLength(0)
    expect(bReceived).toHaveLength(0)
  })

  it('admits a join-request whose fromNode MATCHES the bound session identity (gate is equality, not blanket reject)', () => {
    const { hostManager } = wireHost(NODE_B)

    hostManager.handleHostInbound({
      clientId: B_CLIENT_ID,
      officeId: OFFICE,
      frame: joinRequest(NODE_B),
    })

    const node = federationStore.getNode(NODE_B)
    expect(node).toBeTruthy()
    expect(node!.status).toBe('online')
    expect(teamStore.listMembersByTeam(OFFICE)).toHaveLength(1)
    expect(teamStore.listMembersByTeam(OFFICE)[0]).toMatchObject({
      appId: 'app-b-1',
      ownerNodeId: NODE_B,
      origin: 'remote',
    })
  })

  it('with no session binding (getSessionIdentity → null) the gate is inert and the first join-request is admitted', () => {
    const { hostManager } = wireHost(null)

    hostManager.handleHostInbound({
      clientId: B_CLIENT_ID,
      officeId: OFFICE,
      frame: joinRequest(NODE_B),
    })

    expect(federationStore.getNode(NODE_B)).toBeTruthy()
    expect(teamStore.listMembersByTeam(OFFICE)).toHaveLength(1)
  })

  it('drops a forged heartbeat (post-admission spoof of a peer node) without learning a binding', () => {
    const { hostManager } = wireHost(NODE_B)
    hostManager.handleHostInbound({ clientId: B_CLIENT_ID, officeId: OFFICE, frame: joinRequest(NODE_B) })
    expect(federationStore.getNode(NODE_B)).toBeTruthy()

    // Must be dropped: a heartbeat from an unknown node would otherwise refresh
    // presence or be learned as a peer binding.
    hostManager.handleHostInbound({
      clientId: B_CLIENT_ID,
      officeId: OFFICE,
      frame: { kind: 'heartbeat', officeId: OFFICE, fromNode: NODE_EVIL, ts: 1 } as FederationMessage,
    })

    expect(federationStore.getNode(NODE_EVIL)).toBeNull()
  })
})
