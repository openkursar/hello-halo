import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionWorkRequest } from '../../../../../src/main/services/agent'

const state = vi.hoisted(() => ({
  enabled: true, sourceRequest: 'source-request',
  source: [] as Array<{ scope: any; callbacks: any }>,
  team: [] as any[],
  release: vi.fn(),
  bindIm: vi.fn(),
}))
vi.mock('../../../../../src/main/services/agent', () => ({
  markMcpServerSettings: (server: object, settings: object) => ({ ...server, settings }),
}))
vi.mock('../../../../../src/main/apps/team', () => ({
  getTeamService: () => ({ participants: { sourceRequestId: () => state.sourceRequest } }),
}))
vi.mock('../../../../../src/main/apps/runtime/team/source-delivery', () => ({ bindImCollaborationSource: state.bindIm }))
vi.mock('../../../../../src/main/apps/runtime/team/tool-session', () => ({
  bindSourceToolSession: (scope: any, callbacks: any) => {
    state.source.push({ scope, callbacks })
    return { generation: 7, server: { kind: 'source' }, release: state.release }
  },
  bindTeamToolSession: (_conversationId: string, context: any) => {
    state.team.push(context)
    return { generation: 8, server: { kind: 'team' }, release: state.release }
  },
}))

import { openConversationWork, openMemberWork } from '../../../../../src/main/apps/runtime/team/chat-work'
import { createExecutionWorkHost } from '../../../../../src/main/apps/runtime/team/execution-work'

const environment = { spaceId: 'space', spacePath: '/space', workDir: '/work', memoryDir: '/memory' }
const permissions = { granted: [], denied: [] }
const principal = { appId: 'app', permissions, environment }
const grants = { engineId: 'halo' as const, collaborationEnabled: true, permissionMode: 'default', mcpServerNames: ['halo-team', 'ocr'] }

function request(overrides: Partial<ExecutionWorkRequest> = {}): ExecutionWorkRequest {
  return {
    key: 'app-chat:app:native:chat', principal, modelSelection: { modelSourceId: 'source', modelId: 'model' },
    requester: undefined, source: { kind: 'conversation' }, grants: () => grants,
    isLive: () => true, mayDelegate: () => state.enabled, input: { accept: async () => 'discarded' }, ...overrides,
  }
}
const conversation = (overrides: Partial<ExecutionWorkRequest> = {}, source: { requestId?: string; channel?: any } = {}) =>
  openConversationWork(request(overrides), { kind: 'conversation', ...source })

beforeEach(() => { state.enabled = true; state.source = []; state.team = []; vi.clearAllMocks() })

describe('a digital human’s conversation turn', () => {
  it('binds the conversation’s tools, marks the server with what it was built from and offers the guidance', () => {
    const owned = conversation({ requester: { origin: 'guest' } })
    const server = owned.tools['halo-team'] as any
    expect(server.kind).toBe('source')
    expect(server.settings).toEqual({ origin: 'guest', generation: 7, canSpawn: true })
    expect(owned.guidance).toContain('independent')
    expect(state.source[0].scope).toMatchObject({
      spaceId: 'space', conversationId: 'app-chat:app:native:chat', workDir: '/work',
      modelSelection: { modelSourceId: 'source', modelId: 'model' }, origin: 'guest', collaborationEnabled: true,
    })
  })

  it('hands collaborators the live session’s grants, the principal and the requester’s limits', () => {
    const files = { workspaceRoots: ['/work'] } as any
    let strict = false
    conversation({
      requester: { origin: 'colleague', delegation: { policy: { allowCollaboration: true }, mode: 'strict' }, files: () => strict ? files : undefined },
    })
    const source = state.source[0].callbacks.source()
    expect(source).toMatchObject({
      engineId: 'halo', permissionMode: 'default', mcpServerNames: ['halo-team', 'ocr'], sourceAppId: 'app', environment, permissions,
      modelSelection: { modelSourceId: 'source', modelId: 'model' }, delegatedPolicy: { allowCollaboration: true }, origin: 'colleague',
    })
    expect(source).not.toHaveProperty('fileAccess')
    strict = true
    expect(state.source[0].callbacks.source().fileAccess).toBe(files)
  })

  it('creates no collaborator without a model selection', () => {
    conversation({ modelSelection: undefined })
    expect(() => state.source[0].callbacks.source()).toThrow('The source model configuration is unavailable.')
  })

  it('asks the execution whether work may be delegated, and reports the answer as it stands', () => {
    conversation()
    expect(state.source[0].callbacks.canSpawn()).toBe(true)
    state.enabled = false
    expect(state.source[0].callbacks.canSpawn()).toBe(false)
    conversation()
    expect(state.source[1].scope.collaborationEnabled).toBe(false)
  })

  it('binds an IM chat’s sender authority when a collaborator is first created, and refuses without it', () => {
    const session = { channel: 'wecom-bot', chatType: 'direct', sessionId: 'inst:chat' } as any
    const permission = { senderId: 'person', senderName: 'Person', isOwner: true } as any
    conversation({}, { channel: { session, permission } })
    expect(state.bindIm).not.toHaveBeenCalled()
    state.source[0].callbacks.source()
    expect(state.bindIm).toHaveBeenCalledWith({
      appId: 'app', conversationId: 'app-chat:app:native:chat', requestId: 'source-request', imSession: session, permission,
    })

    conversation({}, { channel: { session, permission: undefined } })
    expect(() => state.source[1].callbacks.source()).toThrow('The originating chat authority is unavailable.')
  })

  it('serves the request of a team turn, and its own request when it has none', () => {
    conversation({}, { requestId: 'root/child' })
    expect(state.source[0].callbacks.requestId()).toBe('root')
    conversation()
    expect(state.source[1].callbacks.requestId()).toBe('source-request')
  })

  it('retires only the endpoint its turn created; it owns no work, waits for nothing and counts nothing', async () => {
    const owned = conversation()
    expect(owned.hasPending()).toBe(false)
    expect(owned.takeUsage()).toBeUndefined()
    expect(owned.onChanged(() => {})).toBeDefined()
    expect(state.release).not.toHaveBeenCalled()
    await owned.end()
    expect(state.release).toHaveBeenCalledOnce()
  })
})

describe('a team member’s turn', () => {
  const runtime = { teamFolders: {}, bus: {}, blackboard: {}, readArtifact: () => {}, readMemberRecord: undefined, checks: { id: 'checks' }, digest: {}, archive: {} } as any
  const member = (overrides = {}) => ({
    appId: 'member-app', teamId: 'team', epochId: 'epoch', forwardDepth: 2, collabMode: 'free' as const, selfIsLead: false,
    teamFolder: { shared: '/team', self: '/team/me' }, disposable: false, servesGuest: false, ...overrides,
  })
  const memberWork = (source: { requestId?: string; member: ReturnType<typeof member> }, overrides: Partial<ExecutionWorkRequest> = {}) =>
    openMemberWork(request({ source: { kind: 'member', ...source }, ...overrides }), { kind: 'member', ...source }, { runtime: () => runtime })

  it('builds the coordination tools from the turn’s team, withholding checks from a disposable or guest turn', () => {
    const owned = memberWork({ requestId: 'request', member: member() }, { requester: undefined })
    const server = owned.tools['halo-team'] as any
    expect(server.kind).toBe('team')
    expect(server.settings).toEqual({ origin: null, generation: 8, canSpawn: true })
    expect(state.team[0]).toMatchObject({
      teamId: 'team', epochId: 'epoch', callerAppId: 'member-app', collabMode: 'free', selfIsLead: false, callerWorkDir: '/work',
      callerTeamFolder: { shared: '/team', self: '/team/me' }, forwardDepth: 2, requestId: 'request',
      checks: runtime.checks, readArtifact: runtime.readArtifact,
    })
    expect(state.team[0]).not.toHaveProperty('servesGuest')
    expect(state.team[0]).not.toHaveProperty('origin')
    expect(state.team[0]).not.toHaveProperty('readMemberRecord')

    memberWork({ member: member({ servesGuest: true }) }, { requester: { origin: 'guest' } })
    expect(state.team[1].checks).toBeUndefined()
    expect(state.team[1]).toMatchObject({ servesGuest: true, origin: 'guest' })
    memberWork({ member: member({ disposable: true }) })
    expect(state.team[2].checks).toBeUndefined()
  })

  it('lets its private assistants inherit what the member holds', () => {
    memberWork({ member: member() }, { requester: { origin: 'colleague' } })
    expect(state.team[0].spawnSource()).toMatchObject({
      engineId: 'halo', sourceAppId: 'app', environment, permissions, origin: 'colleague',
      modelSelection: { modelSourceId: 'source', modelId: 'model' },
    })
    expect(state.team[0].canSpawn()).toBe(true)
    state.enabled = false
    expect(state.team[0].canSpawn()).toBe(false)
  })

  it('needs the team runtime, and says so when it is gone', () => {
    expect(() => openMemberWork(request(), { kind: 'member', member: member() }, { runtime: () => null })).toThrow(/team runtime is unavailable/)
  })

  it('retires its endpoint when the turn ends', async () => {
    const owned = memberWork({ member: member() })
    await owned.end()
    expect(state.release).toHaveBeenCalledOnce()
  })
})

describe('the work host', () => {
  const runtime = { teamFolders: {}, bus: {}, blackboard: {}, checks: undefined, digest: {}, archive: {} } as any

  it('answers each kind of entry with its own work', () => {
    const host = createExecutionWorkHost({ runtime: () => runtime })
    expect((host.open(request()).tools['halo-team'] as any).kind).toBe('source')
    expect((host.open(request({
      source: { kind: 'member', member: { appId: 'm', teamId: 't', epochId: 'e', collabMode: 'free', selfIsLead: false, teamFolder: null, disposable: false, servesGuest: false } },
    })).tools['halo-team'] as any).kind).toBe('team')
  })
})
