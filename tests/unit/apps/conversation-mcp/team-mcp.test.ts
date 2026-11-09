import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCollaborationServer, createMessageBus, type TeamDelivery, type CollaborationResult } from '@hello-halo/agent-sdk/collaboration'

const refs = vi.hoisted(() => ({ service: null as any, runtime: null as any, directory: '', app: null as any }))
vi.mock('../../../../src/main/services/agent/resolved-sdk', async () =>
  import('../../../../src/main/services/agent/mcp/sdk-server'))
vi.mock('../../../../src/main/apps/team', async () => ({
  ...(await import('../../../../src/main/apps/team/work-members')), getTeamService: () => refs.service,
}))
vi.mock('../../../../src/main/apps/runtime/team', async () => ({
  createCoordinationMcpServer: (await import('../../../../src/main/apps/runtime/team/team-tools')).createCoordinationMcpServer,
  getActiveTeamRuntime: () => refs.runtime,
}))
vi.mock('../../../../src/main/services/space.service', () => ({ getSpace: (id: string) => id === 'space-1' ? { path: refs.directory } : null }))
vi.mock('../../../../src/main/apps/manager', () => ({ getAppManager: () => ({ getApp: () => refs.app, listEffectiveMcpApps: () => [] }) }))
vi.mock('../../../../src/main/http/websocket', () => ({ broadcastToAll: vi.fn() }))
vi.mock('../../../../src/main/foundation/window.service', () => ({ sendToRenderer: vi.fn() }))

import { createSpaceTeamMcpServer, type SpaceTeamMcpScope } from '../../../../src/main/apps/conversation-mcp/team-mcp'
import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import type { DatabaseManager } from '../../../../src/main/platform/store/types'
import { TeamStore } from '../../../../src/main/apps/team/store'
import { MIGRATION_NAMESPACE, migrations } from '../../../../src/main/apps/team/migrations'
import { createParticipantService } from '../../../../src/main/apps/team/participant-service'
import { createWorkMembership } from '../../../../src/main/apps/runtime/team/membership'
import { createBlackboard } from '../../../../src/main/apps/runtime/team/blackboard'
import { spaceCoordinatorAppId } from '../../../../src/shared/apps/team-types'

let db: DatabaseManager
let store: TeamStore
let deliveries: TeamDelivery[]
let busy: Set<string>
let counter: number

beforeEach(async () => {
  refs.directory = await realpath(await mkdtemp(join(tmpdir(), 'halo-source-mcp-')))
  refs.app = null
  db = createDatabaseManager(':memory:')
  db.runMigrations(db.getAppDatabase(), MIGRATION_NAMESPACE, migrations)
  store = new TeamStore(db.getAppDatabase())
  deliveries = []; busy = new Set(); counter = 0
  const bus = createMessageBus({ store: createWorkMembership(store), hooks: {
    isBusy: key => busy.has(key),
    wakeTarget: async request => { busy.add(request.sessionKey); deliveries.push(...request.deliveries!) },
  } })
  refs.runtime = { bus, blackboard: createBlackboard({ store }),
    teamFolders: { forMember: vi.fn(() => null) },
    stopMemberTurn: vi.fn(async () => true), discardReports: vi.fn() }
  const participants = createParticipantService({ store, getRuntime: () => refs.runtime })
  const contexts = new Map<string, { teamId: string; epochId: string }>()
  refs.service = { participants, getTeam: (id: string) => store.getTeamById(id),
    getCollabForConversation: (id: string) => contexts.get(id),
    getCollaborationScope: (id: string) => { const context = contexts.get(id); return context ? { team: store.getTeamById(context.teamId), epochId: context.epochId } : null },
    ensureCollaboration: vi.fn(async (input: { owningSpaceId: string; conversationId: string }) => {
      const old = contexts.get(input.conversationId)
      if (old) return { team: store.getTeamById(old.teamId), epochId: old.epochId }
      const id = `team-${++counter}`, epochId = `work-${counter}`
      const team = { id, name: `Conversation ${counter}`, owningSpaceId: input.owningSpaceId, goal: '',
        leadAppId: spaceCoordinatorAppId(input.conversationId), memberSourcing: 'manual' as const,
        collabMode: 'free' as const, escalationRouting: 'user' as const, status: 'idle' as const,
        currentEpochId: null, ephemeral: true, coordinatorConversationId: input.conversationId, createdAt: 1, updatedAt: 1 }
      store.insertTeam(team)
      store.insertEpoch({ id: epochId, teamId: id, startedAt: 1, endedAt: null, endReason: null, summary: null, lifecycle: 'conversation' })
      store.addMember({ teamId: id, appId: team.leadAppId, memberName: 'coordinator', role: 'Coordinator',
        isLead: true, isSystemCoordinator: true, aiProvisioned: false, addedAt: 1 })
      contexts.set(input.conversationId, { teamId: id, epochId })
      return { team, epochId }
    }),
  }
})
afterEach(async () => { db.closeAll(); await rm(refs.directory, { recursive: true, force: true }) })

function server(overrides: Partial<SpaceTeamMcpScope> = {}) {
  return createSpaceTeamMcpServer({ spaceId: 'space-1', conversationId: 'conversation-1', workDir: refs.directory,
    modelSelection: { modelSourceId: 'parent-source', modelId: 'parent-model' },
    executionOptions: () => ({ engineId: 'halo', collaborationEnabled: true, mcpServerNames: ['user-jira'],
      allowedTools: ['Read'], disallowedTools: ['Bash'], permissionMode: 'default' }), ...overrides })
}
async function spawn(endpoint: ReturnType<typeof server>, name = 'reviewer') {
  const reply = await endpoint.instance.callTool('spawn_agent', { name, prompt: `Review as ${name}; return evidence.` }) as CollaborationResult | undefined
  expect(reply?.isError, JSON.stringify(reply)).not.toBe(true)
  return JSON.parse((reply!.content[0] as { text: string }).text) as { handle: string; name: string }
}

describe('conversation collaboration MCP', () => {
  it('advertises exactly the same nine schemas as the standalone package, without management tools', () => {
    const tools = server().instance.listTools()
    const operations = Object.fromEntries(tools.map(tool => [tool.name, async () => ({ content: [] })]))
    expect(tools).toEqual(createCollaborationServer(operations).instance.listTools())
    expect(tools.map(tool => tool.name)).toHaveLength(9)
    expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining(['spawn_agent', 'team_stop', 'team_read_member']))
    for (const name of ['collab_start', 'collab_save', 'team_list', 'team_run', 'team_status', 'team_complete', 'team_schedule']) {
      expect(tools.map(tool => tool.name)).not.toContain(name)
    }
  })

  it('creates the first and later members within one host-bound work context', async () => {
    const endpoint = server()
    const first = await spawn(endpoint)
    const second = await spawn(endpoint, 'tester')
    const context = refs.service.getCollabForConversation('conversation-1')
    expect(counter).toBe(1)
    expect(first.handle).not.toBe(second.handle)
    expect(store.participants.list(context.teamId, context.epochId)).toHaveLength(2)
    expect(deliveries.map(delivery => delivery.envelope.body)).toEqual(['Review as reviewer; return evidence.', 'Review as tester; return evidence.'])
    expect(store.participants.getExecution(context.teamId, context.epochId, first.handle)).toMatchObject({
      engineId: 'halo', modelSelection: { modelSourceId: 'parent-source', modelId: 'parent-model' },
      allowedTools: ['Read'], disallowedTools: ['Bash'], mcpServerNames: ['user-jira'],
    })
    expect(store.listMembersByTeam(context.teamId)).toHaveLength(1)
  })

  it('retains a collaborator for follow-up and stop without a new group', async () => {
    const endpoint = server()
    const member = await spawn(endpoint)
    expect(await endpoint.instance.callTool('team_send', { to: member.handle, message: 'Also check cancellation.' })).not.toMatchObject({ isError: true })
    expect(await endpoint.instance.callTool('team_stop', { to: member.handle })).not.toMatchObject({ isError: true })
    expect(refs.runtime.stopMemberTurn).toHaveBeenCalledWith(expect.objectContaining({ appId: member.handle }))
    const context = refs.service.getCollabForConversation('conversation-1')
    expect(store.participants.getExecution(context.teamId, context.epochId, member.handle)?.stopped).toBe(true)
    expect(counter).toBe(1)
  })

  it('does not offer creation when disabled and validates unsupported scope or model arguments', async () => {
    expect(server({ collaborationEnabled: false }).instance.listTools().map(tool => tool.name)).not.toContain('spawn_agent')
    const endpoint = server()
    expect(await endpoint.instance.callTool('spawn_agent', { prompt: 'Review', team_id: 'foreign' })).toMatchObject({ isError: true })
    expect(await endpoint.instance.callTool('spawn_agent', { prompt: 'Review', model: 'invented' })).toMatchObject({ isError: true })
    expect(refs.service.ensureCollaboration).not.toHaveBeenCalled()
  })

  it.each([
    { modelSelection: undefined },
    { executionOptions: undefined, collaborationEnabled: true },
    { spaceId: 'missing-space' },
    { canSpawn: () => false },
  ])('refuses an unavailable source before allocating work (%j)', async overrides => {
    expect(await server(overrides).instance.callTool('spawn_agent', { prompt: 'Review' })).toMatchObject({ isError: true })
    expect(refs.service.ensureCollaboration).not.toHaveBeenCalled()
    expect(deliveries).toHaveLength(0)
  })

  it('refuses ordinary coordination before creation, then resolves the new context in the same endpoint', async () => {
    const endpoint = server()
    const before = await endpoint.instance.callTool('team_send', { to: 'missing', message: 'Hello' }) as CollaborationResult
    expect(before).toMatchObject({ isError: true })
    expect((before!.content[0] as { text: string }).text).toContain('spawn_agent')
    expect(await endpoint.instance.callTool('team_read_board', {})).not.toMatchObject({ isError: true })
    const member = await spawn(endpoint)
    const board = await endpoint.instance.callTool('team_read_board', {}) as CollaborationResult
    expect(board?.isError).not.toBe(true)
    expect(JSON.stringify(board)).toContain(member.name)
  })

  it('isolates conversations even when a foreign handle or team id is known', async () => {
    const first = server(), second = server({ conversationId: 'conversation-2' })
    const member = await spawn(first)
    await spawn(second, 'other')
    expect(await second.instance.callTool('team_send', { to: member.handle, message: 'Cross scope' })).toMatchObject({ isError: true })
    expect(await second.instance.callTool('team_stop', { to: member.handle })).toMatchObject({ isError: true })
    expect(refs.runtime.stopMemberTurn).not.toHaveBeenCalled()
    expect(deliveries).toHaveLength(2)
    expect(counter).toBe(2)
  })

  it('refuses a source endpoint in another space even when its conversation and member handle are known', async () => {
    const member = await spawn(server())
    const wrongSpace = server({ spaceId: 'another-space' })
    expect(await wrongSpace.instance.callTool('team_send', { to: member.handle, message: 'Wrong source space' })).toMatchObject({ isError: true })
    expect(deliveries).toHaveLength(1)
    expect(refs.runtime.stopMemberTurn).not.toHaveBeenCalled()
  })

  it('keeps an already-stopped endpoint invalid after a later user request resumes the conversation', async () => {
    const old = server()
    await spawn(old)
    await refs.service.participants.stopSource('conversation-1')
    refs.service.participants.beginRequest('conversation-1', 'new-human-request')
    expect(await old.instance.callTool('spawn_agent', { prompt: 'Stale work' })).toMatchObject({ isError: true })
    expect(await old.instance.callTool('team_read_board', {})).toMatchObject({ isError: true })
    await spawn(server(), 'resumed')
    expect(counter).toBe(1)
  })
})
