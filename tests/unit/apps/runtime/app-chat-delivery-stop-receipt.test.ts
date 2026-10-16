/**
 * A message that joined a running turn and was taken back unread by a person's
 * stop is answered with an empty receipt. The stopped turn's reply answered a
 * different message, so it must never reach this message's sender — for a
 * wake from another machine that reply would be returned as the member's answer.
 *
 * Real chat delivery and the real sink; only the engine handoff is faked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppChatRequest } from '../../../../src/main/apps/runtime/app-chat'

const env = vi.hoisted(() => ({
  busy: false,
  identity: undefined as string | undefined,
  takenBack: [] as Array<(indexes: readonly number[]) => void>,
  changes: new Set<(key: string) => void>(),
}))

vi.mock('../../../../src/main/services/agent', () => ({
  formatCanvasContext: () => '',
  emitAgentEvent: vi.fn(),
  onAgentEvent: () => ({ dispose: () => {} }),
  listResidentSessions: () => [],
  hasPendingSessionInput: () => false,
}))
vi.mock('../../../../src/main/services/agent/control', () => ({ stopGeneration: vi.fn(async () => {}) }))
vi.mock('../../../../src/main/apps/runtime/session-store', () => ({
  openSessionWriter: () => ({ writeEvent: vi.fn(), writeTrigger: vi.fn(), writeInputOutcome: vi.fn(), writePush: vi.fn() }),
  saveChatSessionId: vi.fn(),
}))
vi.mock('../../../../src/main/apps/runtime/im-session-registry', () => ({ getImSessionRegistry: () => null }))
vi.mock('../../../../src/main/apps/runtime/im-channels', () => ({ getActiveImChannelManager: () => null }))
vi.mock('../../../../src/main/apps/runtime/im-permission-registry', () => ({ getImPermissionContext: () => undefined }))
vi.mock('../../../../src/main/apps/runtime/team/external-origin', () => ({
  peekTurnOrigin: (_key: string, trigger: { external?: boolean }) => trigger.external === true,
}))
vi.mock('../../../../src/main/apps/runtime/app-chat-live-turn', () => ({
  isAppChatConversationGenerating: () => env.busy,
  getAppChatTurnIdentity: () => env.identity,
  appChatMessageIdentity: (_permission: unknown, external: boolean) => (external ? 'external' : 'owner'),
  injectIntoAppChatBatch: (_key: string, _messages: unknown[], onTakenBack: (indexes: readonly number[]) => void) => {
    env.takenBack.push(onTakenBack)
    return true
  },
  keepStoppedInputs: () => {},
  refreshAppChatTurnStarts: () => {},
  onAppChatConversationChange: (listener: (key: string) => void) => {
    env.changes.add(listener)
    return () => env.changes.delete(listener)
  },
}))

import { createAppChatDelivery } from '../../../../src/main/apps/runtime/app-chat-delivery'
import { getAppChatSink, disposeAppChatSink } from '../../../../src/main/apps/runtime/app-chat-sink'

const KEY = 'app-chat:member:team:team-1:epoch-1'

function remoteWake(message: string, correlationId: string, hooks: Pick<AppChatRequest, 'onReply' | 'onResult'>): AppChatRequest {
  return {
    appId: 'member',
    spaceId: 'space',
    conversationId: KEY,
    message,
    teamContext: { teamId: 'team-1', epochId: 'epoch-1', correlationId, fromAppId: 'lead', wait: true, kind: 'message', external: true },
    ...hooks,
  }
}

function stoppedResult() {
  return {
    finalContent: '',
    hasMeaningfulContent: true,
    thoughts: [],
    tokenUsage: null,
    isInterrupted: false,
    wasAborted: true,
    hasErrorThought: false,
    reachedMaxTurns: false,
    firstEventReceived: true,
    drainTimedOut: false,
  } as never
}

beforeEach(() => {
  vi.useFakeTimers()
  env.busy = false
  env.identity = undefined
  env.takenBack = []
  env.changes.clear()
  disposeAppChatSink(KEY)
})
afterEach(() => {
  disposeAppChatSink(KEY)
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('a wake a person stopped before the member read it', () => {
  it('gets an empty receipt, never the reply the stopped turn wrote for another message', async () => {
    const sink = getAppChatSink({ appId: 'member', conversationId: KEY, runId: 'run', spacePath: '/tmp/space', spaceId: 'space' })
    // The member is running a turn a first wake from another machine started.
    const firstResult = vi.fn()
    const first = sink.beginRound({ onReply: vi.fn(), onResult: firstResult })
    sink.onTurnStart()
    env.busy = true
    env.identity = 'external'

    const run = vi.fn(async (_request: AppChatRequest) => {})
    const delivery = createAppChatDelivery(run)
    const secondResult = vi.fn()
    const secondReply = vi.fn()
    let receipted = false
    const second = delivery.send(remoteWake('second wake', 'corr-2', { onResult: secondResult, onReply: secondReply }))
      .then(() => { receipted = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(env.takenBack).toHaveLength(1)

    // The member's owner stops before the member reads the second wake: its
    // receipt is settled now, before the stopped turn reports anything.
    delivery.holdAfterStop(KEY)
    env.takenBack[0]([0])
    await vi.advanceTimersByTimeAsync(0)
    expect(receipted).toBe(true)

    // The stopped turn ends with what it wrote for the first wake.
    sink.onRawMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial answer to the first wake' }] } })
    sink.onTurnComplete(stoppedResult())
    await Promise.all([first.done, second])
    expect(firstResult.mock.calls[0]?.[0]).toBe('partial answer to the first wake')
    expect(secondResult).not.toHaveBeenCalled()
    expect(secondReply).not.toHaveBeenCalled()

    // Held for the member's next turn rather than started after the stop.
    env.busy = false
    env.identity = undefined
    for (const listener of env.changes) listener(KEY)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(run).not.toHaveBeenCalled()
  })
})
