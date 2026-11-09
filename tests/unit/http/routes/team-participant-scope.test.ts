import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import express, { type Request } from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import { TeamStore } from '../../../../src/main/apps/team/store'
import { migrations, MIGRATION_NAMESPACE } from '../../../../src/main/apps/team/migrations'
import type { TeamMember, TeamParticipant } from '../../../../src/shared/apps/team-types'

let store: TeamStore
let db: DatabaseManager
let server: Server
let base: string
const read = vi.fn()
const remote = vi.fn()
const send = vi.fn()
const stop = vi.fn()
const collaboration = vi.fn()
vi.mock('../../../../src/main/apps/team', async () => ({
  getTeamStore: () => store,
  getTeamService: () => ({ listConversations: () => [], sendToMember: (input: unknown) => send(input), stopMember: (input: unknown) => stop(input),
    getCollabForConversation: (id: string) => collaboration(id) }),
  workMemberPrincipalId: (await vi.importActual<typeof import('../../../../src/main/apps/team/work-members')>('../../../../src/main/apps/team/work-members')).workMemberPrincipalId,
}))
vi.mock('../../../../src/main/http/auth/middleware', () => ({
  getOfficeCredential: (req: Request) => req.get('x-office') ? { officeId: req.get('x-office'), identity: req.get('x-identity') } : null,
}))
vi.mock('../../../../src/main/apps/runtime/app-chat', () => ({ readTeamMemberHistory: (...args: unknown[]) => read(...args) }))
vi.mock('../../../../src/main/apps/runtime/federation/manager', () => ({ getFederationManager: () => ({ fetchMemberHistory: (...args: unknown[]) => remote(...args) }) }))
vi.mock('../../../../src/main/services/agent', () => ({ formatReferencesBlock: () => '', getWorkingDir: () => '/fixture' }))

import { registerTeamRoutes } from '../../../../src/main/http/routes/team.routes'

const child = (appId: string, parentAppId: string, ownerNodeId?: string): TeamParticipant => ({
  appId, parentAppId, ownerNodeId, teamId: 'team', epochId: 'work', memberName: appId, role: '',
  isLead: false, aiProvisioned: false, isTemporary: true, addedAt: 1, origin: ownerNodeId ? 'remote' : 'local',
})

beforeEach(async () => {
  vi.clearAllMocks()
  db = createDatabaseManager(':memory:')
  db.runMigrations(db.getAppDatabase(), MIGRATION_NAMESPACE, migrations)
  store = new TeamStore(db.getAppDatabase())
  for (const id of ['team', 'other']) store.insertTeam({ id, name: id, goal: '', owningSpaceId: 'space', leadAppId: 'lead', memberSourcing: 'manual',
    collabMode: 'free', escalationRouting: 'user', status: 'idle', currentEpochId: null, createdAt: 1, updatedAt: 1 })
  for (const [id, teamId] of [['work', 'team'], ['separate', 'team'], ['foreign', 'other']]) store.insertEpoch({
    id, teamId, lifecycle: 'conversation', startedAt: 1, endedAt: null, endReason: null, summary: null,
  })
  const members: Array<Partial<TeamMember> & { appId: string }> = [
    { appId: 'lead', memberIdentity: 'lead-owner', isLead: true },
    { appId: 'local-parent', memberIdentity: 'local-owner' },
    { appId: 'remote-parent', memberIdentity: 'remote-owner', ownerNodeId: 'remote-node', origin: 'remote', scopeJson: JSON.stringify({ visibility: 'assigned', discoverable: false }) },
    { appId: 'restricted', memberIdentity: 'restricted-owner', scopeJson: JSON.stringify({ visibility: 'readonly', discoverable: false }) },
  ]
  for (const member of members) store.addMember({ teamId: 'team', memberName: member.appId, role: '', isLead: false, aiProvisioned: false, addedAt: 1, ...member })
  store.participants.insert(child('local-child', 'local-parent'))
  store.participants.insert(child('remote-child', 'remote-parent', 'remote-node'))
  store.participants.insert(child('nested-child', 'remote-child', 'remote-node'))
  read.mockReturnValue([{ seq: 1, role: 'assistant', content: 'Persisted local work' }])
  remote.mockResolvedValue({ messages: [{ seq: 1, role: 'assistant', content: 'Persisted remote work' }], stale: false })
  send.mockResolvedValue({ ok: true, finalMessage: 'Reply' })
  stop.mockResolvedValue({ ok: true, stopped: true })
  const app = express(); app.use(express.json()); registerTeamRoutes(app)
  server = await new Promise<Server>(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); db.closeAll() })

const credential = (identity: string, office = 'team') => ({ 'x-office': office, 'x-identity': identity })
const history = (appId: string, epochId = 'work', headers: Record<string, string> = {}) => fetch(`${base}/api/teams/team/chat-messages?appId=${appId}&epochId=${epochId}`, { headers })
const action = (appId: string, verb: string, epochId = 'work', headers: Record<string, string> = {}) => fetch(`${base}/api/teams/team/members/${appId}/${verb}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ epochId, message: 'Continue this work.' }),
})

it('reads a real scoped local participant and routes a remote participant to its owner without standing membership', async () => {
  expect(store.listMembersByTeam('team').some(member => member.appId === 'local-child')).toBe(false)
  const local = await history('local-child')
  expect(local.status).toBe(200)
  expect((await local.json()).data[0].content).toBe('Persisted local work')
  expect(read).toHaveBeenCalledWith('local-child', 'team', 'work', undefined)
  const elsewhere = await history('remote-child')
  expect(elsewhere.status).toBe(200)
  expect((await elsewhere.json()).data[0].content).toBe('Persisted remote work')
  expect(remote).toHaveBeenCalledWith({ officeId: 'team', ownerNodeId: 'remote-node', appId: 'remote-child', epochId: 'work', sinceSeq: undefined })
})

it('rejects absent, different-work and foreign-team scopes before history or dispatch', async () => {
  for (const epochId of ['separate', 'foreign', 'missing']) {
    expect((await history('remote-child', epochId)).status).toBe(404)
    expect((await action('remote-child', 'send', epochId)).status).toBe(404)
    expect((await action('remote-child', 'stop', epochId)).status).toBe(404)
  }
  expect((await history('local-parent', 'foreign')).status).toBe(404)
  expect(read).not.toHaveBeenCalled(); expect(remote).not.toHaveBeenCalled()
  expect(send).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
})

it('uses scoped membership for member contact and stop, without changing the addressed work', async () => {
  expect((await action('remote-child', 'send')).status).toBe(200)
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ teamId: 'team', appId: 'remote-child', epochId: 'work' }))
  expect((await action('remote-child', 'stop')).status).toBe(200)
  expect(stop).toHaveBeenCalledWith({ teamId: 'team', appId: 'remote-child', epochId: 'work' })
})

it('lets an authenticated owner read nested participants while retaining peer and office denials', async () => {
  expect((await history('nested-child', 'work', credential('remote-owner'))).status).toBe(200)
  expect((await history('remote-child', 'work', credential('restricted-owner'))).status).toBe(404)
  expect((await history('remote-child', 'work', credential('unknown'))).status).toBe(404)
  expect((await history('remote-child', 'work', credential('lead-owner', 'other'))).status).toBe(403)
  expect(remote).toHaveBeenCalledTimes(1)
})

it('enforces readonly callers and inherited lead-only contact limits for temporary targets', async () => {
  for (const verb of ['send', 'stop']) expect((await action('remote-child', verb, 'work', credential('restricted-owner'))).status).toBe(403)
  store.setMemberScope('team', 'remote-parent', JSON.stringify({ contactable: 'lead-only' }))
  for (const verb of ['send', 'stop']) expect((await action('remote-child', verb, 'work', credential('local-owner'))).status).toBe(403)
  expect(send).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
  expect((await action('remote-child', 'send', 'work', credential('lead-owner'))).status).toBe(200)
})

it('allows owner source inspection without exposing private scopes to office credentials', async () => {
  const source = 'app-chat:local-parent:team:team:work'
  const summary = { teamId: 'private', epochId: 'private-work', members: [{ appId: 'private-helper' }] }
  collaboration.mockReturnValue(summary)
  const route = `${base}/api/teams/collab-for-conversation/${encodeURIComponent(source)}`
  const owner = await fetch(route)
  expect(owner.status).toBe(200)
  expect((await owner.json()).data).toEqual(summary)
  expect(collaboration).toHaveBeenCalledWith(source)
  collaboration.mockClear()
  for (const identity of ['local-owner', 'lead-owner', 'unknown']) {
    expect((await fetch(route, { headers: credential(identity) })).status).toBe(403)
  }
  expect(collaboration).not.toHaveBeenCalled()
})

it('keeps the required-work contract and never selects the latest scope for a temporary handle', async () => {
  expect((await fetch(`${base}/api/teams/team/chat-messages?appId=local-child`)).status).toBe(404)
  const standing = await fetch(`${base}/api/teams/team/chat-messages?appId=local-parent`)
  expect(standing.status).toBe(400)
  expect((await standing.json()).code).toBe('halo.team.conversation_required')
  expect(read).not.toHaveBeenCalled(); expect(remote).not.toHaveBeenCalled()
})
