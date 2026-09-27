import { beforeEach, describe, expect, it, vi } from 'vitest'

const { serviceRef, runtimeRef } = vi.hoisted(() => ({
  serviceRef: { current: null as any },
  runtimeRef: { current: null as any },
}))

vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  tool: (name: string, _description: string, _schema: unknown, handler: Function) => ({ name, handler }),
  createSdkMcpServer: (options: unknown) => options,
}))

vi.mock('../../../../src/main/apps/team', () => ({
  getTeamService: () => serviceRef.current,
}))

vi.mock('../../../../src/main/apps/runtime/team', () => ({
  getActiveTeamRuntime: () => runtimeRef.current,
}))

import { createSpaceTeamMcpServer } from '../../../../src/main/apps/conversation-mcp/team-mcp'
import { TEAM_TOOL_NAMES } from '../../../../src/shared/apps/team-types'

function toolsFor(service: any, runtime: any = null) {
  serviceRef.current = service
  runtimeRef.current = runtime
  const server = createSpaceTeamMcpServer({
    spaceId: 'space-1',
    conversationId: 'conversation-1',
    workDir: '/tmp/space-1',
  }) as unknown as { tools: Array<{ name: string; handler: Function }> }
  return new Map(server.tools.map(tool => [tool.name, tool.handler]))
}

const fakeRuntime = () => ({
  bus: {
    resolveMemberAppId: vi.fn(() => 'member-app'),
    assertCanContact: vi.fn(),
    send: vi.fn(async () => ({ messageId: 'msg-1' })),
  },
  blackboard: {},
  digest: undefined,
  archive: undefined,
})

describe('Space Team MCP', () => {
  beforeEach(() => {
    serviceRef.current = null
    runtimeRef.current = null
  })

  it('exposes the coordination tool surface alongside the management tools', () => {
    const tools = toolsFor({})
    for (const name of [
      'collab_start',
      'collab_save',
      'team_list',
      'team_run',
      'team_status',
      TEAM_TOOL_NAMES.send,
      TEAM_TOOL_NAMES.postTask,
      TEAM_TOOL_NAMES.readBoard,
      TEAM_TOOL_NAMES.complete,
    ]) {
      expect(tools.has(name), name).toBe(true)
    }
    // Standing timers are a persistent-team capability, not a space one.
    expect(tools.has(TEAM_TOOL_NAMES.schedule)).toBe(false)
    expect(tools.has(TEAM_TOOL_NAMES.unschedule)).toBe(false)
  })

  it('collab_start assembles an ephemeral team bound to this conversation', async () => {
    const createCollab = vi.fn(async () => ({
      team: { id: 'team-1', name: 'Research crew' },
      epochId: 'epoch-1',
    }))
    const tools = toolsFor({ createCollab })

    const result = await tools.get('collab_start')!({
      name: 'Research crew',
      goal: 'Compare competitors',
      members: [{ memberName: 'researcher', role: 'Researcher', responsibility: 'Collect sources' }],
    })

    expect(createCollab).toHaveBeenCalledWith(
      expect.objectContaining({ owningSpaceId: 'space-1', conversationId: 'conversation-1' })
    )
    expect(result.content[0].text).toContain('Research crew')
    expect(result.isError).toBeUndefined()
  })

  it('coordination tools refuse before a collaboration exists', async () => {
    const tools = toolsFor({ getCollabForConversation: () => null }, fakeRuntime())
    const result = await tools.get(TEAM_TOOL_NAMES.send)!({ to: 'researcher', message: 'go' })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('collab_start')
  })

  it('coordination tools resolve the active collaboration per call', async () => {
    const runtime = fakeRuntime()
    const tools = toolsFor(
      {
        getCollabForConversation: () => ({
          teamId: 'team-1',
          epochId: 'epoch-1',
          active: true,
          saved: false,
          name: 'Crew',
          goal: 'g',
          members: [],
        }),
        getTeam: () => ({ id: 'team-1', collabMode: 'free', leadAppId: 'space-conv-conversation-1' }),
      },
      runtime
    )

    const result = await tools.get(TEAM_TOOL_NAMES.send)!({ to: 'researcher', message: 'go' })

    expect(runtime.bus.send).toHaveBeenCalledWith(
      expect.objectContaining({ teamId: 'team-1', epochId: 'epoch-1', to: 'researcher' })
    )
    expect(result.isError).toBeUndefined()
  })

  it('collab_save keeps the current collaboration', async () => {
    const saveCollab = vi.fn(() => ({ id: 'team-1', name: 'Crew' }))
    const tools = toolsFor({
      getCollabForConversation: () => ({ teamId: 'team-1', saved: false, name: 'Crew' }),
      saveCollab,
    })

    const result = await tools.get('collab_save')!({})

    expect(saveCollab).toHaveBeenCalledWith('team-1', undefined)
    expect(result.content[0].text).toContain('Saved as team')
  })

  it('team_list lists only persistent teams of this space', async () => {
    const listTeamItems = vi.fn(() => [
      { id: 'team-1', name: 'Research', memberCount: 2, status: 'idle', ephemeral: false },
      { id: 'team-2', name: 'Temp', memberCount: 2, status: 'idle', ephemeral: true },
    ])
    const tools = toolsFor({ listTeamItems })

    const result = await tools.get('team_list')!({})

    expect(listTeamItems).toHaveBeenCalledWith('space-1')
    expect(result.content[0].text).toContain('Research')
    expect(result.content[0].text).not.toContain('Temp')
  })

  it('team_run delegates with the run brief and refuses foreign or ephemeral teams', async () => {
    const runTeam = vi.fn(async () => {})
    const tools = toolsFor({
      getTeam: (id: string) =>
        id === 'team-1'
          ? { id: 'team-1', name: 'Research', owningSpaceId: 'space-1', ephemeral: false }
          : { id: 'team-2', name: 'Elsewhere', owningSpaceId: 'space-9', ephemeral: false },
      runTeam,
    })

    const ok = await tools.get('team_run')!({ teamId: 'team-1', instruction: 'Compare pricing' })
    expect(runTeam).toHaveBeenCalledWith('team-1', { type: 'manual' }, 'Compare pricing')
    expect(ok.content[0].text).toContain('Delegated')

    const foreign = await tools.get('team_run')!({ teamId: 'team-2' })
    expect(foreign.isError).toBe(true)
  })

  it('team_status reports a bounded snapshot', async () => {
    const tools = toolsFor({
      getTeamDetail: () => ({
        team: { id: 'team-1', name: 'Research', owningSpaceId: 'space-1', status: 'running' },
        roster: [
          { appId: 'a', memberName: 'researcher', role: 'Researcher', isLead: false, status: 'working' },
        ],
        tasks: [{ id: 't1', title: 'Scrape', status: 'in_progress' }],
        findings: [],
        pendingEscalations: [],
      }),
    })

    const result = await tools.get('team_status')!({ teamId: 'team-1' })
    expect(result.content[0].text).toContain('running')
    expect(result.content[0].text).toContain('researcher')
    expect(result.content[0].text).toContain('Scrape')
  })
})
