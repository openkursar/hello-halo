import { afterEach, describe, expect, it, vi } from 'vitest'
import http from 'http'
import { WebSocketServer, type WebSocket } from 'ws'
import { createDatabaseManager } from '../../../../../src/main/platform/store/database-manager'
import { TeamStore } from '../../../../../src/main/apps/team/store'
import { migrations as teamMigrations, MIGRATION_NAMESPACE as TEAM_NS } from '../../../../../src/main/apps/team/migrations'
import { FederationStore } from '../../../../../src/main/apps/federation/store'
import { AuthorityStore } from '../../../../../src/main/apps/federation/authority-store'
import { FeedStore } from '../../../../../src/main/apps/federation/feed-store'
import { migrations as federationMigrations, MIGRATION_NAMESPACE as FED_NS } from '../../../../../src/main/apps/federation/migrations'
import { createFederationManager } from '../../../../../src/main/apps/runtime/federation/manager'
import { buildTeamSessionKey } from '../../../../../src/shared/apps/team-types'
import { FEDERATION_PROTOCOL_VERSION } from '../../../../../src/shared/federation/protocol-version'
import { feedIdKey } from '../../../../../src/main/apps/runtime/federation/log/types'
import type { FederationMessage, RosterFrame, WakeFrame } from '../../../../../src/main/apps/runtime/federation/types'

const OFFICE = 'office-origin'
const OLD = 'old-authority'
const NEXT = 'new-authority'
const SELF = 'owner'
const PEER = 'other-peer'
const TARGET = 'target'
const EPOCH = 'epoch'
const cleanup: Array<() => Promise<void>> = []

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  expect(predicate()).toBe(true)
}

async function harness(gateway = false, existingOffice = true, history = false, stamped = gateway) {
  const db = createDatabaseManager(':memory:')
  db.runMigrations(db.getAppDatabase(), TEAM_NS, teamMigrations)
  db.runMigrations(db.getAppDatabase(), FED_NS, federationMigrations)
  const team = new TeamStore(db.getAppDatabase())
  const roster: RosterFrame = { kind: 'roster', officeId: OFFICE, version: 1, snapshot: {
    team: { id: OFFICE, name: 'Office', goal: 'Review', leadAppId: 'sender', collabMode: 'free', hostNodeId: OLD },
    members: [{ appId: TARGET, memberName: 'Target', role: 'Member', isLead: false, ownerNodeId: SELF, memberIdentity: null, ownerDisplayName: null },
      { appId: 'sender', memberName: 'Sender', role: 'Member', isLead: true, ownerNodeId: PEER, memberIdentity: null, ownerDisplayName: null }], edges: [] } }
  if (existingOffice) team.materializeJoinedOffice({ hostNodeId: OLD, selfNodeId: SELF, snapshot: roster.snapshot })
  let authority = OLD
  const realGetTeam = team.getTeamById.bind(team)
  vi.spyOn(team, 'getTeamById').mockImplementation(id => {
    const result = realGetTeam(id)
    return result ? { ...result, hostNodeId: authority } : result
  })
  const materialize = vi.spyOn(team, 'materializeJoinedOffice')
  const run = vi.fn(async () => ({ finalMessage: 'done' }))
  const readMemberHistory = vi.fn(() => [{ seq: 1, role: 'assistant' as const, content: 'reply retained on owner' }])
  const stopMemberTurn = vi.fn(async () => true)
  const outgoing: FederationMessage[] = []
  const server = http.createServer()
  const wss = new WebSocketServer({ server, path: '/ws' })
  let socket: WebSocket | undefined
  const send = (frame: FederationMessage, from?: string) => socket!.send(JSON.stringify({ type: 'federation', payload: frame, ...(from ? { from } : {}) }))
  wss.on('connection', client => {
    socket = client
    client.on('message', bytes => {
      const msg = JSON.parse(bytes.toString())
      if (msg.type === 'federation') outgoing.push(msg.payload)
      if (msg.type === 'auth') client.send(JSON.stringify({ type: 'auth:success', ...(gateway ? { payload: { wirePv: 2 } } : {}) }))
      if (msg.type === 'federation' && msg.payload.kind === 'join-request') {
        send({ kind: 'join-grant', officeId: OFFICE, assignedNodeId: SELF, pv: FEDERATION_PROTOCOL_VERSION }, stamped ? OLD : undefined)
        send(roster, stamped ? OLD : undefined)
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const manager = createFederationManager({ teamStore: team, federationStore: new FederationStore(db.getAppDatabase()),
    feedStore: new FeedStore(db.getAppDatabase()), hostSend: () => false, hostListOfficeClients: () => [],
    ...(history ? { authorityStore: new AuthorityStore(db.getAppDatabase()), readMemberHistory, stopMemberTurn } : {}),
    getLocalNodeId: () => SELF, getSessionIdentity: client => client, verifyCredential: () => null, runLocalTurn: run })
  cleanup.push(async () => { manager.stopAll(); for (const client of wss.clients) client.terminate(); wss.close(); await new Promise<void>(resolve => server.close(() => resolve())); db.closeAll() })
  await manager.joinOffice({ officeId: OFFICE, serverUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    credentialToken: 'test-token', selfContext: { officeId: OFFICE, selfNodeId: SELF }, bringMembers: [] })
  await waitFor(() => materialize.mock.calls.length === 1)
  team.insertEpoch({ id: EPOCH, teamId: OFFICE, startedAt: Date.now(), endedAt: null, endReason: null, summary: null, lifecycle: 'conversation' })
  const wake = (from: string, correlationId = 'wake'): WakeFrame => ({ kind: 'wake', officeId: OFFICE, fromNode: from, correlationId,
    request: { appId: TARGET, spaceId: 'ignored', message: 'Review', conversationId: buildTeamSessionKey(TARGET, OFFICE, EPOCH),
      teamContext: { teamId: OFFICE, epochId: EPOCH, fromAppId: 'sender', correlationId, wait: false, kind: 'message' } } })
  return { manager, team, run, send, wake, roster, materialize, readMemberHistory, stopMemberTurn, outgoing, setAuthority: (node: string) => { authority = node } }
}

afterEach(async () => { for (const close of cleanup.splice(0)) await close() })

describe('upstream transport identity', () => {
  it('accepts the first roster and wake from the directly joined host', async () => {
    const h = await harness(false, false)
    h.send(h.wake(OLD))
    await waitFor(() => h.run.mock.calls.length === 1)
  })

  it('does not relabel an old LAN socket as the new authority or accept its forged envelope sender', async () => {
    const h = await harness()
    h.setAuthority(NEXT)
    h.send(h.wake(NEXT), NEXT)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(h.run).not.toHaveBeenCalled()
    h.manager.deliverInbound(OFFICE, h.wake(NEXT, 'legitimate'), NEXT)
    await waitFor(() => h.run.mock.calls.length === 1)
  })

  it('keeps the gateway-stamped new host identity on the existing member socket', async () => {
    const h = await harness(true)
    h.setAuthority(NEXT)
    h.send(h.wake(NEXT), NEXT)
    await waitFor(() => h.run.mock.calls.length === 1)
  })

  it('keeps working after a host change on a relay that does not stamp host frames', async () => {
    // The deployed relay forwards host frames without a sender. The member keeps
    // its socket across the change; the successor's frames must not be pinned
    // to the first host the socket happened to see.
    const h = await harness(true, true, false, false)
    h.setAuthority(NEXT)
    h.send(h.wake(NEXT))
    await waitFor(() => h.run.mock.calls.length === 1)

    const successorRoster = structuredClone(h.roster)
    successorRoster.version = 2
    successorRoster.snapshot.team.hostNodeId = NEXT
    h.send(successorRoster)
    await waitFor(() => h.materialize.mock.calls.length === 2)
  })

  it('refuses a peer roster and a spoofed sender on a dialed peer connection', async () => {
    const h = await harness()
    const forged = structuredClone(h.roster)
    forged.snapshot.members[0].ownerNodeId = PEER
    h.manager.handleHostInbound({ clientId: PEER, officeId: OFFICE, frame: forged })
    expect(h.materialize).toHaveBeenCalledTimes(1)
    h.manager.deliverInbound(OFFICE, h.wake(OLD), PEER)
    expect(h.run).not.toHaveBeenCalled()
  })

  it('does not accept another author control feed sent by the old LAN socket', async () => {
    const h = await harness()
    h.setAuthority(NEXT)
    const wake = h.wake(NEXT)
    h.send({ kind: 'feed-entries', officeId: OFFICE, feedKey: feedIdKey({ officeId: OFFICE, author: NEXT, kind: `ctrl:${SELF}` }),
      upToSeq: 1, more: false, entries: [{ seq: 1, hlc: '0'.repeat(16), fid: 'spoofed-feed', ts: Date.now(), type: 'wake',
        payload: { target: SELF, from: NEXT, correlationId: wake.correlationId, request: wake.request } }] }, NEXT)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(h.run).not.toHaveBeenCalled()
  })

  it('serves an authority-relayed history request without accepting forged relay claims from peers', async () => {
    const h = await harness(false, true, true)
    h.send({ kind: 'history-request', officeId: OFFICE, teamId: OFFICE, appId: TARGET, epochId: EPOCH,
      fromNode: PEER, relayed: true, fid: 'relayed-history' })
    await waitFor(() => h.outgoing.some(frame => frame.kind === 'history-response' && frame.reFid === 'relayed-history'))
    expect(h.readMemberHistory).toHaveBeenCalledWith(expect.objectContaining({
      requester: { nodeId: OLD, frame: expect.objectContaining({ fromNode: PEER, relayed: true }) },
    }))
    expect(h.outgoing).toContainEqual(expect.objectContaining({ kind: 'history-response', reFid: 'relayed-history',
      messages: [{ seq: 1, role: 'assistant', content: 'reply retained on owner' }] }))

    h.manager.handleHostInbound({ clientId: PEER, officeId: OFFICE, frame: {
      kind: 'history-request', officeId: OFFICE, teamId: OFFICE, appId: TARGET, epochId: EPOCH,
      fromNode: OLD, relayed: true, fid: 'forged-history',
    } })
    expect(h.readMemberHistory).toHaveBeenCalledTimes(1)
    h.manager.deliverInbound(OFFICE, { kind: 'history-request', officeId: OFFICE, teamId: OFFICE,
      appId: TARGET, epochId: EPOCH, fromNode: PEER, relayed: true, fid: 'peer-as-relay' }, PEER)
    expect(h.readMemberHistory).toHaveBeenCalledTimes(1)
    h.send({ ...h.wake(PEER), relayed: true } as FederationMessage)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(h.run).not.toHaveBeenCalled()
  })
  it('carries out a stop the authority relayed for another viewer, and refuses a peer posing as the relay', async () => {
    const h = await harness(false, true, true)
    h.send({ kind: 'stop-turn-request', officeId: OFFICE, fromNode: PEER, teamId: OFFICE, appId: TARGET,
      epochId: EPOCH, relayed: true, fid: 'relayed-stop' })
    await waitFor(() => h.outgoing.some(frame => frame.kind === 'stop-turn-response' && frame.reFid === 'relayed-stop'))
    expect(h.stopMemberTurn).toHaveBeenCalledTimes(1)

    h.manager.deliverInbound(OFFICE, { kind: 'stop-turn-request', officeId: OFFICE, fromNode: OLD, teamId: OFFICE,
      appId: TARGET, epochId: EPOCH, relayed: true, fid: 'peer-as-relay' }, PEER)
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(h.stopMemberTurn).toHaveBeenCalledTimes(1)
  })
})
