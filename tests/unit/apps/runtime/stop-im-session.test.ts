/**
 * Unit tests for stopImSession() in apps/runtime/app-chat.ts
 *
 * Behavior under test:
 *   - Aborts the active generation for a single IM session conversationId.
 *   - Calls clearSupplementBuffer() to drop buffered follow-ups.
 *   - Does NOT call closeV2Session() (history preserved, V2 session reused).
 *   - Returns { stopped: true } when a generation was active.
 *   - Returns { stopped: false } (idempotent) when nothing was active.
 *
 * Mocks mirror restart-app-chat.test.ts so the heavy app-chat module-load
 * chain is stubbed identically.
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
    closeV2Session: vi.fn((id: string) => {
      _v2Sessions.delete(id)
    }),
    stopGeneration: vi.fn(async (id: string) => {
      _activeSessions.delete(id)
    }),
  }
})

const { clearSupplementBuffer } = vi.hoisted(() => ({
  clearSupplementBuffer: vi.fn(),
}))

const { getImStreamHandle, clearImStreamHandle } = vi.hoisted(() => {
  const _store = new Map<string, unknown>()
  return {
    getImStreamHandle: vi.fn((id: string) => _store.get(id)),
    clearImStreamHandle: vi.fn((id: string) => { _store.delete(id) }),
    _store,
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

vi.mock('../../../../src/main/services/agent/control', () => ({
  stopGeneration,
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
vi.mock('../../../../src/main/services/agent/events', () => ({
  emitAgentEvent: vi.fn(),
}))
vi.mock('../../../../src/main/services/agent/stream-processor', () => ({
  processStream: vi.fn(),
}))
vi.mock('../../../../src/main/services/agent/message-utils', () => ({
  buildMessageContent: vi.fn(),
}))

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
  getActivityStore: vi.fn().mockReturnValue(null),
}))

vi.mock('../../../../src/main/apps/runtime/dispatch-inbound', () => ({
  flushSupplementBuffer: vi.fn(),
  clearSupplementBuffer,
}))

vi.mock('../../../../src/main/apps/runtime/im-stream-registry', () => ({
  getImStreamHandle,
  clearImStreamHandle,
}))

vi.mock('../../../../src/main/platform/memory/snapshot', () => ({
  createMemoryStatusMcpServer: vi.fn(),
}))

// ============================================
// Imports (after all mocks)
// ============================================

import { stopImSession } from '../../../../src/main/apps/runtime/app-chat'
import { buildImSessionKey } from '../../../../src/shared/apps/im-keys'

// ============================================
// Tests
// ============================================

describe('stopImSession', () => {
  beforeEach(() => {
    activeSessions.clear()
    v2Sessions.clear()
    closeV2Session.mockClear()
    stopGeneration.mockClear()
    clearSupplementBuffer.mockClear()
    getImStreamHandle.mockClear()
    clearImStreamHandle.mockClear()
  })

  it('aborts the active generation and returns stopped: true', async () => {
    const conversationId = buildImSessionKey('app-1', 'wecom-bot', 'group', 'room-1')
    activeSessions.set(conversationId, {})

    const result = await stopImSession('app-1', 'wecom-bot', 'group', 'room-1')

    expect(result).toEqual({ stopped: true })
    expect(stopGeneration).toHaveBeenCalledTimes(1)
    expect(stopGeneration).toHaveBeenCalledWith(conversationId)
  })

  it('drops buffered supplements for the conversation', async () => {
    const conversationId = buildImSessionKey('app-1', 'wecom-bot', 'group', 'room-1')
    activeSessions.set(conversationId, {})

    await stopImSession('app-1', 'wecom-bot', 'group', 'room-1')

    expect(clearSupplementBuffer).toHaveBeenCalledTimes(1)
    expect(clearSupplementBuffer).toHaveBeenCalledWith(conversationId)
  })

  it('does NOT close the V2 session (history preserved)', async () => {
    const conversationId = buildImSessionKey('app-1', 'wecom-bot', 'group', 'room-1')
    activeSessions.set(conversationId, {})
    v2Sessions.set(conversationId, {})

    await stopImSession('app-1', 'wecom-bot', 'group', 'room-1')

    expect(closeV2Session).not.toHaveBeenCalled()
    expect(v2Sessions.has(conversationId)).toBe(true)
  })

  it('returns stopped: false when no generation is active (idempotent)', async () => {
    const result = await stopImSession('app-1', 'wecom-bot', 'group', 'room-1')

    expect(result).toEqual({ stopped: false })
    expect(stopGeneration).not.toHaveBeenCalled()
    // Supplements are still cleared even when not active — a stale buffer
    // from a previously-aborted round should not leak into the next.
    expect(clearSupplementBuffer).toHaveBeenCalledTimes(1)
  })

  it('only stops the targeted session, not siblings', async () => {
    const targetKey = buildImSessionKey('app-1', 'wecom-bot', 'group', 'room-1')
    const siblingKey = buildImSessionKey('app-1', 'wecom-bot', 'group', 'room-2')
    activeSessions.set(targetKey, {})
    activeSessions.set(siblingKey, {})

    await stopImSession('app-1', 'wecom-bot', 'group', 'room-1')

    expect(stopGeneration).toHaveBeenCalledTimes(1)
    expect(stopGeneration).toHaveBeenCalledWith(targetKey)
    expect(activeSessions.has(siblingKey)).toBe(true)
  })

  it('disposes the IM stream handle when one is registered (streaming mode)', async () => {
    const conversationId = buildImSessionKey('app-1', 'wecom-bot', 'group', 'room-1')
    activeSessions.set(conversationId, {})

    const dispose = vi.fn()
    const handle = { dispose, update: vi.fn(), finish: vi.fn() }
    getImStreamHandle.mockReturnValue(handle)

    await stopImSession('app-1', 'wecom-bot', 'group', 'room-1')

    // dispose() abandons the stream without sending — the user wants no message
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(handle.finish).not.toHaveBeenCalled()
    expect(clearImStreamHandle).toHaveBeenCalledWith(conversationId)
  })

  it('proceeds normally when no stream handle is registered (non-streaming mode)', async () => {
    const conversationId = buildImSessionKey('app-1', 'wecom-bot', 'group', 'room-1')
    activeSessions.set(conversationId, {})

    // No stream handle — registry returns undefined for this conversation
    getImStreamHandle.mockReturnValue(undefined)

    const result = await stopImSession('app-1', 'wecom-bot', 'group', 'room-1')

    expect(result).toEqual({ stopped: true })
    expect(stopGeneration).toHaveBeenCalledWith(conversationId)
    expect(clearImStreamHandle).toHaveBeenCalledWith(conversationId)
  })

  it('disposes the stream even when generation is already idle (defensive cleanup)', async () => {
    const conversationId = buildImSessionKey('app-1', 'wecom-bot', 'group', 'room-1')

    // Stream handle registered but no active generation (round completed without
    // the registry being cleared — e.g. crash between dispatch and finally)
    const dispose = vi.fn()
    getImStreamHandle.mockReturnValue({ dispose })

    const result = await stopImSession('app-1', 'wecom-bot', 'group', 'room-1')

    expect(result).toEqual({ stopped: false })
    expect(stopGeneration).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(clearImStreamHandle).toHaveBeenCalledWith(conversationId)
  })
})
