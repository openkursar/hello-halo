import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createDatabaseManager } from '../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../src/main/platform/store/types'
import { TeamStore } from '../../../src/main/apps/team/store'
import { migrations, MIGRATION_NAMESPACE } from '../../../src/main/apps/team/migrations'

type Handler = (event: unknown, input: any) => Promise<any>
const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, Handler>() }))
let store: TeamStore
let db: DatabaseManager
const localRead = vi.fn(), remoteRead = vi.fn()
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: Handler) => { handlers.set(name, handler) } } }))
vi.mock('../../../src/main/apps/team', () => ({ getTeamStore: () => store, getTeamService: () => null }))
vi.mock('../../../src/main/apps/runtime/app-chat', () => ({ readTeamMemberHistory: (...args: unknown[]) => localRead(...args) }))
vi.mock('../../../src/main/apps/runtime/federation/manager', () => ({ getFederationManager: () => ({ fetchMemberHistory: (...args: unknown[]) => remoteRead(...args) }) }))
vi.mock('../../../src/main/controllers/team-invite.controller', () => ({ generateTeamInvite: vi.fn(), revokeTeamInvite: vi.fn(), joinTeamOffice: vi.fn(), leaveTeamOffice: vi.fn() }))
vi.mock('../../../src/main/services/agent', () => ({ formatReferencesBlock: () => '', getWorkingDir: () => '/fixture' }))
import { registerTeamIpc } from '../../../src/main/ipc/team'

beforeEach(() => {
  vi.clearAllMocks(); handlers.clear()
  db = createDatabaseManager(':memory:')
  db.runMigrations(db.getAppDatabase(), MIGRATION_NAMESPACE, migrations)
  store = new TeamStore(db.getAppDatabase())
  for (const id of ['team', 'other']) store.insertTeam({ id, name: id, goal: '', owningSpaceId: 'space', leadAppId: null,
    memberSourcing: 'manual', collabMode: 'free', escalationRouting: 'user', status: 'idle', currentEpochId: null, createdAt: 1, updatedAt: 1 })
  for (const [id, teamId] of [['work', 'team'], ['separate', 'team'], ['foreign', 'other']]) store.insertEpoch({ id, teamId,
    lifecycle: 'conversation', startedAt: 1, endedAt: null, endReason: null, summary: null })
  for (const [appId, remote] of [['local-child', false], ['remote-child', true]] as const) store.participants.insert({
    teamId: 'team', epochId: 'work', appId, parentAppId: 'parent', memberName: appId, role: '', isLead: false,
    aiProvisioned: false, isTemporary: true, addedAt: 1, ...(remote ? { ownerNodeId: 'owner-node', origin: 'remote' as const } : {}),
  })
  localRead.mockReturnValue([{ role: 'assistant', content: 'Local record' }])
  remoteRead.mockResolvedValue({ messages: [{ role: 'assistant', content: 'Remote record' }], stale: true })
  registerTeamIpc()
})
afterEach(() => db.closeAll())
const history = (appId: string, epochId = 'work') => handlers.get('team:chat-messages')!(null, { teamId: 'team', appId, epochId })

it('routes temporary member history by the owner in its explicit work, including retained closed history', async () => {
  store.endEpoch('work', 2, 'stopped', null)
  expect(await history('local-child')).toEqual({ success: true, data: [{ role: 'assistant', content: 'Local record' }] })
  expect(await history('remote-child')).toEqual({ success: true, data: [{ role: 'assistant', content: 'Remote record' }], stale: true })
  expect(localRead).toHaveBeenCalledWith('local-child', 'team', 'work', undefined)
  expect(remoteRead).toHaveBeenCalledWith({ officeId: 'team', ownerNodeId: 'owner-node', appId: 'remote-child', epochId: 'work', sinceSeq: undefined })
})

it('does not fall back to a temporary actor history in another or missing work scope', async () => {
  for (const epoch of ['separate', 'foreign', 'missing', '']) expect(await history('remote-child', epoch)).toEqual({ success: true, data: [] })
  expect(localRead).not.toHaveBeenCalled()
  expect(remoteRead).not.toHaveBeenCalled()
})
