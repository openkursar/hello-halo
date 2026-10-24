/**
 * Opening this computer's own team's invite link on this computer and pressing
 * Join (the deep link pre-fills the join dialog with it).
 *
 * Joining starts by tearing down whatever this computer runs for that office —
 * for a re-join, the connection it replaces. For its own team that is the
 * hosting itself, so every other computer is cut off at once; and the join
 * that follows can be answered by this computer itself, which rewrites the team
 * as one hosted elsewhere: read-only here, with a Leave that deletes it. It is
 * refused before anything is touched, the same over IPC and over HTTP, and the
 * hosting goes on.
 *
 * Built as bootstrap builds it: real stores, a hosting FederationManager with
 * M2 (authority store) and the join-client proof factory, a second computer
 * joined over a real `ws` server, and the real controller and transports.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'http'
import path from 'path'
import express from 'express'
import type { AddressInfo } from 'net'

type IpcHandler = (event: unknown, ...args: unknown[]) => Promise<unknown>

const ref = vi.hoisted(() => ({
  store: null as unknown,
  apps: new Map<string, { id: string; spaceId: string | null; spec: { name: string } }>(),
  ipc: new Map<string, IpcHandler>(),
}))

function testHome(): string {
  return globalThis.__HALO_TEST_DIR__ || '/tmp/halo-test-fallback'
}

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: (name: string) => (name === 'userData' ? path.join(testHome(), '.halo') : testHome()),
    getAppPath: () => path.join(testHome(), 'app'),
    getName: () => 'Halo',
    getVersion: () => '1.0.0-test',
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: (channel: string, fn: IpcHandler) => { ref.ipc.set(channel, fn) }, on: vi.fn() },
  powerMonitor: { on: vi.fn(), removeListener: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
}))
vi.mock('../../../src/main/apps/team', () => ({ getTeamStore: () => ref.store, getTeamService: () => null }))
vi.mock('../../../src/main/apps/manager', () => ({
  getAppManager: () => ({ getApp: (id: string) => ref.apps.get(id) ?? null }),
}))
vi.mock('../../../src/main/apps/runtime/app-chat', () => ({
  readTeamMemberHistory: () => [],
  isAppChatConversationGenerating: () => false,
}))
vi.mock('../../../src/main/http/auth/middleware', () => ({ getOfficeCredential: () => null }))

import { createDatabaseManager } from '../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../src/main/platform/store/types'
import {
  getAuthorityStore,
  getFeedStore,
  initFederationStore,
  shutdownFederationStore,
} from '../../../src/main/apps/federation/index'
import { FederationStore } from '../../../src/main/apps/federation/store'
import { FeedStore } from '../../../src/main/apps/federation/feed-store'
import { MIGRATION_NAMESPACE as FED_NS, migrations as fedMigrations } from '../../../src/main/apps/federation/migrations'
import { TeamStore } from '../../../src/main/apps/team/store'
import { MIGRATION_NAMESPACE as TEAM_NS, migrations as teamMigrations } from '../../../src/main/apps/team/migrations'
import { initIdentity, getLocalIdentity } from '../../../src/main/http/identity/index'
import { issueOfficeCredential, verifyOfficeCredential } from '../../../src/main/http/auth/office-credential'
import {
  initWebSocket,
  listOfficeClientIds,
  sendFederationFrameToClient,
  setFederationInbound,
  shutdownWebSocket,
} from '../../../src/main/http/websocket'
import { createFederationManager, setFederationManager } from '../../../src/main/apps/runtime/federation/manager'
import type { FederationManager } from '../../../src/main/apps/runtime/federation/manager'
import { joinTeamOffice } from '../../../src/main/controllers/team-invite.controller'
import { registerTeamIpc } from '../../../src/main/ipc/team'
import { registerTeamRoutes } from '../../../src/main/http/routes/team.routes'
import { TEAM_IPC } from '../../../src/shared/apps/team-types'
import { localAuthProof } from '../apps/runtime/federation/_ws-auth'

registerTeamIpc()

const OFFICE = 'office-own-team'
const JOINER = 'joiner-node-b'
const LEAD = 'app-host-lead'
const MINE = 'app-host-writer'
const B1 = 'app-b-tester'

async function waitFor(predicate: () => boolean, budgetMs = 4000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  expect(predicate()).toBe(true)
}

describe('the hosting computer pressing Join on its own team’s invite link', () => {
  let dbManager: DatabaseManager
  let joinerDbManager: DatabaseManager
  let hostTeamStore: TeamStore
  let hostFederationStore: FederationStore
  let server: http.Server
  let hostManager: FederationManager
  let joinerManager: FederationManager
  let serverUrl: string
  let token: string

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
    hostTeamStore.addMember({ teamId: OFFICE, appId: MINE, memberName: 'writer', role: '', isLead: false, aiProvisioned: false, addedAt: now })
    ref.store = hostTeamStore
    ref.apps.clear()
    ref.apps.set(MINE, { id: MINE, spaceId: 'space-host', spec: { name: 'writer' } })

    // As the product mints them: no expiry (TeamInviteDialog → generateTeamInvite).
    token = issueOfficeCredential({ officeId: OFFICE, identity: getLocalIdentity().id }).token

    server = http.createServer()
    initWebSocket(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    hostManager = createFederationManager({
      hostSend: (clientId, frame) => sendFederationFrameToClient(clientId, frame),
      hostListOfficeClients: (officeId) => listOfficeClientIds(officeId),
      federationStore: hostFederationStore,
      authorityStore: getAuthorityStore()!,
      feedStore: getFeedStore()!,
      teamStore: hostTeamStore,
      verifyCredential: (t) => verifyOfficeCredential(t),
      getLocalNodeId: () => getLocalIdentity().id,
      // Bootstrap hands every join client of this computer the same proof factory.
      makeAuthProof: (nonce) => localAuthProof(nonce),
    })
    hostManager.hostOffice(OFFICE)
    setFederationInbound((ctx) => hostManager.handleHostInbound(ctx))
    setFederationManager(hostManager)

    // Another computer in the team.
    joinerDbManager = createDatabaseManager(':memory:')
    const joinerDb = joinerDbManager.getAppDatabase()
    joinerDbManager.runMigrations(joinerDb, TEAM_NS, teamMigrations)
    joinerDbManager.runMigrations(joinerDb, FED_NS, fedMigrations)
    joinerManager = createFederationManager({
      hostSend: () => false,
      hostListOfficeClients: () => [],
      federationStore: new FederationStore(joinerDb),
      feedStore: new FeedStore(joinerDb),
      teamStore: new TeamStore(joinerDb),
      verifyCredential: () => null,
      getLocalNodeId: () => JOINER,
      makeAuthProof: (nonce) => localAuthProof(nonce),
    })
    const joined = await joinerManager.joinOffice({
      officeId: OFFICE,
      serverUrl,
      credentialToken: token,
      selfContext: { officeId: OFFICE, selfNodeId: JOINER },
      bringMembers: [{ appId: B1, memberName: 'tester', role: '', spaceId: 'space-b' }],
    })
    expect(joined.ok).toBe(true)
    await waitFor(() => hostTeamStore.getMember(OFFICE, B1) !== null && hostManager.isMemberReachable(B1, OFFICE))
  })

  afterEach(() => {
    setFederationManager(null)
    joinerManager?.stopAll()
    hostManager?.stopAll()
    setFederationInbound(null)
    shutdownWebSocket()
    server?.close()
    shutdownFederationStore()
    dbManager.closeAll()
    joinerDbManager.closeAll()
  })

  const input = () => ({ officeId: OFFICE, serverUrl, inviteToken: token, bringAppIds: [MINE] })

  /** Still hosted here, the other computer still served, the team still this computer's own. */
  function expectStillHosting() {
    expect(hostManager.listHostedOffices()).toContain(OFFICE)
    expect(hostManager.listJoinedOffices()).not.toContain(OFFICE)
    expect(hostManager.isMemberReachable(B1, OFFICE)).toBe(true)
    expect(hostTeamStore.getTeamById(OFFICE)?.hostNodeId ?? null).toBeNull()
    // Nothing written down for the next start to join instead of host.
    expect(hostFederationStore.listJoinedOfficeConnections()).toEqual([])
  }

  it('is refused before anything is torn down: the team stays hosted and the other computer stays connected', async () => {
    const result = await joinTeamOffice(input())

    expect(result).toEqual({ success: false, error: 'OWN_TEAM' })
    expectStillHosting()
  }, 30_000)

  it('is refused the same way over IPC and over HTTP', async () => {
    expect(await ref.ipc.get(TEAM_IPC.joinOffice)!({}, input())).toEqual({ success: false, error: 'OWN_TEAM' })

    const app = express()
    app.use(express.json())
    registerTeamRoutes(app)
    const routes = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s))
    })
    try {
      const { officeId, ...body } = input()
      const res = await fetch(`http://127.0.0.1:${(routes.address() as AddressInfo).port}/api/teams/${officeId}/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(await res.json()).toEqual({ success: false, error: 'OWN_TEAM' })
    } finally {
      await new Promise<void>((resolve) => routes.close(() => resolve()))
    }

    expectStillHosting()
  }, 30_000)
})
