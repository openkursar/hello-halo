/**
 * A viewer's cached copy of a remote member's transcript is reconciled with the
 * owner after it is served: rows of the last turn may have moved or changed on
 * the owner after they were replicated, so the copy is checked from its last
 * reply on, not only past its highest seq.
 */
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
import { historyCacheKey } from '../../../../../src/main/apps/runtime/federation/session-feed'
import { FEDERATION_PROTOCOL_VERSION } from '../../../../../src/shared/federation/protocol-version'
import type { SerializedHistoryMessage } from '../../../../../src/main/apps/runtime/federation/protocol-m2'
import type { FederationMessage, RosterFrame } from '../../../../../src/main/apps/runtime/federation/types'

const OFFICE = 'office-history'
const HOST = 'host'
const SELF = 'viewer'
const OWNER = 'owner'
const MEMBER = 'member'
const EPOCH = 'epoch'
const CACHE_KEY = historyCacheKey(OWNER, MEMBER, EPOCH)
const cleanup: Array<() => Promise<void>> = []

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  expect(predicate()).toBe(true)
}

const row = (seq: number, role: string, content: string): SerializedHistoryMessage => ({ seq, role, content })

async function harness() {
  const db = createDatabaseManager(':memory:')
  db.runMigrations(db.getAppDatabase(), TEAM_NS, teamMigrations)
  db.runMigrations(db.getAppDatabase(), FED_NS, federationMigrations)
  const team = new TeamStore(db.getAppDatabase())
  const feedStore = new FeedStore(db.getAppDatabase())
  const roster: RosterFrame = { kind: 'roster', officeId: OFFICE, version: 1, snapshot: {
    team: { id: OFFICE, name: 'Office', goal: 'Review', leadAppId: MEMBER, collabMode: 'free', hostNodeId: HOST },
    members: [{ appId: MEMBER, memberName: 'Member', role: 'Member', isLead: true, ownerNodeId: OWNER, memberIdentity: null, ownerDisplayName: null }],
    edges: [] } }
  const materialize = vi.spyOn(team, 'materializeJoinedOffice')
  const outgoing: FederationMessage[] = []
  const server = http.createServer()
  const wss = new WebSocketServer({ server, path: '/ws' })
  let socket: WebSocket | undefined
  const send = (frame: FederationMessage) => socket!.send(JSON.stringify({ type: 'federation', payload: frame }))
  wss.on('connection', client => {
    socket = client
    client.on('message', bytes => {
      const msg = JSON.parse(bytes.toString())
      if (msg.type === 'federation') outgoing.push(msg.payload)
      if (msg.type === 'auth') client.send(JSON.stringify({ type: 'auth:success' }))
      if (msg.type === 'federation' && msg.payload.kind === 'join-request') {
        send({ kind: 'join-grant', officeId: OFFICE, assignedNodeId: SELF, pv: FEDERATION_PROTOCOL_VERSION })
        send(roster)
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const onMemberHistoryUpdated = vi.fn()
  const manager = createFederationManager({ teamStore: team, federationStore: new FederationStore(db.getAppDatabase()),
    feedStore, authorityStore: new AuthorityStore(db.getAppDatabase()), hostSend: () => false, hostListOfficeClients: () => [],
    onMemberHistoryUpdated, getLocalNodeId: () => SELF, getSessionIdentity: client => client, verifyCredential: () => null,
    runLocalTurn: vi.fn(async () => ({ finalMessage: 'done' })) })
  cleanup.push(async () => { manager.stopAll(); for (const client of wss.clients) client.terminate(); wss.close(); await new Promise<void>(resolve => server.close(() => resolve())); db.closeAll() })
  await manager.joinOffice({ officeId: OFFICE, serverUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    credentialToken: 'test-token', selfContext: { officeId: OFFICE, selfNodeId: SELF }, bringMembers: [] })
  await waitFor(() => materialize.mock.calls.length === 1)

  const seed = (rows: SerializedHistoryMessage[]) => { for (const m of rows) feedStore.putCache(OFFICE, CACHE_KEY, m.seq, JSON.stringify(m)) }
  const cached = () => feedStore.listCache(OFFICE, CACHE_KEY, 0, 100).map(r => JSON.parse(r.entryJson) as SerializedHistoryMessage)
  const fetch = () => manager.fetchMemberHistory({ officeId: OFFICE, ownerNodeId: OWNER, appId: MEMBER, epochId: EPOCH })
  const requests = () => outgoing.filter((f): f is Extract<FederationMessage, { kind: 'history-request' }> => f.kind === 'history-request')
  const answer = (fid: string, messages: SerializedHistoryMessage[]) => send({ kind: 'history-response', officeId: OFFICE,
    fromNode: HOST, reFid: fid, teamId: OFFICE, appId: MEMBER, epochId: EPOCH, messages, fid: `re-${fid}` } as FederationMessage)
  return { seed, cached, fetch, requests, answer, onMemberHistoryUpdated }
}

afterEach(async () => { for (const close of cleanup.splice(0)) await close() })

describe('member history cache reconcile', () => {
  it('rewrites the last turn from the owner, including rows below the cached high-water, and drops rows the owner lacks', async () => {
    const h = await harness()
    // The copy holds the turn as it was replicated mid-turn: the reply is
    // missing and a duplicated arrival took its place.
    h.seed([row(1, 'user', 'q1'), row(2, 'assistant', 'a1'), row(3, 'user', 'q2'), row(4, 'user', 'from writer'),
      row(5, 'user', 'from writer'), row(6, 'user', 'from lead')])

    const first = await h.fetch()
    expect(first.messages.map(m => m.content)).toEqual(['q1', 'a1', 'q2', 'from writer', 'from writer', 'from lead'])
    await waitFor(() => h.requests().length === 1)
    // Checked from the last cached reply on, not past the highest cached seq.
    expect(h.requests()[0].sinceSeq).toBe(1)

    h.answer(h.requests()[0].fid, [row(2, 'assistant', 'a1'), row(3, 'user', 'q2'), row(4, 'assistant', 'a2'),
      row(5, 'user', 'from writer')])
    await waitFor(() => h.cached().length === 5)
    expect(h.cached().map(m => `${m.seq}:${m.content}`)).toEqual(['1:q1', '2:a1', '3:q2', '4:a2', '5:from writer'])
    await waitFor(() => h.onMemberHistoryUpdated.mock.calls.length === 1)
  })

  it('leaves a copy that matches the owner untouched and silent', async () => {
    const h = await harness()
    const rows = [row(1, 'user', 'q1'), row(2, 'assistant', 'a1')]
    h.seed(rows)
    await h.fetch()
    await waitFor(() => h.requests().length === 1)
    expect(h.requests()[0].sinceSeq).toBe(1)
    h.answer(h.requests()[0].fid, rows.slice(1))
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(h.cached()).toEqual(rows)
    expect(h.onMemberHistoryUpdated).not.toHaveBeenCalled()
  })
})
