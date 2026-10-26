/**
 * Taking one digital human out of a joined team, end to end over a REAL `ws`
 * transport between a host and a joiner on this build (the wiring of
 * governance-egress-ws.test.ts).
 *
 * The host removes exactly the member it is asked to and keeps this computer in
 * its office, because it still has other members there; both rosters converge on
 * the rest. Leaving afterwards takes the rest and this computer out. A member
 * that left stays out when the host later asks this computer to join again
 * (its own presence FSM, unscripted), and its kept duty waits for a real rejoin.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import http from 'http'
import path from 'path'

function testHome(): string {
  return globalThis.__HALO_TEST_DIR__ || '/tmp/halo-test-fallback'
}

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: (name: string) => {
      const dir = testHome()
      if (name === 'userData') return path.join(dir, '.halo')
      return dir
    },
    getAppPath: () => path.join(testHome(), 'app'),
    getName: () => 'Halo',
    getVersion: () => '1.0.0-test',
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}))

import { createDatabaseManager } from '../../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../../src/main/platform/store/types'
import { initFederationStore, shutdownFederationStore } from '../../../../../src/main/apps/federation/index'
import type { FederationStore } from '../../../../../src/main/apps/federation/store'
import { FederationStore as JoinerFederationStore } from '../../../../../src/main/apps/federation/store'
import {
  MIGRATION_NAMESPACE as FED_NS,
  migrations as fedMigrations,
} from '../../../../../src/main/apps/federation/migrations'
import { TeamStore } from '../../../../../src/main/apps/team/store'
import {
  MIGRATION_NAMESPACE as TEAM_NS,
  migrations as teamMigrations,
} from '../../../../../src/main/apps/team/migrations'
import { initIdentity, getLocalIdentity } from '../../../../../src/main/http/identity/index'
import { issueOfficeCredential, verifyOfficeCredential } from '../../../../../src/main/http/auth/office-credential'
import {
  initWebSocket,
  shutdownWebSocket,
  setFederationInbound,
  sendFederationFrameToClient,
  listOfficeClientIds,
} from '../../../../../src/main/http/websocket'
import { createFederationManager } from '../../../../../src/main/apps/runtime/federation/manager'
import type { FederationManager } from '../../../../../src/main/apps/runtime/federation/manager'
import { localAuthProof } from './_ws-auth'

const OFFICE = 'office-withdraw-ws'
const JOINER = 'joiner-node-b'
const LEAD = 'app-host-lead'
const A = 'app-ws-writer'
const B = 'app-ws-tester'
const C = 'app-ws-reviewer'
const DUTY = 'You test every build.'

async function waitFor(predicate: () => boolean, budgetMs = 4000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  expect(predicate()).toBe(true)
}

describe('taking one digital human out of a joined team (real ws, both sides on this build)', () => {
  let dbManager: DatabaseManager
  let joinerDbManager: DatabaseManager
  let hostTeamStore: TeamStore
  let joinerTeamStore: TeamStore
  let hostFederationStore: FederationStore
  let joinerFederationStore: JoinerFederationStore
  let server: http.Server
  let hostManager: FederationManager
  let joinerManager: FederationManager
  let port: number
  let token: string
  let restored: string[]
  let removedRemote: Array<{ appId: string; ownMember: boolean }>

  beforeEach(async () => {
    initIdentity()

    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, TEAM_NS, teamMigrations)
    hostFederationStore = initFederationStore({ db: dbManager })
    hostTeamStore = new TeamStore(db)
    const now = Date.now()
    hostTeamStore.insertTeam({
      id: OFFICE, name: 'Release', owningSpaceId: 'space-host', goal: 'Ship', leadAppId: LEAD,
      memberSourcing: 'manual', collabMode: 'free', escalationRouting: 'user', status: 'idle',
      currentEpochId: null, createdAt: now, updatedAt: now,
    })
    hostTeamStore.addMember({ teamId: OFFICE, appId: LEAD, memberName: 'lead', role: 'Lead', isLead: true, aiProvisioned: false, addedAt: now })

    joinerDbManager = createDatabaseManager(':memory:')
    const joinerDb = joinerDbManager.getAppDatabase()
    joinerDbManager.runMigrations(joinerDb, TEAM_NS, teamMigrations)
    joinerDbManager.runMigrations(joinerDb, FED_NS, fedMigrations)
    joinerTeamStore = new TeamStore(joinerDb)
    joinerFederationStore = new JoinerFederationStore(joinerDb)

    // As the product mints them: no expiry (TeamInviteDialog → generateTeamInvite).
    token = issueOfficeCredential({ officeId: OFFICE, identity: getLocalIdentity().id }).token

    server = http.createServer()
    initWebSocket(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port

    hostManager = createFederationManager({
      hostSend: (clientId, frame) => sendFederationFrameToClient(clientId, frame),
      hostListOfficeClients: (officeId) => listOfficeClientIds(officeId),
      federationStore: hostFederationStore,
      teamStore: hostTeamStore,
      verifyCredential: (t) => verifyOfficeCredential(t),
      getLocalNodeId: () => getLocalIdentity().id,
      // Bootstrap's path: the team service removes each member, which projects
      // the removal and re-broadcasts the roster.
      onMemberLeft: (officeId, appIds) => {
        for (const appId of appIds) {
          hostTeamStore.removeMember(officeId, appId)
          hostManager.projectMemberRemoved(officeId, appId)
        }
        hostManager.broadcastRosterFor(officeId)
      },
    })
    hostManager.hostOffice(OFFICE)
    setFederationInbound((ctx) => hostManager.handleHostInbound(ctx))

    restored = []
    removedRemote = []
    joinerManager = createFederationManager({
      hostSend: () => false,
      hostListOfficeClients: () => [],
      federationStore: joinerFederationStore,
      teamStore: joinerTeamStore,
      verifyCredential: () => null,
      getLocalNodeId: () => JOINER,
      makeAuthProof: (nonce) => localAuthProof(nonce),
      onDutiesRestored: (_officeId, appIds) => restored.push(...appIds),
      onMemberRemovedRemote: (_officeId, appId, ownMember) => removedRemote.push({ appId, ownMember }),
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    joinerManager?.stopAll()
    hostManager?.stopAll()
    setFederationInbound(null)
    shutdownWebSocket()
    server?.close()
    shutdownFederationStore()
    dbManager.closeAll()
    joinerDbManager.closeAll()
  })

  const memberIds = (store: TeamStore) => store.listMembersByTeam(OFFICE).map((m) => m.appId).sort()
  const record = () => joinerFederationStore.listJoinedOfficeConnections().find((c) => c.officeId === OFFICE)

  async function joinWith(appIds: string[], expectMembers = appIds.length + 1) {
    const result = await joinerManager.joinOffice({
      officeId: OFFICE,
      serverUrl: `http://127.0.0.1:${port}`,
      credentialToken: token,
      selfContext: { officeId: OFFICE, selfNodeId: JOINER },
      bringMembers: appIds.map((appId) => ({ appId, memberName: appId, role: '', spaceId: `space-${appId}` })),
    })
    expect(result.ok).toBe(true)
    await waitFor(() => memberIds(joinerTeamStore).length === expectMembers)
  }

  /**
   * The host's own presence FSM confirms the joiner offline after 20 s of
   * silence on its monotonic clock (a laptop asleep with the TCP session alive);
   * the joiner's next heartbeat makes it ask for a rejoin, which the joiner
   * answers with its remembered join-request. Resolves once it was admitted.
   */
  async function hostAsksForRejoin() {
    const realNow = performance.now.bind(performance)
    vi.spyOn(performance, 'now').mockImplementation(() => realNow() + 20_000)
    hostManager.getOffice(OFFICE)!.coordinator.sweepPresence()
    expect(hostFederationStore.getNode(OFFICE, JOINER)?.status).toBe('offline')
    await waitFor(() => hostFederationStore.getNode(OFFICE, JOINER)?.status === 'online', 8000)
    // Let the roster that follows the admission settle on the joiner.
    await new Promise((r) => setTimeout(r, 300))
  }

  it('the host removes only that member and keeps this computer in the team', async () => {
    await joinWith([A, B, C])
    expect(memberIds(hostTeamStore)).toEqual([A, B, C, LEAD].sort())

    expect(joinerManager.withdrawMembers(OFFICE, [B])).toBe('sent')

    await waitFor(() => !memberIds(hostTeamStore).includes(B))
    expect(memberIds(hostTeamStore)).toEqual([A, C, LEAD].sort())
    // Still a member of the office: its other digital humans are there.
    expect(hostFederationStore.getNode(OFFICE, JOINER)).not.toBeNull()
    await waitFor(() => !memberIds(joinerTeamStore).includes(B))
    expect(memberIds(joinerTeamStore)).toEqual([A, C, LEAD].sort())
    expect(joinerManager.listJoinedOffices()).toContain(OFFICE)
  })

  it('leaving afterwards takes the rest out, and this computer with them', async () => {
    await joinWith([A, B, C])
    joinerManager.withdrawMembers(OFFICE, [B])
    await waitFor(() => !memberIds(hostTeamStore).includes(B))

    joinerManager.signalLeave(OFFICE)

    await waitFor(() => memberIds(hostTeamStore).length === 1)
    expect(memberIds(hostTeamStore)).toEqual([LEAD])
    expect(hostFederationStore.getNode(OFFICE, JOINER)).toBeNull()
  })

  it('a member taken out stays out when the host asks this computer to rejoin, and its duty waits for a real rejoin', async () => {
    await joinWith([A, B, C])
    // What leaveTeamOffice keeps for it.
    joinerTeamStore.retainMemberDuties(OFFICE, [{ appId: B, duty: DUTY }])
    expect(joinerManager.withdrawMembers(OFFICE, [B])).toBe('sent')
    await waitFor(() => !memberIds(hostTeamStore).includes(B) && !memberIds(joinerTeamStore).includes(B))

    await hostAsksForRejoin()

    expect(memberIds(hostTeamStore)).toEqual([A, C, LEAD].sort())
    expect(memberIds(joinerTeamStore)).toEqual([A, C, LEAD].sort())
    expect(record()?.bringAppIds.sort()).toEqual([A, C].sort())
    expect(restored).toEqual([])

    // Joining with B again on purpose gives it its duty back.
    await joinWith([B], 4)
    expect(joinerTeamStore.getMember(OFFICE, B)?.duty).toBe(DUTY)
    expect(restored).toEqual([B])
  }, 30_000)

  it('a member the host removed stays out when the host asks this computer to rejoin', async () => {
    await joinWith([A, B, C])
    hostTeamStore.removeMember(OFFICE, B)
    hostManager.projectMemberRemoved(OFFICE, B)
    hostManager.broadcastRosterFor(OFFICE)
    await waitFor(() => !memberIds(joinerTeamStore).includes(B))
    expect(record()?.bringAppIds.sort()).toEqual([A, C].sort())

    await hostAsksForRejoin()

    expect(memberIds(hostTeamStore)).toEqual([A, C, LEAD].sort())
    expect(memberIds(joinerTeamStore)).toEqual([A, C, LEAD].sort())
  }, 30_000)

  it('taking out a second one before the office answered the first is leaving: the host keeps this computer and the second', async () => {
    await joinWith([A, B])
    expect(joinerManager.withdrawMembers(OFFICE, [A])).toBe('sent')
    expect(joinerManager.withdrawMembers(OFFICE, [B])).toBe('last-members')

    await waitFor(() => !memberIds(hostTeamStore).includes(A))
    await waitFor(() => !memberIds(joinerTeamStore).includes(A))
    expect(memberIds(hostTeamStore)).toEqual([B, LEAD].sort())
    expect(hostFederationStore.getNode(OFFICE, JOINER)).not.toBeNull()
    // A's removal is the one this computer asked for, not a kick.
    expect(removedRemote).toEqual([{ appId: A, ownMember: false }])
    expect(record()?.bringAppIds).toEqual([B])
  }, 30_000)
})
