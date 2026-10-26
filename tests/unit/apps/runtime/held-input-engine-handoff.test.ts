import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppChatRequest } from '../../../../src/main/apps/runtime/app-chat'

const state = vi.hoisted(() => ({ active: false, withdrawn: [] as Array<() => void> }))
vi.mock('../../../../src/main/services/agent/live-turn', () => ({
  hasLiveTurn: () => state.active,
  sendIntoLiveTurn: (_id: string, _text: string, _images: unknown, options: { onWithdrawn(): void }) => { state.withdrawn.push(options.onWithdrawn); return true },
}))
vi.mock('../../../../src/main/services/agent', async () => ({
  ...(await vi.importActual('../../../../src/main/services/agent/engine-handoff')),
  formatReferencesBlock: () => '', formatCanvasContext: () => '', emitAgentEvent: vi.fn(),
  onAgentEvent: () => ({ dispose: () => {} }), listResidentSessions: () => [], hasPendingSessionInput: () => false,
  getLegacyEngine: () => 'anthropic', getSessionEngineId: () => state.active ? 'anthropic' : undefined,
  isSessionBusy: () => state.active, ensureEngineAvailable: async () => {}, resolveDefaultEngine: async () => 'halo',
}))
vi.mock('../../../../src/main/services/agent/control', () => ({ stopGeneration: async () => {} }))
vi.mock('../../../../src/main/apps/runtime/im-session-registry', () => ({ getImSessionRegistry: () => null }))
vi.mock('../../../../src/main/apps/runtime/im-channels', () => ({ getActiveImChannelManager: () => null }))
vi.mock('../../../../src/main/apps/runtime/im-permission-registry', () => ({ getImPermissionContext: () => undefined }))

import { createAppChatDelivery } from '../../../../src/main/apps/runtime/app-chat-delivery'
import { getAppChatSink, disposeAppChatSink } from '../../../../src/main/apps/runtime/app-chat-sink'
import { injectIntoAppChatBatch } from '../../../../src/main/apps/runtime/app-chat-live-turn'
import { openSessionWriter, readChatHandoffHistory, readSessionMessages } from '../../../../src/main/apps/runtime/session-store'
import { prepareAppEngineSession } from '../../../../src/main/apps/runtime/engine-selection'
import { prependEngineHandoff, serializeEngineHandoff } from '../../../../src/main/services/agent/engine-handoff'

const key = 'app-chat:person'
const root = () => globalThis.__HALO_TEST_DIR__
const transcript = () => join(root(), '.halo/apps/person/runs/chat.jsonl')
const result = () => ({ finalContent: 'Original reply', hasMeaningfulContent: true, thoughts: [], tokenUsage: null, isInterrupted: false, wasAborted: false, hasErrorThought: false, reachedMaxTurns: false, firstEventReceived: true, drainTimedOut: false } as never)
function sink() {
  const sink = getAppChatSink({ appId: 'person', conversationId: key, runId: 'chat', spacePath: root(), spaceId: 'space' })
  sink.setTurnIdentity('owner', () => true, (text, images) => ({ text, images }))
  return sink
}
beforeEach(() => { state.active = false; state.withdrawn = [] })
afterEach(() => { disposeAppChatSink(key) })

describe('held input identities across engine changes', () => {
  it('carries a withdrawn reminder through refresh and batching, excluding only its own stored record', async () => {
    const writer = openSessionWriter(root(), 'person', 'chat')
    writer.writeTrigger('KEEP_EARLIER_DECISION')
    const current = sink()
    const originalRound = current.beginRound({})
    current.onTurnStart()
    state.active = true
    const inputs: string[] = []
    const seen: AppChatRequest[] = []
    const delivery = createAppChatDelivery(async request => {
      seen.push(request)
      const plan = prepareAppEngineSession({ engineId: 'halo', state: { sessionId: 'old-native', binding: { version: 1, engineId: 'anthropic', sessionId: 'old-native' } }, spacePath: root(), appId: 'person', runId: 'chat', excludeInputIds: request.recordedInputIds })
      inputs.push(prependEngineHandoff(request.message, plan.engineHandoffContent!))
    })
    let reminder!: AppChatRequest
    reminder = { appId: 'person', spaceId: 'space', conversationId: key, message: 'UNREAD_REMINDER', refreshBeforeDelivery: () => reminder }
    const receipt = delivery.send(reminder)
    await vi.waitFor(() => expect(state.withdrawn).toHaveLength(1))
    delivery.holdAfterStop(key)
    state.withdrawn[0]()
    await receipt
    expect(delivery.pendingRecordedInputIds(key)).toHaveLength(1)
    expect(delivery.pendingRecordedInputIds('other')).toEqual([])
    state.active = false
    current.onTurnComplete(result())
    await originalRound.done
    const before = readFileSync(transcript(), 'utf8')
    await delivery.send({ appId: 'person', spaceId: 'space', conversationId: key, message: 'START_NEXT_TURN' })
    expect(seen).toHaveLength(1)
    expect(delivery.pendingRecordedInputIds(key)).toEqual([])
    expect(seen[0].recordedInputIds).toHaveLength(1)
    expect(seen[0].recordedMessages?.map(message => message.content)).toEqual(['START_NEXT_TURN'])
    expect(inputs[0].match(/UNREAD_REMINDER/g)).toHaveLength(1)
    expect(inputs[0]).toContain('KEEP_EARLIER_DECISION')
    expect(readFileSync(transcript(), 'utf8')).toBe(before)
    expect(readSessionMessages(root(), 'person', 'chat').filter(message => message.content === 'UNREAD_REMINDER')).toHaveLength(1)
    delivery.dispose()
  })

  it.each(['halo', 'anthropic'] as const)('keeps identical earlier text when preparing %s from a repeated unread input', engineId => {
    const writer = openSessionWriter(root(), 'person', 'chat')
    const earlier = writer.writeTrigger('IDENTICAL_TEXT')!
    writer.writeEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'EARLIER_RESULT' }] } })
    const pending = writer.writeTrigger('IDENTICAL_TEXT')!
    const before = readFileSync(transcript(), 'utf8')
    const filtered = readChatHandoffHistory(root(), 'person', 'chat', { excludeInputIds: [pending.inputId] })
    expect(filtered.messages.filter(message => message.content === 'IDENTICAL_TEXT')).toHaveLength(1)
    const plan = prepareAppEngineSession({ engineId, state: { sessionId: 'old-native', binding: { version: 1, engineId: 'anthropic', sessionId: 'old-native' } }, spacePath: root(), appId: 'person', runId: 'chat', excludeInputIds: [pending.inputId] })
    const context = plan.engineHandoffContent ?? plan.recoverNativeSession!()
    const input = prependEngineHandoff('IDENTICAL_TEXT', context)
    expect(input.match(/IDENTICAL_TEXT/g)).toHaveLength(2)
    expect(input).toContain('EARLIER_RESULT')
    expect(earlier.inputId).not.toBe(pending.inputId)
    expect(readFileSync(transcript(), 'utf8')).toBe(before)
  })

  it('voids the person’s unread words and returns only the other input’s local identity', () => {
    const current = sink()
    state.active = true
    const takenBack = vi.fn()
    expect(injectIntoAppChatBatch(key, [{ text: 'OWN_STOPPED_INPUT', personal: true }, { text: 'QUEUED_OTHER_INPUT', personal: false }], takenBack)).toBe(true)
    state.withdrawn[0]()
    expect(takenBack.mock.calls[0][0]).toEqual([1])
    const byIndex = takenBack.mock.calls[0][1] as string[][]
    expect(byIndex).toHaveLength(2)
    expect(byIndex[1]).toHaveLength(1)
    const records = readSessionMessages(root(), 'person', 'chat')
    expect(records.find(message => message.content === 'OWN_STOPPED_INPUT')?.metadata?.inputOutcome).toBe('stopped')
    expect(records.find(message => message.content === 'QUEUED_OTHER_INPUT')?.metadata?.inputOutcome).toBeUndefined()
    const context = serializeEngineHandoff({ ...readChatHandoffHistory(root(), 'person', 'chat', { excludeInputIds: byIndex[1] }), targetEngine: 'halo' })
    const data = JSON.parse(context.text.slice(context.text.indexOf('\n') + 1))
    expect(data.records.find((record: { text?: string }) => record.text === 'OWN_STOPPED_INPUT')).toMatchObject({ inputOutcome: 'stopped' })
    expect(context.text).toContain('must not be executed')
    expect(current.getRecordedInputIds([])).toEqual([])
  })
})
