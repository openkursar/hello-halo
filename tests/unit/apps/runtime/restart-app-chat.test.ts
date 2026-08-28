/**
 * Unit tests for restartAppChat() in apps/runtime/app-chat.ts
 *
 * Behavior under test:
 *   - Closes V2 sessions whose conversationId === `app-chat:{appId}` (native).
 *   - Closes V2 sessions whose conversationId starts with `app-chat:{appId}:`
 *     (IM channel sessions for this app).
 *   - Does NOT touch sessions belonging to other apps.
 *   - interruptActive:true aborts an in-flight turn via stopGeneration() first,
 *     then closes it. Default (false) LEAVES an actively-generating session alone
 *     (deferred to the next-message fingerprint rebuild) and closes only idle ones.
 *   - Calls closeV2Session() for every closed session.
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
const { consumers, v2Sessions, closeV2Session, stopGeneration } = vi.hoisted(() => {
  const _consumers = new Map<string, unknown>()
  const _v2Sessions = new Map<string, unknown>()
  return {
    consumers: _consumers,
    v2Sessions: _v2Sessions,
    closeV2Session: vi.fn((id: string) => {
      _v2Sessions.delete(id)
    }),
    stopGeneration: vi.fn(async (id: string) => {
      _consumers.delete(id)
    }),
  }
})

vi.mock('../../../../src/main/services/agent/session-manager', () => ({
  v2Sessions,
  closeV2Session,
  getConsumerHandle: (id: string) => consumers.get(id) ?? null,
  getRunningConsumerIds: () => Array.from(consumers.keys()),
  // Unused by restartAppChat but referenced by app-chat module-level imports
  getOrCreateV2Session: vi.fn(),
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

// Apps siblings. app-chat.ts pulls in runtime/index.ts via getAppMemoryService;
// that pulls service.ts → analytics → electron-as-CJS.
// We stub the index re-exports so the heavy chain never loads.
vi.mock('../../../../src/main/apps/manager', () => ({
  getAppManager: vi.fn().mockReturnValue(null),
}))
vi.mock('../../../../src/main/apps/conversation-mcp', () => ({
  createHaloAppsMcpServer: vi.fn(),
}))
vi.mock('../../../../src/main/apps/runtime/index', () => ({
  getAppMemoryService: vi.fn().mockReturnValue(null),
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

/** A cached CC subprocess for this conversation (idle unless also marked generating). */
function seedSession(conversationId: string): void {
  v2Sessions.set(conversationId, {})
}

/**
 * Mark a seeded session as mid-turn. Generating state now lives on the
 * persistent consumer, and a live consumer always has its V2 session cached —
 * so this is strictly an annotation on an already-seeded session.
 */
function markGenerating(conversationId: string): void {
  consumers.set(conversationId, {
    isRunning: true,
    getActiveSessionState: () => ({ thoughts: [], spaceId: 'space-1' }),
  })
}

// ============================================
// Tests
// ============================================

describe('restartAppChat', () => {
  beforeEach(() => {
    consumers.clear()
    v2Sessions.clear()
    closeV2Session.mockClear()
    stopGeneration.mockClear()
  })

  it('returns 0 when no sessions match the app', async () => {
    seedSession(getAppChatConversationId('other-app'))
    seedSession(getAppChatConversationId('other-app') + ':wecom-bot:direct:abc')

    const result = await restartAppChat('target-app')

    expect(result.sessionsClosed).toBe(0)
    expect(closeV2Session).not.toHaveBeenCalled()
    expect(stopGeneration).not.toHaveBeenCalled()
  })

  it('closes the native app-chat session', async () => {
    const nativeKey = getAppChatConversationId('target-app')
    seedSession(nativeKey)

    const result = await restartAppChat('target-app')

    expect(result.sessionsClosed).toBe(1)
    expect(closeV2Session).toHaveBeenCalledWith(nativeKey)
  })

  it('closes IM channel sessions for the same app', async () => {
    const nativeKey = getAppChatConversationId('target-app')
    seedSession(nativeKey)
    seedSession(`${nativeKey}:wecom-bot:direct:user-123`)
    seedSession(`${nativeKey}:wecom-bot:group:room-456`)

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
    seedSession(targetKey)
    seedSession(otherKey)
    seedSession(`${otherKey}:wecom-bot:direct:foo`)

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
    seedSession(targetKey)
    seedSession(lookalikeKey)
    seedSession(`${lookalikeKey}:wecom-bot:direct:foo`)

    const result = await restartAppChat('target-app')

    expect(result.sessionsClosed).toBe(1)
    expect(closeV2Session).toHaveBeenCalledWith(targetKey)
    expect(closeV2Session).not.toHaveBeenCalledWith(lookalikeKey)
  })

  it('interruptActive aborts in-flight generations before closing the session', async () => {
    const nativeKey = getAppChatConversationId('target-app')
    seedSession(nativeKey)
    markGenerating(nativeKey)

    const callOrder: string[] = []
    stopGeneration.mockImplementationOnce(async (id: string) => {
      callOrder.push(`stop:${id}`)
      consumers.delete(id)
    })
    closeV2Session.mockImplementationOnce((id: string) => {
      callOrder.push(`close:${id}`)
      v2Sessions.delete(id)
    })

    const result = await restartAppChat('target-app', { interruptActive: true })

    expect(result.sessionsClosed).toBe(1)
    expect(callOrder).toEqual([`stop:${nativeKey}`, `close:${nativeKey}`])
  })

  it('ignores a generating conversation whose V2 session is already gone', async () => {
    // A consumer whose session was already swept has nothing left to restart:
    // the enumeration is over cached subprocesses precisely so this is a no-op.
    const nativeKey = getAppChatConversationId('target-app')
    markGenerating(nativeKey)

    const result = await restartAppChat('target-app', { interruptActive: true })

    expect(result.sessionsClosed).toBe(0)
    expect(stopGeneration).not.toHaveBeenCalled()
    expect(closeV2Session).not.toHaveBeenCalled()
  })

  it('closes a generating session exactly once', async () => {
    const nativeKey = getAppChatConversationId('target-app')
    seedSession(nativeKey)
    markGenerating(nativeKey)

    const result = await restartAppChat('target-app', { interruptActive: true })

    expect(result.sessionsClosed).toBe(1)
    expect(closeV2Session).toHaveBeenCalledTimes(1)
    expect(stopGeneration).toHaveBeenCalledTimes(1)
  })

  it('default (no interrupt) leaves an actively-generating session alone', async () => {
    // A non-revoke edit must not drop an in-flight reply: the active session is
    // deferred (not stopped, not closed) and rebuilt on its next message.
    const nativeKey = getAppChatConversationId('target-app')
    seedSession(nativeKey)
    markGenerating(nativeKey)

    const result = await restartAppChat('target-app')

    expect(result.sessionsClosed).toBe(0)
    expect(stopGeneration).not.toHaveBeenCalled()
    expect(closeV2Session).not.toHaveBeenCalled()
  })

  it('default (no interrupt) still closes idle sessions while deferring active ones', async () => {
    const nativeKey = getAppChatConversationId('target-app')
    const idleImKey = `${nativeKey}:wecom-bot:direct:user-1`
    seedSession(nativeKey)
    markGenerating(nativeKey)    // mid-generation → deferred
    seedSession(idleImKey)       // idle → closed now

    const result = await restartAppChat('target-app')

    expect(result.sessionsClosed).toBe(1)
    expect(stopGeneration).not.toHaveBeenCalled()
    expect(closeV2Session).toHaveBeenCalledWith(idleImKey)
    expect(closeV2Session).not.toHaveBeenCalledWith(nativeKey)
  })

  it('continues closing other sessions after a per-session failure', async () => {
    const nativeKey = getAppChatConversationId('target-app')
    const imKey = `${nativeKey}:wecom-bot:direct:user-1`
    seedSession(nativeKey)
    seedSession(imKey)

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
