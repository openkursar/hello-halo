import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CapabilityPolicy } from '../../../../src/shared/apps/capability-policy'
import type { TeamRequestOrigin } from '../../../../src/shared/apps/team-types'

const { state, app, library, acquireSession, sink } = vi.hoisted(() => ({
  state: { policy: null as CapabilityPolicy | null, disposable: false, workDir: '', sessions: [] as Record<string, any>[] },
  app: {
    id: 'skill-owner', spaceId: 'space', specId: 'skill-owner', status: 'active',
    permissions: { granted: [], denied: ['ai-browser', 'ai-terminal', 'email', 'im-push'] },
    userConfig: {}, userOverrides: {},
    spec: { type: 'automation', name: 'Skill owner', system_prompt: 'Manage approved skills.', config_schema: [], requires: { mcps: [] } },
  },
  library: { list: vi.fn(), delete: vi.fn() },
  acquireSession: vi.fn(),
  sink: {
    setTurnIdentity: vi.fn(), writeUserMessage: vi.fn(), writePreInitFailure: vi.fn(),
    beginRound: () => ({ done: Promise.resolve(), cancel: vi.fn() }),
  },
}))

vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  tool: (name: string, description: string, schema: unknown, handler: Function) => ({ name, description, schema, handler }),
  createSdkMcpServer: (options: unknown) => options,
}))
vi.mock('../../../../src/main/services/agent', () => ({
  acquireV2Session: acquireSession, getToolset: () => undefined,
  formatTurnAttachments: () => '', workingDirErrorDetail: () => ({}), engineErrorDetail: () => ({}),
  hasPendingSessionInput: () => false, hasLiveTurn: () => false, markMcpServerSettings: (server: unknown) => server,
  resolveCredentialsForSdk: async () => ({ displayModel: 'fixture', capabilities: {} }),
  buildUserSessionSdkOptions: async (options: Record<string, unknown>) => ({ mcpServers: options.mcpServers }),
  toEngineSystemPrompt: (prompt: string) => prompt,
  getEngineCapabilities: () => ({ features: { permissionRules: true, hooks: true } }),
}))
vi.mock('../../../../src/main/services/agent/session-manager', () => ({
  closeV2Session: vi.fn(), getConsumerHandle: () => null, getRunningConsumerIds: () => [],
  updateConsumerDisplayModel: vi.fn(), v2Sessions: new Map(),
}))
vi.mock('../../../../src/main/services/agent/control', () => ({ stopGeneration: vi.fn(), getSessionState: () => ({ isActive: false }) }))
vi.mock('../../../../src/main/services/agent/helpers', () => ({
  getApiCredentialsForSelection: async () => ({}), getWorkingDir: () => state.workDir,
  getHeadlessElectronPath: () => '/fixture/electron', getDbMcpServers: () => null,
}))
vi.mock('../../../../src/main/services/agent/events', () => ({ emitAgentEvent: vi.fn() }))
vi.mock('../../../../src/main/services/agent/sdk-config', () => ({ addSdkHooks: vi.fn() }))
vi.mock('../../../../src/main/services/agent/reasoning-effort', () => ({ applyReasoningEffort: () => 0, pickReasoningEffort: () => undefined }))
vi.mock('../../../../src/main/services/agent/permission-handler', () => ({ createCanUseTool: vi.fn() }))
vi.mock('../../../../src/main/services/agent/message-utils', () => ({ buildMessageContent: (text: string) => text, formatCanvasContext: () => '' }))
vi.mock('../../../../src/main/services/agent/image-attachments', () => ({ prepareNonVisionImageFallback: () => undefined }))
vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({ analytics: { track: vi.fn() } }))
vi.mock('../../../../src/main/foundation/config.service', () => ({ getConfig: () => ({ agent: {} }) }))
vi.mock('../../../../src/main/foundation/window.service', () => ({ sendToRenderer: vi.fn() }))
vi.mock('../../../../src/main/http/websocket', () => ({ broadcastToAll: vi.fn() }))
vi.mock('../../../../src/main/services/space.service', () => ({
  getSpace: () => ({ id: 'space', path: state.workDir }), getSpaceDir: () => state.workDir, isSpaceMemoryEnabled: () => false,
}))
vi.mock('../../../../src/main/services/ai-browser', () => ({ createAIBrowserMcpServer: vi.fn() }))
vi.mock('../../../../src/main/services/ai-terminal', () => ({
  createTerminalMcpServer: vi.fn(), getGlobalTerminalContext: vi.fn(), isTerminalAvailable: () => false,
}))
vi.mock('../../../../src/main/services/web-search', () => ({ createWebSearchMcpServer: () => ({ name: 'web-search' }) }))
vi.mock('../../../../src/main/services/official-docs-mcp', () => ({
  CREATE_GUIDE_PATH: 'create-digital-human/SKILL.md',
  createOfficialDocsSession: () => ({ server: { name: 'halo-docs' }, guideConsulted: () => false }),
}))
vi.mock('../../../../src/main/services/api-ref', () => ({ createApiRefMcpServer: () => ({ name: 'halo-api-ref' }) }))
vi.mock('../../../../src/main/services/ocr', () => ({ createOcrMcpServer: () => ({ name: 'ocr' }) }))
vi.mock('../../../../src/main/services/email-mcp', () => ({ createEmailMcpServer: vi.fn() }))
vi.mock('../../../../src/main/services/conversation-interop', () => ({ getPendingConversationInputIds: () => [], holdConversationAfterStop: vi.fn() }))
vi.mock('../../../../src/main/apps/manager', () => ({ getAppManager: () => ({ getApp: () => app }) }))
vi.mock('../../../../src/main/apps/skills', () => ({ getSkillLibrary: () => library }))
vi.mock('../../../../src/main/store', () => ({ installFromStore: vi.fn() }))
vi.mock('../../../../src/main/store/registry.service', () => ({ installRequiredSkills: vi.fn() }))
vi.mock('../../../../src/main/apps/skill-discovery', () => ({ listLoadableSkillCopies: () => [] }))
vi.mock('../../../../src/main/apps/team', () => ({ getTeamService: () => null }))
vi.mock('../../../../src/main/apps/runtime/team', () => ({
  getActiveTeamRuntime: () => ({
    buildPromptContext: () => ({ selfIsDisposable: state.disposable, selfIsLead: false, teamName: 'Fixture team', roster: [] }),
    getDelegatedPolicy: () => state.policy,
    noteEpochTurn: () => true, maybeAutoNameConversation: vi.fn(), recordToolAudit: vi.fn(),
    noteMemberStatusChanged: vi.fn(), noteMemberTurnStarted: vi.fn(), noteMemberTurnEnded: vi.fn(),
    reconcileAwaitingDecision: vi.fn(), bus: { drainMailbox: vi.fn() },
  }),
}))
vi.mock('../../../../src/main/apps/runtime/team/team-tools', () => ({
  buildCoordinationTools: () => [], createTeamMcpServer: () => ({ name: 'halo-team' }),
}))
vi.mock('../../../../src/main/apps/runtime/team/team-prompt', () => ({
  buildRestrictionNotice: () => '', buildTeamEntry: () => '', buildTeamConstraints: () => [], buildTeamImBridge: () => '',
}))
vi.mock('../../../../src/main/apps/runtime/index', () => ({
  getAppRuntime: () => null,
  getAppMemoryService: () => ({}), getActivityStore: () => ({}),
}))
vi.mock('../../../../src/main/apps/runtime/execution-environment', () => ({
  resolveChatEnvironment: () => ({ spaceId: 'space', spacePath: state.workDir, workDir: state.workDir, memoryDir: state.workDir }),
  validateEnvironmentConnections: vi.fn(), appChatRunId: (conversationId: string) => conversationId,
}))
vi.mock('../../../../src/main/apps/runtime/engine-selection', () => ({
  resolveAppSessionEngine: async () => 'halo', prepareAppEngineSession: () => ({}),
}))
vi.mock('../../../../src/main/apps/runtime/session-store', () => ({
  loadChatEngineState: () => ({}), saveChatEngineRouting: () => ({}),
}))
vi.mock('../../../../src/main/apps/runtime/turn/memory-lifecycle', () => ({
  appMemorySettings: () => ({ enabled: false }), appMemoryGuard: () => ({}),
  appTurnFileAccess: () => ({ cwd: state.workDir, memoryWritable: [], memoryReadable: [], attachedFiles: [], workspaceRoots: [state.workDir], closed: [], hookGuarded: [], memorySystemPaths: [] }),
}))
vi.mock('../../../../src/main/apps/runtime/app-chat-browser', () => ({
  acquireChatBrowserContext: vi.fn(), bindChatBrowserSession: vi.fn(), endChatBrowserTurn: vi.fn(), destroyChatBrowserContext: vi.fn(),
}))
vi.mock('../../../../src/main/apps/runtime/app-chat-sink', () => ({ getAppChatSink: () => sink, bindAppChatEngine: () => sink }))
vi.mock('../../../../src/main/apps/runtime/app-chat-live-turn', () => ({
  appChatMessageIdentity: () => 'fixture', isAppChatConversationGenerating: () => false, onAppChatConversationChange: vi.fn(),
}))
vi.mock('../../../../src/main/apps/runtime/app-chat-delivery', () => ({ createAppChatDelivery: vi.fn(), isPersonRequest: () => false }))
vi.mock('../../../../src/main/apps/runtime/im-session-registry', () => ({ getImSessionRegistry: () => null }))
vi.mock('../../../../src/main/apps/runtime/im-channels', () => ({ getActiveImChannelManager: () => null }))
vi.mock('../../../../src/main/apps/runtime/dispatch-inbound', () => ({ getPendingSupplementInputIds: () => [], holdSupplementsAfterStop: vi.fn() }))
vi.mock('../../../../src/main/apps/runtime/delegation-gate', () => ({
  beginDelegatedTurn: vi.fn(), createDelegationAuditHooks: () => ({}), createSkillGateHooks: () => ({}),
  createTurnFileAccessHooks: () => ({}), turnFileExportRefusal: () => undefined,
}))
vi.mock('../../../../src/main/apps/runtime/prompt/identity', () => ({ buildIdentityFragments: () => [] }))
vi.mock('../../../../src/main/apps/runtime/prompt/capabilities', () => ({ buildDisabledCapabilitiesGuidance: () => '', buildUnconfiguredCapabilitiesGuidance: () => '' }))
vi.mock('../../../../src/main/apps/runtime/prompt/team-guidance', () => ({ buildTeamGuidance: () => null }))
vi.mock('../../../../src/main/apps/runtime/live-instances', () => ({ describeSelfInstance: () => ({}), formatInstanceTag: () => 'fixture' }))
vi.mock('../../../../src/main/apps/runtime/standing-teams', () => ({ listStandingTeams: () => [] }))
vi.mock('../../../../src/main/apps/runtime/conversation-collab', () => ({ resolveConversationCollab: () => null, createConversationCollabMcpServer: vi.fn() }))
vi.mock('../../../../src/main/apps/runtime/notify-tool', () => ({ createNotifyToolServer: () => ({ name: 'halo-notify' }) }))
vi.mock('../../../../src/main/apps/runtime/notify-availability', () => ({ resolveNotifyAvailability: () => ({}) }))
vi.mock('../../../../src/main/apps/runtime/reminders/tool', () => ({ createRemindersMcpServer: () => ({ name: 'halo-reminders' }) }))
vi.mock('../../../../src/main/apps/runtime/report-tool', () => ({ createReportToolServer: () => ({ name: 'halo-report' }) }))

import { sendAppChatMessage } from '../../../../src/main/apps/runtime/app-chat'
import { createHaloAppsMcpServer } from '../../../../src/main/apps/conversation-mcp'
import { registerAppBridge } from '../../../../src/main/services/app-bridge'
import { buildImSessionKey, buildTeamSessionKey } from '../../../../src/shared/apps/im-keys'

beforeEach(() => {
  state.workDir = globalThis.__HALO_TEST_DIR__
  state.sessions = []
  state.policy = { allowedTools: ['Read'] }
  state.disposable = false
  registerAppBridge({ getAppManager: () => null, createHaloAppsMcpServer, onMcpAppsChange: () => () => {} })
  acquireSession.mockImplementation(async (_space: string, _conversation: string, options: Record<string, unknown>) => {
    state.sessions.push(options)
    return { session: {}, isCurrent: true, isUsable: true, onRetired: () => () => {}, send: vi.fn(), release: vi.fn() }
  })
  library.list.mockReturnValue({ groups: [] })
})

async function turn(origin?: TeamRequestOrigin, guestPolicy?: CapabilityPolicy) {
  const request = {
    appId: app.id, spaceId: 'space', message: 'List my skills',
    conversationId: origin ? buildTeamSessionKey(app.id, 'fixture-team', 'fixture-task')
      : guestPolicy ? buildImSessionKey(app.id, 'wecom-bot', 'direct', 'guest') : `app-chat:${app.id}`,
    turnStart: { cancelled: false, stoppedBy: undefined, reset: false, end: vi.fn(), releaseSession: vi.fn(), bindSession: vi.fn() },
    ...(origin ? { teamContext: {
      teamId: 'fixture-team', epochId: 'fixture-task', kind: 'message', fromAppId: 'sender', correlationId: 'fixture', wait: false, origin,
    } } : {}),
    ...(guestPolicy ? {
      imPermission: { senderId: 'guest', senderName: 'Guest', isOwner: false, guestPolicy },
      imSession: { channel: 'wecom-bot', chatType: 'direct', displayName: 'Guest', sessionId: 'fixture:guest' },
    } : {}),
  } as Parameters<typeof sendAppChatMessage>[0]
  await sendAppChatMessage(request)
  expect(state.sessions).toHaveLength(1)
  return state.sessions[0].mcpServers as Record<string, { tools?: Array<{ name: string; schema: any; handler: Function }> }>
}

describe('skill management at the real digital-human chat entry', () => {
  it('hands the local owner the fully assembled skill actions, not a factory sentinel', async () => {
    const servers = await turn()
    const tool = servers['halo-apps'].tools!.find(tool => tool.name === 'skill_manage')!
    expect(tool.schema.action.options).toEqual(['list', 'read', 'install', 'enable', 'disable', 'move', 'save', 'delete', 'uninstall'])
    await tool.handler({ action: 'list' })
    expect(library.list).toHaveBeenCalledWith({ spaceId: 'space', q: undefined, offset: undefined, limit: 20 })
  })

  it('withholds skill management from an IM guest without an apps grant', async () => {
    const servers = await turn(undefined, {})
    expect(servers).not.toHaveProperty('halo-apps')
    expect(library.list).not.toHaveBeenCalled()
    expect(library.delete).not.toHaveBeenCalled()
  })

  it.each(['guest', 'colleague'] as const)('withholds skill management from a restricted %s origin', async origin => {
    const servers = await turn(origin)
    expect(servers).not.toHaveProperty('halo-apps')
    expect(servers).toHaveProperty('halo-team')
    expect(library.list).not.toHaveBeenCalled()
    expect(library.delete).not.toHaveBeenCalled()
  })

  it('does not build durable management tools for a disposable team member', async () => {
    state.disposable = true
    expect(await turn('colleague')).not.toHaveProperty('halo-apps')
  })

  it('withholds skill management even when a colleague has full reach for other tools', async () => {
    state.policy = null
    const tools = (await turn('colleague'))['halo-apps'].tools!
    expect(tools.some(tool => tool.name === 'skill_manage')).toBe(false)
    expect(tools.some(tool => tool.name === 'list_automation_apps')).toBe(true)
  })

  it('keeps the explicit apps grant without exposing skill management to an IM guest', async () => {
    const tools = (await turn(undefined, { allowApps: true }))['halo-apps'].tools!
    expect(tools.some(tool => tool.name === 'skill_manage')).toBe(false)
    expect(tools.some(tool => tool.name === 'list_automation_apps')).toBe(true)
  })
})
