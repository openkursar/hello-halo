/**
 * Integration test for apps/runtime/federation -- real `ws` transport path.
 *
 * Stands up a real http server + the production initWebSocket on an ephemeral
 * port, registers the federation inbound seam to a host FederationManager, then
 * has a joiner manager connect with a REAL WsFederationClient, authenticate with
 * a REAL office credential, send a join-request, and verifies the host persists
 * the node + remote member and the joiner observes a grant.
 *
 * This proves the §14.1 same-machine multi-instance affordance end-to-end over
 * actual sockets — the affordance the injected-fake manager.test.ts cannot. The
 * fake test remains the primary deterministic gate; this is the real-path proof.
 *
 * Importing http/* here is fine: tests are not part of the layered runtime, and
 * this test must exercise the real WS server the Lead owns.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import http from 'http'
import path from 'path'

function testHome(): string {
  return globalThis.__HALO_TEST_DIR__ || '/tmp/halo-test-fallback'
}

// Own the electron mock to add a safeStorage stub the identity module needs
// (the global setup omits it). Plaintext fallback — no OS keychain in tests.
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
  getSessionIdentity,
} from '../../../../../src/main/http/websocket'
import { createFederationManager } from '../../../../../src/main/apps/runtime/federation/manager'
import type { FederationManager } from '../../../../../src/main/apps/runtime/federation/manager'
import { localAuthProof } from './_ws-auth'

const OFFICE = 'office-ws-1'

/** Poll a predicate until true or the budget elapses (real async, no fake timers). */
async function waitFor(predicate: () => boolean, budgetMs = 4000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('FederationManager (real ws transport)', () => {
  let dbManager: DatabaseManager
  let joinerDbManager: DatabaseManager
  let teamStore: TeamStore
  let joinerTeamStore: TeamStore
  let server: http.Server
  let hostManager: FederationManager
  let joinerManager: FederationManager
  let port: number
  let token: string

  beforeEach(async () => {
    // Identity must exist before issuing/verifying office credentials.
    initIdentity()

    dbManager = createDatabaseManager(':memory:')
    const db = dbManager.getAppDatabase()
    dbManager.runMigrations(db, TEAM_NS, teamMigrations)
    // Federation store singleton backs verifyOfficeCredential's revocation ledger.
    const federationStore = initFederationStore({ db: dbManager })
    teamStore = new TeamStore(db)

    // The joiner is a SEPARATE process in production with its OWN store; model
    // that with an independent db so the host-side persistence assertion is not
    // clobbered when the joiner materializes its host-driven shadow office (which
    // remaps its own brought member to SELF — correct on the joiner's own db).
    joinerDbManager = createDatabaseManager(':memory:')
    const joinerDb = joinerDbManager.getAppDatabase()
    joinerDbManager.runMigrations(joinerDb, TEAM_NS, teamMigrations)
    joinerTeamStore = new TeamStore(joinerDb)

    // A real, signed office credential the WS auth gate will accept.
    token = issueOfficeCredential({ officeId: OFFICE, identity: getLocalIdentity().id }).token

    server = http.createServer()
    initWebSocket(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port

    hostManager = createFederationManager({
      hostSend: (clientId, frame) => sendFederationFrameToClient(clientId, frame),
      hostListOfficeClients: (officeId) => listOfficeClientIds(officeId),
      federationStore,
      teamStore,
      verifyCredential: (t) => verifyOfficeCredential(t),
      getLocalNodeId: () => getLocalIdentity().id,
    })
    hostManager.hostOffice(OFFICE)
    setFederationInbound((ctx) => hostManager.handleHostInbound(ctx))

    joinerManager = createFederationManager({
      // The joiner does not host; these host-side deps are unused on its path.
      hostSend: () => false,
      hostListOfficeClients: () => [],
      federationStore,
      teamStore: joinerTeamStore,
      verifyCredential: () => null,
      getLocalNodeId: () => 'joiner-node-b',
      // D10: the WS node handshake requires a device-key proof (the shared
      // in-process identity signs it). The base host omits getSessionIdentity so
      // the anti-spoof gate stays inert and the joiner's label is admitted.
      makeAuthProof: (nonce) => localAuthProof(nonce),
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

  it('joins a remote office over a real socket: host persists node + member, joiner gets grant', async () => {
    const result = await joinerManager.joinOffice({
      officeId: OFFICE,
      serverUrl: `http://127.0.0.1:${port}`,
      credentialToken: token,
      selfContext: { officeId: OFFICE, selfNodeId: 'joiner-node-b' },
      bringMembers: [
        { appId: 'app-ws-1', memberName: 'ws-writer', role: 'Writer', spaceId: 'space-ws-1' },
      ],
    })

    expect(result.ok).toBe(true)

    await waitFor(() => teamStore.listMembersByTeam(OFFICE).length > 0)
    const members = teamStore.listMembersByTeam(OFFICE)
    expect(members).toHaveLength(1)
    expect(members[0]).toMatchObject({
      appId: 'app-ws-1',
      memberName: 'ws-writer',
      origin: 'remote',
      ownerNodeId: 'joiner-node-b',
    })

    expect(hostManager.getRemoteMemberSpaceId('app-ws-1')).toBe('space-ws-1')

    // The joiner materialized its host-driven shadow office: the team carries the
    // host as authority and the joiner's own brought member is SELF-relative
    // (so its RelayCapture recognizes it as owned-here).
    await waitFor(() => joinerTeamStore.getTeamById(OFFICE) != null)
    const shadow = joinerTeamStore.getTeamById(OFFICE)!
    expect(shadow.hostNodeId).toBe(getLocalIdentity().id)
    const ownMember = joinerTeamStore.getMemberByName(OFFICE, 'ws-writer')!
    expect(ownMember.ownerNodeId).toBe('SELF')
    expect(ownMember.origin).toBe('local')
  })

  it('device-key handshake binds the real identity; a join whose fromNode matches it is admitted with the anti-spoof gate ACTIVE (D10)', async () => {
    // D10: the invite token is a shareable bearer (identity:'' at issue), but a
    // federation node session additionally PROVES its portable identity via the
    // device-key challenge–response. So getSessionIdentity now reports the real
    // proven id — not null and not '' — and the anti-spoof gate is live. A join
    // whose fromNode equals that proven id (as production always sets:
    // selfNodeId = getLocalIdentity().id) is admitted through the active gate.
    const provenId = getLocalIdentity().id

    hostManager.stopAll()
    const federationStore = initFederationStore({ db: dbManager })
    hostManager = createFederationManager({
      hostSend: (clientId, frame) => sendFederationFrameToClient(clientId, frame),
      hostListOfficeClients: (officeId) => listOfficeClientIds(officeId),
      federationStore,
      teamStore,
      verifyCredential: (t) => verifyOfficeCredential(t),
      getLocalNodeId: () => provenId,
      getSessionIdentity: (clientId) => getSessionIdentity(clientId),
    })
    hostManager.hostOffice(OFFICE)
    setFederationInbound((ctx) => hostManager.handleHostInbound(ctx))

    const result = await joinerManager.joinOffice({
      officeId: OFFICE,
      serverUrl: `http://127.0.0.1:${port}`,
      credentialToken: token,
      // fromNode === the device-key-proven session id, as production sets it.
      selfContext: { officeId: OFFICE, selfNodeId: provenId },
      bringMembers: [
        { appId: 'app-ph-1', memberName: 'ph-writer', role: 'Writer', spaceId: 'space-ph-1' },
      ],
    })

    expect(result.ok).toBe(true)
    await waitFor(() => teamStore.listMembersByTeam(OFFICE).length > 0)
    const members = teamStore.listMembersByTeam(OFFICE)
    expect(members).toHaveLength(1)
    expect(members[0]).toMatchObject({
      appId: 'app-ph-1',
      origin: 'remote',
      ownerNodeId: provenId,
    })
  })

  it('drops a join-request whose fromNode disagrees with a non-empty bound session identity (gate still works for real identities)', async () => {
    // Counterpart to the placeholder case: when the session IS bound to a real
    // (non-empty) identity, the gate must still drop a frame whose fromNode forges a
    // different node. Bind the session to a concrete id via getSessionIdentity and
    // feed a join-request claiming a foreign fromNode straight into the host edge.
    const boundIdentity = 'bound-node-real'
    hostManager.stopAll()
    const federationStore = initFederationStore({ db: dbManager })
    hostManager = createFederationManager({
      hostSend: (clientId, frame) => sendFederationFrameToClient(clientId, frame),
      hostListOfficeClients: (officeId) => listOfficeClientIds(officeId),
      federationStore,
      teamStore,
      verifyCredential: (t) => verifyOfficeCredential(t),
      getLocalNodeId: () => getLocalIdentity().id,
      getSessionIdentity: () => boundIdentity,
    })
    hostManager.hostOffice(OFFICE)

    hostManager.handleHostInbound({
      clientId: 'forging-client',
      officeId: OFFICE,
      frame: {
        kind: 'join-request',
        officeId: OFFICE,
        fromNode: 'foreign-evil-node',
        identityId: 'identity-evil',
        displayName: 'Evil',
        credentialToken: token,
        bringMembers: [{ appId: 'app-evil', memberName: 'evil', role: 'Writer', spaceId: 'space-evil' }],
      } as any,
    })

    expect(teamStore.listMembersByTeam(OFFICE)).toHaveLength(0)
    expect(federationStore.getNode(OFFICE, 'foreign-evil-node')).toBeNull()
  })

  it('routes a JOINER → HOST-owned-member wake over the upstream link and refluxes the result', async () => {
    // Directional symmetry: the host owns a member; a JOINER drives that member
    // (1:1 chat / wakeTarget). The joiner has only its single upstream link, so
    // its sendWakeToMember must ride that link to the host; the host owns the
    // member, runs it locally (runLocalTurn), and refluxes turn-complete back to
    // the joiner, whose registered waiter resolves with the member's final message.
    const HOST_MEMBER = 'app-host-owned'
    const hostNode = getLocalIdentity().id
    const now = Date.now()

    // Seed the team + a host-owned member + an open run epoch on the HOST store so
    // the host's roster projection carries the member and its run epoch.
    teamStore.insertTeam({
      id: OFFICE, name: 'Office', owningSpaceId: 'space-a', goal: 'g',
      leadAppId: 'app-lead', memberSourcing: 'manual', collabMode: 'free',
      escalationRouting: 'user', status: 'running', currentEpochId: 'epoch-h1',
      createdAt: now, updatedAt: now,
    })
    teamStore.addMember({
      teamId: OFFICE, appId: 'app-lead', memberName: 'lead', role: 'Lead',
      isLead: true, aiProvisioned: false, addedAt: now,
    })
    teamStore.addMember({
      teamId: OFFICE, appId: HOST_MEMBER, memberName: 'host-writer', role: 'Writer',
      isLead: false, aiProvisioned: false, addedAt: now,
    })
    teamStore.insertEpoch({
      id: 'epoch-h1', teamId: OFFICE, startedAt: now, endedAt: null,
      endReason: null, summary: null, lifecycle: 'run',
    })

    // Re-host with runLocalTurn so the host can run the member it OWNS on a wake.
    const hostRan = vi.fn(async (req: { appId: string; message: string }) => ({
      finalMessage: `HOST RAN ${req.appId}`,
    }))
    hostManager.stopAll()
    const federationStore = initFederationStore({ db: dbManager })
    hostManager = createFederationManager({
      hostSend: (clientId, frame) => sendFederationFrameToClient(clientId, frame),
      hostListOfficeClients: (officeId) => listOfficeClientIds(officeId),
      federationStore,
      teamStore,
      verifyCredential: (t) => verifyOfficeCredential(t),
      getLocalNodeId: () => hostNode,
      runLocalTurn: (req) => hostRan(req),
    })
    hostManager.hostOffice(OFFICE)
    setFederationInbound((ctx) => hostManager.handleHostInbound(ctx))

    const joinResult = await joinerManager.joinOffice({
      officeId: OFFICE,
      serverUrl: `http://127.0.0.1:${port}`,
      credentialToken: token,
      selfContext: { officeId: OFFICE, selfNodeId: 'joiner-node-b' },
      bringMembers: [{ appId: 'app-b-own', memberName: 'b-own', role: 'Writer', spaceId: 'space-b' }],
    })
    expect(joinResult.ok).toBe(true)

    // The joiner materialized the shadow office including the host-owned member.
    await waitFor(() => joinerTeamStore.getMemberByName(OFFICE, 'host-writer') != null)
    const shadowMember = joinerTeamStore.getMemberByName(OFFICE, 'host-writer')!
    expect(shadowMember.ownerNodeId).toBe(hostNode)
    expect(shadowMember.origin).toBe('remote')

    // The joiner registers a one-shot waiter then sends the wake over its upstream
    // link (the joined-office branch of sendWakeToMember).
    const outcome = await new Promise<{ kind: string; content?: string }>((resolve) => {
      joinerManager.registerTurnComplete('corr-jh-1', (o) => resolve(o as never))
      const sent = joinerManager.sendWakeToMember({
        officeId: OFFICE,
        ownerNodeId: hostNode,
        correlationId: 'corr-jh-1',
        request: {
          appId: HOST_MEMBER,
          spaceId: 'ignored-on-host',
          message: 'please summarize',
          conversationId: `app-chat:${HOST_MEMBER}:team:${OFFICE}:epoch-h1`,
          teamContext: {
            teamId: OFFICE, epochId: 'epoch-h1', correlationId: 'corr-jh-1',
            fromAppId: null, wait: true, kind: 'message',
          },
        },
      })
      expect(sent).toBe(true)
    })

    expect(hostRan).toHaveBeenCalledTimes(1)
    expect(hostRan.mock.calls[0][0].appId).toBe(HOST_MEMBER)
    expect(outcome.kind).toBe('result')
    expect(outcome.content).toBe(`HOST RAN ${HOST_MEMBER}`)
  })

  it('rejects a forged credential over the real socket (auth gate denies)', async () => {
    const result = await joinerManager.joinOffice({
      officeId: OFFICE,
      serverUrl: `http://127.0.0.1:${port}`,
      credentialToken: 'forged-not-a-real-token',
      selfContext: { officeId: OFFICE, selfNodeId: 'joiner-node-b' },
      bringMembers: [],
    })

    // The WS auth gate closes the socket before any federation frame is accepted,
    // so the join never completes — it resolves failed (timeout/closed), not ok.
    expect(result.ok).toBe(false)
    expect(teamStore.listMembersByTeam(OFFICE)).toHaveLength(0)
  })
})
