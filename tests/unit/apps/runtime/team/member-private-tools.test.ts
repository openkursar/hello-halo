import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabaseManager } from '../../../../../src/main/platform/store/database-manager'
import { TeamStore } from '../../../../../src/main/apps/team/store'
import { migrations, MIGRATION_NAMESPACE } from '../../../../../src/main/apps/team/migrations'
import { createParticipantService } from '../../../../../src/main/apps/team/participant-service'
import { buildTeamSessionKey, spaceCoordinatorAppId } from '../../../../../src/shared/apps/team-types'

const host = vi.hoisted(() => ({ store: null as any, service: null as any }))
vi.mock('../../../../../src/main/apps/team', async () => ({ ...await import('../../../../../src/main/apps/team/work-members'), getTeamStore: () => host.store, getTeamService: () => host.service }))
vi.mock('../../../../../src/main/apps/conversation-mcp', () => ({ createSpaceTeamMcpServer: vi.fn() }))
vi.mock('../../../../../src/main/apps/manager', () => ({ getAppManager: () => null }))
vi.mock('../../../../../src/main/apps/runtime/im-channels', () => ({ getActiveImChannelManager: () => null }))
vi.mock('../../../../../src/main/apps/runtime/im-session-registry', () => ({ getImSessionRegistry: () => null }))
vi.mock('../../../../../src/main/apps/runtime/im-channels/file-send-resolve', () => ({ resolveImFileSend: () => undefined }))
vi.mock('../../../../../src/main/services/space.service', () => ({ getSpaceDir: () => '/space' }))
vi.mock('../../../../../src/main/services/agent/resolved-sdk', async () => import('../../../../../src/main/services/agent/mcp/sdk-server'))
import { bindTeamToolSession } from '../../../../../src/main/apps/runtime/team/tool-session'
import { createMessageBus } from '../../../../../src/main/apps/runtime/team/message-bus'
import { createWorkMembership } from '../../../../../src/main/apps/runtime/team/membership'

const cleanups: Array<() => void> = []
afterEach(() => { cleanups.splice(0).reverse().forEach(fn => fn()); host.store = null; host.service = null })

it.each([undefined, 'colleague', 'guest'] as const)('keeps public work separate while allowing private handle operations under %s authority', async origin => {
  const directory = mkdtempSync(join(tmpdir(), 'member-private-tools-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const database = createDatabaseManager(':memory:')
  cleanups.push(() => database.closeAll())
  database.runMigrations(database.getAppDatabase(), MIGRATION_NAMESPACE, migrations)
  const store = host.store = new TeamStore(database.getAppDatabase())
  const sourceKey = buildTeamSessionKey('parent', 'public', 'public-work')
  const coordinator = spaceCoordinatorAppId(sourceKey)
  for (const [id, lead] of [['public', 'lead'], ['private', coordinator]]) {
    store.insertTeam({ id, name: id, owningSpaceId: 'space', goal: '', leadAppId: lead, memberSourcing: 'manual', collabMode: 'free',
      escalationRouting: 'user', status: 'idle', currentEpochId: null, createdAt: 1, updatedAt: 1,
      ...(id === 'private' ? { ephemeral: true, coordinatorConversationId: sourceKey } : {}) })
    store.insertEpoch({ id: `${id}-work`, teamId: id, startedAt: 1, endedAt: null, endReason: null, summary: null, lifecycle: 'conversation' })
    for (const appId of id === 'public' ? ['parent', 'lead', 'peer'] : [lead]) store.addMember({ teamId: id, appId, memberName: appId,
      role: '', isLead: appId === lead, aiProvisioned: false, addedAt: 1 })
  }
  const wake = vi.fn(async () => {})
  const bus = createMessageBus({ store: createWorkMembership(store), hooks: { isBusy: () => false, wakeTarget: wake } })
  const sends = vi.spyOn(bus, 'send')
  const stopMemberTurn = vi.fn(async () => true)
  const participants = createParticipantService({ store, getRuntime: () => ({ bus, stopMemberTurn }) })
  store.requests.track(sourceKey, 'root/parent')
  const work = { team: store.getTeamById('private')!, epochId: 'private-work' }
  host.service = { participants, ensureCollaboration: vi.fn(async () => work), getCollaborationScope: () => work }
  const postFinding = vi.fn(() => ({ findingId: 'finding' }))
  const readMemberRecord = vi.fn(async () => ({ ok: false as const, reason: 'unavailable' as const, message: 'record read' }))
  const binding = bindTeamToolSession(sourceKey, {
    teamId: 'public', epochId: 'public-work', callerAppId: 'parent', collabMode: 'free', selfIsLead: false,
    requestId: 'root/parent', origin, participants, bus, callerWorkDir: directory,
    blackboard: { postFinding, postActivity: vi.fn() } as any, readMemberRecord,
    canSpawn: () => true, spawnSource: () => ({ modelSelection: { modelSourceId: 'source', modelId: 'model' }, engineId: 'halo',
      permissions: { granted: [], denied: [] }, environment: { spaceId: 'space', spacePath: directory, workDir: directory, memoryDir: directory } }),
  })
  cleanups.push(binding.release)
  const call = async (name: string, input: Record<string, unknown>) => await binding.server.instance.callTool(name, input, {}) as { content: Array<{ text: string }>; isError?: boolean }
  const result = await call('spawn_agent', { prompt: 'Inspect only.', name: 'helper' })
  const handle = JSON.parse((result!.content[0] as any).text).handle
  expect(store.participants.list('public', 'public-work')).toHaveLength(0)
  expect(store.participants.list('private', 'private-work')).toHaveLength(1)
  expect(store.participants.getExecution('private', 'private-work', handle)?.requestId).toMatch(/^root\/parent\/assistant-/)
  await call('team_send', { to: 'peer', message: 'Public assignment' })
  await call('team_send', { to: handle, message: 'Private follow-up' })
  expect(sends.mock.calls.map(([input]) => input.teamId)).toEqual(['private', 'public', 'private'])
  await call('team_post_finding', { content: 'Shared finding' })
  expect(postFinding).toHaveBeenCalledWith(expect.objectContaining({ teamId: 'public', epochId: 'public-work' }))
  await call('team_read_member', { member: handle })
  expect(readMemberRecord).toHaveBeenCalledWith(expect.objectContaining({ teamId: 'private', memberAppId: handle }))
  expect(store.participants.getExecution('private', 'private-work', handle)?.origin).toBe(origin)
  readMemberRecord.mockClear()
  const publicRead = await call('team_read_member', { member: 'peer' })
  expect(publicRead.isError).toBe(true)
  expect(readMemberRecord).not.toHaveBeenCalled()
  const unknown = await call('team_send', { to: 'unowned-handle', message: 'Not authorized' })
  expect(unknown?.isError).toBe(true)
  await call('team_stop', { to: handle })
  expect(stopMemberTurn).toHaveBeenCalledWith(expect.objectContaining({ teamId: 'private', appId: handle }))
  expect(store.requests.cancelled('root/other-parent')).toBe(false)
  const next = await call('spawn_agent', { prompt: 'Another isolated assignment.' })
  const nextHandle = JSON.parse(next.content[0].text).handle
  const nestedSource = buildTeamSessionKey(nextHandle, 'private', 'private-work')
  const nestedCoordinator = spaceCoordinatorAppId(nestedSource)
  store.insertTeam({ ...work.team, id: 'nested', name: 'nested', leadAppId: nestedCoordinator, coordinatorConversationId: nestedSource })
  store.insertEpoch({ id: 'nested-work', teamId: 'nested', startedAt: 1, endedAt: null, endReason: null, summary: null, lifecycle: 'conversation' })
  store.addMember({ teamId: 'nested', appId: nestedCoordinator, memberName: 'coordinator', role: '', isLead: true, aiProvisioned: false, addedAt: 1 })
  const nestedWork = { team: store.getTeamById('nested')!, epochId: 'nested-work' }
  host.service.ensureCollaboration = async ({ conversationId }: { conversationId: string }) => conversationId === nestedSource ? nestedWork : work
  host.service.getCollaborationScope = (conversationId: string) => conversationId === nestedSource ? nestedWork : work
  const nested = bindTeamToolSession(nestedSource, {
    teamId: 'private', epochId: 'private-work', callerAppId: nextHandle, collabMode: 'free', selfIsLead: false,
    participants, bus, callerWorkDir: directory, blackboard: {} as any, canSpawn: () => true,
    spawnSource: () => store.participants.getExecution('private', 'private-work', nextHandle)!,
  })
  cleanups.push(nested.release)
  const nestedResult = await nested.server.instance.callTool('spawn_agent', { prompt: 'Nested private assignment.' }, {}) as { content: Array<{ text: string }> }
  const nestedHandle = JSON.parse(nestedResult.content[0].text).handle
  expect(store.participants.list('private', 'private-work')).toHaveLength(2)
  expect(store.participants.list('nested', 'nested-work')).toHaveLength(1)
  expect(store.sourceBindings.get(store.participants.getExecution('nested', 'nested-work', nestedHandle)!.requestId!)?.sourceKey).toBe(nestedSource)
  await participants.stopSource(sourceKey)
  expect(stopMemberTurn).toHaveBeenCalledWith(expect.objectContaining({ teamId: 'nested', appId: nestedHandle }))
  expect(stopMemberTurn).toHaveBeenCalledWith(expect.objectContaining({ teamId: 'private', appId: nextHandle }))
  expect(store.participants.getExecution('private', 'private-work', nextHandle)?.stopped).toBe(true)
  expect(store.requests.cancelled('root/parent')).toBe(false)
  expect(store.requests.cancelled('root/other-parent')).toBe(false)
  expect(store.participants.list('public', 'public-work')).toHaveLength(0)
})
