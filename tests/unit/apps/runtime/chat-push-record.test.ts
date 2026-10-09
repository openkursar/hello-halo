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

const { registry, sessionEnvironments, sentToRenderer, installedApps } = vi.hoisted(() => ({
  installedApps: {
    dh: { id: 'dh', spaceId: 'space-1', spec: { name: 'Release Bot' } },
    'ops-dh': { id: 'ops-dh', spaceId: 'space-1', spec: { name: 'Ops Bot' } },
  } as Record<string, { id: string; spaceId: string; spec: { name: string } }>,
  registry: {
    sessions: new Map<string, Record<string, unknown>>(),
    current: undefined as import('../../../../src/main/apps/runtime/im-session-registry').ImSessionRegistry | undefined,
    notePush: vi.fn(),
  },
  sessionEnvironments: new Map<string, { spacePath: string }>(),
  sentToRenderer: vi.fn(),
}))

vi.mock('../../../../src/main/apps/runtime/im-session-registry', () => ({
  getImSessionRegistry: () => registry.current ?? ({
    findSession: (appId: string, channel: string, chatId: string) => registry.sessions.get(`${appId}:${channel}:${chatId}`),
    getSessionRevision: (appId: string, channel: string, chatId: string) => registry.sessions.get(`${appId}:${channel}:${chatId}`),
    notePush: registry.notePush,
  }),
}))
vi.mock('../../../../src/main/apps/runtime/index', () => ({
  getActivityStore: () => ({ getSessionEnvironment: (key: string) => sessionEnvironments.get(key) }),
}))
vi.mock('../../../../src/main/apps/manager', () => ({
  getAppManager: () => ({ getApp: (id: string) => installedApps[id] }),
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
import { chatPushConversationId, recordChatPush } from '../../../../src/main/apps/runtime/chat-push'
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
  registry.current = undefined
  registry.notePush.mockClear()
  sessionEnvironments.clear()
  sentToRenderer.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  for (const key of [
    buildImSessionKey('dh', 'wecom-bot', 'group', 'ops-group'),
    buildTeamSessionKey('dh', 'team-1', 'epoch-1'),
    buildTeamSessionKey('dh', 'team-1', 'private-epoch'),
    buildImSessionKey('dh', 'wecom-bot', 'direct', 'boss'),
  ]) disposeAppChatSink(key)
  rmSync(root, { recursive: true, force: true })
})

describe('the shared destination for a push record and relay', () => {
  it.each(['direct', 'group'] as const)('uses the provider-qualified key for an ordinary %s chat', chatType => {
    const push = { appId: 'dh', channel: 'wecom-bot', chatType, chatId: 'same-chat' }

    expect(chatPushConversationId(push)).toBe(buildImSessionKey('dh', 'wecom-bot', chatType, 'same-chat'))
    expect(chatPushConversationId(push, {})).toBe(buildImSessionKey('dh', 'wecom-bot', chatType, 'same-chat'))
  })

  it('uses the private team chat’s own epoch rather than an ordinary IM key', () => {
    const push = { appId: 'dh', channel: 'wecom-bot', chatType: 'direct' as const, chatId: 'boss' }

    expect(chatPushConversationId(push, { teamContext: { teamId: 'team-1', epochId: 'private-epoch' } }))
      .toBe(buildTeamSessionKey('dh', 'team-1', 'private-epoch'))
  })
})

describe('a push in the record of the chat it went to', () => {
  it('reads as a message the digital human sent on its own, after what came before it', () => {
    const conversationId = buildImSessionKey('dh', 'wecom-bot', 'group', 'ops-group')
    registry.sessions.set('dh:wecom-bot:ops-group', { appId: 'dh', channel: 'wecom-bot', chatId: 'ops-group', instanceId: 'inst-1' })
    const writer = openSessionWriter(spaceDir(), 'dh', appChatRunId(conversationId, 'dh'))
    writer.writeTrigger('Is the build green?')
    writer.writeEvent({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Yes.' }] } })
    writer.writeEvent({ type: 'result', subtype: 'success' })

    writeChatPush({ appId: 'dh', channel: 'wecom-bot', chatType: 'group', chatId: 'ops-group', text: 'Nightly report: 3 failures', via: 'result', pushedBy: 'dh' })

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

    writeChatPush({ appId: 'dh', channel: 'wecom-bot', chatType: 'group', chatId: 'ops-group', text: 'Reminder: standup at 10', via: 'message', pushedBy: 'dh' })

    expect(registry.notePush).toHaveBeenCalledWith('dh', 'wecom-bot', 'ops-group', { lastSender: 'Release Bot', lastMessage: 'Reminder: standup at 10' })
    expect(sentToRenderer).toHaveBeenCalledWith('app:im-session-updated', expect.objectContaining({
      appId: 'dh', channel: 'wecom-bot', chatId: 'ops-group', instanceId: 'inst-1', lastMessage: 'Reminder: standup at 10',
    }))
  })

  it('names the digital human that pushed it when that is not the chat\'s own one', () => {
    // Another digital human reaches this chat through a push link (#135); the
    // record and the reply stay with the chat's own one.
    const conversationId = buildImSessionKey('dh', 'wecom-bot', 'group', 'ops-group')
    registry.sessions.set('dh:wecom-bot:ops-group', { appId: 'dh', channel: 'wecom-bot', chatId: 'ops-group', instanceId: 'inst-1' })

    writeChatPush({ appId: 'dh', channel: 'wecom-bot', chatType: 'group', chatId: 'ops-group', text: 'Deploy finished', via: 'result', pushedBy: 'ops-dh' })

    const [message] = readChat(spaceDir(), conversationId)
    expect(message.metadata).toEqual({ pushVia: 'result', pushedByAppId: 'ops-dh', pushedByName: 'Ops Bot' })
    expect(registry.notePush).toHaveBeenCalledWith('dh', 'wecom-bot', 'ops-group', { lastSender: 'Ops Bot', lastMessage: 'Deploy finished' })
    expect(sentToRenderer).toHaveBeenCalledWith('app:im-session-updated', expect.objectContaining({ appId: 'dh', lastSender: 'Ops Bot' }))
  })

  it('goes where the chat\'s record is kept: the space its session was pinned to', () => {
    // A digital human moved to another space keeps its chats where they were.
    const conversationId = buildImSessionKey('dh', 'wecom-bot', 'group', 'ops-group')
    const pinned = join(root, 'old-space')
    sessionEnvironments.set(conversationId, { spacePath: pinned })

    writeChatPush({ appId: 'dh', channel: 'wecom-bot', chatType: 'group', chatId: 'ops-group', text: 'Moved but still here', via: 'message', pushedBy: 'dh' })

    expect(readChat(pinned, conversationId).map(m => m.content)).toEqual(['Moved but still here'])
    expect(existsSync(join(spaceDir(), '.halo'))).toBe(false)
  })

  it('keeps a member’s private question in the owner chat’s team epoch under the asking member’s name', () => {
    const teamContext = { teamId: 'team-1', epochId: 'private-epoch' }
    registry.sessions.set('dh:wecom-bot:boss', {
      appId: 'dh', channel: 'wecom-bot', chatType: 'direct', chatId: 'boss', instanceId: 'inst-1', teamContext,
    })
    const push = {
      appId: 'dh', channel: 'wecom-bot', chatType: 'direct' as const, chatId: 'boss',
      text: '「Ops Bot」的任务需要你决定：Ship tonight? 直接回复我就行。', via: 'question' as const, pushedBy: 'ops-dh',
    }
    const conversationId = chatPushConversationId(push, { teamContext })
    const pinned = join(root, 'old-space')
    sessionEnvironments.set(conversationId, { spacePath: pinned })

    writeChatPush(push)

    const [message] = readChat(pinned, conversationId)
    expect(message).toMatchObject({
      role: 'assistant', content: push.text, source: 'push',
      metadata: { pushVia: 'question', pushedByAppId: 'ops-dh', pushedByName: 'Ops Bot' },
    })
    expect(readChat(pinned, buildImSessionKey('dh', 'wecom-bot', 'direct', 'boss'))).toEqual([])
    expect(readChat(pinned, buildTeamSessionKey('dh', 'team-1', 'epoch-1'))).toEqual([])
    expect(existsSync(join(spaceDir(), '.halo'))).toBe(false)
    expect(registry.notePush).toHaveBeenCalledWith('dh', 'wecom-bot', 'boss', expect.objectContaining({ lastSender: 'Ops Bot' }))
    expect(sentToRenderer).toHaveBeenCalledWith('team:member-history', { teamId: 'team-1', appId: 'dh', epochId: 'private-epoch' })
  })

  it('pins a question to its resolved destination even when asynchronous recording sees a different registry context', () => {
    registry.sessions.set('dh:wecom-bot:boss', {
      appId: 'dh', channel: 'wecom-bot', chatType: 'direct', chatId: 'boss', instanceId: 'inst-1',
      teamContext: { teamId: 'team-1', epochId: 'epoch-1' },
    })
    const teamContext = { teamId: 'team-1', epochId: 'private-epoch' }

    writeChatPush({ appId: 'dh', channel: 'wecom-bot', chatType: 'direct', chatId: 'boss',
      text: 'A new private question', via: 'question', pushedBy: 'ops-dh', teamContext })

    expect(readChat(spaceDir(), buildTeamSessionKey('dh', 'team-1', 'private-epoch')).map(m => m.content)).toEqual(['A new private question'])
    expect(readChat(spaceDir(), buildTeamSessionKey('dh', 'team-1', 'epoch-1'))).toEqual([])
    expect(sentToRenderer).toHaveBeenCalledWith('team:member-history', { ...teamContext, appId: 'dh' })
  })

  it.each(['recreated', 'cleared', 'rebound', 'removed'] as const)('does not refresh a session %s before the deferred push write', async change => {
    const teamContext = { teamId: 'team-1', epochId: 'private-epoch' }
    const key = 'dh:wecom-bot:boss'
    const original = {
      appId: 'dh', channel: 'wecom-bot', chatType: 'direct', chatId: 'boss', instanceId: 'inst-1', teamContext,
    }
    registry.sessions.set(key, original)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      recordChatPush({ appId: 'dh', channel: 'wecom-bot', chatType: 'direct', chatId: 'boss',
        text: 'Delivered before the session changed', via: 'message', pushedBy: 'dh',
        ...(change === 'rebound' ? {} : { teamContext }) })
      const successor = { ...original, lastMessage: 'New conversation', lastActiveAt: 42, messageCount: 1,
        ...(change === 'rebound' ? { teamContext: { teamId: 'team-1', epochId: 'epoch-1' } } : {}) }
      if (change === 'removed') registry.sessions.delete(key)
      else registry.sessions.set(key, successor)

      await vi.dynamicImportSettled()

      expect(readChat(spaceDir(), buildTeamSessionKey('dh', 'team-1', 'private-epoch')).map(m => m.content))
        .toEqual(['Delivered before the session changed'])
      expect(registry.notePush).not.toHaveBeenCalled()
      expect(sentToRenderer).not.toHaveBeenCalledWith('app:im-session-updated', expect.anything())
      expect(sentToRenderer).toHaveBeenCalledWith('team:member-history', { ...teamContext, appId: 'dh' })
      expect(registry.sessions.get(key)).toBe(change === 'removed' ? undefined : successor)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('reason=session changed before recording'))
    } finally {
      warn.mockRestore()
    }
  })

  it('records a previously invalidated delivery without changing the current session list', () => {
    registry.sessions.set('dh:wecom-bot:boss', {
      appId: 'dh', channel: 'wecom-bot', chatId: 'boss', instanceId: 'inst-1',
      teamContext: { teamId: 'team-1', epochId: 'epoch-1' },
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      writeChatPush({ appId: 'dh', channel: 'wecom-bot', chatType: 'direct', chatId: 'boss',
        text: 'Already delivered', via: 'message', pushedBy: 'dh',
        teamContext: { teamId: 'team-1', epochId: 'private-epoch' }, sessionRevision: null })

      expect(readChat(spaceDir(), buildTeamSessionKey('dh', 'team-1', 'private-epoch')).map(m => m.content)).toEqual(['Already delivered'])
      expect(registry.notePush).not.toHaveBeenCalled()
      expect(sentToRenderer).not.toHaveBeenCalledWith('app:im-session-updated', expect.anything())
      expect(sentToRenderer).toHaveBeenCalledWith('team:member-history', { teamId: 'team-1', epochId: 'private-epoch', appId: 'dh' })
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it.each(['cleared', 'new epoch', 'recreated'] as const)('preserves real registry activity when the delivery’s session was %s', async change => {
    const { ImSessionRegistry } = await vi.importActual<typeof import('../../../../src/main/apps/runtime/im-session-registry')>(
      '../../../../src/main/apps/runtime/im-session-registry',
    )
    const { AtomicFileWriter } = await import('../../../../src/main/apps/runtime/atomic-file-writer')
    const persist = vi.spyOn(AtomicFileWriter.prototype, 'write').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const current = new ImSessionRegistry(join(root, 'sessions.json'))
      registry.current = current
      const teamContext = { teamId: 'team-1', epochId: 'private-epoch' }
      current.register('dh', 'wecom-bot', 'boss', 'direct', 'inst-1', { teamContext, lastMessage: 'Original' })
      const originalRevision = current.getSessionRevision('dh', 'wecom-bot', 'boss')
      recordChatPush({ appId: 'dh', channel: 'wecom-bot', chatType: 'direct', chatId: 'boss',
        text: 'A delivered file', via: 'message', pushedBy: 'dh', teamContext })
      if (change === 'cleared') current.resetActivity('dh', 'wecom-bot', 'boss')
      else {
        if (change === 'recreated') current.removeSession('dh', 'wecom-bot', 'boss')
        current.register('dh', 'wecom-bot', 'boss', 'direct', 'inst-1', {
          teamContext: change === 'new epoch' ? { teamId: 'team-1', epochId: 'epoch-1' } : teamContext,
          lastMessage: 'Successor conversation',
        })
      }
      const successor = current.findSession('dh', 'wecom-bot', 'boss')
      const revision = current.getSessionRevision('dh', 'wecom-bot', 'boss')
      expect(revision).not.toBe(originalRevision)

      await vi.dynamicImportSettled()

      expect(readChat(spaceDir(), buildTeamSessionKey('dh', 'team-1', 'private-epoch')).map(m => m.content)).toEqual(['A delivered file'])
      expect(current.findSession('dh', 'wecom-bot', 'boss')).toEqual(successor)
      expect(current.getSessionRevision('dh', 'wecom-bot', 'boss')).toBe(revision)
      expect(sentToRenderer).not.toHaveBeenCalledWith('app:im-session-updated', expect.anything())
      expect(sentToRenderer).toHaveBeenCalledWith('team:member-history', { ...teamContext, appId: 'dh' })
    } finally {
      await Promise.resolve()
      registry.current = undefined
      persist.mockRestore()
      warn.mockRestore()
    }
  })

  it('refreshes the same session after deferred recording', async () => {
    registry.sessions.set('dh:wecom-bot:boss', { appId: 'dh', channel: 'wecom-bot', chatId: 'boss', instanceId: 'inst-1' })

    recordChatPush({ appId: 'dh', channel: 'wecom-bot', chatType: 'direct', chatId: 'boss',
      text: 'Still current', via: 'message', pushedBy: 'dh', teamContext: null })
    await vi.dynamicImportSettled()

    expect(registry.notePush).toHaveBeenCalledWith('dh', 'wecom-bot', 'boss', { lastSender: 'Release Bot', lastMessage: 'Still current' })
    expect(sentToRenderer).toHaveBeenCalledWith('app:im-session-updated', expect.objectContaining({ lastMessage: 'Still current' }))
  })

  it('keeps an explicitly non-team question out of a cached team conversation', () => {
    registry.sessions.set('dh:wecom-bot:boss', {
      appId: 'dh', channel: 'wecom-bot', chatType: 'direct', chatId: 'boss', instanceId: 'inst-1',
      teamContext: { teamId: 'team-1', epochId: 'epoch-1' },
    })

    writeChatPush({ appId: 'dh', channel: 'wecom-bot', chatType: 'direct', chatId: 'boss',
      text: 'A solo question', via: 'question', pushedBy: 'dh', teamContext: null })

    expect(readChat(spaceDir(), buildImSessionKey('dh', 'wecom-bot', 'direct', 'boss')).map(m => m.content)).toEqual(['A solo question'])
    expect(readChat(spaceDir(), buildTeamSessionKey('dh', 'team-1', 'epoch-1'))).toEqual([])
    expect(sentToRenderer).not.toHaveBeenCalledWith('team:member-history', expect.anything())
  })

  it('goes into the team\'s conversation with a chat a team fronts', () => {
    registry.sessions.set('dh:wecom-bot:ops-group', {
      appId: 'dh', channel: 'wecom-bot', chatId: 'ops-group', instanceId: 'inst-1', teamContext: { teamId: 'team-1', epochId: 'epoch-1' },
    })

    writeChatPush({ appId: 'dh', channel: 'wecom-bot', chatType: 'group', chatId: 'ops-group', text: 'A question waits for the owner', via: 'question', pushedBy: 'dh' })

    const team = readChat(spaceDir(), buildTeamSessionKey('dh', 'team-1', 'epoch-1'))
    expect(team.map(m => [m.content, m.metadata?.pushVia])).toEqual([['A question waits for the owner', 'question']])
    expect(readChat(spaceDir(), buildImSessionKey('dh', 'wecom-bot', 'group', 'ops-group'))).toEqual([])
    // The team's conversation open in Halo reads its record again on this.
    expect(sentToRenderer).toHaveBeenCalledWith('team:member-history', { teamId: 'team-1', appId: 'dh', epochId: 'epoch-1' })
  })
})

describe('a push that comes while a turn of the chat is running', () => {
  const conversationId = buildImSessionKey('dh', 'wecom-bot', 'group', 'ops-group')
  const push = { appId: 'dh', channel: 'wecom-bot', chatType: 'group' as const, chatId: 'ops-group', text: 'FYI: deploy started', via: 'message' as const, pushedBy: 'ops-dh' }
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
    expect(messages[2].metadata?.pushedByName).toBe('Ops Bot')
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
      // A pusher without a name is not one the reader can show.
      { _ts: at(3), type: 'push', _pushVia: 'question', _pushedBy: { appId: 'ops-dh' }, message: { role: 'assistant', content: [{ type: 'text', text: 'Ship tonight? You can reply here.' }] } } as StoredEvent,
      { _ts: at(4), type: 'user', _isTrigger: true, message: { role: 'user', content: [{ type: 'text', text: 'Status?' }] } },
    ]

    const messages = convertEventsToMessages(events)
    expect(messages.map(m => [m.id, m.content, m.source, m.metadata?.pushVia])).toEqual([
      ['session-msg-1', 'Go', undefined, undefined],
      ['session-msg-2', 'Working…', undefined, undefined],
      ['session-msg-3', 'Ship tonight? You can reply here.', 'push', 'question'],
      ['session-msg-4', 'Status?', undefined, undefined],
    ])
    expect(messages[2].metadata).toEqual({ pushVia: 'question' })
  })
})
