import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { CapabilityPolicy } from '../../../../src/shared/apps/capability-policy'
import type { EngineId } from '../../../../src/shared/types/engine'

const { library, manager, settings, docs } = vi.hoisted(() => ({
  library: {
    list: vi.fn(), read: vi.fn(), import: vi.fn(), setEnabled: vi.fn(),
    movePreview: vi.fn(), move: vi.fn(), save: vi.fn(), delete: vi.fn(),
  },
  manager: { install: vi.fn(), uninstall: vi.fn(), getApp: vi.fn() },
  settings: { agent: { enableDigitalHumans: true } },
  docs: { consulted: false },
}))

vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  tool: (name: string, description: string, schema: z.ZodRawShape, handler: Function) => ({ name, description, schema, handler }),
  createSdkMcpServer: (options: unknown) => options,
}))
vi.mock('../../../../src/main/apps/skills', () => ({ getSkillLibrary: () => library }))
vi.mock('../../../../src/main/apps/manager', () => ({ getAppManager: () => manager }))
vi.mock('../../../../src/main/apps/runtime', () => ({
  getAppRuntime: () => null,
}))
vi.mock('../../../../src/main/store', () => ({ installFromStore: vi.fn() }))
vi.mock('../../../../src/main/store/registry.service', () => ({ installRequiredSkills: vi.fn() }))
vi.mock('../../../../src/main/apps/team', () => ({ getTeamService: () => null }))
vi.mock('../../../../src/main/apps/runtime/team', () => ({ getActiveTeamRuntime: () => null }))
vi.mock('../../../../src/main/apps/runtime/team/team-tools', () => ({ buildCoordinationTools: () => [] }))
vi.mock('../../../../src/main/foundation/config.service', () => ({ getConfig: () => settings, saveConfig: vi.fn() }))
vi.mock('../../../../src/main/services/agent/events', () => ({ emitAgentEvent: vi.fn() }))
vi.mock('../../../../src/main/services/agent/toolsets/registry', () => ({
  getAvailableToolsets: () => [], getToolset: () => undefined,
}))
vi.mock('../../../../src/main/services/agent/toolsets/state', () => ({
  getOpenToolsets: () => new Set(), markOpen: vi.fn(), markClosed: vi.fn(),
}))
vi.mock('../../../../src/main/services/web-search', () => ({ createWebSearchMcpServer: () => ({ name: 'web-search' }) }))
vi.mock('../../../../src/main/services/official-docs-mcp', () => ({
  CREATE_GUIDE_PATH: 'create-digital-human/SKILL.md',
  createOfficialDocsSession: () => ({ server: { name: 'halo-docs' }, guideConsulted: () => docs.consulted }),
}))

import { createHaloAppsMcpServer, createSpaceTeamMcpServer, TEAM_TOOLSET_GUIDE } from '../../../../src/main/apps/conversation-mcp'
import { registerAppBridge } from '../../../../src/main/services/app-bridge'
import { buildCreationTimeServers } from '../../../../src/main/services/agent/toolsets/broker'
import { buildBaseToolset } from '../../../../src/main/services/agent/toolsets/base'
import { applyCapabilityPolicy, isBorrowedTeamTurn } from '../../../../src/main/apps/runtime/capability-policy'
import { buildSystemPrompt } from '../../../../src/main/services/agent/system-prompt'

interface ObservedTool {
  name: string
  description: string
  schema: z.ZodRawShape
  handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>
}
interface ObservedServer { name: string; tools: ObservedTool[] }

const actions = ['list', 'read', 'install', 'enable', 'disable', 'move', 'save', 'delete', 'uninstall']
const ref = { id: 'app:legacy-id', spaceId: 'space' }

function skillTool(servers = buildCreationTimeServers({ spaceId: 'space', conversationId: 'conversation', workDir: '/fixture' })) {
  const server = servers['halo-apps'] as ObservedServer
  expect(server.name).toBe('halo-apps')
  const tools = server.tools.filter(tool => tool.name === 'skill_manage')
  expect(tools).toHaveLength(1)
  return tools[0]
}

beforeEach(() => {
  vi.resetAllMocks()
  settings.agent.enableDigitalHumans = true
  docs.consulted = false
  registerAppBridge({
    getAppManager: () => null,
    createHaloAppsMcpServer,
    onMcpAppsChange: () => () => {},
  })
})

describe('skill management in the assembled Halo Apps server', () => {
  it('publishes the complete action schema through the real bridge and space broker', () => {
    const tool = skillTool()
    expect((tool.schema.action as z.ZodEnum<[string, ...string[]]>).options).toEqual(actions)
    for (const action of actions) expect(z.object(tool.schema).safeParse({ action }).success).toBe(true)
    expect(z.object(tool.schema).safeParse({ action: 'erase', path: '/arbitrary' }).success).toBe(false)
    expect(tool.schema).not.toHaveProperty('path')
    expect(tool.schema).not.toHaveProperty('filePath')
    expect(tool.description).toContain('Never treat a tool call as authorization')
    expect(tool.description).toContain('OS trash')
    expect(tool.description).toContain('never arbitrary paths')
  })

  it('preserves automation tools, the per-session authoring gate and team exports', async () => {
    const server = createHaloAppsMcpServer('space', () => docs.consulted) as unknown as ObservedServer
    expect(server.tools.map(tool => tool.name)).toEqual([
      'list_automation_apps', 'create_automation_app', 'update_automation_app', 'delete_automation_app',
      'get_automation_status', 'pause_automation_app', 'resume_automation_app', 'trigger_automation_app',
      'skill_manage',
    ])
    const create = server.tools.find(tool => tool.name === 'create_automation_app')!
    expect((await create.handler({ spec: '{}' })).content[0].text).toContain('Read the authoring guide first')
    expect(manager.install).not.toHaveBeenCalled()
    docs.consulted = true
    expect((await create.handler({ spec: '{}' })).content[0].text).toContain('Spec validation failed')
    const other = createHaloAppsMcpServer('space', () => false) as unknown as ObservedServer
    expect((await other.tools.find(tool => tool.name === 'create_automation_app')!.handler({ spec: '{}' })).content[0].text)
      .toContain('Read the authoring guide first')
    expect(createSpaceTeamMcpServer).toBeTypeOf('function')
    expect(TEAM_TOOLSET_GUIDE).toContain('## Agent teams and standing teams')
  })

  it.each([undefined, 'global'] as const)('lists the requested %s scope with opaque references and pagination', async scope => {
    const spaceId = scope === 'global' ? null : 'space'
    library.list.mockReturnValue({
      groups: [{ name: 'report', copies: [{ id: 'file:' + 'a'.repeat(64), spaceId }] }],
      offset: 3, limit: 7, total: 12, truncated: true, warnings: ['One root cannot be read.'],
    })
    const result = await skillTool().handler({ action: 'list', scope, q: 'report', offset: 3, limit: 7 })
    expect(library.list).toHaveBeenCalledWith({ spaceId, q: 'report', offset: 3, limit: 7 })
    const data = JSON.parse(result.content[0].text)
    expect(data.groups[0].copies[0].ref).toEqual({ id: 'file:' + 'a'.repeat(64), spaceId })
    expect(data).toMatchObject({ offset: 3, limit: 7, total: 12, truncated: true, warnings: ['One root cannot be read.'] })
  })

  it('reads bounded instruction windows and file metadata, never the package payload', async () => {
    library.read.mockReturnValue({
      copy: { id: ref.id }, revision: 'revision', content: 'x'.repeat(13000) + 'end',
      files: Array.from({ length: 51 }, (_, i) => ({ path: `assets/${i}.bin`, binary: true, size: 10 })),
      spec: { skill_assets: { secret: 'BINARY_PAYLOAD' }, skill_files: { 'script.js': 'COMPANION_PAYLOAD' } },
    })
    const tool = skillTool()
    const first = await tool.handler({ action: 'read', ref })
    expect(first.content[0].text.length).toBeLessThan(24 * 1024)
    expect(first.content[0].text).not.toMatch(/BINARY_PAYLOAD|COMPANION_PAYLOAD/)
    const data = JSON.parse(first.content[0].text)
    expect(data).toMatchObject({ ref, revision: 'revision', nextOffset: 12000, filesTruncated: true })
    expect(data.content).toHaveLength(12000)
    expect(data.files).toHaveLength(50)
    const next = JSON.parse((await tool.handler({ action: 'read', ref, offset: data.nextOffset })).content[0].text)
    expect(next.content).toBe('x'.repeat(1000) + 'end')
    expect(next.nextOffset).toBeNull()
  })

  it('routes revision-checked edits through the shared library without the legacy manager path', async () => {
    library.save.mockReturnValue({ copy: { id: ref.id }, revision: 'saved' })
    const tool = skillTool()
    expect((await tool.handler({ action: 'save', ref, content: 'new' })).isError).toBe(true)
    expect(library.save).not.toHaveBeenCalled()
    expect((await tool.handler({ action: 'save', ref, revision: 'read-revision', content: 'new' })).isError).not.toBe(true)
    expect(library.save).toHaveBeenCalledWith({ ref, revision: 'read-revision', content: 'new' })
    expect(manager.getApp).not.toHaveBeenCalled()
    expect(manager.uninstall).not.toHaveBeenCalled()
  })

  it.each(['delete', 'uninstall'])('%s requires a read revision and forwards the missing sentinel', async action => {
    const tool = skillTool()
    expect((await tool.handler({ action, skill_id: 'legacy-id' })).isError).toBe(true)
    expect(library.delete).not.toHaveBeenCalled()
    library.read.mockReturnValue({ copy: { availability: 'missing' }, revision: 'missing', content: '', files: [] })
    const read = JSON.parse((await tool.handler({ action: 'read', skill_id: 'legacy-id' })).content[0].text)
    expect(read.revision).toBe('missing')
    expect((await tool.handler({ action, ref: read.ref, revision: read.revision })).isError).not.toBe(true)
    expect(library.delete).toHaveBeenCalledWith({ ref, revision: 'missing' })
    expect(manager.uninstall).not.toHaveBeenCalled()
  })

  it('preserves the global digital-human switch instead of adding another management permission gate', () => {
    settings.agent.enableDigitalHumans = false
    expect(buildCreationTimeServers({ spaceId: 'space', conversationId: 'conversation', workDir: '/fixture' })).not.toHaveProperty('halo-apps')
  })

  it.each(['halo', 'anthropic', 'codex', 'dsh'] satisfies EngineId[])('matches the existing %s prompt guidance with a callable management schema', engineId => {
    const prompt = buildSystemPrompt({ engineId, workDir: '/workspace', promptProfile: 'halo', digitalHumansEnabled: true })
    expect(prompt).toContain('Manage them with the capability library or skill_manage')
    expect(prompt).not.toContain('private runtime skill directories')
    expect((skillTool().schema.action as z.ZodEnum<[string, ...string[]]>).options).toEqual(actions)
  })
})

describe('existing origin and policy boundary around the assembled server', () => {
  it('retains skill management for the local digital-human owner base with its own tool list', () => {
    expect(isBorrowedTeamTurn({ kind: 'message' }, false)).toBe(false)
    const servers = buildBaseToolset({ spaceId: 'space' })
    expect((skillTool(servers).schema.action as z.ZodEnum<[string, ...string[]]>).options).toEqual(actions)
  })

  it.each(['guest', 'colleague'] as const)('removes actual management actions from a restricted %s turn', origin => {
    expect(isBorrowedTeamTurn({ kind: 'message', origin }, false)).toBe(true)
    const servers = buildBaseToolset({ spaceId: 'space' })
    expect(skillTool(servers).name).toBe('skill_manage')
    const sdkOptions: Record<string, unknown> = { mcpServers: servers }
    const policy: CapabilityPolicy = origin === 'guest' ? {} : { allowedTools: ['Read'] }
    const applied = applyCapabilityPolicy(sdkOptions, { policy, mode: 'strict', mcpServers: servers, dbMcpServers: null })
    expect(applied.enforced).toBe(true)
    expect(applied.mcpServers).not.toHaveProperty('halo-apps')
    expect(sdkOptions.mcpServers).toBe(applied.mcpServers)
    expect(library.list).not.toHaveBeenCalled()
    expect(library.delete).not.toHaveBeenCalled()
  })

  it('also filters a direct IM guest whose authority comes from the channel, not a borrowed team turn', () => {
    expect(isBorrowedTeamTurn({ kind: 'human_message', origin: 'guest' }, true)).toBe(false)
    const servers = buildBaseToolset({ spaceId: 'space' })
    const applied = applyCapabilityPolicy({}, { policy: {}, mode: 'strict', mcpServers: servers, dbMcpServers: null })
    expect(applied.mcpServers).not.toHaveProperty('halo-apps')
  })

  it('retains other granted app tools but leaves shared-file management out for an outside turn', () => {
    const servers = buildBaseToolset({ spaceId: 'space', omitSkillManagement: true })
    const applied = applyCapabilityPolicy({}, {
      policy: { allowApps: true }, mode: 'strict', mcpServers: servers, dbMcpServers: null,
    })
    const tools = (applied.mcpServers['halo-apps'] as ObservedServer).tools
    expect(tools.some(tool => tool.name === 'skill_manage')).toBe(false)
    expect(tools.some(tool => tool.name === 'list_automation_apps')).toBe(true)
  })
})
