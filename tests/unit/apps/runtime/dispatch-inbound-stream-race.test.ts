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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { InboundMessage, ReplyHandle, StreamingHandle } from '../../../../src/shared/types/inbound-message'
import type { RelayEvent } from '../../../../src/main/apps/runtime/pending-relays'
import type { ImChannelInstanceConfig, ImSessionRecord } from '../../../../src/shared/types/im-channel'
import type { ImSessionRegistry } from '../../../../src/main/apps/runtime/im-session-registry'

// ============================================
// Mocks (must be declared before importing dispatch-inbound)
// ============================================

const { streamHandles, setImStreamHandle, getImStreamHandle, clearImStreamHandle } = vi.hoisted(() => {
  const streamHandles = new Map<string, StreamingHandle>()
  return {
    streamHandles,
    setImStreamHandle: vi.fn((conversationId: string, handle: StreamingHandle) => { streamHandles.set(conversationId, handle) }),
    getImStreamHandle: vi.fn((conversationId: string) => streamHandles.get(conversationId)),
    clearImStreamHandle: vi.fn((conversationId: string) => { streamHandles.delete(conversationId) }),
  }
})

const { pendingRelays, commitRelays, prepareActions, turnHold } = vi.hoisted(() => ({
  pendingRelays: [] as RelayEvent[],
  commitRelays: vi.fn(),
  prepareActions: vi.fn(async (_events: RelayEvent[], _isAuthorized: () => boolean) => new Map<string, string>()),
  turnHold: { cancelled: false, end: vi.fn() },
}))

vi.mock('../../../../src/main/apps/runtime/app-chat-live-turn', () => ({
  beginAppChatTurnStart: () => turnHold,
}))

vi.mock('../../../../src/main/apps/runtime/pending-relays', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../../src/main/apps/runtime/pending-relays')>()),
  getPendingRelayStore: () => ({ peek: () => pendingRelays, commit: commitRelays }),
}))

vi.mock('../../../../src/main/apps/runtime/relay-actions', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../../src/main/apps/runtime/relay-actions')>()),
  hasOpenImQuestion: () => false,
  prepareRelayActions: prepareActions,
}))

const { sendAppChatMessage, clearImSession, buildImSessionKey, isAppChatConversationGenerating } = vi.hoisted(() => ({
  sendAppChatMessage: vi.fn(async () => {}),
  clearImSession: vi.fn(async () => {}),
  buildImSessionKey: vi.fn(
    (appId: string, channel: string, chatType: string, chatId: string) =>
      `app-chat:${appId}:${channel}:${chatType}:${chatId}`,
  ),
  isAppChatConversationGenerating: vi.fn(() => false),
}))

const { sessions, registry } = vi.hoisted(() => {
  const sessions = new Map<string, ImSessionRecord>()
  return {
    sessions,
    registry: {
      register: (...args: Parameters<ImSessionRegistry['register']>) => {
        const [appId, channel, chatId, chatType, instanceId, opts] = args
        const key = `${appId}:${channel}:${chatId}`
        sessions.set(key, {
          appId, channel, chatId, chatType, source: 'im', proactive: false,
          displayName: opts?.displayName ?? chatId, ...sessions.get(key),
          instanceId, lastActiveAt: Date.now(), ...opts,
        })
      },
      findSession: (appId: string, channel: string, chatId: string) => sessions.get(`${appId}:${channel}:${chatId}`),
      getSessionRevision: (appId: string, channel: string, chatId: string) => sessions.get(`${appId}:${channel}:${chatId}`),
    },
  }
})

const { getActiveImChannelManager, getInstanceConfig } = vi.hoisted(() => {
  const getInstanceConfig = vi.fn<[], ImChannelInstanceConfig>()
  return {
    getInstanceConfig,
    getActiveImChannelManager: vi.fn(() => ({
      getInstance: vi.fn(() => undefined),
      getInstanceConfig,
      getAuthorizationRevision: () => getInstanceConfig(),
    })),
  }
})

const { stopGeneration } = vi.hoisted(() => ({
  stopGeneration: vi.fn(async () => {}),
}))



const { maybeClaimOwner } = vi.hoisted(() => ({
  maybeClaimOwner: vi.fn(async () => false),
}))

vi.mock('../../../../src/main/apps/runtime/app-chat', () => ({
  sendAppChatMessage,
  clearImSession,
  buildImSessionKey,
  isAppChatConversationGenerating,
}))

vi.mock('../../../../src/main/apps/runtime/im-session-registry', () => ({
  getImSessionRegistry: () => registry,
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

// The IM error reply asks whether a failure is a refused local connection; what
// a chat is then told is im-error-reply.test's, with the real check.
vi.mock('../../../../src/main/services/agent', () => ({ isRefusedLocalConnection: () => false }))
vi.mock('../../../../src/main/foundation/product-config', () => ({
  getImChannelsPermissionDefaults: vi.fn(() => ({})),
}))
vi.mock('../../../../src/main/apps/team', () => ({
  getTeamStore: vi.fn(() => ({})),
}))
vi.mock('../../../../src/main/apps/runtime/team', () => ({
  getActiveTeamRuntime: vi.fn(() => undefined),
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

import { clearSupplementBuffer, dispatchInboundMessage } from '../../../../src/main/apps/runtime/dispatch-inbound'
import { RelayActionUnauthorizedError } from '../../../../src/main/apps/runtime/relay-actions'

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
    channel: 'wecom-bot',
    chatId: 'chat-1',
    send: vi.fn(async () => {}),
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

const CONVERSATION = 'app-chat:app-1:wecom-bot:group:room-1'
const DIRECT_CONVERSATION = 'app-chat:app-1:wecom-bot:direct:room-1'

beforeEach(() => {
  vi.clearAllMocks()
  streamHandles.clear()
  pendingRelays.length = 0
  turnHold.cancelled = false
  prepareActions.mockReset().mockResolvedValue(new Map())
  isAppChatConversationGenerating.mockReturnValue(false)
  sessions.clear()
  getInstanceConfig.mockReturnValue({
    id: 'inst-1', type: 'wecom-bot', enabled: true, appId: 'app-1', config: {},
    streaming: true, permissionEnabled: true, owners: ['user-1'],
  })
})

afterEach(() => {
  clearSupplementBuffer(CONVERSATION)
  clearSupplementBuffer(DIRECT_CONVERSATION)
  streamHandles.clear()
  vi.restoreAllMocks()
})

describe('dispatchInboundMessage — stream-handle race regression', () => {

  it('does NOT call setImStreamHandle when the message is buffered as a supplement', async () => {
    // Simulate an active round — the supplement-buffer busy-check will buffer
    // this message and return before reaching the setImStreamHandle call.
    isAppChatConversationGenerating.mockReturnValue(true)

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
    getInstanceConfig.mockReturnValue({
      id: 'inst-1', type: 'wecom-bot', enabled: true, appId: 'app-1', config: {},
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

describe('dispatchInboundMessage — cancellation during relay preparation', () => {
  beforeEach(() => {
    pendingRelays.push({
      kind: 'push', id: 'question', at: Date.now(),
      source: { key: 'app-run:app-1:run-1', appId: 'app-1', runId: 'run-1' },
      sourceOwner: true, message: 'Which region?',
      action: { kind: 'answer-question', appId: 'app-1', entryId: 'q-1' },
    })
  })

  it.each([
    { label: 'the stopped handle is still registered', replacement: false, failDispose: false },
    { label: 'a replacement handle is registered', replacement: true, failDispose: false },
    { label: 'disposing the registered handle throws', replacement: false, failDispose: true },
    { label: 'disposing an old handle throws after replacement', replacement: true, failDispose: true },
  ])('cleans up only its own stream when $label', async ({ replacement, failDispose }) => {
    const handle = makeStreamingHandle()
    const disposeError = new Error('stream dispose failed')
    handle.dispose = vi.fn(() => { if (failDispose) throw disposeError })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reply = makeReply(handle)
    let finish!: (actions: Map<string, string>) => void
    prepareActions.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const dispatch = dispatchInboundMessage(makeMsg({ chatType: 'direct' }), reply, 'app-1', 'inst-1')
    expect(prepareActions).toHaveBeenCalledWith(pendingRelays, expect.any(Function))
    expect(prepareActions.mock.calls[0][1]()).toBe(true)
    expect(streamHandles.get(DIRECT_CONVERSATION)).toBe(handle)
    expect(sendAppChatMessage).not.toHaveBeenCalled()
    expect(turnHold.end).not.toHaveBeenCalled()

    turnHold.cancelled = true
    const nextHandle = makeStreamingHandle()
    if (replacement) setImStreamHandle(DIRECT_CONVERSATION, nextHandle)
    finish(new Map())
    await dispatch

    expect(handle.dispose).toHaveBeenCalledOnce()
    expect(handle.finish).not.toHaveBeenCalled()
    expect(reply.send).not.toHaveBeenCalled()
    expect(sendAppChatMessage).not.toHaveBeenCalled()
    expect(commitRelays).not.toHaveBeenCalled()
    expect(pendingRelays).toHaveLength(1)
    expect(turnHold.end).toHaveBeenCalledOnce()
    expect(getImStreamHandle).toHaveBeenCalledWith(DIRECT_CONVERSATION)
    if (replacement) {
      expect(clearImStreamHandle).not.toHaveBeenCalled()
      expect(streamHandles.get(DIRECT_CONVERSATION)).toBe(nextHandle)
      expect(nextHandle.dispose).not.toHaveBeenCalled()
      expect(nextHandle.finish).not.toHaveBeenCalled()
    } else {
      expect(clearImStreamHandle).toHaveBeenCalledOnce()
      expect(clearImStreamHandle).toHaveBeenCalledWith(DIRECT_CONVERSATION)
      expect(streamHandles.has(DIRECT_CONVERSATION)).toBe(false)
    }
    if (failDispose) {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Stopped reply stream could not be disposed'), disposeError)
    }
  })

  it.each([
    { label: 'unexpected failure', error: new Error('unexpected preparation failure'), replacement: false },
    { label: 'authorization revocation', error: new RelayActionUnauthorizedError(), replacement: false },
    { label: 'unexpected failure after stream replacement', error: new Error('unexpected preparation failure'), replacement: true },
    { label: 'authorization revocation after stream replacement', error: new RelayActionUnauthorizedError(), replacement: true },
  ])('silently disposes only the stopped stream on $label', async ({ error, replacement }) => {
    const handle = makeStreamingHandle()
    const reply = makeReply(handle)
    let reject!: (error: Error) => void
    prepareActions.mockImplementationOnce(() => new Promise((_resolve, rejectPreparation) => { reject = rejectPreparation }))
    const dispatch = dispatchInboundMessage(makeMsg({ chatType: 'direct' }), reply, 'app-1', 'inst-1')
    expect(prepareActions).toHaveBeenCalledOnce()

    turnHold.cancelled = true
    const nextHandle = makeStreamingHandle()
    if (replacement) setImStreamHandle(DIRECT_CONVERSATION, nextHandle)
    reject(error)
    await dispatch

    expect.soft(handle.dispose).toHaveBeenCalledOnce()
    expect.soft(handle.finish).not.toHaveBeenCalled()
    if (replacement) {
      expect(clearImStreamHandle).not.toHaveBeenCalled()
      expect(streamHandles.get(DIRECT_CONVERSATION)).toBe(nextHandle)
      expect(nextHandle.dispose).not.toHaveBeenCalled()
      expect(nextHandle.finish).not.toHaveBeenCalled()
    } else {
      expect.soft(clearImStreamHandle).toHaveBeenCalledWith(DIRECT_CONVERSATION)
      expect.soft(streamHandles.has(DIRECT_CONVERSATION)).toBe(false)
    }
    expect(reply.send).not.toHaveBeenCalled()
    expect(sendAppChatMessage).not.toHaveBeenCalled()
    expect(commitRelays).not.toHaveBeenCalled()
    expect(turnHold.end).toHaveBeenCalledOnce()
  })
})
