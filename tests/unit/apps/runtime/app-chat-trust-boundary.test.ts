/**
 * Unit tests for the trust-boundary guards in apps/runtime/app-chat.ts:
 *
 *   clearAppChat()          — refuses to clear IM-channel sessions (they have a
 *                             dedicated clearImSession path) and cross-app keys,
 *                             while allowing native default / local / http keys.
 *   forkNativeChatSession() — refuses to fork from a source conversation owned by
 *                             another app, while allowing the app's own native
 *                             default and channel-qualified (IM/http/local) keys.
 *
 * These guard the IPC entry points, which pass caller-supplied conversationIds
 * without the HTTP layer's resolveHttpConversationId validation.
 *
 * The heavy module graph of app-chat.ts is stubbed (same scaffolding as
 * restart-app-chat.test.ts) so the pure guard logic runs without spawning real
 * CC subprocesses or touching disk.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync, renameSync } from 'fs'
import { join } from 'path'

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync) }
})

// ============================================
// Mocks (must be declared before importing app-chat)
// ============================================

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  unstable_v2_createSession: vi.fn(),
  tool: vi.fn((opts: any) => ({ ...opts, _isTool: true })),
  createSdkMcpServer: vi.fn((opts: any) => ({
    name: opts.name,
    version: opts.version,
    tools: opts.tools,
    _isMcpServer: true,
  })),
}))

const { consumers, v2Sessions, closeV2Session, stopGeneration } = vi.hoisted(() => {
  const _consumers = new Map<string, unknown>()
  const _v2Sessions = new Map<string, unknown>()
  return {
    consumers: _consumers,
    v2Sessions: _v2Sessions,
    closeV2Session: vi.fn((id: string) => { _v2Sessions.delete(id) }),
    stopGeneration: vi.fn(async (id: string) => { _consumers.delete(id) }),
  }
})

// Registry stub — forkNativeChatSession requires a non-null registry, and
// createLocalSession returns the new session record on the happy path.
const { registry, createLocalSession } = vi.hoisted(() => {
  const _createLocalSession = vi.fn((appId: string, uuid: string, _options?: { forkOrigin?: string; pendingResumeSessionId?: string }) => ({
    appId,
    channel: 'local',
    source: 'local',
    instanceId: '',
    chatId: uuid,
    chatType: 'direct',
    displayName: '',
    proactive: false,
    lastActiveAt: 0,
    messageCount: 0,
  }))
  return {
    createLocalSession: _createLocalSession,
    registry: { createLocalSession: _createLocalSession, resetActivity: vi.fn() },
  }
})

vi.mock('../../../../src/main/services/agent/session-manager', () => ({
  activeSessions: new Map(),
  hasPendingSessionInput: () => false,
  getSessionEngineId: vi.fn(() => undefined),
  v2Sessions,
  closeV2Session,
  acquireV2Session: vi.fn(),
  getConsumerHandle: (id: string) => consumers.get(id) ?? null,
  getRunningConsumerIds: () => Array.from(consumers.keys()),
  markTurnDispatched: vi.fn(),
  updateConsumerDisplayModel: vi.fn(),
}))

vi.mock('../../../../src/main/services/agent/control', () => ({
  stopGeneration,
  getSessionState: (id: string) =>
    consumers.has(id)
      ? { isActive: true, thoughts: [], spaceId: 'space-1' }
      : { isActive: false, thoughts: [] },
}))

vi.mock('../../../../src/main/apps/runtime/im-session-registry', () => ({
  getImSessionRegistry: vi.fn(() => registry),
}))

vi.mock('../../../../src/main/services/agent/helpers', () => ({
  getApiCredentials: vi.fn(),
  getApiCredentialsForSelection: vi.fn(),
  getWorkingDir: vi.fn(),
  getHeadlessElectronPath: vi.fn(),
  getDbMcpServers: vi.fn(),
}))
vi.mock('../../../../src/main/services/agent/sdk-config', () => ({
  markMcpServerSettings: (server: unknown) => server,
  resolveCredentialsForSdk: vi.fn(),
  buildUserSessionSdkOptions: vi.fn(),
}))
vi.mock('../../../../src/main/services/agent/permission-handler', () => ({
  createCanUseTool: vi.fn(),
}))
vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn(), trackErrorSurface: vi.fn() },
}))

vi.mock('../../../../src/main/services/agent/events', () => ({ emitAgentEvent: vi.fn() }))
vi.mock('../../../../src/main/foundation/window.service', () => ({ sendToRenderer: vi.fn() }))
vi.mock('../../../../src/main/http/websocket', () => ({ broadcastToAll: vi.fn() }))
vi.mock('../../../../src/main/services/agent/stream-processor', () => ({ processStream: vi.fn() }))
vi.mock('../../../../src/main/services/agent/message-utils', () => ({ buildMessageContent: vi.fn(), formatCanvasContext: () => '' }))

vi.mock('../../../../src/main/services/ai-browser', () => ({
  AI_BROWSER_DESCRIPTION: 'Browse websites',
  AI_BROWSER_SYSTEM_PROMPT: '',
  createAIBrowserMcpServer: vi.fn(),
  createScopedBrowserContext: vi.fn(),
}))
vi.mock('../../../../src/main/services/web-search', () => ({
  createWebSearchMcpServer: vi.fn().mockReturnValue({ _isMcpServer: true }),
}))
vi.mock('../../../../src/main/services/email-mcp', () => ({
  createEmailMcpServer: vi.fn().mockReturnValue(null),
}))

vi.mock('../../../../src/main/foundation/config.service', () => ({
  getConfig: vi.fn().mockReturnValue({}),
  getTempSpacePath: vi.fn().mockReturnValue('/tmp/halo-test/temp'),
  onApiConfigChange: vi.fn(),
  onAgentConfigChange: vi.fn(),
  onNetworkConfigChange: vi.fn(),
}))
// getSpace returns null so both guards' allow-path skips disk I/O entirely.
vi.mock('../../../../src/main/services/space.service', () => ({
  getSpace: vi.fn().mockReturnValue(null),
}))

vi.mock('../../../../src/main/apps/manager', () => ({
  getAppManager: vi.fn().mockReturnValue({ getApp: (id: string) => ({ id, spaceId: 'new-space' }) }),
}))
const { environment, activityStore, resolveChatEnvironment, copySessionJsonl } = vi.hoisted(() => {
  const environment = { spaceId: 'old-space', spacePath: '/original-space', workDir: '/original-cwd', memoryDir: '/original-memory' }
  return {
    environment,
    activityStore: { getSessionEnvironment: vi.fn(), deleteSessionEnvironment: vi.fn(), pinSessionEnvironment: vi.fn() },
    resolveChatEnvironment: vi.fn(() => environment),
    copySessionJsonl: vi.fn((_spacePath: string, _appId: string, _fromRunId: string, _toRunId: string) => true),
  }
})
vi.mock('../../../../src/main/apps/runtime/execution-environment', () => ({
  resolveChatEnvironment,
  appChatRunId: (conversationId: string, appId: string) => conversationId === `app-chat:${appId}` ? 'chat' : `chat-${conversationId.slice(`app-chat:${appId}:`.length).replace(/:/g, '-')}`,
  legacySessionEnvironmentKey: (appId: string, runId: string) => `legacy-file:${appId}:${runId}`,
}))
vi.mock('../../../../src/main/apps/runtime/engine-selection', () => ({
  resolveAppSessionEngine: async (selection: { engineId?: string }) => selection.engineId ?? 'halo',
  prepareAppEngineSession: (options: { state: { sessionId?: string }; legacySessionId?: string }) => ({ resumeSessionId: options.state.sessionId ?? options.legacySessionId }),
}))

const persistence = vi.hoisted(() => ({ real: false }))
vi.mock('../../../../src/main/apps/runtime/session-store', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../src/main/apps/runtime/session-store')>()
  return {
    ...actual,
    saveChatEngineRouting: vi.fn((...args: Parameters<typeof actual.saveChatEngineRouting>) => persistence.real
      ? actual.saveChatEngineRouting(...args) : args[4] ?? { routingEngine: args[3] }),
    loadChatEngineState: vi.fn((...args: Parameters<typeof actual.loadChatEngineState>) => persistence.real
      ? actual.loadChatEngineState(...args) : { sessionId: 'original-sdk-session' }),
    saveChatEngineBinding: vi.fn((...args: Parameters<typeof actual.saveChatEngineBinding>) => persistence.real
      ? actual.saveChatEngineBinding(...args) : true),
    copySessionJsonl: (...args: Parameters<typeof actual.copySessionJsonl>) => persistence.real
      ? actual.copySessionJsonl(...args) : copySessionJsonl(...args),
    loadChatSessionId: vi.fn((...args: Parameters<typeof actual.loadChatSessionId>) => persistence.real
      ? actual.loadChatSessionId(...args) : 'original-sdk-session'),
    deleteChatSessionId: vi.fn((...args: Parameters<typeof actual.deleteChatSessionId>) => {
      if (persistence.real) actual.deleteChatSessionId(...args)
    }),
  }
})
vi.mock('../../../../src/main/apps/conversation-mcp', () => ({
  createHaloAppsMcpServer: vi.fn(),
}))
vi.mock('../../../../src/main/apps/runtime/index', () => ({
  getAppMemoryService: vi.fn().mockReturnValue(null),
  getActivityStore: () => activityStore,
}))
vi.mock('../../../../src/main/apps/runtime/dispatch-inbound', () => ({
}))
vi.mock('../../../../src/main/services/memory-consolidation', () => ({
  requestConsolidation: vi.fn(),
}))

// ============================================
// Imports (after all mocks)
// ============================================

import {
  clearAppChat,
  forkNativeChatSession,
  getAppChatConversationId,
  loadChatEngineMetadata,
} from '../../../../src/main/apps/runtime/app-chat'
import { getConfig } from '../../../../src/main/foundation/config.service'
import { getAppManager } from '../../../../src/main/apps/manager'
import { loadChatEngineState, saveChatEngineBinding, saveChatSessionId, reloadChatInstructions, openSessionWriter, readSessionMessages } from '../../../../src/main/apps/runtime/session-store'
import { appChatRunId } from '../../../../src/main/apps/runtime/execution-environment'
import type { EngineId } from '../../../../src/shared/types/engine'
import { sendToRenderer } from '../../../../src/main/foundation/window.service'
import { broadcastToAll } from '../../../../src/main/http/websocket'
import { getSessionEngineId } from '../../../../src/main/services/agent/session-manager'
import { filterMcpServersByPolicy } from '../../../../src/main/apps/runtime/capability-policy'
import type { GuestPolicy } from '../../../../src/shared/types/im-channel'

/** A guest is a stranger: nothing is granted unless the host said so. */
const buildGuestMcpServers = (
  all: Record<string, unknown>,
  db: Record<string, unknown> | null,
  policy?: GuestPolicy
) => filterMcpServersByPolicy(all, db, policy, 'strict')

const APP = 'target-app'
const OTHER = 'other-app'

describe('cold digital-human engine metadata', () => {
  it.each([
    ['halo', 'anthropic'],
    ['anthropic', 'halo'],
  ] as const)('keeps current %s separate from desired %s before the next turn', (current, desired) => {
    const binding = { version: 1 as const, engineId: current, sessionId: 'native-session' }
    const app = { id: APP, userOverrides: { engineId: desired } }
    vi.mocked(getAppManager).mockReturnValueOnce({ getApp: () => app } as unknown as ReturnType<typeof getAppManager>)
    vi.mocked(loadChatEngineState).mockReturnValueOnce({ sessionId: binding.sessionId, binding })
    expect(loadChatEngineMetadata('/space', APP, `app-chat:${APP}`)).toEqual({ engineId: current, engineBinding: binding })
    expect(app.userOverrides.engineId).toBe(desired)
  })

  it.each(['halo', 'anthropic'] as const)('uses override %s when no binding exists', (engineId) => {
    vi.mocked(getAppManager).mockReturnValueOnce({ getApp: () => ({ userOverrides: { engineId } }) } as unknown as ReturnType<typeof getAppManager>)
    vi.mocked(loadChatEngineState).mockReturnValueOnce({})
    expect(loadChatEngineMetadata('/space', APP, `app-chat:${APP}`)).toEqual({ engineId })
  })

  it('resolves an automatic CC binding to Halo while preserving its native ownership', () => {
    const binding = { version: 1 as const, engineId: 'anthropic' as const, sessionId: 'cc-native' }
    vi.mocked(getConfig).mockReturnValueOnce({ agent: { sdkEngine: 'anthropic', ccRuntime: { selectedPath: '/automatic/claude' } } } as ReturnType<typeof getConfig>)
    vi.mocked(loadChatEngineState).mockReturnValueOnce({ sessionId: binding.sessionId, binding })
    expect(loadChatEngineMetadata('/space', APP, `app-chat:${APP}`)).toEqual({ engineId: 'halo', engineBinding: binding })
  })

  it('retains a CC binding when the user explicitly selected the runtime', () => {
    const binding = { version: 1 as const, engineId: 'anthropic' as const, sessionId: 'cc-native' }
    vi.mocked(getConfig).mockReturnValueOnce({ agent: { sdkEngine: 'halo', ccRuntime: { selectedPath: '/chosen/claude', selectionOrigin: 'user' } } } as ReturnType<typeof getConfig>)
    vi.mocked(loadChatEngineState).mockReturnValueOnce({ sessionId: binding.sessionId, binding })
    expect(loadChatEngineMetadata('/space', APP, `app-chat:${APP}`)).toEqual({ engineId: 'anthropic', engineBinding: binding })
  })

  it('reports the resident engine during a handoff before its binding is committed', () => {
    const binding = { version: 1 as const, engineId: 'anthropic' as const, sessionId: 'cc-native' }
    vi.mocked(loadChatEngineState).mockReturnValueOnce({ sessionId: binding.sessionId, binding })
    vi.mocked(getSessionEngineId).mockReturnValueOnce('halo')
    expect(loadChatEngineMetadata('/space', APP, `app-chat:${APP}`)).toEqual({ engineId: 'halo', engineBinding: binding })
  })
})

describe('clearAppChat trust boundary', () => {
  beforeEach(() => {
    consumers.clear()
    v2Sessions.clear()
    closeV2Session.mockClear()
    stopGeneration.mockClear()
  })

  it('rejects an IM-channel session key (dedicated clearImSession path)', async () => {
    const imKey = `${getAppChatConversationId(APP)}:wecom-bot:direct:user-1`
    await expect(clearAppChat(APP, 'space-1', imKey)).rejects.toThrow(/Cannot clear IM session/)
    expect(closeV2Session).not.toHaveBeenCalled()
  })

  it('rejects a key owned by another app', async () => {
    const foreign = `${getAppChatConversationId(OTHER)}:local:direct:abc`
    await expect(clearAppChat(APP, 'space-1', foreign)).rejects.toThrow(/Invalid conversationId for clear/)
    expect(closeV2Session).not.toHaveBeenCalled()
  })

  it('rejects a non-app-chat key', async () => {
    await expect(clearAppChat(APP, 'space-1', 'random-garbage')).rejects.toThrow(/Invalid conversationId for clear/)
    expect(closeV2Session).not.toHaveBeenCalled()
  })

  it('allows the native default session', async () => {
    await expect(clearAppChat(APP, 'space-1')).resolves.toBeUndefined()
    expect(closeV2Session).toHaveBeenCalledWith(getAppChatConversationId(APP))
  })

  it('allows a local session of the same app', async () => {
    const localKey = `${getAppChatConversationId(APP)}:local:direct:sess-1`
    await expect(clearAppChat(APP, 'space-1', localKey)).resolves.toBeUndefined()
    expect(closeV2Session).toHaveBeenCalledWith(localKey)
  })

  it('allows an http session of the same app', async () => {
    const httpKey = `${getAppChatConversationId(APP)}:http:direct:ext-1`
    await expect(clearAppChat(APP, 'space-1', httpKey)).resolves.toBeUndefined()
    expect(closeV2Session).toHaveBeenCalledWith(httpKey)
  })
})

describe('forkNativeChatSession trust boundary', () => {
  beforeEach(() => {
    createLocalSession.mockClear()
    resolveChatEnvironment.mockClear()
    activityStore.pinSessionEnvironment.mockClear()
    copySessionJsonl.mockClear()
  })

  it('rejects a source owned by another app', () => {
    const foreign = `${getAppChatConversationId(OTHER)}:local:direct:abc`
    expect(() => forkNativeChatSession(APP, 'space-1', foreign)).toThrow(/Invalid sourceConversationId for fork/)
    expect(createLocalSession).not.toHaveBeenCalled()
    expect(resolveChatEnvironment).not.toHaveBeenCalled()
  })

  it('rejects the native default key of another app', () => {
    expect(() => forkNativeChatSession(APP, 'space-1', getAppChatConversationId(OTHER)))
      .toThrow(/Invalid sourceConversationId for fork/)
    expect(createLocalSession).not.toHaveBeenCalled()
    expect(resolveChatEnvironment).not.toHaveBeenCalled()
  })

  it('rejects a non-app-chat source key', () => {
    expect(() => forkNativeChatSession(APP, 'space-1', 'random-garbage'))
      .toThrow(/Invalid sourceConversationId for fork/)
    expect(createLocalSession).not.toHaveBeenCalled()
    expect(resolveChatEnvironment).not.toHaveBeenCalled()
  })

  it('allows forking from the app’s own native default session', () => {
    const result = forkNativeChatSession(APP, 'space-1', getAppChatConversationId(APP))
    expect(result.conversationId).toMatch(new RegExp(`^app-chat:${APP}:local:direct:`))
    expect(createLocalSession).toHaveBeenCalledTimes(1)
    expect(activityStore.pinSessionEnvironment).toHaveBeenCalledWith(result.conversationId, APP, environment)
    expect(copySessionJsonl).toHaveBeenCalledWith('/original-space', APP, expect.any(String), expect.any(String))
    expect(createLocalSession).toHaveBeenCalledWith(APP, expect.any(String), expect.objectContaining({ pendingResumeSessionId: 'original-sdk-session' }))
  })

  it('allows forking from the app’s own IM session', () => {
    const imKey = `${getAppChatConversationId(APP)}:wecom-bot:direct:user-1`
    const result = forkNativeChatSession(APP, 'space-1', imKey)
    expect(result.conversationId).toMatch(new RegExp(`^app-chat:${APP}:local:direct:`))
    expect(createLocalSession).toHaveBeenCalledTimes(1)
    expect(activityStore.pinSessionEnvironment).toHaveBeenCalledWith(result.conversationId, APP, environment)
    expect(copySessionJsonl).toHaveBeenCalledWith('/original-space', APP, expect.any(String), expect.any(String))
    expect(createLocalSession).toHaveBeenCalledWith(APP, expect.any(String), expect.objectContaining({ pendingResumeSessionId: 'original-sdk-session' }))
  })
})

describe('forked conversation instruction state', () => {
  beforeEach(() => {
    persistence.real = true
    environment.spacePath = globalThis.__HALO_TEST_DIR__
    createLocalSession.mockClear()
    vi.mocked(getConfig).mockReturnValue({ agent: { legacySdkEngine: 'anthropic', sdkEngine: 'anthropic', ccRuntime: {
      selectedPath: '/synthetic/claude', selectionOrigin: 'user',
    } } } as ReturnType<typeof getConfig>)
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    persistence.real = false
    environment.spacePath = '/original-space'
    vi.mocked(getConfig).mockReturnValue({} as ReturnType<typeof getConfig>)
    vi.mocked(console.log).mockRestore()
  })

  for (const source of ['default', 'im'] as const) {
    it.each(['legacy-reload', 'modern-reload', 'legacy-unchanged'] as const)(`preserves %s instructions from the ${source} conversation`, format => {
      const sourceConversationId = source === 'im'
        ? `${getAppChatConversationId(APP)}:wecom-bot:direct:owner`
        : getAppChatConversationId(APP)
      const sourceRunId = appChatRunId(sourceConversationId, APP)
      const sourceBinding = { version: 1 as const, engineId: 'anthropic' as const, sessionId: 'source-native' }
      if (format === 'modern-reload') saveChatEngineBinding(environment.spacePath, APP, sourceRunId, sourceBinding)
      else saveChatSessionId(environment.spacePath, APP, sourceRunId, sourceBinding.sessionId)
      const writer = openSessionWriter(environment.spacePath, APP, sourceRunId)
      writer.writeTrigger('Keep the source history')
      writer.writeEvent({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Source answer' }] } })
      if (format !== 'legacy-unchanged') expect(reloadChatInstructions(environment.spacePath, APP)).toBe(1)
      const before = loadChatEngineState(environment.spacePath, APP, sourceRunId)
      const sourceFile = join(environment.spacePath, '.halo/apps', APP, 'runs', `${sourceRunId}.jsonl`)
      const sourceBytes = readFileSync(sourceFile, 'utf8')

      const result = forkNativeChatSession(APP, 'space-1', sourceConversationId)
      expect(result.conversationId).not.toBe(sourceConversationId)
      const targetRunId = appChatRunId(result.conversationId, APP)
      const copied = loadChatEngineState(environment.spacePath, APP, targetRunId)
      expect(copied).toEqual(format === 'legacy-unchanged' ? {} : before)
      if (format === 'legacy-reload') {
        expect(copied).toEqual({ sessionId: 'source-native', useCurrentInstructions: true })
        expect(copied.binding).toBeUndefined()
        expect(copied.routingEngine).toBeUndefined()
      }
      expect(loadChatEngineState(environment.spacePath, APP, sourceRunId)).toEqual(before)
      expect(createLocalSession).toHaveBeenLastCalledWith(APP, expect.any(String), {
        forkOrigin: sourceConversationId, pendingResumeSessionId: sourceBinding.sessionId,
      })
      expect(readFileSync(sourceFile, 'utf8')).toBe(sourceBytes)
      expect(readFileSync(join(environment.spacePath, '.halo/apps', APP, 'runs', `${targetRunId}.jsonl`), 'utf8')).toBe(sourceBytes)
      expect(readSessionMessages(environment.spacePath, APP, targetRunId).map(message => message.content)).toEqual([
        'Keep the source history', 'Source answer',
      ])
    })
  }

  it('preserves another supported engine without adding CC reload state', () => {
    const source = getAppChatConversationId(APP)
    const binding = { version: 1 as const, engineId: 'halo' as const, sessionId: 'halo-native' }
    saveChatEngineBinding(environment.spacePath, APP, 'chat', binding)
    const result = forkNativeChatSession(APP, 'space-1', source)
    expect(loadChatEngineState(environment.spacePath, APP, appChatRunId(result.conversationId, APP))).toEqual({ sessionId: 'halo-native', binding })
  })

  it('does not create a visible conversation when reload state could not be copied', () => {
    saveChatSessionId(environment.spacePath, APP, 'chat', 'source-native')
    reloadChatInstructions(environment.spacePath, APP)
    const file = join(environment.spacePath, '.halo/apps', APP, 'runs/_session-ids.json')
    const before = readFileSync(file, 'utf8')
    vi.mocked(renameSync).mockImplementationOnce(() => { throw Object.assign(new Error('unavailable'), { code: 'EBUSY' }) })
    vi.mocked(sendToRenderer).mockClear()
    vi.mocked(broadcastToAll).mockClear()
    expect(() => forkNativeChatSession(APP, 'space-1', getAppChatConversationId(APP))).toThrow('Could not preserve')
    expect(createLocalSession).not.toHaveBeenCalled()
    expect(sendToRenderer).not.toHaveBeenCalled()
    expect(broadcastToAll).not.toHaveBeenCalled()
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it.each(['codex', 'dsh'] as EngineId[])('refuses an unsupported %s source before creating a destination', engineId => {
    saveChatEngineBinding(environment.spacePath, APP, 'chat', { version: 1, engineId, sessionId: 'unsupported-native' })
    expect(() => forkNativeChatSession(APP, 'space-1', getAppChatConversationId(APP))).toThrow('does not support branching')
    expect(createLocalSession).not.toHaveBeenCalled()
    expect(Object.keys(JSON.parse(readFileSync(join(environment.spacePath, '.halo/apps', APP, 'runs/_session-ids.json'), 'utf8')))).toEqual(['chat'])
  })
})

describe('buildGuestMcpServers guest MCP injection', () => {
  // The full owner MCP set as app-chat builds it before guest filtering.
  const ALL = {
    'web-search': { _: 1 },
    'ocr': { _: 1 },
    'ai-browser': { _: 1 },
    'halo-email': { _: 1 },
  }

  it('always injects filesystem-free web search, without a memory MCP', () => {
    const out = buildGuestMcpServers(ALL, null, {})
    expect(Object.keys(out)).toEqual(['web-search'])
  })

  it('does NOT inject OCR for a guest without allowOcr (reads local files)', () => {
    expect(buildGuestMcpServers(ALL, null, {})).not.toHaveProperty('ocr')
    expect(buildGuestMcpServers(ALL, null, undefined)).not.toHaveProperty('ocr')
    expect(buildGuestMcpServers(ALL, null, { allowOcr: false })).not.toHaveProperty('ocr')
  })

  it('injects OCR only when the host enables allowOcr', () => {
    const out = buildGuestMcpServers(ALL, null, { allowOcr: true } as GuestPolicy)
    expect(out).toHaveProperty('ocr')
  })

  it('keeps OCR gated independently of other capability toggles', () => {
    const out = buildGuestMcpServers(ALL, null, { allowAiBrowser: true } as GuestPolicy)
    expect(out).toHaveProperty('ai-browser')
    expect(out).not.toHaveProperty('ocr')
  })
})
