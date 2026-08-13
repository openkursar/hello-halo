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

import { describe, it, expect, beforeEach, vi } from 'vitest'

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

const { activeSessions, v2Sessions, closeV2Session, stopGeneration } = vi.hoisted(() => {
  const _activeSessions = new Map<string, unknown>()
  const _v2Sessions = new Map<string, unknown>()
  return {
    activeSessions: _activeSessions,
    v2Sessions: _v2Sessions,
    closeV2Session: vi.fn((id: string) => { _v2Sessions.delete(id) }),
    stopGeneration: vi.fn(async (id: string) => { _activeSessions.delete(id) }),
  }
})

// Registry stub — forkNativeChatSession requires a non-null registry, and
// createLocalSession returns the new session record on the happy path.
const { registry, createLocalSession } = vi.hoisted(() => {
  const _createLocalSession = vi.fn((appId: string, uuid: string) => ({
    appId,
    channel: 'local',
    source: 'local',
    instanceId: '',
    chatId: uuid,
    chatType: 'direct',
    displayName: '',
    proactive: false,
    lastActiveAt: 0,
  }))
  return {
    createLocalSession: _createLocalSession,
    registry: { createLocalSession: _createLocalSession },
  }
})

vi.mock('../../../../src/main/services/agent/session-manager', () => ({
  activeSessions,
  v2Sessions,
  closeV2Session,
  getOrCreateV2Session: vi.fn(),
  createSessionState: vi.fn(),
  registerActiveSession: vi.fn(),
  unregisterActiveSession: vi.fn(),
}))

vi.mock('../../../../src/main/services/agent/control', () => ({ stopGeneration }))

vi.mock('../../../../src/main/apps/runtime/im-session-registry', () => ({
  getImSessionRegistry: vi.fn(() => registry),
}))

vi.mock('../../../../src/main/services/agent/helpers', () => ({
  getApiCredentials: vi.fn(),
  getApiCredentialsForSource: vi.fn(),
  getWorkingDir: vi.fn(),
  getHeadlessElectronPath: vi.fn(),
  getDbMcpServers: vi.fn(),
}))
vi.mock('../../../../src/main/services/agent/sdk-config', () => ({
  resolveCredentialsForSdk: vi.fn(),
  buildBaseSdkOptions: vi.fn(),
}))
vi.mock('../../../../src/main/services/agent/permission-handler', () => ({
  createCanUseTool: vi.fn(),
}))
vi.mock('../../../../src/main/services/agent/events', () => ({ emitAgentEvent: vi.fn() }))
vi.mock('../../../../src/main/services/agent/stream-processor', () => ({ processStream: vi.fn() }))
vi.mock('../../../../src/main/services/agent/message-utils', () => ({ buildMessageContent: vi.fn() }))

vi.mock('../../../../src/main/services/ai-browser', () => ({
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
  getAppManager: vi.fn().mockReturnValue(null),
}))
vi.mock('../../../../src/main/apps/conversation-mcp', () => ({
  createHaloAppsMcpServer: vi.fn(),
}))
vi.mock('../../../../src/main/apps/runtime/index', () => ({
  getAppMemoryService: vi.fn().mockReturnValue(null),
}))
vi.mock('../../../../src/main/apps/runtime/dispatch-inbound', () => ({
  flushSupplementBuffer: vi.fn(),
}))
vi.mock('../../../../src/main/platform/memory/snapshot', () => ({
  createMemoryStatusMcpServer: vi.fn(),
}))

// ============================================
// Imports (after all mocks)
// ============================================

import {
  clearAppChat,
  forkNativeChatSession,
  getAppChatConversationId,
} from '../../../../src/main/apps/runtime/app-chat'
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

describe('clearAppChat trust boundary', () => {
  beforeEach(() => {
    activeSessions.clear()
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
  })

  it('rejects a source owned by another app', () => {
    const foreign = `${getAppChatConversationId(OTHER)}:local:direct:abc`
    expect(() => forkNativeChatSession(APP, 'space-1', foreign)).toThrow(/Invalid sourceConversationId for fork/)
    expect(createLocalSession).not.toHaveBeenCalled()
  })

  it('rejects the native default key of another app', () => {
    expect(() => forkNativeChatSession(APP, 'space-1', getAppChatConversationId(OTHER)))
      .toThrow(/Invalid sourceConversationId for fork/)
    expect(createLocalSession).not.toHaveBeenCalled()
  })

  it('rejects a non-app-chat source key', () => {
    expect(() => forkNativeChatSession(APP, 'space-1', 'random-garbage'))
      .toThrow(/Invalid sourceConversationId for fork/)
    expect(createLocalSession).not.toHaveBeenCalled()
  })

  it('allows forking from the app’s own native default session', () => {
    const result = forkNativeChatSession(APP, 'space-1', getAppChatConversationId(APP))
    expect(result.conversationId).toMatch(new RegExp(`^app-chat:${APP}:local:direct:`))
    expect(createLocalSession).toHaveBeenCalledTimes(1)
  })

  it('allows forking from the app’s own IM session', () => {
    const imKey = `${getAppChatConversationId(APP)}:wecom-bot:direct:user-1`
    const result = forkNativeChatSession(APP, 'space-1', imKey)
    expect(result.conversationId).toMatch(new RegExp(`^app-chat:${APP}:local:direct:`))
    expect(createLocalSession).toHaveBeenCalledTimes(1)
  })
})

describe('buildGuestMcpServers guest MCP injection', () => {
  // The full owner MCP set as app-chat builds it before guest filtering.
  const ALL = {
    'web-search': { _: 1 },
    'halo-memory': { _: 1 },
    'ocr': { _: 1 },
    'ai-browser': { _: 1 },
    'halo-email': { _: 1 },
  }

  it('always injects filesystem-free safe MCPs (web-search, halo-memory)', () => {
    const out = buildGuestMcpServers(ALL, null, {})
    expect(out).toHaveProperty('web-search')
    expect(out).toHaveProperty('halo-memory')
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
