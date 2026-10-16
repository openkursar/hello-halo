/**
 * Joiner side of a refused join, over a real socket that behaves like the relay
 * in front of the office: it answers a join-request with a join-reject and then
 * ends the member's session, as the gateway does for every refused member. A
 * host on the LAN keeps a refused session open instead ('refuse-and-keep').
 *
 * Before the refusal period existed this was a loop: the reconnect re-auth reset
 * the backoff, re-drove the join, was refused and closed again — once a second,
 * all day. Here the office is asked again after a wait that grows per refusal,
 * or sooner when something says the answer may have changed; the user is told
 * once, and a grant ends it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../../src/main/http/websocket', () => ({ broadcastToAll: vi.fn() }))
vi.mock('../../../../../src/main/foundation/window.service', () => ({ sendToRenderer: vi.fn() }))

import http from 'http'
import { WebSocketServer, type WebSocket } from 'ws'
import { createDatabaseManager } from '../../../../../src/main/platform/store/database-manager'
import { TeamStore } from '../../../../../src/main/apps/team/store'
import { migrations as teamMigrations, MIGRATION_NAMESPACE as TEAM_NS } from '../../../../../src/main/apps/team/migrations'
import { FederationStore } from '../../../../../src/main/apps/federation/store'
import { migrations as federationMigrations, MIGRATION_NAMESPACE as FED_NS } from '../../../../../src/main/apps/federation/migrations'
import { DEFAULT_OFFICE_SCOPE } from '../../../../../src/main/apps/federation/types'
import { createFederationManager, type FederationManager, type FederationManagerDeps } from '../../../../../src/main/apps/runtime/federation/manager'
import { createTeamService } from '../../../../../src/main/apps/team/service'
import { FEDERATION_PROTOCOL_VERSION } from '../../../../../src/shared/federation/protocol-version'
import type { TeamVersionMismatch } from '../../../../../src/shared/apps/team-types'
import type { FederationMessage } from '../../../../../src/main/apps/runtime/federation/types'

const OFFICE = 'office-old-host'
const HOST = 'old-host'
const PEER = 'other-member'
const SELF = 'this-node'

type RelayMode =
  | 'refuse-version'
  | 'refuse-credential'
  | 'refuse-and-keep'
  | 'refuse-then-grant'
  | 'grant'
  | 'grant-other-version'
  | 'silent'

interface FakeRelay {
  url: string
  sessions: () => number
  joinRequests: () => number
  /** Heartbeats that reached the far side. */
  heartbeats: () => number
  pings: () => number
  setMode: (mode: RelayMode) => void
  /** Stop answering pings, as a far side that vanished without a word. */
  goQuiet: () => void
  dropAll: () => void
  close: () => Promise<void>
}

async function startRelay(officeId: string, initial: RelayMode): Promise<FakeRelay> {
  let mode = initial
  let sessions = 0
  let joins = 0
  let heartbeats = 0
  let pings = 0
  let quiet = false
  const server = http.createServer()
  const wss = new WebSocketServer({ server, path: '/ws', autoPong: false })
  const fromHost = (socket: WebSocket, payload: Record<string, unknown>) =>
    socket.send(JSON.stringify({ type: 'federation', from: HOST, payload }))
  wss.on('connection', (socket) => {
    sessions += 1
    socket.on('ping', (data) => {
      pings += 1
      if (!quiet) socket.pong(data)
    })
    socket.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as { type?: string; payload?: { kind?: string } }
      if (msg.type === 'auth') socket.send(JSON.stringify({ type: 'auth:success', payload: { wirePv: 2 } }))
      if (msg.type === 'federation' && msg.payload?.kind === 'heartbeat') heartbeats += 1
      if (msg.type !== 'federation' || msg.payload?.kind !== 'join-request') return
      joins += 1
      if (mode === 'grant') {
        fromHost(socket, { kind: 'join-grant', officeId, assignedNodeId: SELF, pv: FEDERATION_PROTOCOL_VERSION })
      } else if (mode === 'refuse-then-grant') {
        // Two joins in flight on one session, decided differently: one refused, the other admitted.
        fromHost(socket, { kind: 'join-reject', officeId, reason: 'CREDENTIAL_INVALID', pv: FEDERATION_PROTOCOL_VERSION })
        fromHost(socket, { kind: 'join-grant', officeId, assignedNodeId: SELF, pv: FEDERATION_PROTOCOL_VERSION })
      } else if (mode === 'grant-other-version') {
        // Admitted as far as the far side knows; this node refuses the grant and the session stays.
        fromHost(socket, { kind: 'join-grant', officeId, assignedNodeId: SELF, pv: FEDERATION_PROTOCOL_VERSION + 1 })
      } else if (mode === 'refuse-credential') {
        fromHost(socket, { kind: 'join-reject', officeId, reason: 'CREDENTIAL_INVALID', pv: FEDERATION_PROTOCOL_VERSION })
        setTimeout(() => socket.terminate(), 100)
      } else if (mode !== 'silent') {
        // A host from before the reject carried its own version.
        fromHost(socket, { kind: 'join-reject', officeId, reason: 'VERSION_INCOMPATIBLE' })
        if (mode === 'refuse-version') setTimeout(() => socket.terminate(), 100)
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    sessions: () => sessions,
    joinRequests: () => joins,
    heartbeats: () => heartbeats,
    pings: () => pings,
    setMode: (next) => {
      mode = next
    },
    goQuiet: () => {
      quiet = true
    },
    dropAll: () => {
      for (const socket of wss.clients) socket.terminate()
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of wss.clients) socket.terminate()
        wss.close(() => server.close(() => resolve()))
      }),
  }
}

async function waitFor(predicate: () => boolean, budgetMs = 4000): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
  expect(predicate()).toBe(true)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})

/** One machine: a federation manager over its own stores, with every signal it gives bootstrap recorded. */
function makeNode(retry: FederationManagerDeps['refusedJoinRetryMs']) {
  const db = createDatabaseManager(':memory:')
  db.runMigrations(db.getAppDatabase(), TEAM_NS, teamMigrations)
  db.runMigrations(db.getAppDatabase(), FED_NS, federationMigrations)
  const teamStore = new TeamStore(db.getAppDatabase())
  const federationStore = new FederationStore(db.getAppDatabase())
  const notices: Array<{ reason: string; detail?: TeamVersionMismatch }> = []
  const restored: string[] = []
  // Every signal bootstrap turns into a renderer event that reloads team views.
  const events = {
    onRosterChanged: vi.fn(),
    onPresenceChange: vi.fn(),
    onOfficePaused: vi.fn(),
    onAuthorityChange: vi.fn(),
  }
  const peerDialer = vi.fn((_officeId: string, _nodeId: string) => null)
  const manager: FederationManager = createFederationManager({
    teamStore,
    federationStore,
    hostSend: () => true,
    hostListOfficeClients: () => [],
    getLocalNodeId: () => SELF,
    verifyCredential: (token) => (token === 'invite-to-mine' ? { officeId: 'office-mine', scope: DEFAULT_OFFICE_SCOPE } : null),
    onOfficeAccessLost: (_officeId, reason, detail) => notices.push({ reason, detail }),
    onOfficeAccessRestored: (officeId) => restored.push(officeId),
    ...events,
    peerDialer,
    refusedJoinRetryMs: retry,
  })
  cleanup.push(() => db.closeAll(), () => manager.stopAll())
  const join = (officeId: string, relay: FakeRelay) =>
    manager.joinOffice({
      officeId,
      serverUrl: relay.url,
      credentialToken: 'invite',
      selfContext: { officeId, selfNodeId: SELF },
      bringMembers: [{ appId: 'app-self', memberName: 'mine', role: 'Writer' }],
    })
  const anyEvent = () =>
    Object.values(events).some((spy) => spy.mock.calls.length > 0) || notices.length > 0 || restored.length > 0
  return { manager, teamStore, federationStore, notices, restored, events, anyEvent, peerDialer, join }
}

async function relayFor(officeId: string, mode: RelayMode): Promise<FakeRelay> {
  const relay = await startRelay(officeId, mode)
  cleanup.push(() => relay.close())
  return relay
}

/** The shadow office as a previous membership left it: the host's row and a peer it learned about. */
function seedFormerMembership(node: ReturnType<typeof makeNode>, officeId = OFFICE, hostLastSeen = Date.now()): void {
  const now = Date.now()
  node.teamStore.insertTeam({
    id: officeId, name: officeId, owningSpaceId: 'space', goal: 'g', leadAppId: null, memberSourcing: 'manual',
    collabMode: 'free', escalationRouting: 'user', status: 'idle', currentEpochId: null,
    createdAt: now, updatedAt: now, hostNodeId: HOST,
  })
  node.teamStore.addMember({
    teamId: officeId, appId: `app-host-${officeId}`, memberName: 'host-member', role: 'Writer', isLead: false,
    aiProvisioned: false, addedAt: now, ownerNodeId: HOST, origin: 'remote', ownerDisplayName: 'Alice',
  })
  node.federationStore.upsertNode({
    nodeId: HOST, officeId, identity: HOST, displayName: 'Alice',
    joinedAt: 0, lastSeen: hostLastSeen, status: 'online', advertisedUrl: null,
  })
  node.federationStore.upsertNode({
    nodeId: PEER, officeId, identity: PEER, displayName: 'Bob',
    joinedAt: 1, lastSeen: now, status: 'online', advertisedUrl: 'http://127.0.0.1:9',
  })
}

const LONG = { version: 60_000, other: 60_000, max: 60_000 }

describe('an office that refuses this node', () => {
  it('answers the join once and asks again only after the retry delay, not in a reconnect loop', async () => {
    const node = makeNode({ version: 2000, max: 4000 })
    const relay = await relayFor(OFFICE, 'refuse-version')

    const result = await node.join(OFFICE, relay)
    expect(result).toMatchObject({ ok: false, reason: 'VERSION_INCOMPATIBLE', detail: { direction: 'peer' } })

    // The reconnect backoff would have been back after 1 s, and refused again.
    await sleep(1500)
    expect(relay.sessions()).toBe(1)

    await waitFor(() => relay.joinRequests() === 2, 2000)
    await sleep(300)
    expect(relay.sessions()).toBe(2)
    // The pending join's caller reported the first refusal; the retry adds nothing.
    expect(node.notices).toEqual([])
  })

  it('tells the user once when a joined office starts refusing, however many retries follow', async () => {
    const node = makeNode({ version: 600, max: 600 })
    const relay = await relayFor(OFFICE, 'grant')
    expect((await node.join(OFFICE, relay)).ok).toBe(true)

    relay.setMode('refuse-version')
    relay.dropAll()
    await waitFor(() => node.notices.length === 1)
    await waitFor(() => relay.joinRequests() >= 4, 4000)

    expect(node.notices).toEqual([{ reason: 'VERSION_INCOMPATIBLE', detail: { direction: 'peer', peerName: null } }])
  })

  it('ends the refusal at the next grant and says so once; a later refusal is told again', async () => {
    const node = makeNode({ version: 500, max: 500 })
    seedFormerMembership(node)
    const relay = await relayFor(OFFICE, 'refuse-version')
    expect((await node.join(OFFICE, relay)).ok).toBe(false)

    // The host updated: the next try is admitted and the office is joined.
    relay.setMode('grant')
    await waitFor(() => node.federationStore.listJoinedOfficeConnections().some((c) => c.officeId === OFFICE), 3000)
    expect(node.restored).toEqual([OFFICE])

    relay.setMode('refuse-version')
    relay.dropAll()
    await waitFor(() => node.notices.length === 1, 3000)
    expect(node.notices[0]).toEqual({ reason: 'VERSION_INCOMPATIBLE', detail: { direction: 'peer', peerName: 'Alice' } })
  })

  it('backs off a refusal for another reason on its own, shorter schedule, logging it once', async () => {
    const node = makeNode({ version: 60_000, other: 1500, max: 1500 })
    const relay = await relayFor(OFFICE, 'grant')
    expect((await node.join(OFFICE, relay)).ok).toBe(true)
    const warn = vi.spyOn(console, 'warn')
    const refusalLines = () => warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('join refused'))

    relay.setMode('refuse-credential')
    relay.dropAll()
    await waitFor(() => relay.joinRequests() === 2)
    const sessionsAtRefusal = relay.sessions()

    // The reconnect backoff would be back after 1 s.
    await sleep(1200)
    expect(relay.sessions()).toBe(sessionsAtRefusal)
    await waitFor(() => relay.joinRequests() === 3, 2000)

    expect(refusalLines()).toHaveLength(1)
    expect(refusalLines()[0]).toContain(`office=${OFFICE} reason=CREDENTIAL_INVALID;`)
    expect(node.notices).toEqual([{ reason: 'CREDENTIAL_INVALID', detail: undefined }])
  })

  it('does not read silence from an office that refuses it as the host going offline', async () => {
    const node = makeNode(LONG)
    seedFormerMembership(node, OFFICE, Date.now() - 60_000)
    const relay = await relayFor(OFFICE, 'refuse-version')
    expect((await node.join(OFFICE, relay)).ok).toBe(false)

    node.manager.getOffice(OFFICE)!.coordinator.sweepPresence()

    expect(node.federationStore.getNode(OFFICE, HOST)!.status).toBe('online')
    expect(node.peerDialer).not.toHaveBeenCalled()
  })

  it('notices that a session it keeps after refusing a grant died silently, and joins once the far side matches', async () => {
    // Only the intervals and the clock are fake; sockets and the reconnect timer are real.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], shouldAdvanceTime: true })
    cleanup.push(() => { vi.useRealTimers() })
    const node = makeNode(LONG)
    seedFormerMembership(node)
    const relay = await relayFor(OFFICE, 'grant-other-version')
    expect(await node.join(OFFICE, relay)).toMatchObject({ ok: false, reason: 'VERSION_INCOMPATIBLE' })

    // The far side updates and restarts; nothing of it reaches this node.
    relay.setMode('grant')
    relay.goQuiet()
    await vi.advanceTimersByTimeAsync(30_000)
    await waitFor(() => relay.pings() === 1)
    await vi.advanceTimersByTimeAsync(30_000)

    await waitFor(() => node.restored.includes(OFFICE), 4000)
    expect(relay.sessions()).toBe(2)
    expect(relay.joinRequests()).toBe(2)
  })

  it('carries frames again when the office admits it on the session it was just refused on', async () => {
    const node = makeNode(LONG)
    const relay = await relayFor(OFFICE, 'refuse-then-grant')
    void node.join(OFFICE, relay)

    await waitFor(() => node.restored.includes(OFFICE))
    // Heartbeats start 2 s in, long after the refusal: they must reach the office.
    await waitFor(() => relay.heartbeats() > 0, 4000)
    expect(relay.sessions()).toBe(1)
  })

  it('still reads a long silence as the host going offline while not refused', async () => {
    const node = makeNode(LONG)
    seedFormerMembership(node, OFFICE, Date.now() - 60_000)
    const relay = await relayFor(OFFICE, 'silent')
    void node.join(OFFICE, relay)
    await waitFor(() => relay.joinRequests() === 1)

    node.manager.getOffice(OFFICE)!.coordinator.sweepPresence()

    expect(node.federationStore.getNode(OFFICE, HOST)!.status).toBe('offline')
    expect(node.peerDialer).toHaveBeenCalledWith(OFFICE, PEER)
  })
})

describe('asking a refusing office again early', () => {
  /** The team service as bootstrap wires it: reading a joined office's detail tells federation. */
  function serviceOver(node: ReturnType<typeof makeNode>) {
    const runtime = {
      checks: { viewForTeam: () => [] },
      getObservableStatus: vi.fn(() => 'idle'),
      getMemberStatus: vi.fn(() => 'idle' as const),
      getMemberBusy: vi.fn(() => []),
    }
    return createTeamService({
      store: node.teamStore,
      appManager: { getApp: vi.fn(() => null) } as never,
      getRuntime: () => runtime as never,
      spaces: { spaceExists: () => true, createMemberSpace: ({ owningSpaceId }) => owningSpaceId },
      listArtifacts: vi.fn(async () => []),
      proposeMembersFromGoal: vi.fn(async () => []),
      onOfficeViewed: (teamId) => node.manager.noteOfficeViewed(teamId),
    })
  }

  it('reloads of the team detail ask at most once per window, and a refused ask emits nothing that reloads it', async () => {
    const node = makeNode({ ...LONG, earlyGap: 500 })
    seedFormerMembership(node)
    const relay = await relayFor(OFFICE, 'refuse-version')
    const service = serviceOver(node)
    expect((await node.join(OFFICE, relay)).ok).toBe(false)

    // Right after a try, reads ask nothing.
    for (let i = 0; i < 25; i++) service.getTeamDetail(OFFICE)
    await sleep(200)
    expect(relay.joinRequests()).toBe(1)
    expect(node.anyEvent()).toBe(false)

    // A page reloads its detail on every member edit, toggle and team event.
    await sleep(400)
    for (let i = 0; i < 25; i++) service.getTeamDetail(OFFICE)
    await waitFor(() => relay.joinRequests() === 2)
    await sleep(300)
    expect(relay.joinRequests()).toBe(2)
    expect(node.anyEvent()).toBe(false)

    // Inside the window the reads ask nothing; past it, one read asks again.
    for (let i = 0; i < 25; i++) service.getTeamDetail(OFFICE)
    await sleep(100)
    expect(relay.joinRequests()).toBe(2)
    await sleep(500)
    for (let i = 0; i < 25; i++) service.getTeamDetail(OFFICE)
    await waitFor(() => relay.joinRequests() === 3)
    await sleep(300)
    expect(relay.joinRequests()).toBe(3)
    expect(node.anyEvent()).toBe(false)
  })

  it('asks again on the session a LAN host kept open after refusing it', async () => {
    const node = makeNode({ ...LONG, earlyGap: 0 })
    seedFormerMembership(node)
    const relay = await relayFor(OFFICE, 'refuse-and-keep')
    expect((await node.join(OFFICE, relay)).ok).toBe(false)

    node.manager.noteOfficeViewed(OFFICE)
    node.manager.noteOfficeViewed(OFFICE)
    await waitFor(() => relay.joinRequests() === 2)
    await sleep(200)

    expect(relay.joinRequests()).toBe(2)
    expect(relay.sessions()).toBe(1)
  })

  it('does nothing for an office that has not refused it', async () => {
    const node = makeNode({ ...LONG, earlyGap: 0 })
    const relay = await relayFor(OFFICE, 'grant')
    expect((await node.join(OFFICE, relay)).ok).toBe(true)

    for (let i = 0; i < 5; i++) node.manager.noteOfficeViewed(OFFICE)
    await sleep(200)

    expect(relay.joinRequests()).toBe(1)
  })

  it('asks at once when the refusing host joins an office of ours on our version', async () => {
    const node = makeNode(LONG)
    seedFormerMembership(node)
    const relay = await relayFor(OFFICE, 'refuse-version')
    expect((await node.join(OFFICE, relay)).ok).toBe(false)
    node.manager.hostOffice('office-mine')
    const joinFrom = (fromNode: string, pv: number): FederationMessage => ({
      kind: 'join-request', officeId: 'office-mine', fromNode, identityId: fromNode, credentialToken: 'invite-to-mine',
      bringMembers: [{ appId: `app-${fromNode}`, memberName: fromNode, role: 'Writer' }], pv,
    })

    // Still behind, or someone else: no reason to ask.
    node.manager.handleHostInbound({ clientId: 'c-host', officeId: 'office-mine', frame: joinFrom(HOST, FEDERATION_PROTOCOL_VERSION - 1) })
    node.manager.handleHostInbound({ clientId: 'c-peer', officeId: 'office-mine', frame: joinFrom(PEER, FEDERATION_PROTOCOL_VERSION) })
    await sleep(300)
    expect(relay.joinRequests()).toBe(1)

    // The host restarted on our version: its own office is asked again now.
    node.manager.handleHostInbound({ clientId: 'c-host', officeId: 'office-mine', frame: joinFrom(HOST, FEDERATION_PROTOCOL_VERSION) })
    await waitFor(() => relay.joinRequests() === 2)
    expect(relay.joinRequests()).toBe(2)
  })

  it('asks an office at once when another office of the same host admits us', async () => {
    const node = makeNode({ ...LONG, earlyGap: 0 })
    seedFormerMembership(node, 'office-one')
    seedFormerMembership(node, 'office-two')
    const one = await relayFor('office-one', 'refuse-version')
    const two = await relayFor('office-two', 'refuse-version')
    expect((await node.join('office-one', one)).ok).toBe(false)
    expect((await node.join('office-two', two)).ok).toBe(false)

    one.setMode('grant')
    node.manager.noteOfficeViewed('office-one')
    await waitFor(() => node.restored.includes('office-one'))

    await waitFor(() => two.joinRequests() === 2)
    expect(two.joinRequests()).toBe(2)
  })
})
