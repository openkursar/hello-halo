/**
 * Regression: a `stop-turn` frame must survive the MANAGER's inbound path.
 *
 * The authority-level suite (authority/owner-served-stop) proves the stop plane
 * itself by handing frames straight to two OfficeAuthority instances — which is
 * exactly why it could not see this: before reaching an authority, every inbound
 * frame is attributed to a source node, and a kind the manager cannot attribute
 * is dropped with a warning. A frame pair can therefore be a valid M2 kind, be
 * dispatched correctly by the authority, and still never arrive.
 *
 * That is what happened: `stop-turn-request` / `stop-turn-response` were
 * registered as M2 kinds but not as kinds carrying their own `fromNode`, so a
 * remote stop reached the wire and died at the door — the button appeared to do
 * nothing and timed out ~6s later, the very symptom the feature exists to fix.
 *
 * So this suite drives the real manager: a host that OWNS a member receives a
 * joiner's stop over `handleHostInbound` and must both run the abort and answer.
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
import { AuthorityStore } from '../../../../../src/main/apps/federation/authority-store'
import {
  MIGRATION_NAMESPACE as FED_NS,
  migrations as fedMigrations,
} from '../../../../../src/main/apps/federation/migrations'
import { TeamStore } from '../../../../../src/main/apps/team/store'
import {
  MIGRATION_NAMESPACE as TEAM_NS,
  migrations as teamMigrations,
} from '../../../../../src/main/apps/team/migrations'
import { createFederationManager, type FederationManager } from '../../../../../src/main/apps/runtime/federation/manager'
import { SELF_NODE_ID } from '../../../../../src/shared/apps/team-types'
import type {
  FederationMessage,
  JoinRequest,
  OfficeCredentialLike,
} from '../../../../../src/main/apps/runtime/federation'
import type { StopTurnRequestFrame } from '../../../../../src/main/apps/runtime/federation/protocol-m2'
import type { TeamMember } from '../../../../../src/main/apps/team/types'

const OFFICE = 'office-stop-inbound'
const HOST_NODE = 'node-host'
const JOINER_NODE = 'node-joiner'
const JOINER_CLIENT = 'ws-client-joiner'
const VALID_TOKEN = 'valid-token'
const HOST_MEMBER = 'app-host-member'
const EPOCH = 'epoch-1'

describe('stop-turn frames survive the manager inbound path', () => {
  let dbManager: DatabaseManager
  let federationStore: FederationStore
  let authorityStore: AuthorityStore
  let teamStore: TeamStore
  let manager: FederationManager | null = null
  let outbound: Array<{ clientId: string; frame: FederationMessage }>
  /** Every abort the host's owner-side hook was asked to perform. */
  let aborts: Array<{ teamId: string; appId: string; epochId: string; requester: string }>

  beforeEach(() => {
    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, FED_NS, fedMigrations)
    dbManager.runMigrations(db, TEAM_NS, teamMigrations)
    federationStore = new FederationStore(db)
    authorityStore = new AuthorityStore(db)
    teamStore = new TeamStore(db)
    outbound = []
    aborts = []
    broadcastToAll.mockClear()
    sendToRenderer.mockClear()
  })

  afterEach(() => {
    manager?.stopAll()
    manager = null
    dbManager.closeAll()
  })

  /**
   * Host an office that OWNS `HOST_MEMBER`, then let the joiner in so the host
   * learns its return path (a join-request is the frame that binds node→client).
   * `stopped` is what the injected aborter reports.
   */
  function hostWithJoiner(stopped = true): FederationManager {
    const member: TeamMember = {
      teamId: OFFICE,
      appId: HOST_MEMBER,
      memberName: 'host-member',
      role: 'Worker',
      isLead: false,
      aiProvisioned: false,
      addedAt: 1,
      ownerNodeId: SELF_NODE_ID,
      origin: 'local',
      memberIdentity: HOST_MEMBER,
      scopeJson: null,
    }
    teamStore.addMember(member)

    const created = createFederationManager({
      hostSend: (clientId, frame) => {
        outbound.push({ clientId, frame })
        return true
      },
      hostListOfficeClients: () => [JOINER_CLIENT],
      federationStore,
      // The stop plane lives on the office authority, and the authority is only
      // assembled when this store is injected — without it the office runs M1b
      // and every M2 frame is dropped before any plane sees it.
      authorityStore,
      teamStore,
      verifyCredential: (token) =>
        token === VALID_TOKEN ? ({ officeId: OFFICE } as OfficeCredentialLike) : null,
      getLocalNodeId: () => HOST_NODE,
      stopMemberTurn: async ({ teamId, appId, epochId, requester }) => {
        aborts.push({ teamId, appId, epochId, requester: requester.nodeId })
        return stopped
      },
    })
    created.hostOffice(OFFICE)

    const join: JoinRequest = {
      kind: 'join-request',
      officeId: OFFICE,
      fromNode: JOINER_NODE,
      identityId: 'identity-joiner',
      displayName: 'Joiner',
      credentialToken: VALID_TOKEN,
      bringMembers: [],
    }
    created.handleHostInbound({ clientId: JOINER_CLIENT, officeId: OFFICE, frame: join })

    manager = created
    return created
  }

  function stopFrame(overrides: Partial<StopTurnRequestFrame> = {}): StopTurnRequestFrame {
    return {
      kind: 'stop-turn-request',
      officeId: OFFICE,
      fromNode: JOINER_NODE,
      teamId: OFFICE,
      appId: HOST_MEMBER,
      epochId: EPOCH,
      fid: 'fid-stop-1',
      ...overrides,
    }
  }

  it('a joiner\u2019s stop reaches the owner\u2019s aborter and is answered', async () => {
    const host = hostWithJoiner(true)

    host.handleHostInbound({ clientId: JOINER_CLIENT, officeId: OFFICE, frame: stopFrame() })
    await Promise.resolve()
    await Promise.resolve()

    // Reached the abort: the frame was attributed, delivered, and authorized.
    expect(aborts).toEqual([
      { teamId: OFFICE, appId: HOST_MEMBER, epochId: EPOCH, requester: JOINER_NODE },
    ])

    // …and answered on the same link, addressed back to the joiner. Without the
    // reply the requester learns nothing and waits out its own deadline, which
    // is indistinguishable from a dead button.
    const response = outbound.find((o) => o.frame.kind === 'stop-turn-response')
    expect(response).toBeDefined()
    expect(response!.clientId).toBe(JOINER_CLIENT)
    expect(response!.frame).toMatchObject({
      reFid: 'fid-stop-1',
      appId: HOST_MEMBER,
      epochId: EPOCH,
      stopped: true,
    })
  })

  it('reports "nothing was running" back over the wire as an answer, not an error', async () => {
    const host = hostWithJoiner(false)

    host.handleHostInbound({ clientId: JOINER_CLIENT, officeId: OFFICE, frame: stopFrame() })
    await Promise.resolve()
    await Promise.resolve()

    const response = outbound.find((o) => o.frame.kind === 'stop-turn-response')
    expect(response!.frame).toMatchObject({ stopped: false })
    expect(response!.frame).not.toHaveProperty('error')
  })

  it('a stop for a member this host does not own is refused, not aborted', async () => {
    const host = hostWithJoiner(true)

    host.handleHostInbound({
      clientId: JOINER_CLIENT,
      officeId: OFFICE,
      frame: stopFrame({ appId: 'app-not-here', fid: 'fid-stop-2' }),
    })
    await Promise.resolve()

    expect(aborts).toHaveLength(0)
    const response = outbound.find(
      (o) => o.frame.kind === 'stop-turn-response' && (o.frame as { reFid?: string }).reFid === 'fid-stop-2'
    )
    expect(response!.frame).toMatchObject({ error: 'stop-not-owned' })
  })

  it('a stop naming another office is not acted on', async () => {
    const host = hostWithJoiner(true)

    // officeId mismatch is rejected at the manager's door, before any plane sees
    // it — the envelope check that keeps offices from addressing each other.
    host.handleHostInbound({
      clientId: JOINER_CLIENT,
      officeId: OFFICE,
      frame: stopFrame({ officeId: 'other-office', fid: 'fid-stop-3' }),
    })
    await Promise.resolve()

    expect(aborts).toHaveLength(0)
  })
})
