/**
 * A message a digital human pushed to an IM chat outside that chat's turns —
 * a notify_bot message, a run's result, a question for the owner — in the
 * chat's own record, which its owner reads in Halo.
 *
 * The push used to go out on the platform and nowhere else: opening the chat in
 * Halo showed the person's reply to it with nothing before it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const { registry, sessionEnvironments, sentToRenderer } = vi.hoisted(() => ({
  registry: {
    sessions: new Map<string, Record<string, unknown>>(),
    notePush: vi.fn(),
  },
  sessionEnvironments: new Map<string, { spacePath: string }>(),
  sentToRenderer: vi.fn(),
}))

vi.mock('../../../../src/main/apps/runtime/im-session-registry', () => ({
  getImSessionRegistry: () => ({
    findSession: (appId: string, channel: string, chatId: string) => registry.sessions.get(`${appId}:${channel}:${chatId}`),
    notePush: registry.notePush,
  }),
}))
vi.mock('../../../../src/main/apps/runtime/index', () => ({
  getActivityStore: () => ({ getSessionEnvironment: (key: string) => sessionEnvironments.get(key) }),
}))
vi.mock('../../../../src/main/apps/manager', () => ({
  getAppManager: () => ({ getApp: () => ({ id: 'dh', spaceId: 'space-1', spec: { name: 'Release Bot' } }) }),
}))
vi.mock('../../../../src/main/services/space.service', () => ({
  getSpace: () => ({ path: spaceDir() }),
}))
vi.mock('../../../../src/main/foundation/window.service', () => ({ sendToRenderer: sentToRenderer }))
vi.mock('../../../../src/main/http/websocket', () => ({ broadcastToAll: vi.fn() }))
vi.mock('../../../../src/main/services/agent/control', () => ({ stopGeneration: vi.fn() }))
vi.mock('../../../../src/main/services/agent', () => ({ listResidentSessions: () => [] }))
vi.mock('../../../../src/main/apps/runtime/im-channels', () => ({ getActiveImChannelManager: () => null }))

import { writeChatPush } from '../../../../src/main/apps/runtime/chat-record'
import { disposeAppChatSink, getAppChatSink } from '../../../../src/main/apps/runtime/app-chat-sink'
import { openSessionWriter, readSessionMessages } from '../../../../src/main/apps/runtime/session-store'
import { convertEventsToMessages, type StoredEvent } from '../../../../src/main/apps/runtime/session-transcript'
import { buildImSessionKey } from '../../../../src/shared/apps/im-keys'
import { buildTeamSessionKey } from '../../../../src/shared/apps/team-types'
import { appChatRunId } from '../../../../src/main/apps/runtime/execution-environment'

let root = ''
function spaceDir(): string {
  return join(root, 'space')
}

function readChat(spacePath: string, conversationId: string) {
  return readSessionMessages(spacePath, 'dh', appChatRunId(conversationId, 'dh'))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'chat-push-'))
  registry.sessions.clear()
  registry.notePush.mockClear()
  sessionEnvironments.clear()
  sentToRenderer.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  for (const key of [
    buildImSessionKey('dh', 'wecom-bot', 'group', 'ops-group'),
    buildTeamSessionKey('dh', 'team-1', 'epoch-1'),
  ]) disposeAppChatSink(key)
  rmSync(root, { recursive: true, force: true })
})

describe('a push in the record of the chat it went to', () => {
  it('reads as a message the digital human sent on its own, after what came before it', () => {
    const conversationId = buildImSessionKey('dh', 'wecom-bot', 'group', 'ops-group')
    registry.sessions.set('dh:wecom-bot:ops-group', { appId: 'dh', channel: 'wecom-bot', chatId: 'ops-group', instanceId: 'inst-1' })
    const writer = openSessionWriter(spaceDir(), 'dh', appChatRunId(conversationId, 'dh'))
    writer.writeTrigger('Is the build green?')
    writer.writeEvent({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Yes.' }] } })
    writer.writeEvent({ type: 'result', subtype: 'success' })

    writeChatPush({ appId: 'dh', channel: 'wecom-bot', chatType: 'group', chatId: 'ops-group', text: 'Nightly report: 3 failures', via: 'result' })

    const messages = readChat(spaceDir(), conversationId)
    expect(messages.map(m => [m.role, m.content, m.source])).toEqual([
      ['user', 'Is the build green?', undefined],
      ['assistant', 'Yes.', undefined],
      ['assistant', 'Nightly report: 3 failures', 'push'],
    ])
    expect(messages[2].metadata).toEqual({ pushVia: 'result' })
  })

  it('moves the chat to the top of the session list, and tells the screens', () => {
    registry.sessions.set('dh:wecom-bot:ops-group', { appId: 'dh', channel: 'wecom-bot', chatId: 'ops-group', instanceId: 'inst-1' })

    writeChatPush({ appId: 'dh', channel: 'wecom-bot', chatType: 'group', chatId: 'ops-group', text: 'Reminder: standup at 10', via: 'message' })

    expect(registry.notePush).toHaveBeenCalledWith('dh', 'wecom-bot', 'ops-group', { lastSender: 'Release Bot', lastMessage: 'Reminder: standup at 10' })
    expect(sentToRenderer).toHaveBeenCalledWith('app:im-session-updated', expect.objectContaining({
      appId: 'dh', channel: 'wecom-bot', chatId: 'ops-group', instanceId: 'inst-1', lastMessage: 'Reminder: standup at 10',
    }))
  })

  it('goes where the chat\'s record is kept: the space its session was pinned to', () => {
    // A digital human moved to another space keeps its chats where they were.
    const conversationId = buildImSessionKey('dh', 'wecom-bot', 'group', 'ops-group')
    const pinned = join(root, 'old-space')
    sessionEnvironments.set(conversationId, { spacePath: pinned })

    writeChatPush({ appId: 'dh', channel: 'wecom-bot', chatType: 'group', chatId: 'ops-group', text: 'Moved but still here', via: 'message' })

    expect(readChat(pinned, conversationId).map(m => m.content)).toEqual(['Moved but still here'])
    expect(existsSync(join(spaceDir(), '.halo'))).toBe(false)
  })

  it('goes into the team\'s conversation with a chat a team fronts', () => {
    registry.sessions.set('dh:wecom-bot:ops-group', {
      appId: 'dh', channel: 'wecom-bot', chatId: 'ops-group', instanceId: 'inst-1', teamContext: { teamId: 'team-1', epochId: 'epoch-1' },
    })

    writeChatPush({ appId: 'dh', channel: 'wecom-bot', chatType: 'group', chatId: 'ops-group', text: 'A question waits for the owner', via: 'question' })

    const team = readChat(spaceDir(), buildTeamSessionKey('dh', 'team-1', 'epoch-1'))
    expect(team.map(m => [m.content, m.metadata?.pushVia])).toEqual([['A question waits for the owner', 'question']])
    expect(readChat(spaceDir(), buildImSessionKey('dh', 'wecom-bot', 'group', 'ops-group'))).toEqual([])
    // The team's conversation open in Halo reads its record again on this.
    expect(sentToRenderer).toHaveBeenCalledWith('team:member-history', { teamId: 'team-1', appId: 'dh', epochId: 'epoch-1' })
  })
})

describe('a push that comes while a turn of the chat is running', () => {
  const conversationId = buildImSessionKey('dh', 'wecom-bot', 'group', 'ops-group')
  const push = { appId: 'dh', channel: 'wecom-bot', chatType: 'group' as const, chatId: 'ops-group', text: 'FYI: deploy started', via: 'message' as const }
  const turnResult = {
    finalContent: 'Two errors, both fixed.', hasMeaningfulContent: true, thoughts: [], tokenUsage: null,
    isInterrupted: false, wasAborted: false, hasErrorThought: false, reachedMaxTurns: false, firstEventReceived: true, drainTimedOut: false,
  }

  function startTurn() {
    const sink = getAppChatSink({ appId: 'dh', conversationId, runId: appChatRunId(conversationId, 'dh'), spacePath: spaceDir() })
    sink.beginRound({})
    sink.writeUserMessage('Summarize the logs')
    sink.onTurnStart()
    sink.onRawMessage({ type: 'system', subtype: 'init' })
    sink.onRawMessage({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'ERROR' } }] } })
    return sink
  }

  function endTurn(sink: ReturnType<typeof startTurn>) {
    sink.onRawMessage({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Two errors, both fixed.' }] } })
    sink.onRawMessage({ type: 'result', subtype: 'success' })
    sink.onTurnComplete(turnResult as never)
  }

  it('is written once the turn ends, so the turn reads whole, and keeps the time it was sent', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-07T10:00:01.000Z'))
    const sink = startTurn()
    vi.setSystemTime(new Date('2026-10-07T10:00:04.000Z'))

    writeChatPush(push)
    expect(readChat(spaceDir(), conversationId).map(m => m.content)).not.toContain('FYI: deploy started')

    vi.setSystemTime(new Date('2026-10-07T10:00:09.000Z'))
    endTurn(sink)

    const messages = readChat(spaceDir(), conversationId)
    expect(messages.map(m => [m.role, m.content, m.source])).toEqual([
      ['user', 'Summarize the logs', undefined],
      ['assistant', 'Two errors, both fixed.', undefined],
      ['assistant', 'FYI: deploy started', 'push'],
    ])
    // The turn kept its tool call: the push did not cut it in two.
    expect(messages[1].thoughts?.map(t => t.type)).toEqual(['tool_use'])
    expect(messages[2].timestamp).toBe('2026-10-07T10:00:04.000Z')
  })

  it('is not written into a chat whose history was cleared before the turn ended', () => {
    const sink = startTurn()
    writeChatPush(push)

    disposeAppChatSink(conversationId)
    endTurn(sink)

    expect(readChat(spaceDir(), conversationId).map(m => m.content)).not.toContain('FYI: deploy started')
  })
})

describe('a push read back from the record', () => {
  const at = (s: number) => `2026-10-07T10:00:${String(s).padStart(2, '0')}.000Z`

  it('ends a turn left open before it, and messages keep the order of their lines', () => {
    // Halo exited before the turn's end was written.
    const events: StoredEvent[] = [
      { _ts: at(1), type: 'user', _isTrigger: true, message: { role: 'user', content: [{ type: 'text', text: 'Go' }] } },
      { _ts: at(2), type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Working…' }] } },
      { _ts: at(3), type: 'push', _pushVia: 'question', message: { role: 'assistant', content: [{ type: 'text', text: 'Ship tonight? /answer 7' }] } },
      { _ts: at(4), type: 'user', _isTrigger: true, message: { role: 'user', content: [{ type: 'text', text: 'Status?' }] } },
    ]

    expect(convertEventsToMessages(events).map(m => [m.id, m.content, m.source, m.metadata?.pushVia])).toEqual([
      ['session-msg-1', 'Go', undefined, undefined],
      ['session-msg-2', 'Working…', undefined, undefined],
      ['session-msg-3', 'Ship tonight? /answer 7', 'push', 'question'],
      ['session-msg-4', 'Status?', undefined, undefined],
    ])
  })
})
