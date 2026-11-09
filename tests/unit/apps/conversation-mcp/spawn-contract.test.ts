import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const { serviceRef, runtimeRef, spaceRef } = vi.hoisted(() => ({ serviceRef: { current: null as unknown }, runtimeRef: { current: null as unknown }, spaceRef: { path: '' } }))
vi.mock('../../../../src/main/services/agent/resolved-sdk', async () => import('../../../../src/main/services/agent/mcp/sdk-server'))
vi.mock('../../../../src/main/apps/team', async () => ({ ...(await import('../../../../src/main/apps/team/work-members')), getTeamService: () => serviceRef.current }))
vi.mock('../../../../src/main/apps/runtime/team', async () => ({
  createCoordinationMcpServer: (await import('../../../../src/main/apps/runtime/team/team-tools')).createCoordinationMcpServer,
  getActiveTeamRuntime: () => runtimeRef.current,
}))
vi.mock('../../../../src/main/services/space.service', () => ({ getSpace: () => spaceRef }))
vi.mock('../../../../src/main/apps/manager', () => ({ getAppManager: () => null }))
vi.mock('../../../../src/main/http/websocket', () => ({ broadcastToAll: vi.fn() }))
vi.mock('../../../../src/main/foundation/window.service', () => ({ sendToRenderer: vi.fn() }))

import { createDatabaseManager } from '../../../../src/main/platform/store/database-manager'
import { TeamStore } from '../../../../src/main/apps/team/store'
import { migrations as teamMigrations, MIGRATION_NAMESPACE as TEAM_NS } from '../../../../src/main/apps/team/migrations'
import { createTeamService } from '../../../../src/main/apps/team/service'
import { AppManagerStore } from '../../../../src/main/apps/manager/store'
import { migrations as appMigrations, MIGRATION_NAMESPACE as APP_NS } from '../../../../src/main/apps/manager/migrations'
import { createAppManagerService } from '../../../../src/main/apps/manager/service'
import { createSpaceTeamMcpServer } from '../../../../src/main/apps/conversation-mcp/team-mcp'
import { createMessageBus } from '@hello-halo/agent-sdk/collaboration'
import { createWorkMembership } from '../../../../src/main/apps/runtime/team/membership'
import { SdkMcpBridge } from '../../../../src/main/services/agent/mcp/sdk-bridge'
import type { SdkMcpServerConfig } from '../../../../src/main/services/agent/mcp/types'
import type { TeamEpoch } from '../../../../src/shared/apps/team-types'

const SPACE = 'collab-contract-space'
const CONVERSATION = 'collab-contract-conversation'

async function harness() {
  const root = mkdtempSync(join(globalThis.__HALO_TEST_DIR__, 'collab-contract-'))
  const db = createDatabaseManager(':memory:')
  db.runMigrations(db.getAppDatabase(), TEAM_NS, teamMigrations)
  db.runMigrations(db.getAppDatabase(), APP_NS, appMigrations)
  const store = new TeamStore(db.getAppDatabase())
  const spacePath = join(root, 'space')
  mkdirSync(spacePath, { recursive: true })
  spaceRef.path = spacePath
  const appManager = createAppManagerService({ store: new AppManagerStore(db.getAppDatabase()),
    getSpacePath: id => id === SPACE ? spacePath : null,
    getAppDataPath: id => id === SPACE ? spacePath : null, getGlobalAppDir: () => join(root, 'global') })
  const runtime = {
    bus: createMessageBus({ store: createWorkMembership(store), hooks: { isBusy: () => false, wakeTarget: async () => {} } }),
    stopMemberTurn: vi.fn(async () => true),
    getObservableStatus: () => 'idle',
    getMemberStatus: () => 'idle',
    teamFolders: { forMember: () => null },
    ensureConversationEpoch: (teamId: string, chatKey: string, title: string): TeamEpoch => {
      const existing = store.getOpenConversationEpoch(teamId, chatKey)
      if (existing) return existing
      const epoch: TeamEpoch = { id: randomUUID(), teamId, chatKey, title, lifecycle: 'conversation',
        startedAt: Date.now(), endedAt: null, endReason: null, summary: null }
      store.insertEpoch(epoch, 'event')
      return epoch
    },
  }
  const service = createTeamService({ store, appManager, getRuntime: () => runtime as never,
    spaces: { spaceExists: id => id === SPACE, createMemberSpace: ({ owningSpaceId }) => owningSpaceId },
    listArtifacts: async () => [], proposeMembersFromGoal: async () => [] })
  serviceRef.current = service
  runtimeRef.current = runtime
  const server = createSpaceTeamMcpServer({
    spaceId: SPACE, conversationId: CONVERSATION, workDir: spacePath,
    modelSelection: { modelSourceId: 'parent-source', modelId: 'parent-model' },
    executionOptions: () => ({ engineId: 'halo', collaborationEnabled: true, mcpServerNames: [] }),
  }) as SdkMcpServerConfig
  const bridge = new SdkMcpBridge({ [server.name]: server.instance })
  const urls = await bridge.start()
  const client = new Client({ name: 'collab-contract-test', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(urls[server.name])))
  return { client, service, store, appManager, runtime, close: async () => {
    await client.close(); await bridge.close(); db.closeAll(); rmSync(root, { recursive: true, force: true })
  } }
}

describe('spawn_agent over the real MCP HTTP bridge', () => {
  let h: Awaited<ReturnType<typeof harness>>
  beforeEach(async () => { h = await harness() })
  afterEach(async () => { serviceRef.current = null; runtimeRef.current = null; await h?.close() })

  it('publishes one assignment schema and creates scoped participants without installing digital humans', async () => {
    const { tools } = await h.client.listTools()
    const start = tools.find(tool => tool.name === 'spawn_agent')!
    expect(start.inputSchema).toMatchObject({ required: ['prompt'], additionalProperties: false,
      properties: { prompt: { type: 'string', minLength: 1 }, name: { type: 'string' } } })
    expect(Object.keys(start.inputSchema.properties!)).toEqual(['prompt', 'name', 'cwd', 'isolation'])
    for (const name of ['reviewer', 'tester']) {
      const result = await h.client.callTool({ name: 'spawn_agent', arguments: { name, prompt: `Review as ${name}.` } })
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      expect(JSON.parse((result.content as Array<{ text: string }>)[0].text)).toMatchObject({ handle: expect.any(String), status: 'accepted' })
    }
    expect(h.appManager.listApps({ spaceId: SPACE })).toEqual([])
    const collab = h.service.getCollabForConversation(CONVERSATION)!
    const members = h.store.participants.list(collab.teamId, collab.epochId!)
    expect(members).toHaveLength(2)
    expect(members.every(member => member.isTemporary)).toBe(true)
    for (const member of members) {
      expect(h.store.participants.getExecution(collab.teamId, collab.epochId!, member.appId)).toMatchObject({
        engineId: 'halo', modelSelection: { modelSourceId: 'parent-source', modelId: 'parent-model' },
      })
    }
    expect(h.store.listMembersByTeam(collab.teamId)).toHaveLength(1)
    expect(h.store.getEpochById(collab.epochId!)?.lifecycle).toBe('conversation')
    expect(h.store.getTeamById(collab.teamId)?.goal).toBe('')
  })

  it('resolves repeated messages without reading the UI task or member-status projection', async () => {
    const created = await h.client.callTool({ name: 'spawn_agent', arguments: { name: 'reviewer', prompt: 'Review the change.' } })
    const member = JSON.parse((created.content as Array<{ text: string }>)[0].text) as { handle: string }
    const context = h.service.getCollaborationScope(CONVERSATION)!
    h.store.insertTask({ id: 'tracked-work', teamId: context.team.id, epochId: context.epochId, title: 'Existing board work',
      assigneeAppId: member.handle, status: 'in_progress', resultRef: null, note: null, parentId: null,
      createdByAppId: context.team.leadAppId!, createdAt: 1, updatedAt: 1 })
    const summary = vi.spyOn(h.service, 'getCollabForConversation')
    const tasks = vi.spyOn(h.store, 'listTasksByEpoch')
    const roster = vi.spyOn(h.store, 'listMembersByTeam')
    const status = vi.spyOn(h.runtime, 'getMemberStatus')
    for (const message of ['Also inspect cancellation.', 'Send evidence when ready.']) {
      const result = await h.client.callTool({ name: 'team_send', arguments: { to: member.handle, message } })
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
    }
    expect(summary).not.toHaveBeenCalled()
    expect(tasks).not.toHaveBeenCalled()
    expect(roster).not.toHaveBeenCalled()
    expect(status).not.toHaveBeenCalled()
    const projected = h.service.getCollabForConversation(CONVERSATION)!
    expect(projected.members).toEqual([expect.objectContaining({ appId: member.handle, currentTaskTitle: 'Existing board work' })])
    expect(tasks).toHaveBeenCalledOnce()
    expect(status).toHaveBeenCalledOnce()
  })

  it('rejects missing assignments and caller-chosen scopes before creating work or digital humans', async () => {
    for (const input of [{ name: 'reviewer' }, { prompt: 'Review', team_id: 'another-work' }]) {
      const result = await h.client.callTool({ name: 'spawn_agent', arguments: input })
      expect(result.isError).toBe(true)
    }
    expect(h.appManager.listApps({ spaceId: SPACE })).toEqual([])
    expect(h.service.getCollabForConversation(CONVERSATION)).toBeNull()
    expect(h.service.listTeams(SPACE)).toEqual([])
  })
})
