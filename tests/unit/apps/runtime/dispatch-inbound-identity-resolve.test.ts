/**
 * Regression tests for two defects found in code review of the identity
 * (real-name) resolution feature, both in dispatch-inbound.ts:
 *
 * B1 — resolvedName is a SESSION-level identity (a directory entry maps
 *      chat_id -> chat_name; for a group chat that chat_id is the GROUP,
 *      not any individual member). Applying it to the sender name would
 *      mislabel every group member's <msg-sender> tag with the group's own
 *      resolved name. Only direct chats may use it for sender identity.
 *
 * B2 — dispatchInboundMessage must reach `sendAppChatMessage` without ever
 *      awaiting identity resolution's own promise. The busy check
 *      (isAppChatConversationGenerating) and the generation start have no
 *      other await between them; awaiting a real network call there would
 *      let a second inbound message on the same conversation pass its own
 *      busy check before the first message marks the conversation busy,
 *      starting two concurrent rounds on one conversationId.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { InboundMessage, ReplyHandle } from '../../../../src/shared/types/inbound-message'
import type { ImSessionRecord } from '../../../../src/shared/types/im-channel'

// ============================================
// Mocks (must be declared before importing dispatch-inbound)
// ============================================

const callOrder: string[] = []

const { resolveInboundIdentity } = vi.hoisted(() => ({
  // Never resolves — if dispatchInboundMessage awaited this (directly or via
  // a race), the test below would hang past vitest's timeout instead of
  // completing. Marks call order so we can also assert it was reached
  // *before* generation start without relying on the hang as the only signal.
  resolveInboundIdentity: vi.fn(),
}))

const { sendAppChatMessage, isAppChatConversationGenerating } = vi.hoisted(() => ({
  sendAppChatMessage: vi.fn(async () => {}),
  isAppChatConversationGenerating: vi.fn(() => false),
}))

const { findSessionMock, registerMock } = vi.hoisted(() => ({
  findSessionMock: vi.fn(() => undefined as unknown),
  registerMock: vi.fn(),
}))

const { getInstanceMock } = vi.hoisted(() => ({
  getInstanceMock: vi.fn(() => ({ identityCapability: { fetchIdentityDirectory: vi.fn() } })),
}))

vi.mock('../../../../src/main/apps/runtime/im-channels/identity-resolve', () => ({
  resolveInboundIdentity: (...args: unknown[]) => {
    callOrder.push('resolveInboundIdentity')
    return resolveInboundIdentity(...args)
  },
}))

vi.mock('../../../../src/main/apps/runtime/app-chat', () => ({
  sendAppChatMessage: (...args: unknown[]) => {
    callOrder.push('sendAppChatMessage')
    return sendAppChatMessage(...args)
  },
  clearImSession: vi.fn(async () => {}),
  isAppChatConversationGenerating,
  buildImSessionKey: (appId: string, channel: string, chatType: string, chatId: string) =>
    `app-chat:${appId}:${channel}:${chatType}:${chatId}`,
}))

vi.mock('../../../../src/main/apps/runtime/im-session-registry', () => ({
  getImSessionRegistry: () => ({
    register: registerMock,
    findSession: findSessionMock,
  }),
}))

vi.mock('../../../../src/main/apps/runtime/im-channels', () => ({
  getActiveImChannelManager: () => ({
    getInstance: getInstanceMock,
    getInstanceConfig: () => ({}),
  }),
}))

vi.mock('../../../../src/main/apps/runtime/im-channels/owner-claim', () => ({
  maybeClaimOwner: vi.fn(async () => false),
}))

vi.mock('../../../../src/main/apps/runtime/im-permission-registry', () => ({
  setImPermissionContext: vi.fn(),
  clearImPermissionContext: vi.fn(),
}))

vi.mock('../../../../src/main/apps/runtime/im-stream-registry', () => ({
  setImStreamHandle: vi.fn(),
}))

vi.mock('../../../../src/main/services/agent/control', () => ({
  stopGeneration: vi.fn(async () => {}),
}))

vi.mock('../../../../src/main/foundation/window.service', () => ({ sendToRenderer: vi.fn() }))
vi.mock('../../../../src/main/http/websocket', () => ({ broadcastToAll: vi.fn() }))
vi.mock('../../../../src/main/services/analytics/analytics.service', () => ({ analytics: { track: vi.fn() } }))
vi.mock('../../../../src/main/services/analytics/types', () => ({ AnalyticsEvents: {} }))
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

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    body: 'hello',
    from: 'user-1',
    fromName: 'Alice',
    channel: 'wecom-bot',
    chatType: 'direct',
    chatId: 'user-1',
    timestamp: Date.now(),
    ...overrides,
  }
}

function makeReply(): ReplyHandle {
  return { send: vi.fn(async () => true) }
}

function fakeSession(overrides: Partial<ImSessionRecord> = {}): ImSessionRecord {
  return {
    appId: 'app-1',
    channel: 'wecom-bot',
    source: 'im',
    instanceId: 'inst-1',
    chatId: 'chat-x',
    chatType: 'direct',
    displayName: 'chat-x',
    proactive: false,
    lastActiveAt: Date.now(),
    ...overrides,
  }
}

function sentPayload(): { message: string; senderIdentity?: { id: string; name: string } } {
  return sendAppChatMessage.mock.calls[0][0] as { message: string; senderIdentity?: { id: string; name: string } }
}

beforeEach(() => {
  callOrder.length = 0
  resolveInboundIdentity.mockReset()
  resolveInboundIdentity.mockReturnValue(new Promise<void>(() => {})) // hangs forever
  sendAppChatMessage.mockClear()
  isAppChatConversationGenerating.mockReturnValue(false)
  findSessionMock.mockReset()
  findSessionMock.mockReturnValue(undefined)
  getInstanceMock.mockReturnValue({ identityCapability: { fetchIdentityDirectory: vi.fn() } })
})

// ============================================
// B2 — fire-and-forget, never awaited
// ============================================

describe('dispatchInboundMessage — identity resolution is fire-and-forget (B2 regression)', () => {
  it('reaches sendAppChatMessage even though resolveInboundIdentity never resolves', async () => {
    await dispatchInboundMessage(makeMsg(), makeReply(), 'app-1', 'inst-1')

    expect(resolveInboundIdentity).toHaveBeenCalledTimes(1)
    expect(sendAppChatMessage).toHaveBeenCalledTimes(1)
    // Reached in this order with nothing awaited in between resolution and
    // dispatch — if a blocking await/race were reintroduced, this call would
    // never settle and the test would time out instead of reaching here.
    expect(callOrder).toEqual(['resolveInboundIdentity', 'sendAppChatMessage'])
  })

  it('does not call resolveInboundIdentity at all when the instance has no identityCapability', async () => {
    getInstanceMock.mockReturnValue({})
    await dispatchInboundMessage(makeMsg(), makeReply(), 'app-1', 'inst-1')

    expect(resolveInboundIdentity).not.toHaveBeenCalled()
    expect(sendAppChatMessage).toHaveBeenCalledTimes(1)
  })
})

// ============================================
// B1 — resolvedName is session-level, not sender-level
// ============================================

describe('dispatchInboundMessage — resolvedName applies to direct chats only (B1 regression)', () => {
  it('does NOT label a group message sender with the group session\'s own resolvedName', async () => {
    findSessionMock.mockImplementation((_appId: string, _channel: string, chatId: string) =>
      chatId === 'room-1'
        ? fakeSession({ chatId: 'room-1', chatType: 'group', resolvedName: 'The Group Chat' })
        : undefined
    )

    await dispatchInboundMessage(
      makeMsg({ chatType: 'group', chatId: 'room-1', from: 'user-1', fromName: 'Alice' }),
      makeReply(),
      'app-1',
      'inst-1',
    )

    const { message } = sentPayload()
    expect(message).toContain('<msg-sender id="user-1" name="Alice" />')
    expect(message).not.toContain('The Group Chat')
  })

  it('applies resolvedName to the sender identity for a direct chat', async () => {
    findSessionMock.mockImplementation((_appId: string, _channel: string, chatId: string) =>
      chatId === 'user-1'
        ? fakeSession({ chatId: 'user-1', chatType: 'direct', resolvedName: 'Alice Real Name' })
        : undefined
    )

    await dispatchInboundMessage(
      makeMsg({ chatType: 'direct', chatId: 'user-1', from: 'user-1', fromName: 'user-1' }),
      makeReply(),
      'app-1',
      'inst-1',
    )

    const { senderIdentity } = sentPayload()
    expect(senderIdentity?.name).toBe('Alice Real Name')
  })

  it('falls back to fromName for a direct chat with no resolvedName yet', async () => {
    await dispatchInboundMessage(
      makeMsg({ chatType: 'direct', chatId: 'user-1', from: 'user-1', fromName: 'Alice' }),
      makeReply(),
      'app-1',
      'inst-1',
    )

    const { senderIdentity } = sentPayload()
    expect(senderIdentity?.name).toBe('Alice')
  })
})
