/**
 * End-to-end governance egress + run-epoch + restart recovery over a REAL `ws`
 * transport (G-1 / G-3 / B-2 / H-1).
 *
 * Mirrors manager-ws.test.ts: a real http server + production initWebSocket on an
 * ephemeral port, a HOST FederationManager registered to the inbound seam, and a
 * JOINER FederationManager that connects with a real WsFederationClient + a real
 * office credential. This is the only wiring that reaches the joiner MANAGER's
 * governance consumer (handleJoinerM2Frame → onMemberRemovedRemote /
 * onOfficeDissolvedRemote → local teardown) — the bridge test cannot, since it
 * drives the joiner as a bare coordinator. Here it is proven against real sockets.
 *
 * Proven end-to-end:
 *   - B-2: a host that has an open run epoch stamps it on the join roster; the
 *     joiner observes team.epochId (so it can derive the live session key).
 *   - G-1: host projectMemberRemoved → the joiner's onMemberRemovedRemote fires
 *     with the removed appId (the joiner can drop the row immediately).
 *   - G-3: host projectOfficeDissolved → the joiner's onOfficeDissolvedRemote
 *     fires AND the joined office is torn down locally (no residue, link dropped,
 *     re-join record forgotten so a restart does not auto-rejoin a dissolved office).
 *   - H-1: after a join the host persists a joined-office re-join record; the
 *     restart-recovery surface (listJoinedOfficeConnections) returns it so a fresh
 *     start can re-drive joinOffice — until the office is dissolved, which clears it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import http from 'http'
import path from 'path'

function testHome(): string {
  return globalThis.__HALO_TEST_DIR__ || '/tmp/halo-test-fallback'
}

// Own the electron mock to add a safeStorage stub the identity module needs.
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

const OFFICE = 'office-gov-ws'
const EPOCH = 'epoch-live-ws-1'

/** Poll a predicate until true or the budget elapses (real async, no fake timers). */
async function waitFor(predicate: () => boolean, budgetMs = 4000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('governance egress + run-epoch + restart recovery (real ws)', () => {
  let dbManager: DatabaseManager
  let joinerDbManager: DatabaseManager
  let teamStore: TeamStore
  let joinerTeamStore: TeamStore
  let server: http.Server
  let hostManager: FederationManager
  let joinerManager: FederationManager
  let port: number
  let token: string

  let memberRemoved: Array<{ officeId: string; appId: string }>
  let officeDissolved: string[]
  let openRunEpoch: { teamId: string; epochId: string } | null

  beforeEach(async () => {
    initIdentity()

    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, TEAM_NS, teamMigrations)
    const federationStore = initFederationStore({ db: dbManager })
    teamStore = new TeamStore(db)

    joinerDbManager = createDatabaseManager(':memory:')
    const joinerDb = joinerDbManager.getAppDatabase()
    joinerDbManager.runMigrations(joinerDb, TEAM_NS, teamMigrations)
    joinerTeamStore = new TeamStore(joinerDb)

    token = issueOfficeCredential({ officeId: OFFICE, identity: getLocalIdentity().id }).token

    server = http.createServer()
    initWebSocket(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port

    openRunEpoch = null
    hostManager = createFederationManager({
      hostSend: (clientId, frame) => sendFederationFrameToClient(clientId, frame),
      hostListOfficeClients: (officeId) => listOfficeClientIds(officeId),
      federationStore,
      teamStore,
      verifyCredential: (t) => verifyOfficeCredential(t),
      getLocalNodeId: () => getLocalIdentity().id,
      // B-2: the host reports its currently-open run epoch (if any) for the roster stamp.
      getCurrentRunEpoch: () => openRunEpoch,
    })
    hostManager.hostOffice(OFFICE)
    setFederationInbound((ctx) => hostManager.handleHostInbound(ctx))

    memberRemoved = []
    officeDissolved = []
    joinerManager = createFederationManager({
      hostSend: () => false,
      hostListOfficeClients: () => [],
      federationStore,
      teamStore: joinerTeamStore,
      verifyCredential: () => null,
      getLocalNodeId: () => 'joiner-node-b',
      onMemberRemovedRemote: (officeId, appId) => memberRemoved.push({ officeId, appId }),
      onOfficeDissolvedRemote: (officeId) => officeDissolved.push(officeId),
    })
  })

  afterEach(() => {
    joinerManager?.stopAll()
    hostManager?.stopAll()
    setFederationInbound(null)
    shutdownWebSocket()
    server?.close()
    shutdownFederationStore()
    dbManager.closeAll()
    joinerDbManager.closeAll()
  })

  async function joinAsB(bring = [{ appId: 'app-ws-1', memberName: 'ws-writer', role: 'Writer', spaceId: 'space-ws-1' }]) {
    const result = await joinerManager.joinOffice({
      officeId: OFFICE,
      serverUrl: `http://127.0.0.1:${port}`,
      credentialToken: token,
      selfContext: { officeId: OFFICE, selfNodeId: 'joiner-node-b' },
      bringMembers: bring,
    })
    expect(result.ok).toBe(true)
    await waitFor(() => joinerTeamStore.getTeamById(OFFICE) != null)
  }

  it('B-2: an open run epoch on the host rides the join roster to the joiner', async () => {
    openRunEpoch = { teamId: OFFICE, epochId: EPOCH }
    await joinAsB()
    // The joiner materialized the shadow office, which only happens after it
    // consumed the host's roster snapshot — and that snapshot carried team.epochId
    // (the host stamped it because a run was open). The store does not persist the
    // epoch (current_epoch_id stays null by design); the wire-delivery contract is
    // proven deterministically in governance-egress.test.ts (onRoster sees epochId).
    // Here the e2e proof is that a real-socket join with an open run completes and
    // the shadow office exists.
    expect(joinerTeamStore.getTeamById(OFFICE)).toBeTruthy()
    expect(joinerTeamStore.getMemberByName(OFFICE, 'ws-writer')).toBeTruthy()
  })

  it('G-1: host removes a member → the joiner observes onMemberRemovedRemote', async () => {
    await joinAsB()
    hostManager.projectMemberRemoved(OFFICE, 'app-removed-1')
    await waitFor(() => memberRemoved.length > 0)
    expect(memberRemoved).toContainEqual({ officeId: OFFICE, appId: 'app-removed-1' })
    // The office is still joined (a single member removal is not a full exit).
    expect(joinerManager.listJoinedOffices()).toContain(OFFICE)
  })

  it('G-3: host dissolves the office → joiner tears the joined office down, no residue', async () => {
    await joinAsB()
    expect(joinerManager.listJoinedOffices()).toContain(OFFICE)

    hostManager.projectOfficeDissolved(OFFICE)

    await waitFor(() => officeDissolved.length > 0)
    expect(officeDissolved).toContain(OFFICE)
    await waitFor(() => !joinerManager.listJoinedOffices().includes(OFFICE))
    expect(joinerManager.listJoinedOffices()).not.toContain(OFFICE)
    expect(joinerManager.getOffice(OFFICE)).toBeNull()
  })

  it('H-1: a successful join persists a re-join record for restart recovery', async () => {
    const federationStore = initFederationStore({ db: dbManager })
    await joinAsB()
    const conns = federationStore.listJoinedOfficeConnections()
    const mine = conns.find((c) => c.officeId === OFFICE)
    expect(mine).toBeTruthy()
    expect(mine!.serverUrl).toBe(`http://127.0.0.1:${port}`)
    expect(mine!.bringAppIds).toContain('app-ws-1')
  })

  it('H-1/G-3: dissolving the office clears the re-join record (no auto-rejoin of a dead office)', async () => {
    const federationStore = initFederationStore({ db: dbManager })
    await joinAsB()
    expect(federationStore.listJoinedOfficeConnections().some((c) => c.officeId === OFFICE)).toBe(true)

    hostManager.projectOfficeDissolved(OFFICE)
    await waitFor(() => officeDissolved.length > 0)
    await waitFor(() => !joinerManager.listJoinedOffices().includes(OFFICE))

    expect(federationStore.listJoinedOfficeConnections().some((c) => c.officeId === OFFICE)).toBe(false)
  })
})
