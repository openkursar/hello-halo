/**
 * Dispatch-level regression test for the IM stream-handle race fixed in c98f64e.
 *
 * Invariant under test:
 *   dispatchInboundMessage must NOT call setImStreamHandle on the
 *   supplement-buffer branch (busy → buffer + return). A buffered
 *   supplement's reply.streaming belongs to a round that will never start;
 *   registering it would overwrite the running round's handle in the
 *   im-stream-registry, leaving the live stream undiscoverable to
 *   stopImSession.
 *
 * The stop-im-session.test.ts suite thoroughly covers stopImSession itself
 * but mocks the registry, so the set-site invariant in dispatch-inbound
 * would silently break under future refactors without this test.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { InboundMessage, ReplyHandle, StreamingHandle } from '../../../../src/shared/types/inbound-message'

// ============================================
// Mocks (must be declared before importing dispatch-inbound)
// ============================================

const { setImStreamHandle, getImStreamHandle, clearImStreamHandle } = vi.hoisted(() => ({
  setImStreamHandle: vi.fn(),
  getImStreamHandle: vi.fn(() => undefined),
  clearImStreamHandle: vi.fn(),
}))

const { sendAppChatMessage, clearImSession, buildImSessionKey } = vi.hoisted(() => ({
  sendAppChatMessage: vi.fn(async () => {}),
  clearImSession: vi.fn(async () => {}),
  buildImSessionKey: vi.fn(
    (appId: string, channel: string, chatType: string, chatId: string) =>
      `app-chat:${appId}:${channel}:${chatType}:${chatId}`,
  ),
}))

const { getImSessionRegistry } = vi.hoisted(() => ({
  getImSessionRegistry: vi.fn(() => null),
}))

const { getActiveImChannelManager } = vi.hoisted(() => ({
  getActiveImChannelManager: vi.fn(() => ({
    getInstance: vi.fn(() => undefined),
    getInstanceConfig: vi.fn(() => ({ streaming: true })), // streaming enabled
  })),
}))

const { stopGeneration } = vi.hoisted(() => ({
  stopGeneration: vi.fn(async () => {}),
}))

const { activeSessions } = vi.hoisted(() => {
  const m = new Map<string, unknown>()
  return { activeSessions: m }
})

const { maybeClaimOwner } = vi.hoisted(() => ({
  maybeClaimOwner: vi.fn(async () => false),
}))

vi.mock('../../../../src/main/apps/runtime/app-chat', () => ({
  sendAppChatMessage,
  clearImSession,
  buildImSessionKey,
}))

vi.mock('../../../../src/main/apps/runtime/im-session-registry', () => ({
  getImSessionRegistry,
}))

vi.mock('../../../../src/main/apps/runtime/im-channels', () => ({
  getActiveImChannelManager,
}))

vi.mock('../../../../src/main/apps/runtime/im-channels/owner-claim', () => ({
  maybeClaimOwner,
}))

vi.mock('../../../../src/main/apps/runtime/im-stream-registry', () => ({
  setImStreamHandle,
  getImStreamHandle,
  clearImStreamHandle,
}))

vi.mock('../../../../src/main/apps/runtime/im-permission-registry', () => ({
  setImPermissionContext: vi.fn(),
  clearImPermissionContext: vi.fn(),
  getImPermissionContext: vi.fn(() => undefined),
  clearAllImPermissionContexts: vi.fn(),
}))

vi.mock('../../../../src/main/services/agent/control', () => ({
  stopGeneration,
}))

vi.mock('../../../../src/main/services/agent/session-manager', () => ({
  activeSessions,
}))

vi.mock('../../../../src/main/foundation/window.service', () => ({
  sendToRenderer: vi.fn(),
}))

vi.mock('../../../../src/main/http/websocket', () => ({
  broadcastToAll: vi.fn(),
}))

vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({
  analytics: { track: vi.fn() },
}))

vi.mock('../../../../src/main/services/analytics/types', () => ({
  AnalyticsEvents: {},
}))

vi.mock('../../../../src/main/foundation/product-config', () => ({
  getImChannelsPermissionDefaults: vi.fn(() => ({})),
}))

vi.mock('../../../../src/main/apps/manager', () => ({
  getAppManager: vi.fn(() => ({
    getApp: vi.fn(() => ({ id: 'app-1', spec: { name: 'Test' }, spaceId: 'space-1' })),
  })),
}))

vi.mock('../../../../src/main/services/space.service', () => ({
  getSpace: vi.fn(() => ({ path: '/tmp/space' })),
  getSpaceDir: vi.fn(() => '/tmp/space-dir'),
}))

vi.mock('../../../../src/main/apps/runtime/file-export-gate', () => ({
  FileExportGate: vi.fn(() => ({})),
}))

import { dispatchInboundMessage } from '../../../../src/main/apps/runtime/dispatch-inbound'

// ============================================
// Helpers
// ============================================

function makeStreamingHandle(): StreamingHandle {
  return {
    update: vi.fn(async () => {}),
    finish: vi.fn(async () => {}),
    dispose: vi.fn(),
  }
}

function makeReply(streaming?: StreamingHandle): ReplyHandle {
  return {
    send: vi.fn(async () => true),
    streaming,
  }
}

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    body: 'hello',
    from: 'user-1',
    channel: 'wecom-bot',
    chatType: 'group',
    chatId: 'room-1',
    timestamp: Date.now(),
    ...overrides,
  }
}

// ============================================
// Tests
// ============================================

describe('dispatchInboundMessage — stream-handle race regression', () => {
  beforeEach(() => {
    setImStreamHandle.mockClear()
    getImStreamHandle.mockClear()
    clearImStreamHandle.mockClear()
    sendAppChatMessage.mockClear()
    activeSessions.clear()
    ;(getActiveImChannelManager as any).mockClear()
  })

  it('does NOT call setImStreamHandle when the message is buffered as a supplement', async () => {
    // Simulate an active round — the supplement-buffer busy-check will buffer
    // this message and return before reaching the setImStreamHandle call.
    const conversationId = 'app-chat:app-1:wecom-bot:group:room-1'
    activeSessions.set(conversationId, {})

    const handle = makeStreamingHandle()
    await dispatchInboundMessage(
      makeMsg(),
      makeReply(handle),
      'app-1',
      'inst-1',
    )

    // The supplement-buffer branch must not register its streaming handle.
    // If it did, it would overwrite the running round's handle, leaving
    // the live stream undiscoverable to stopImSession.
    expect(setImStreamHandle).not.toHaveBeenCalled()
    expect(sendAppChatMessage).not.toHaveBeenCalled()
  })

  it('calls setImStreamHandle on the start-of-round path when reply.streaming is present', async () => {
    // No active session — this message starts a new round.
    const handle = makeStreamingHandle()
    await dispatchInboundMessage(
      makeMsg(),
      makeReply(handle),
      'app-1',
      'inst-1',
    )

    expect(setImStreamHandle).toHaveBeenCalledTimes(1)
    expect(setImStreamHandle).toHaveBeenCalledWith(
      'app-chat:app-1:wecom-bot:group:room-1',
      handle,
    )
    expect(sendAppChatMessage).toHaveBeenCalledTimes(1)
  })

  it('does NOT call setImStreamHandle when reply.streaming is absent (non-streaming mode)', async () => {
    await dispatchInboundMessage(
      makeMsg(),
      makeReply(undefined),
      'app-1',
      'inst-1',
    )

    expect(setImStreamHandle).not.toHaveBeenCalled()
    expect(sendAppChatMessage).toHaveBeenCalledTimes(1)
  })

  it('strips streaming when instance has not enabled it (default off) and does not register', async () => {
    ;(getActiveImChannelManager as any).mockReturnValue({
      getInstance: vi.fn(() => undefined),
      getInstanceConfig: vi.fn(() => ({})), // streaming !== true
    })

    const handle = makeStreamingHandle()
    await dispatchInboundMessage(
      makeMsg(),
      makeReply(handle),
      'app-1',
      'inst-1',
    )

    // Streaming was stripped by the instance-config disable check before
    // reaching the registry set, so setImStreamHandle must not fire.
    expect(setImStreamHandle).not.toHaveBeenCalled()
  })
})
