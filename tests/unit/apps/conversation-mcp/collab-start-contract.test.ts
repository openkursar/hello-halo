import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const { serviceRef } = vi.hoisted(() => ({ serviceRef: { current: null as unknown } }))
vi.mock('../../../../src/main/services/agent/resolved-sdk', async () => import('../../../../src/main/services/agent/mcp/sdk-server'))
vi.mock('../../../../src/main/apps/team', () => ({ getTeamService: () => serviceRef.current }))
vi.mock('../../../../src/main/apps/runtime/team', () => ({ getActiveTeamRuntime: () => null }))
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
import { validateAppSpec } from '../../../../src/main/apps/spec'
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
  const appManager = createAppManagerService({ store: new AppManagerStore(db.getAppDatabase()),
    getSpacePath: id => id === SPACE ? spacePath : null,
    getAppDataPath: id => id === SPACE ? spacePath : null, getGlobalAppDir: () => join(root, 'global') })
  const runtime = {
    getObservableStatus: () => 'idle',
    getMemberStatus: () => 'idle',
    ensureConversationEpoch: (teamId: string, chatKey: string, title: string): TeamEpoch => {
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
  const server = createSpaceTeamMcpServer({
    spaceId: SPACE, conversationId: CONVERSATION, workDir: spacePath,
    modelSelection: { modelSourceId: 'parent-source', modelId: 'parent-model' },
  }) as SdkMcpServerConfig
  const bridge = new SdkMcpBridge({ [server.name]: server.instance })
  const urls = await bridge.start()
  const client = new Client({ name: 'collab-contract-test', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(urls[server.name])))
  return { client, service, store, appManager, close: async () => {
    await client.close(); await bridge.close(); db.closeAll(); rmSync(root, { recursive: true, force: true })
  } }
}

describe('collab_start MCP contract and member installation', () => {
  let h: Awaited<ReturnType<typeof harness>>
  beforeEach(async () => { h = await harness() })
  afterEach(async () => { serviceRef.current = null; await h?.close() })

  it('publishes every required member field and installs real schema-valid automation specs', async () => {
    const { tools } = await h.client.listTools()
    const start = tools.find(tool => tool.name === 'collab_start')!
    expect(start.inputSchema).toMatchObject({ properties: { members: {
      type: 'array', minItems: 1, items: { type: 'object', required: ['memberName', 'role', 'responsibility'],
        properties: { memberName: { type: 'string', minLength: 1 }, role: { type: 'string', minLength: 1 },
          responsibility: { type: 'string', minLength: 1, description: expect.any(String) } } },
    } } })
    const members = [
      { memberName: 'reviewer', role: 'Concurrency reviewer', responsibility: 'Review active-turn delivery races.' },
      { memberName: 'tester', role: 'Regression reviewer', responsibility: 'Check the verification evidence.' },
    ]
    const result = await h.client.callTool({ name: 'collab_start', arguments: { name: 'Review crew', goal: 'Review this change', members } })
    expect(result.isError).not.toBe(true)
    const apps = h.appManager.listApps({ spaceId: SPACE })
    expect(apps).toHaveLength(2)
    expect(apps.map(app => validateAppSpec(app.spec).description).sort()).toEqual(members.map(member => member.responsibility).sort())
    expect(apps.every(app => app.spec.type === 'automation' && app.status === 'active')).toBe(true)
    // Members run on the coordinator's model, persisted in their own overrides.
    expect(apps.map(app => app.userOverrides)).toEqual([
      expect.objectContaining({ modelSourceId: 'parent-source', modelId: 'parent-model' }),
      expect.objectContaining({ modelSourceId: 'parent-source', modelId: 'parent-model' }),
    ])
    const collab = h.service.getCollabForConversation(CONVERSATION)!
    expect(h.store.listMembersByTeam(collab.teamId).filter(member => member.aiProvisioned)).toHaveLength(2)
    expect(h.store.getEpochById(collab.epochId!)?.lifecycle).toBe('conversation')
  })

  it('returns a correctable tool error for missing nested fields before creating any team or app', async () => {
    const result = await h.client.callTool({ name: 'collab_start', arguments: {
      name: 'Review crew', goal: 'Review this change',
      members: [{ memberName: 'reviewer', role: 'Concurrency reviewer', description: 'Review the change' }],
    } })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([expect.objectContaining({ type: 'text', text: expect.stringContaining('responsibility') })])
    expect(h.appManager.listApps({ spaceId: SPACE })).toEqual([])
    expect(h.service.getCollabForConversation(CONVERSATION)).toBeNull()
    expect(h.service.listTeams(SPACE)).toEqual([])
  })
})
