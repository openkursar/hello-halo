/**
 * Unit tests for restartAppChat() in apps/runtime/app-chat.ts
 *
 * Behavior under test:
 *   - Closes V2 sessions whose conversationId === `app-chat:{appId}` (native).
 *   - Closes V2 sessions whose conversationId starts with `app-chat:{appId}:`
 *     (IM channel sessions for this app).
 *   - Does NOT touch sessions belonging to other apps.
 *   - Calls stopGeneration() first when a session is actively generating.
 *   - Calls closeV2Session() for every matched session.
 *   - Returns the count of sessions closed.
 *   - Idempotent: returns 0 when no sessions match.
 *   - Continues on per-session errors (one failure does not abort the loop).
 *
 * The test stubs session-manager state directly so prefix-matching logic
 * can be exercised without spawning real CC subprocesses.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// ============================================
// Mocks (must be declared before importing app-chat)
// ============================================

// Anthropic SDK — used transitively by helpers/sdk-config.
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

// Electron is mocked globally in tests/unit/setup.ts — do not re-mock here
// or the local stub will shadow the richer global one.

// Session-manager — the heart of this test. We expose mutable maps that
// each test populates, plus spies for the close/stop calls.
//
// vi.mock factories are hoisted above top-level statements; use vi.hoisted
// so the maps and spies are available to the factories.
const { activeSessions, v2Sessions, closeV2Session, stopGeneration } = vi.hoisted(() => {
  const _activeSessions = new Map<string, unknown>()
  const _v2Sessions = new Map<string, unknown>()
  return {
    activeSessions: _activeSessions,
    v2Sessions: _v2Sessions,
    closeV2Session: vi.fn((id: string) => {
      _v2Sessions.delete(id)
    }),
    stopGeneration: vi.fn(async (id: string) => {
      _activeSessions.delete(id)
    }),
  }
})

vi.mock('../../../../src/main/services/agent/session-manager', () => ({
  activeSessions,
  v2Sessions,
  closeV2Session,
  // Unused by restartAppChat but referenced by app-chat module-level imports
  getOrCreateV2Session: vi.fn(),
  createSessionState: vi.fn(),
  registerActiveSession: vi.fn(),
  unregisterActiveSession: vi.fn(),
}))

vi.mock('../../../../src/main/services/agent/control', () => ({
  stopGeneration,
}))

// Helpers, sdk-config, permission-handler — unused by restartAppChat but
// referenced at the top of app-chat.ts.
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
vi.mock('../../../../src/main/services/agent/events', () => ({
  emitAgentEvent: vi.fn(),
}))
vi.mock('../../../../src/main/services/agent/stream-processor', () => ({
  processStream: vi.fn(),
}))
vi.mock('../../../../src/main/services/agent/message-utils', () => ({
  buildMessageContent: vi.fn(),
}))

// AI Browser and other MCP servers — referenced at module load.
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

// Config + space services. onAgentConfigChange is consumed by the logging
// controller at module load — must be a no-op subscriber stub.
vi.mock('../../../../src/main/foundation/config.service', () => ({
  getConfig: vi.fn().mockReturnValue({}),
  getTempSpacePath: vi.fn().mockReturnValue('/tmp/halo-test/temp'),
  onApiConfigChange: vi.fn(),
  onAgentConfigChange: vi.fn(),
  onNetworkConfigChange: vi.fn(),
}))
vi.mock('../../../../src/main/services/space.service', () => ({
  getSpace: vi.fn().mockReturnValue(null),
}))

// Apps siblings. app-chat.ts pulls in runtime/index.ts via getAppMemoryService
// + getActivityStore; that pulls service.ts → analytics → electron-as-CJS.
// We stub the index re-exports so the heavy chain never loads.
vi.mock('../../../../src/main/apps/manager', () => ({
  getAppManager: vi.fn().mockReturnValue(null),
}))
vi.mock('../../../../src/main/apps/conversation-mcp', () => ({
  createHaloAppsMcpServer: vi.fn(),
}))
vi.mock('../../../../src/main/apps/runtime/index', () => ({
  getAppMemoryService: vi.fn().mockReturnValue(null),
  getActivityStore: vi.fn().mockReturnValue(null),
}))

// dispatch-inbound pulls in analytics → electron-CJS at module load.
vi.mock('../../../../src/main/apps/runtime/dispatch-inbound', () => ({
  flushSupplementBuffer: vi.fn(),
}))

// Memory snapshot — used at module load.
vi.mock('../../../../src/main/platform/memory/snapshot', () => ({
  createMemoryStatusMcpServer: vi.fn(),
}))

// ============================================
// Imports (after all mocks)
// ============================================

import { restartAppChat, getAppChatConversationId } from '../../../../src/main/apps/runtime/app-chat'

// ============================================
// Helpers
// ============================================

function seedSession(map: 'active' | 'v2', conversationId: string): void {
  const target = map === 'active' ? activeSessions : v2Sessions
  target.set(conversationId, {})
}

// ============================================
// Tests
// ============================================

describe('restartAppChat', () => {
  beforeEach(() => {
    activeSessions.clear()
    v2Sessions.clear()
    closeV2Session.mockClear()
    stopGeneration.mockClear()
  })

  it('returns 0 when no sessions match the app', async () => {
    seedSession('v2', getAppChatConversationId('other-app'))
    seedSession('v2', getAppChatConversationId('other-app') + ':wecom-bot:direct:abc')

    const result = await restartAppChat('target-app')

    expect(result.sessionsClosed).toBe(0)
    expect(closeV2Session).not.toHaveBeenCalled()
    expect(stopGeneration).not.toHaveBeenCalled()
  })

  it('closes the native app-chat session', async () => {
    const nativeKey = getAppChatConversationId('target-app')
    seedSession('v2', nativeKey)

    const result = await restartAppChat('target-app')

    expect(result.sessionsClosed).toBe(1)
    expect(closeV2Session).toHaveBeenCalledWith(nativeKey)
  })

  it('closes IM channel sessions for the same app', async () => {
    const nativeKey = getAppChatConversationId('target-app')
    seedSession('v2', nativeKey)
    seedSession('v2', `${nativeKey}:wecom-bot:direct:user-123`)
    seedSession('v2', `${nativeKey}:wecom-bot:group:room-456`)

    const result = await restartAppChat('target-app')

    expect(result.sessionsClosed).toBe(3)
    expect(closeV2Session).toHaveBeenCalledTimes(3)
    expect(closeV2Session.mock.calls.map(c => c[0]).sort()).toEqual([
      nativeKey,
      `${nativeKey}:wecom-bot:direct:user-123`,
      `${nativeKey}:wecom-bot:group:room-456`,
    ].sort())
  })

  it('does not touch sessions of other apps', async () => {
    const targetKey = getAppChatConversationId('target-app')
    const otherKey = getAppChatConversationId('other-app')
    seedSession('v2', targetKey)
    seedSession('v2', otherKey)
    seedSession('v2', `${otherKey}:wecom-bot:direct:foo`)

    const result = await restartAppChat('target-app')

    expect(result.sessionsClosed).toBe(1)
    expect(closeV2Session).toHaveBeenCalledWith(targetKey)
    expect(closeV2Session).not.toHaveBeenCalledWith(otherKey)
    expect(closeV2Session).not.toHaveBeenCalledWith(`${otherKey}:wecom-bot:direct:foo`)
  })

  it('does NOT match cross-app prefix collision (target-app vs target-app-2)', async () => {
    // "target-app-2" must not match the "target-app:" prefix. The match
    // uses `prefix + ':'` precisely to guard against this.
    const targetKey = getAppChatConversationId('target-app')
    const lookalikeKey = getAppChatConversationId('target-app-2')
    seedSession('v2', targetKey)
    seedSession('v2', lookalikeKey)
    seedSession('v2', `${lookalikeKey}:wecom-bot:direct:foo`)

    const result = await restartAppChat('target-app')

    expect(result.sessionsClosed).toBe(1)
    expect(closeV2Session).toHaveBeenCalledWith(targetKey)
    expect(closeV2Session).not.toHaveBeenCalledWith(lookalikeKey)
  })

  it('aborts in-flight generations before closing the session', async () => {
    const nativeKey = getAppChatConversationId('target-app')
    seedSession('active', nativeKey)
    seedSession('v2', nativeKey)

    const callOrder: string[] = []
    stopGeneration.mockImplementationOnce(async (id: string) => {
      callOrder.push(`stop:${id}`)
      activeSessions.delete(id)
    })
    closeV2Session.mockImplementationOnce((id: string) => {
      callOrder.push(`close:${id}`)
      v2Sessions.delete(id)
    })

    const result = await restartAppChat('target-app')

    expect(result.sessionsClosed).toBe(1)
    expect(callOrder).toEqual([`stop:${nativeKey}`, `close:${nativeKey}`])
  })

  it('handles sessions present only in activeSessions (no cached V2 entry)', async () => {
    // Edge case: a session is mid-generation but the v2Sessions cache
    // has been swept (idle cleanup race). Restart must still close it.
    const nativeKey = getAppChatConversationId('target-app')
    seedSession('active', nativeKey)

    const result = await restartAppChat('target-app')

    expect(result.sessionsClosed).toBe(1)
    expect(stopGeneration).toHaveBeenCalledWith(nativeKey)
    expect(closeV2Session).toHaveBeenCalledWith(nativeKey)
  })

  it('deduplicates when a session lives in both maps', async () => {
    // Sessions that are actively generating also have a v2Sessions entry.
    // The function must not double-close.
    const nativeKey = getAppChatConversationId('target-app')
    seedSession('active', nativeKey)
    seedSession('v2', nativeKey)

    const result = await restartAppChat('target-app')

    expect(result.sessionsClosed).toBe(1)
    expect(closeV2Session).toHaveBeenCalledTimes(1)
    expect(stopGeneration).toHaveBeenCalledTimes(1)
  })

  it('continues closing other sessions after a per-session failure', async () => {
    const nativeKey = getAppChatConversationId('target-app')
    const imKey = `${nativeKey}:wecom-bot:direct:user-1`
    seedSession('v2', nativeKey)
    seedSession('v2', imKey)

    // First close throws; second must still execute.
    closeV2Session
      .mockImplementationOnce(() => { throw new Error('boom') })
      .mockImplementationOnce((id: string) => { v2Sessions.delete(id) })

    const result = await restartAppChat('target-app')

    // One succeeded — only successful closes are counted.
    expect(result.sessionsClosed).toBe(1)
    expect(closeV2Session).toHaveBeenCalledTimes(2)
  })
})
